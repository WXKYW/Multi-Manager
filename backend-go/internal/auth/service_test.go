package auth

import (
	"context"
	"database/sql"
	"encoding/base32"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/iwvw/api-monitor/backend-go/internal/applog"
	"github.com/iwvw/api-monitor/backend-go/internal/config"
)

func TestLoginAuditIncludesRequestID(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "")
	t.Setenv("DEMO_MODE", "")
	t.Setenv("ENCRYPTION_KEY", "")

	service := New(config.Config{
		Version: "test",
		Host:    "127.0.0.1",
		Port:    0,
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})

	res := performAuthRequest(service, http.MethodPost, "/api/auth/set-password", `{"password":"secret123"}`, nil)
	if res.Code != http.StatusOK {
		t.Fatalf("set-password status = %d body=%s", res.Code, res.Body.String())
	}

	const requestID = "req_login_audit_test"
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"password":"secret123"}`))
	req.RemoteAddr = "203.0.113.20:4567"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Request-ID", requestID)
	res = httptest.NewRecorder()
	applog.Middleware(service).ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("login status = %d body=%s", res.Code, res.Body.String())
	}

	db, err := service.openDB(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var traceID sql.NullString
	if err := db.QueryRowContext(context.Background(), `
		SELECT trace_id FROM operation_logs
		WHERE operation_type = 'LOGIN_SUCCESS'
		ORDER BY id DESC LIMIT 1
	`).Scan(&traceID); err != nil {
		t.Fatal(err)
	}
	if !traceID.Valid || traceID.String != requestID {
		t.Fatalf("login audit trace_id = %#v, want %q", traceID, requestID)
	}
}

func Test2FAManagementFlow(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "")
	t.Setenv("DEMO_MODE", "")
	t.Setenv("ENCRYPTION_KEY", "")

	service := New(config.Config{
		Version: "test",
		Host:    "127.0.0.1",
		Port:    0,
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})

	res := performAuthRequest(service, http.MethodPost, "/api/auth/set-password", `{"password":"secret123"}`, nil)
	if res.Code != http.StatusOK {
		t.Fatalf("set-password status = %d body=%s", res.Code, res.Body.String())
	}

	res = performAuthRequest(service, http.MethodPost, "/api/auth/login", `{"password":"secret123"}`, nil)
	if res.Code != http.StatusOK {
		t.Fatalf("login status = %d body=%s", res.Code, res.Body.String())
	}
	initialCookie := findCookie(res.Result().Cookies(), "sid")
	if initialCookie == nil {
		t.Fatal("expected login cookie")
	}

	res = performAuthRequest(service, http.MethodGet, "/api/auth/2fa/status", "", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("initial 2fa status = %d body=%s", res.Code, res.Body.String())
	}
	var statusPayload struct {
		Success bool `json:"success"`
		Enabled bool `json:"enabled"`
	}
	mustDecodeAuth(t, res, &statusPayload)
	if !statusPayload.Success || statusPayload.Enabled {
		t.Fatalf("unexpected initial status: %#v", statusPayload)
	}

	res = performAuthRequest(service, http.MethodPost, "/api/auth/2fa/setup", `{}`, nil)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("setup without session status = %d body=%s", res.Code, res.Body.String())
	}

	res = performAuthRequest(service, http.MethodPost, "/api/auth/2fa/setup", `{}`, initialCookie)
	if res.Code != http.StatusOK {
		t.Fatalf("setup status = %d body=%s", res.Code, res.Body.String())
	}
	var setupPayload struct {
		Success bool   `json:"success"`
		Secret  string `json:"secret"`
		QRCode  string `json:"qrCode"`
	}
	mustDecodeAuth(t, res, &setupPayload)
	if !setupPayload.Success || setupPayload.Secret == "" || !strings.HasPrefix(setupPayload.QRCode, "data:image/png;base64,") {
		t.Fatalf("unexpected setup payload: %#v", setupPayload)
	}

	token := totpForTest(t, setupPayload.Secret, time.Now().UTC())
	enableBody := `{"secret":"` + setupPayload.Secret + `","token":"` + token + `"}`
	res = performAuthRequest(service, http.MethodPost, "/api/auth/2fa/enable", enableBody, initialCookie)
	if res.Code != http.StatusOK {
		t.Fatalf("enable status = %d body=%s", res.Code, res.Body.String())
	}

	db, err := service.openDB(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	encryptedSecret, err := service.getConfig(context.Background(), db, system2FASecretKey)
	if err != nil {
		t.Fatal(err)
	}
	decryptedSecret, err := decryptNodeGCM(encryptedSecret)
	if err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	if encryptedSecret == setupPayload.Secret || decryptedSecret != setupPayload.Secret {
		t.Fatalf("2fa secret storage mismatch encrypted=%q decrypted=%q secret=%q", encryptedSecret, decryptedSecret, setupPayload.Secret)
	}

	res = performAuthRequest(service, http.MethodGet, "/api/auth/2fa/status", "", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("enabled status code = %d body=%s", res.Code, res.Body.String())
	}
	mustDecodeAuth(t, res, &statusPayload)
	if !statusPayload.Enabled {
		t.Fatalf("expected 2fa enabled, got %#v", statusPayload)
	}

	res = performAuthRequest(service, http.MethodPost, "/api/auth/logout", "", initialCookie)
	if res.Code != http.StatusOK {
		t.Fatalf("logout status = %d body=%s", res.Code, res.Body.String())
	}

	res = performAuthRequest(service, http.MethodPost, "/api/auth/login", `{"password":"secret123"}`, nil)
	if res.Code != http.StatusOK {
		t.Fatalf("login without 2fa status = %d body=%s", res.Code, res.Body.String())
	}
	var requirePayload struct {
		Success    bool `json:"success"`
		Require2FA bool `json:"require2FA"`
	}
	mustDecodeAuth(t, res, &requirePayload)
	if requirePayload.Success || !requirePayload.Require2FA {
		t.Fatalf("expected 2fa challenge, got %#v", requirePayload)
	}

	loginBody := `{"password":"secret123","totpToken":"` + token + `"}`
	res = performAuthRequest(service, http.MethodPost, "/api/auth/login", loginBody, nil)
	if res.Code != http.StatusOK {
		t.Fatalf("login with 2fa status = %d body=%s", res.Code, res.Body.String())
	}
	totpCookie := findCookie(res.Result().Cookies(), "sid")
	if totpCookie == nil {
		t.Fatal("expected 2fa login cookie")
	}

	res = performAuthRequest(service, http.MethodPost, "/api/auth/2fa/disable", `{"password":"secret123"}`, totpCookie)
	if res.Code != http.StatusOK {
		t.Fatalf("disable status = %d body=%s", res.Code, res.Body.String())
	}

	db, err = service.openDB(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	enabled, err := service.is2FAEnabled(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	secretAfterDisable, err := service.getConfig(context.Background(), db, system2FASecretKey)
	if err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	if enabled || secretAfterDisable != "" {
		t.Fatalf("expected disabled 2fa with deleted secret, enabled=%v secret=%q", enabled, secretAfterDisable)
	}
}

func TestLoginDoesNotExposeSessionIDAndProductionCookieIsSecure(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "")
	service := New(config.Config{
		Environment:   "production",
		SecureCookies: true,
		Host:          "127.0.0.1",
		DataDir:       t.TempDir(),
		DBName:        "data.db",
	})
	res := performAuthRequest(service, http.MethodPost, "/api/auth/set-password", `{"password":"secret123"}`, nil)
	if res.Code != http.StatusOK {
		t.Fatalf("set password: %d %s", res.Code, res.Body.String())
	}
	res = performAuthRequest(service, http.MethodPost, "/api/auth/login", `{"password":"secret123"}`, nil)
	if strings.Contains(res.Body.String(), "sessionId") {
		t.Fatalf("login response exposed session id: %s", res.Body.String())
	}
	cookie := findCookie(res.Result().Cookies(), "sid")
	if cookie == nil || !cookie.HttpOnly || !cookie.Secure {
		t.Fatalf("expected secure HttpOnly cookie, got %#v", cookie)
	}
}

func TestWebAuthnRegistrationBeginDoesNotRequirePasswordPrompt(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "")
	t.Setenv("DEMO_MODE", "")
	t.Setenv("ENCRYPTION_KEY", "")

	service := New(config.Config{
		Version: "test",
		Host:    "127.0.0.1",
		Port:    0,
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})

	res := performAuthRequest(service, http.MethodPost, "/api/auth/set-password", `{"password":"secret123"}`, nil)
	if res.Code != http.StatusOK {
		t.Fatalf("set-password status = %d body=%s", res.Code, res.Body.String())
	}

	res = performAuthRequest(service, http.MethodPost, "/api/auth/login", `{"password":"secret123"}`, nil)
	if res.Code != http.StatusOK {
		t.Fatalf("login status = %d body=%s", res.Code, res.Body.String())
	}
	cookie := findCookie(res.Result().Cookies(), "sid")
	if cookie == nil {
		t.Fatal("expected login cookie")
	}

	req := httptest.NewRequest(http.MethodPost, "/api/auth/webauthn/register/begin", strings.NewReader(`{"label":"Windows Hello"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://example.com")
	req.RemoteAddr = "203.0.113.20:4567"
	req.AddCookie(cookie)
	res = httptest.NewRecorder()
	service.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("register begin status = %d body=%s", res.Code, res.Body.String())
	}
	var payload struct {
		Success bool   `json:"success"`
		FlowID  string `json:"flowId"`
	}
	mustDecodeAuth(t, res, &payload)
	if !payload.Success || payload.FlowID == "" {
		t.Fatalf("unexpected register begin payload: %#v", payload)
	}
}

func TestClientIPOnlyTrustsConfiguredProxy(t *testing.T) {
	service := New(config.Config{TrustedProxyCIDRs: []string{"10.0.0.0/8"}})
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	req.RemoteAddr = "203.0.113.8:1234"
	req.Header.Set("X-Forwarded-For", "198.51.100.7")
	if got := service.requestClientIP(req); got != "203.0.113.8" {
		t.Fatalf("untrusted proxy address = %q", got)
	}
	req.RemoteAddr = "10.1.2.3:1234"
	if got := service.requestClientIP(req); got != "198.51.100.7" {
		t.Fatalf("trusted proxy address = %q", got)
	}
}

func TestGitHubOAuthConfigRoundTripEncryptsSecret(t *testing.T) {
	service := New(config.Config{
		Version: "test",
		Host:    "127.0.0.1",
		Port:    0,
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})

	db, err := service.openDB(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	input := githubOAuthConfig{
		Enabled:       true,
		ClientID:      "client-id",
		ClientSecret:  "super-secret",
		AllowedLogins: normalizeGitHubList("IWVW\niwvw,Other"),
		AllowedEmails: normalizeGitHubList("ADMIN@example.com,admin@example.com"),
	}
	if err := service.saveGitHubOAuthConfig(context.Background(), db, input); err != nil {
		t.Fatal(err)
	}

	rawSecret, err := service.getConfig(context.Background(), db, githubClientSecretKey)
	if err != nil {
		t.Fatal(err)
	}
	if rawSecret == "" || rawSecret == input.ClientSecret {
		t.Fatalf("expected encrypted secret, got %q", rawSecret)
	}

	loaded, err := service.loadGitHubOAuthConfig(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	if !loaded.Enabled || loaded.ClientID != input.ClientID || loaded.ClientSecret != input.ClientSecret {
		t.Fatalf("unexpected config roundtrip: %#v", loaded)
	}
	if len(loaded.AllowedLogins) != 2 || loaded.AllowedLogins[0] != "iwvw" || loaded.AllowedLogins[1] != "other" {
		t.Fatalf("unexpected allowed logins: %#v", loaded.AllowedLogins)
	}
	if len(loaded.AllowedEmails) != 1 || loaded.AllowedEmails[0] != "admin@example.com" {
		t.Fatalf("unexpected allowed emails: %#v", loaded.AllowedEmails)
	}
}

func TestAuthFlowIsSingleUse(t *testing.T) {
	service := New(config.Config{
		Version: "test",
		Host:    "127.0.0.1",
		Port:    0,
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})

	db, err := service.openDB(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	type payload struct {
		Value string `json:"value"`
	}
	flowID, err := service.createAuthFlow(context.Background(), db, flowTypeGitHub2FA, payload{Value: "once"}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}

	var first payload
	ok, err := service.consumeAuthFlow(context.Background(), db, flowTypeGitHub2FA, flowID, &first)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || first.Value != "once" {
		t.Fatalf("unexpected first consume result: ok=%v payload=%#v", ok, first)
	}

	var second payload
	ok, err = service.consumeAuthFlow(context.Background(), db, flowTypeGitHub2FA, flowID, &second)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatalf("expected second consume to fail, got payload=%#v", second)
	}
}

func performAuthRequest(service *Service, method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.RemoteAddr = "203.0.113.20:4567"
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	res := httptest.NewRecorder()
	service.ServeHTTP(res, req)
	return res
}

func mustDecodeAuth(t *testing.T, res *httptest.ResponseRecorder, target interface{}) {
	t.Helper()
	if err := json.Unmarshal(res.Body.Bytes(), target); err != nil {
		t.Fatalf("decode %q: %v", res.Body.String(), err)
	}
}

func findCookie(cookies []*http.Cookie, name string) *http.Cookie {
	for _, cookie := range cookies {
		if cookie.Name == name {
			return cookie
		}
	}
	return nil
}

func totpForTest(t *testing.T, secret string, now time.Time) string {
	t.Helper()
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(normalizeBase32Secret(secret))
	if err != nil {
		t.Fatal(err)
	}
	return hotp(key, uint64(now.Unix()/30))
}

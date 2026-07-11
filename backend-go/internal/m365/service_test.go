package m365

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/iwvw/api-monitor/backend-go/internal/config"
)

func TestM365LifecycleAndReports(t *testing.T) {
	t.Setenv("ENCRYPTION_KEY", "test-encryption-key")

	var reportHits int
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/oauth2/v2.0/token"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"access_token":"test-token"}`))
		case r.URL.Path == "/organization":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"value":[{"displayName":"Contoso","verifiedDomains":[{"name":"contoso.com","isDefault":true}]}]}`))
		case strings.HasSuffix(r.URL.Path, "/drive"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"drive-1","quota":{"total":1073741824,"used":536870912,"remaining":536870912}}`))
		case strings.HasPrefix(r.URL.Path, "/users") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"@odata.count":1,"value":[{"id":"user-1","displayName":"Alice","userPrincipalName":"alice@contoso.com","accountEnabled":true}]}`))
		case strings.HasPrefix(r.URL.Path, "/users") && r.Method == http.MethodPost:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"new-user","displayName":"New User"}`))
		case r.URL.Path == "/subscribedSkus":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"value":[{"skuId":"sku-1","skuPartNumber":"ENTERPRISEPACK","consumedUnits":2} ]}`))
		case strings.HasPrefix(r.URL.Path, "/groups") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"value":[{"id":"group-1","displayName":"Engineering","securityEnabled":true}]}`))
		case strings.Contains(r.URL.Path, "/members") && r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"value":[{"id":"user-1","displayName":"Alice","userPrincipalName":"alice@contoso.com"}]}`))
		case strings.Contains(r.URL.Path, "/assignLicense"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"updated-object"}`))
		case strings.HasPrefix(r.URL.Path, "/reports/getOffice365ActiveUserDetail"):
			w.Header().Set("Location", "http://"+r.Host+"/download/office")
			w.WriteHeader(http.StatusFound)
		case r.URL.Path == "/download/office":
			reportHits++
			w.Header().Set("Content-Type", "text/csv")
			_, _ = w.Write([]byte("Report Refresh Date,User Principal Name,Last Activity Date\n2026-07-11,alice@contoso.com,2026-07-10\n"))
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.String())
		}
	}))
	defer mock.Close()

	t.Setenv("M365_GRAPH_BASE_URL", mock.URL)
	t.Setenv("M365_LOGIN_BASE_URL", mock.URL)

	service := New(config.Config{
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})

	createRes := performM365(service, http.MethodPost, "/api/m365/accounts", `{"name":"Contoso","tenantId":"tenant-1","clientId":"client-1","clientSecret":"secret-1"}`)
	if createRes.Code != http.StatusOK {
		t.Fatalf("create account status=%d body=%s", createRes.Code, createRes.Body.String())
	}

	listRes := performM365(service, http.MethodGet, "/api/m365/accounts", "")
	if listRes.Code != http.StatusOK || !strings.Contains(listRes.Body.String(), `"name":"Contoso"`) {
		t.Fatalf("list account status=%d body=%s", listRes.Code, listRes.Body.String())
	}

	verifyRes := performM365(service, http.MethodPost, "/api/m365/accounts/1/verify", "")
	if verifyRes.Code != http.StatusOK || !strings.Contains(verifyRes.Body.String(), `"displayName":"Contoso"`) {
		t.Fatalf("verify status=%d body=%s", verifyRes.Code, verifyRes.Body.String())
	}

	usersRes := performM365(service, http.MethodGet, "/api/m365/accounts/1/users?top=10", "")
	if usersRes.Code != http.StatusOK || !strings.Contains(usersRes.Body.String(), `"Alice"`) {
		t.Fatalf("users status=%d body=%s", usersRes.Code, usersRes.Body.String())
	}

	createUserRes := performM365(service, http.MethodPost, "/api/m365/accounts/1/users", `{"displayName":"New User","mailNickname":"newuser","userPrincipalName":"newuser@contoso.com","password":"TempPassw0rd!"}`)
	if createUserRes.Code != http.StatusOK || !strings.Contains(createUserRes.Body.String(), `"new-user"`) {
		t.Fatalf("create user status=%d body=%s", createUserRes.Code, createUserRes.Body.String())
	}

	skuRes := performM365(service, http.MethodGet, "/api/m365/accounts/1/licenses/skus", "")
	if skuRes.Code != http.StatusOK || !strings.Contains(skuRes.Body.String(), `"ENTERPRISEPACK"`) {
		t.Fatalf("sku status=%d body=%s", skuRes.Code, skuRes.Body.String())
	}

	groupRes := performM365(service, http.MethodGet, "/api/m365/accounts/1/groups", "")
	if groupRes.Code != http.StatusOK || !strings.Contains(groupRes.Body.String(), `"Engineering"`) {
		t.Fatalf("groups status=%d body=%s", groupRes.Code, groupRes.Body.String())
	}

	reportRes := performM365(service, http.MethodGet, "/api/m365/accounts/1/reports/office-activity", "")
	if reportRes.Code != http.StatusOK || !strings.Contains(reportRes.Body.String(), `"alice@contoso.com"`) {
		t.Fatalf("report status=%d body=%s", reportRes.Code, reportRes.Body.String())
	}

	reportResCached := performM365(service, http.MethodGet, "/api/m365/accounts/1/reports/office-activity", "")
	if reportResCached.Code != http.StatusOK {
		t.Fatalf("report cached status=%d body=%s", reportResCached.Code, reportResCached.Body.String())
	}
	if reportHits != 1 {
		t.Fatalf("expected cached report after one download, got report hits=%d", reportHits)
	}

	quotaRes := performM365(service, http.MethodGet, "/api/m365/accounts/1/reports/onedrive/users/user-1/quota", "")
	if quotaRes.Code != http.StatusOK || !strings.Contains(quotaRes.Body.String(), `"usagePct":50`) {
		t.Fatalf("quota status=%d body=%s", quotaRes.Code, quotaRes.Body.String())
	}
}

func TestAccountSecretStoredEncrypted(t *testing.T) {
	t.Setenv("ENCRYPTION_KEY", "test-encryption-key")
	service := New(config.Config{
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})

	res := performM365(service, http.MethodPost, "/api/m365/accounts", `{"name":"Contoso","tenantId":"tenant-1","clientId":"client-1","clientSecret":"secret-1"}`)
	if res.Code != http.StatusOK {
		t.Fatalf("create account status=%d body=%s", res.Code, res.Body.String())
	}

	db, err := service.open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	var secret string
	if err := db.QueryRowContext(context.Background(), `SELECT client_secret FROM m365_accounts WHERE id = 1`).Scan(&secret); err != nil {
		t.Fatal(err)
	}
	if secret == "secret-1" {
		t.Fatalf("expected encrypted secret, got plaintext")
	}
}

func performM365(service *Service, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	service.ServeHTTP(rec, req)
	return rec
}

func TestMain(m *testing.M) {
	os.Exit(m.Run())
}

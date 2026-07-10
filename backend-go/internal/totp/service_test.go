package totp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/iwvw/api-monitor/backend-go/internal/config"
)

func TestTOTPAccountGroupCodeImportAndExportFlow(t *testing.T) {
	service := New(config.Config{
		Version: "test",
		Host:    "127.0.0.1",
		Port:    0,
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})
	secret := "JBSWY3DPEHPK3PXP"

	groupsRes := performTOTPRequest(service, http.MethodGet, "/api/totp/groups", "")
	if groupsRes.Code != http.StatusOK {
		t.Fatalf("groups status = %d body=%s", groupsRes.Code, groupsRes.Body.String())
	}

	createGroupRes := performTOTPRequest(service, http.MethodPost, "/api/totp/groups", `{"name":"Work","color":"#4285f4"}`)
	if createGroupRes.Code != http.StatusOK {
		t.Fatalf("create group status = %d body=%s", createGroupRes.Code, createGroupRes.Body.String())
	}
	var groupPayload struct {
		Success bool  `json:"success"`
		Data    Group `json:"data"`
	}
	mustDecodeTOTP(t, createGroupRes, &groupPayload)
	if !groupPayload.Success || groupPayload.Data.ID == "" || groupPayload.Data.Name != "Work" {
		t.Fatalf("unexpected group payload: %#v", groupPayload)
	}

	createAccountRes := performTOTPRequest(service, http.MethodPost, "/api/totp/accounts", `{
		"issuer":"GitHub",
		"account":"user@example.com",
		"secret":"`+secret+`",
		"group_id":"`+groupPayload.Data.ID+`"
	}`)
	if createAccountRes.Code != http.StatusOK {
		t.Fatalf("create account status = %d body=%s", createAccountRes.Code, createAccountRes.Body.String())
	}
	var accountPayload struct {
		Success bool    `json:"success"`
		Data    Account `json:"data"`
	}
	mustDecodeTOTP(t, createAccountRes, &accountPayload)
	if !accountPayload.Success || accountPayload.Data.ID == "" || accountPayload.Data.Secret != "" || !accountPayload.Data.HasSecret {
		t.Fatalf("unexpected account payload: %#v", accountPayload)
	}
	if accountPayload.Data.GroupID == nil || *accountPayload.Data.GroupID != groupPayload.Data.ID {
		t.Fatalf("account group_id = %#v, want %q", accountPayload.Data.GroupID, groupPayload.Data.ID)
	}

	code, err := totpCode(secret, time.Now(), 6, 30, "SHA1")
	if err != nil {
		t.Fatal(err)
	}
	verifyRes := performTOTPRequest(service, http.MethodPost, "/api/totp/verify", `{"id":"`+accountPayload.Data.ID+`","token":"`+code+`"}`)
	if verifyRes.Code != http.StatusOK {
		t.Fatalf("verify status = %d body=%s", verifyRes.Code, verifyRes.Body.String())
	}
	var verifyPayload struct {
		Success bool `json:"success"`
		Valid   bool `json:"valid"`
	}
	mustDecodeTOTP(t, verifyRes, &verifyPayload)
	if !verifyPayload.Success || !verifyPayload.Valid {
		t.Fatalf("unexpected verify payload: %#v", verifyPayload)
	}

	codesRes := performTOTPRequest(service, http.MethodGet, "/api/totp/codes", "")
	if codesRes.Code != http.StatusOK {
		t.Fatalf("codes status = %d body=%s", codesRes.Code, codesRes.Body.String())
	}
	var codesPayload struct {
		Success bool                              `json:"success"`
		Data    map[string]map[string]interface{} `json:"data"`
	}
	mustDecodeTOTP(t, codesRes, &codesPayload)
	if !codesPayload.Success || codesPayload.Data[accountPayload.Data.ID]["code"] == "" {
		t.Fatalf("unexpected codes payload: %#v", codesPayload)
	}

	revealRes := performTOTPRequest(service, http.MethodGet, "/api/totp/accounts/"+accountPayload.Data.ID+"?showSecret=true", "")
	if revealRes.Code != http.StatusOK {
		t.Fatalf("reveal status = %d body=%s", revealRes.Code, revealRes.Body.String())
	}
	mustDecodeTOTP(t, revealRes, &accountPayload)
	if accountPayload.Data.Secret != secret || accountPayload.Data.LastRevealedAt == nil {
		t.Fatalf("unexpected revealed account: %#v", accountPayload.Data)
	}

	hotpRes := performTOTPRequest(service, http.MethodPost, "/api/totp/accounts", `{
		"otp_type":"hotp",
		"issuer":"Yubi",
		"account":"token",
		"secret":"`+secret+`",
		"counter":0
	}`)
	if hotpRes.Code != http.StatusOK {
		t.Fatalf("create hotp status = %d body=%s", hotpRes.Code, hotpRes.Body.String())
	}
	var hotpPayload struct {
		Success bool    `json:"success"`
		Data    Account `json:"data"`
	}
	mustDecodeTOTP(t, hotpRes, &hotpPayload)
	incrementRes := performTOTPRequest(service, http.MethodPost, "/api/totp/accounts/"+hotpPayload.Data.ID+"/increment", "")
	if incrementRes.Code != http.StatusOK {
		t.Fatalf("increment status = %d body=%s", incrementRes.Code, incrementRes.Body.String())
	}
	var incrementPayload struct {
		Success bool `json:"success"`
		Data    struct {
			Code    string `json:"code"`
			Counter int64  `json:"counter"`
		} `json:"data"`
	}
	mustDecodeTOTP(t, incrementRes, &incrementPayload)
	if !incrementPayload.Success || incrementPayload.Data.Code == "" || incrementPayload.Data.Counter != 1 {
		t.Fatalf("unexpected increment payload: %#v", incrementPayload)
	}

	exportRes := performTOTPRequest(service, http.MethodGet, "/api/totp/export", "")
	if exportRes.Code != http.StatusOK {
		t.Fatalf("export status = %d body=%s", exportRes.Code, exportRes.Body.String())
	}
	var exportPayload struct {
		Success bool   `json:"success"`
		Format  string `json:"format"`
		Data    struct {
			AccountCount int    `json:"accountCount"`
			GroupCount   int    `json:"groupCount"`
			Payload      string `json:"payload"`
		} `json:"data"`
	}
	mustDecodeTOTP(t, exportRes, &exportPayload)
	if !exportPayload.Success || exportPayload.Format != "encrypted-backup" || exportPayload.Data.AccountCount != 2 || exportPayload.Data.GroupCount != 1 || exportPayload.Data.Payload == "" {
		t.Fatalf("unexpected export payload: %#v", exportPayload)
	}

	importURI := "otpauth://totp/Example:new@example.com?secret=" + secret + "&issuer=Example"
	previewRes := performTOTPRequest(service, http.MethodPost, "/api/totp/import/preview", `{"uris":["`+importURI+`"]}`)
	if previewRes.Code != http.StatusOK {
		t.Fatalf("preview status = %d body=%s", previewRes.Code, previewRes.Body.String())
	}
	var previewPayload struct {
		Success bool `json:"success"`
		Data    struct {
			Total int `json:"total"`
			Valid int `json:"valid"`
		} `json:"data"`
	}
	mustDecodeTOTP(t, previewRes, &previewPayload)
	if !previewPayload.Success || previewPayload.Data.Total != 1 || previewPayload.Data.Valid != 1 {
		t.Fatalf("unexpected preview payload: %#v", previewPayload)
	}

	importRes := performTOTPRequest(service, http.MethodPost, "/api/totp/import", `{"uris":["`+importURI+`"]}`)
	if importRes.Code != http.StatusOK {
		t.Fatalf("import status = %d body=%s", importRes.Code, importRes.Body.String())
	}
	var importPayload struct {
		Success bool `json:"success"`
		Data    struct {
			Success int `json:"success"`
			Failed  int `json:"failed"`
		} `json:"data"`
	}
	mustDecodeTOTP(t, importRes, &importPayload)
	if !importPayload.Success || importPayload.Data.Success != 1 || importPayload.Data.Failed != 0 {
		t.Fatalf("unexpected import payload: %#v", importPayload)
	}
}

func TestTOTPBrandFieldsSyncAcrossSameIssuer(t *testing.T) {
	service := New(config.Config{
		Version: "test",
		Host:    "127.0.0.1",
		Port:    0,
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})
	secret := "JBSWY3DPEHPK3PXP"
	first := createTOTPAccountForTest(t, service, `{"issuer":"Microsoft","account":"one@example.com","secret":"`+secret+`"}`)
	second := createTOTPAccountForTest(t, service, `{"issuer":"microsoft","account":"two@example.com","secret":"`+secret+`"}`)

	updateRes := performTOTPRequest(service, http.MethodPut, "/api/totp/accounts/"+first.ID, `{"icon":"svgrepo:448239-microsoft","color":"#3aa7e0"}`)
	if updateRes.Code != http.StatusOK {
		t.Fatalf("update status = %d body=%s", updateRes.Code, updateRes.Body.String())
	}

	accounts := listTOTPAccountsForTest(t, service)
	for _, account := range []Account{
		findTOTPAccountForTest(t, accounts, first.ID),
		findTOTPAccountForTest(t, accounts, second.ID),
	} {
		if account.Icon == nil || *account.Icon != "svgrepo:448239-microsoft" {
			t.Fatalf("account %s icon = %#v, want synced svg repo icon", account.ID, account.Icon)
		}
		if account.Color == nil || *account.Color != "#3aa7e0" {
			t.Fatalf("account %s color = %#v, want synced color", account.ID, account.Color)
		}
	}

	third := createTOTPAccountForTest(t, service, `{"issuer":"Microsoft","account":"three@example.com","secret":"`+secret+`"}`)
	if third.Icon == nil || *third.Icon != "svgrepo:448239-microsoft" {
		t.Fatalf("new same-issuer account icon = %#v, want inherited icon", third.Icon)
	}
	if third.Color == nil || *third.Color != "#3aa7e0" {
		t.Fatalf("new same-issuer account color = %#v, want inherited color", third.Color)
	}
}

func TestParseSVGRepoIconRef(t *testing.T) {
	cases := []struct {
		name  string
		input string
		key   string
		url   string
	}{
		{
			name:  "shorthand",
			input: "svgrepo:448239-microsoft",
			key:   "448239-microsoft",
			url:   "https://www.svgrepo.com/show/448239/microsoft.svg",
		},
		{
			name:  "svg page url",
			input: "https://www.svgrepo.com/svg/448239/microsoft",
			key:   "448239-microsoft",
			url:   "https://www.svgrepo.com/show/448239/microsoft.svg",
		},
		{
			name:  "download svg url",
			input: "https://www.svgrepo.com/download/452062/microsoft.svg",
			key:   "452062-microsoft",
			url:   "https://www.svgrepo.com/show/452062/microsoft.svg",
		},
		{
			name:  "show svg url",
			input: "https://www.svgrepo.com/show/331528/parsec.svg",
			key:   "331528-parsec",
			url:   "https://www.svgrepo.com/show/331528/parsec.svg",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			entry, ok := parseSVGRepoIconRef(tc.input)
			if !ok {
				t.Fatalf("parseSVGRepoIconRef(%q) did not match", tc.input)
			}
			if entry.Key != tc.key || entry.URL != tc.url || entry.Source != "svgrepo" {
				t.Fatalf("entry = %#v, want key=%q url=%q source=svgrepo", entry, tc.key, tc.url)
			}
		})
	}
}

func TestMatchSVGRepoBrandIconAlias(t *testing.T) {
	entry, ok := matchSVGRepoBrandIcon("Microsoft", "user@example.com", "")
	if !ok {
		t.Fatal("matchSVGRepoBrandIcon did not match Microsoft alias")
	}
	if entry.Key != "microsoft" || entry.URL == "" {
		t.Fatalf("entry = %#v, want microsoft alias", entry)
	}
}

func TestSVGRepoBrandIconOptionsAreCurated(t *testing.T) {
	parsec, ok := matchSVGRepoBrandIcon("Parsec", "", "")
	if !ok {
		t.Fatal("matchSVGRepoBrandIcon did not match Parsec")
	}
	parsecOptions := svgRepoBrandIconOptions(parsec)
	if len(parsecOptions) != 3 {
		t.Fatalf("parsec options len = %d, want 3", len(parsecOptions))
	}
	wantParsecKeys := []string{"518470-parsec", "504721-parsec", "331528-parsec"}
	for i, key := range wantParsecKeys {
		if parsecOptions[i].Key != key {
			t.Fatalf("parsecOptions[%d].Key = %q, want %q", i, parsecOptions[i].Key, key)
		}
	}

	microsoft, ok := matchSVGRepoBrandIcon("Microsoft", "", "")
	if !ok {
		t.Fatal("matchSVGRepoBrandIcon did not match Microsoft")
	}
	microsoftOptions := svgRepoBrandIconOptions(microsoft)
	if len(microsoftOptions) != 1 || microsoftOptions[0].Key != "microsoft" {
		t.Fatalf("microsoft options = %#v, want only the issuer brand icon", microsoftOptions)
	}
}

func createTOTPAccountForTest(t *testing.T, service *Service, body string) Account {
	t.Helper()
	res := performTOTPRequest(service, http.MethodPost, "/api/totp/accounts", body)
	if res.Code != http.StatusOK {
		t.Fatalf("create account status = %d body=%s", res.Code, res.Body.String())
	}
	var payload struct {
		Success bool    `json:"success"`
		Data    Account `json:"data"`
	}
	mustDecodeTOTP(t, res, &payload)
	if !payload.Success {
		t.Fatalf("create account payload = %#v", payload)
	}
	return payload.Data
}

func listTOTPAccountsForTest(t *testing.T, service *Service) []Account {
	t.Helper()
	res := performTOTPRequest(service, http.MethodGet, "/api/totp/accounts", "")
	if res.Code != http.StatusOK {
		t.Fatalf("list accounts status = %d body=%s", res.Code, res.Body.String())
	}
	var payload struct {
		Success bool      `json:"success"`
		Data    []Account `json:"data"`
	}
	mustDecodeTOTP(t, res, &payload)
	if !payload.Success {
		t.Fatalf("list accounts payload = %#v", payload)
	}
	return payload.Data
}

func findTOTPAccountForTest(t *testing.T, accounts []Account, id string) Account {
	t.Helper()
	for _, account := range accounts {
		if account.ID == id {
			return account
		}
	}
	t.Fatalf("account %q not found in %#v", id, accounts)
	return Account{}
}

func performTOTPRequest(service *Service, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	res := httptest.NewRecorder()
	service.ServeHTTP(res, req)
	return res
}

func mustDecodeTOTP(t *testing.T, res *httptest.ResponseRecorder, target interface{}) {
	t.Helper()
	if err := json.Unmarshal(res.Body.Bytes(), target); err != nil {
		t.Fatalf("decode %q: %v", res.Body.String(), err)
	}
}

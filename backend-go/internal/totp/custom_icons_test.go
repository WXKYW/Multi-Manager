package totp

import (
	"context"
	"net"
	"net/http"
	"strings"
	"testing"

	"github.com/iwvw/api-monitor/backend-go/internal/config"
)

func TestImportCustomBrandIconFromURLStoresDownloadedAsset(t *testing.T) {
	service := New(config.Config{
		Version: "test",
		Host:    "127.0.0.1",
		Port:    0,
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})
	service.remoteBrandIconFetcher = func(ctx context.Context, rawURL string) (remoteBrandIconAsset, error) {
		if rawURL != "https://cdn.example/icon.svg" {
			t.Fatalf("fetch URL = %q", rawURL)
		}
		return remoteBrandIconAsset{
			Data:        []byte(`<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1"/></svg>`),
			FileName:    "icon.svg",
			ContentType: "image/svg+xml",
		}, nil
	}

	res := performTOTPRequest(service, http.MethodPost, "/api/totp/icons/library/import-url", `{
		"url":"https://cdn.example/icon.svg",
		"name":"Example",
		"issuer":"Example",
		"color":"#123456"
	}`)
	if res.Code != http.StatusOK {
		t.Fatalf("import URL status = %d body=%s", res.Code, res.Body.String())
	}
	var payload struct {
		Success bool `json:"success"`
		Data    struct {
			ID     string `json:"id"`
			Icon   string `json:"icon"`
			Issuer string `json:"issuer"`
		} `json:"data"`
	}
	mustDecodeTOTP(t, res, &payload)
	if !payload.Success || payload.Data.ID == "" || payload.Data.Icon != "custom:"+payload.Data.ID || payload.Data.Issuer != "Example" {
		t.Fatalf("unexpected import payload: %#v", payload)
	}

	serveRes := performTOTPRequest(service, http.MethodGet, "/api/totp/icons/custom-"+payload.Data.ID, "")
	if serveRes.Code != http.StatusOK || !strings.Contains(serveRes.Body.String(), "<path") {
		t.Fatalf("stored icon status = %d body=%s", serveRes.Code, serveRes.Body.String())
	}

	createRes := performTOTPRequest(service, http.MethodPost, "/api/totp/accounts", `{
		"issuer":"Example",
		"account":"user@example.com",
		"secret":"JBSWY3DPEHPK3PXP",
		"icon":"custom:`+payload.Data.ID+`"
	}`)
	if createRes.Code != http.StatusOK {
		t.Fatalf("create account status = %d body=%s", createRes.Code, createRes.Body.String())
	}

	deleteRes := performTOTPRequest(service, http.MethodDelete, "/api/totp/icons/library/"+payload.Data.ID, "")
	if deleteRes.Code != http.StatusOK {
		t.Fatalf("delete icon status = %d body=%s", deleteRes.Code, deleteRes.Body.String())
	}
	serveRes = performTOTPRequest(service, http.MethodGet, "/api/totp/icons/custom-"+payload.Data.ID, "")
	if serveRes.Code != http.StatusNotFound {
		t.Fatalf("deleted icon status = %d body=%s", serveRes.Code, serveRes.Body.String())
	}
	accounts := listTOTPAccountsForTest(t, service)
	if len(accounts) != 1 || (accounts[0].Icon != nil && *accounts[0].Icon != "") {
		t.Fatalf("account icon after delete = %#v", accounts)
	}
}

func TestValidateRemoteBrandIconURLRejectsUnsafeTargets(t *testing.T) {
	for _, rawURL := range []string{
		"file:///tmp/icon.svg",
		"http://127.0.0.1/icon.svg",
		"http://10.0.0.1/icon.svg",
		"http://169.254.169.254/latest/meta-data/",
		"http://198.18.0.1/icon.svg",
		"http://[::1]/icon.svg",
		"https://user:password@example.com/icon.svg",
	} {
		t.Run(rawURL, func(t *testing.T) {
			if err := validateRemoteBrandIconURL(rawURL); err == nil {
				t.Fatalf("validateRemoteBrandIconURL(%q) succeeded", rawURL)
			}
		})
	}
	if err := validateRemoteBrandIconURL("https://cdn.example.com/icon.svg"); err != nil {
		t.Fatalf("public image URL rejected: %v", err)
	}
}

func TestFilterPublicRemoteBrandIconAddressesKeepsUsableDNSResults(t *testing.T) {
	addresses := []net.IPAddr{
		{IP: net.ParseIP("fdfe:dcba:9876::2")},
		{IP: net.ParseIP("198.18.1.23")},
		{IP: net.ParseIP("104.26.7.231")},
		{IP: net.ParseIP("2606:4700:20::681a:6e7")},
	}
	publicAddresses := filterPublicRemoteBrandIconAddresses(addresses)
	if len(publicAddresses) != 3 {
		t.Fatalf("public addresses = %#v, want proxy synthetic and public addresses", publicAddresses)
	}
	if got := publicAddresses[0].IP.String(); got != "198.18.1.23" {
		t.Fatalf("first public address = %q", got)
	}
}

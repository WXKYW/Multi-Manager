package oracle

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/iwvw/api-monitor/backend-go/internal/config"
	"github.com/iwvw/api-monitor/backend-go/internal/secure"
	"github.com/oracle/oci-go-sdk/v65/core"
)

func TestAccountLifecycleEncryptsPrivateKey(t *testing.T) {
	service := testService(t)
	body := `{
		"name":"prod",
		"tenancyOcid":"ocid1.tenancy.oc1..exampleuniqueid",
		"userOcid":"ocid1.user.oc1..exampleuniqueid",
		"fingerprint":"aa:bb:cc",
		"region":"ap-tokyo-1",
		"privateKeyPem":"-----BEGIN PRIVATE KEY-----\nsmoke\n-----END PRIVATE KEY-----",
		"passphrase":"secret",
		"defaultCompartmentId":"ocid1.compartment.oc1..exampleuniqueid",
		"description":"primary"
	}`
	res := perform(service, http.MethodPost, "/api/oracle/accounts", body)
	if res.Code != http.StatusOK {
		t.Fatalf("create account status=%d body=%s", res.Code, res.Body.String())
	}
	var createPayload map[string]interface{}
	mustDecode(t, res, &createPayload)
	if createPayload["success"] != true {
		t.Fatalf("unexpected create payload: %#v", createPayload)
	}

	db, err := service.open(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var privateKeyEncrypted string
	var passphraseEncrypted sql.NullString
	if err := db.QueryRowContext(t.Context(), `SELECT private_key_encrypted, passphrase_encrypted FROM oracle_accounts WHERE name = ?`, "prod").Scan(&privateKeyEncrypted, &passphraseEncrypted); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(privateKeyEncrypted, "BEGIN PRIVATE KEY") || !secure.IsEncrypted(privateKeyEncrypted) {
		t.Fatalf("private key was not encrypted: %q", privateKeyEncrypted)
	}
	if !passphraseEncrypted.Valid || passphraseEncrypted.String == "secret" || !secure.IsEncrypted(passphraseEncrypted.String) {
		t.Fatalf("passphrase was not encrypted: %#v", passphraseEncrypted)
	}

	res = perform(service, http.MethodGet, "/api/oracle/accounts", "")
	if res.Code != http.StatusOK {
		t.Fatalf("list accounts status=%d body=%s", res.Code, res.Body.String())
	}
	var listPayload struct {
		Success bool                     `json:"success"`
		Data    []map[string]interface{} `json:"data"`
	}
	mustDecode(t, res, &listPayload)
	if !listPayload.Success || len(listPayload.Data) != 1 {
		t.Fatalf("unexpected list payload: %#v", listPayload)
	}
	if _, ok := listPayload.Data[0]["privateKeyPem"]; ok {
		t.Fatalf("private key leaked in list payload: %#v", listPayload.Data[0])
	}
	if listPayload.Data[0]["hasPrivateKey"] != true || listPayload.Data[0]["hasPassphrase"] != true {
		t.Fatalf("missing credential flags: %#v", listPayload.Data[0])
	}

	id := int64(listPayload.Data[0]["id"].(float64))
	res = perform(service, http.MethodPut, "/api/oracle/accounts/"+strconvFormat(id), `{"name":"prod2","region":"ap-singapore-1","description":"updated"}`)
	if res.Code != http.StatusOK {
		t.Fatalf("update account status=%d body=%s", res.Code, res.Body.String())
	}
	var updated Account
	updated, err = getAccount(t.Context(), db, id)
	if err != nil {
		t.Fatal(err)
	}
	if updated.TenancyOCID != "ocid1.tenancy.oc1..exampleuniqueid" || updated.UserOCID != "ocid1.user.oc1..exampleuniqueid" {
		t.Fatalf("blank edit fields should preserve OCIDs: %#v", updated)
	}

	res = perform(service, http.MethodDelete, "/api/oracle/accounts/"+strconvFormat(id), "")
	if res.Code != http.StatusOK {
		t.Fatalf("delete account status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestAccountExportImportRoundTrip(t *testing.T) {
	service := testService(t)

	createRes := perform(service, http.MethodPost, "/api/oracle/accounts", `{
		"name":"backup-source",
		"tenancyOcid":"ocid1.tenancy.oc1..backupsource",
		"userOcid":"ocid1.user.oc1..backupsource",
		"fingerprint":"11:22:33",
		"region":"us-sanjose-1",
		"privateKeyPem":"-----BEGIN PRIVATE KEY-----\nbackup\n-----END PRIVATE KEY-----",
		"passphrase":"backup-secret",
		"defaultCompartmentId":"ocid1.compartment.oc1..backupsource",
		"description":"export me"
	}`)
	if createRes.Code != http.StatusOK {
		t.Fatalf("create export source status=%d body=%s", createRes.Code, createRes.Body.String())
	}

	exportRes := perform(service, http.MethodGet, "/api/oracle/export/accounts", "")
	if exportRes.Code != http.StatusOK {
		t.Fatalf("export accounts status=%d body=%s", exportRes.Code, exportRes.Body.String())
	}
	var exportPayload struct {
		Success bool                     `json:"success"`
		Data    map[string][]interface{} `json:"data"`
	}
	mustDecode(t, exportRes, &exportPayload)
	if !exportPayload.Success || len(exportPayload.Data["accounts"]) != 1 {
		t.Fatalf("unexpected export payload: %#v", exportPayload)
	}
	exported := exportPayload.Data["accounts"][0].(map[string]interface{})
	if exported["tenancyOcid"] != "ocid1.tenancy.oc1..backupsource" || exported["privateKeyPem"] == nil {
		t.Fatalf("unexpected exported account: %#v", exported)
	}

	importRes := perform(service, http.MethodPost, "/api/oracle/import/accounts", `{
		"overwrite": true,
		"accounts": [{
			"name":"restored",
			"tenancyOcid":"ocid1.tenancy.oc1..restored",
			"userOcid":"ocid1.user.oc1..restored",
			"fingerprint":"44:55:66",
			"region":"ap-singapore-1",
			"privateKeyPem":"-----BEGIN PRIVATE KEY-----\nrestored\n-----END PRIVATE KEY-----",
			"passphrase":"restored-secret",
			"defaultCompartmentId":"ocid1.compartment.oc1..restored",
			"description":"restored account"
		}]
	}`)
	if importRes.Code != http.StatusOK {
		t.Fatalf("import accounts status=%d body=%s", importRes.Code, importRes.Body.String())
	}

	listRes := perform(service, http.MethodGet, "/api/oracle/accounts", "")
	if listRes.Code != http.StatusOK {
		t.Fatalf("list after import status=%d body=%s", listRes.Code, listRes.Body.String())
	}
	var listPayload struct {
		Success bool                     `json:"success"`
		Data    []map[string]interface{} `json:"data"`
	}
	mustDecode(t, listRes, &listPayload)
	if !listPayload.Success || len(listPayload.Data) != 1 {
		t.Fatalf("unexpected list payload after import: %#v", listPayload)
	}
	if listPayload.Data[0]["name"] != "restored" {
		t.Fatalf("unexpected imported account name: %#v", listPayload.Data[0])
	}

	db, err := service.open(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	imported, err := getAccount(t.Context(), db, int64(listPayload.Data[0]["id"].(float64)))
	if err != nil {
		t.Fatal(err)
	}
	if secure.SecureDecrypt(imported.PrivateKeyEncrypted) != "-----BEGIN PRIVATE KEY-----\nrestored\n-----END PRIVATE KEY-----" {
		t.Fatalf("unexpected imported private key: %#v", imported)
	}
	if secure.SecureDecrypt(imported.PassphraseEncrypted) != "restored-secret" {
		t.Fatalf("unexpected imported passphrase: %#v", imported)
	}
}

func TestBuildUpdateInstanceDetails(t *testing.T) {
	details, err := buildUpdateInstanceDetails(updateInstancePayload{
		Shape:         "VM.Standard.A1.Flex",
		OCPUCount:     float64Ptr(2),
		MemoryGB:      float64Ptr(12),
		AvoidDowntime: boolPtr(true),
	})
	if err != nil {
		t.Fatalf("build update details: %v", err)
	}
	if details.Shape == nil || *details.Shape != "VM.Standard.A1.Flex" {
		t.Fatalf("unexpected shape: %#v", details.Shape)
	}
	if details.ShapeConfig == nil || details.ShapeConfig.Ocpus == nil || *details.ShapeConfig.Ocpus != 2 {
		t.Fatalf("unexpected ocpus: %#v", details.ShapeConfig)
	}
	if details.ShapeConfig.MemoryInGBs == nil || *details.ShapeConfig.MemoryInGBs != 12 {
		t.Fatalf("unexpected memory: %#v", details.ShapeConfig)
	}
	if details.UpdateOperationConstraint != core.UpdateInstanceDetailsUpdateOperationConstraintAvoidDowntime {
		t.Fatalf("unexpected update constraint: %s", details.UpdateOperationConstraint)
	}
}

func TestBuildUpdateInstanceDetailsRequiresAnyChange(t *testing.T) {
	if _, err := buildUpdateInstanceDetails(updateInstancePayload{}); err == nil {
		t.Fatal("expected empty payload to be rejected")
	}
}

func TestNormalizeShape(t *testing.T) {
	item := normalizeShape(core.Shape{
		Shape:                     stringPtr("VM.Standard.A1.Flex"),
		Ocpus:                     float32Ptr(1),
		MemoryInGBs:               float32Ptr(6),
		IsFlexible:                boolPtr(true),
		BaselineOcpuUtilizations:  []core.ShapeBaselineOcpuUtilizationsEnum{core.ShapeBaselineOcpuUtilizations8},
		ResizeCompatibleShapes:    []string{"VM.Standard.A2.Flex"},
		NetworkingBandwidthInGbps: float32Ptr(1),
		OcpuOptions:               &core.ShapeOcpuOptions{Min: float32Ptr(1), Max: float32Ptr(4)},
		MemoryOptions: &core.ShapeMemoryOptions{
			MinInGBs:            float32Ptr(6),
			MaxInGBs:            float32Ptr(24),
			DefaultPerOcpuInGBs: float32Ptr(6),
		},
	})
	if item.Name != "VM.Standard.A1.Flex" {
		t.Fatalf("unexpected shape name: %#v", item)
	}
	if !item.IsFlexible || item.OCPUOptions.Max != 4 || item.MemoryOptions.Max != 24 {
		t.Fatalf("unexpected normalized shape: %#v", item)
	}
	if len(item.ResizeCompatibleShapes) != 1 || item.ResizeCompatibleShapes[0] != "VM.Standard.A2.Flex" {
		t.Fatalf("unexpected compatible shapes: %#v", item.ResizeCompatibleShapes)
	}
	if len(item.BaselineOcpuUtilizations) != 1 || item.BaselineOcpuUtilizations[0] != "BASELINE_1_8" {
		t.Fatalf("unexpected baseline options: %#v", item.BaselineOcpuUtilizations)
	}
}

func testService(t *testing.T) *Service {
	t.Helper()
	return New(config.Config{
		Version: "test",
		Host:    "127.0.0.1",
		Port:    0,
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})
}

func perform(service *Service, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	res := httptest.NewRecorder()
	service.ServeHTTP(res, req)
	return res
}

func mustDecode(t *testing.T, res *httptest.ResponseRecorder, target interface{}) {
	t.Helper()
	if err := json.NewDecoder(res.Body).Decode(target); err != nil {
		t.Fatalf("decode response: %v body=%s", err, res.Body.String())
	}
}

func strconvFormat(id int64) string {
	return strconv.FormatInt(id, 10)
}

func boolPtr(value bool) *bool {
	return &value
}

func float64Ptr(value float64) *float64 {
	return &value
}

func float32Ptr(value float32) *float32 {
	return &value
}

func stringPtr(value string) *string {
	return &value
}

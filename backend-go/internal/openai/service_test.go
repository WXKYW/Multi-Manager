package openai

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/iwvw/api-monitor/backend-go/internal/config"
	_ "modernc.org/sqlite"
)

func TestOpenAINormalization(t *testing.T) {
	s := New(config.Config{
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})

	testCases := []struct {
		input    string
		expected string
	}{
		{"api.openai.com", "https://api.openai.com/v1"},
		{"http://api.openai.com/v1/chat/completions", "http://api.openai.com/v1"},
		{"https://api.openai.com/v1/models/", "https://api.openai.com/v1"},
		{"http://my-proxy.com", "http://my-proxy.com/v1"},
		{"https://my-proxy.com/v2/", "https://my-proxy.com/v2"},
	}

	for _, tc := range testCases {
		res := s.normalizeBaseURL(tc.input)
		if res != tc.expected {
			t.Errorf("normalizeBaseURL(%q) = %q; want %q", tc.input, res, tc.expected)
		}
	}
}

func TestEnsureSchemaMigratesGatewayAnalyticsKeyColumn(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	_, err = db.Exec(`CREATE TABLE openai_gateway_analytics (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		endpoint_id TEXT,
		model TEXT NOT NULL,
		status_code INTEGER NOT NULL,
		latency_ms INTEGER NOT NULL,
		prompt_tokens INTEGER DEFAULT 0,
		completion_tokens INTEGER DEFAULT 0,
		total_tokens INTEGER DEFAULT 0,
		timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
	)`)
	if err != nil {
		t.Fatal(err)
	}

	if err := ensureSchema(context.Background(), db); err != nil {
		t.Fatalf("ensureSchema failed: %v", err)
	}

	rows, err := db.Query("PRAGMA table_info(openai_gateway_analytics)")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()

	foundGatewayKeyID := false
	foundRoute := false
	for rows.Next() {
		var cid int
		var name, columnType string
		var notNull, primaryKey int
		var defaultValue interface{}
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			t.Fatal(err)
		}
		if name == "gateway_key_id" {
			foundGatewayKeyID = true
		}
		if name == "route" {
			foundRoute = true
		}
	}
	if !foundGatewayKeyID {
		t.Fatal("gateway_key_id column was not added")
	}
	if !foundRoute {
		t.Fatal("route column was not added")
	}
}

func TestAnalyticsLogsRespectDaysFilter(t *testing.T) {
	service := New(config.Config{
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})
	db, err := service.open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`
		INSERT INTO openai_gateway_analytics (endpoint_id, model, status_code, latency_ms, timestamp)
		VALUES
			('recent', 'recent-model', 200, 10, ?),
			('old', 'old-model', 200, 20, ?)
	`, time.Now().AddDate(0, 0, -1).Format("2006-01-02 15:04:05"), time.Now().AddDate(0, 0, -30).Format("2006-01-02 15:04:05"))
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	db.Close()

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/openai/analytics/logs?days=7&page=1&pageSize=20", nil)
	service.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("logs status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	var result struct {
		Total   int `json:"total"`
		Records []struct {
			Model string `json:"model"`
		} `json:"records"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Total != 1 || len(result.Records) != 1 || result.Records[0].Model != "recent-model" {
		t.Fatalf("unexpected filtered logs: %+v", result)
	}
}

func TestRecordAnalyticsSurvivesCancelledRequestContext(t *testing.T) {
	service := New(config.Config{DataDir: t.TempDir(), DBName: "data.db"})
	ctx, cancel := context.WithCancel(context.Background())
	ctx = context.WithValue(ctx, gatewayKeyContextKey{}, gatewayKeyIdentity{ID: "key-1", Name: "client"})
	cancel()

	service.RecordAnalytics(ctx, "chat.completions", "endpoint-1", "model-1", http.StatusBadGateway, 42, 0, 0, 0, 0, 0, 0, 0, "203.0.113.9", "198.51.100.7")

	db, err := service.open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var route, gatewayKeyID string
	if err := db.QueryRow("SELECT route, gateway_key_id FROM openai_gateway_analytics LIMIT 1").Scan(&route, &gatewayKeyID); err != nil {
		t.Fatal(err)
	}
	if route != "chat.completions" || gatewayKeyID != "key-1" {
		t.Fatalf("unexpected analytics identity: route=%q gateway_key_id=%q", route, gatewayKeyID)
	}
}

func TestEnsureSchemaMigratesGatewayKeyCipherColumn(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	_, err = db.Exec(`CREATE TABLE openai_gateway_keys (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		key_hash TEXT NOT NULL UNIQUE,
		key_prefix TEXT NOT NULL,
		key_suffix TEXT NOT NULL,
		enabled INTEGER DEFAULT 1,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		last_used DATETIME,
		expires_at DATETIME,
		request_count INTEGER DEFAULT 0
	)`)
	if err != nil {
		t.Fatal(err)
	}
	if err := ensureSchema(context.Background(), db); err != nil {
		t.Fatalf("ensureSchema failed: %v", err)
	}

	rows, err := db.Query("PRAGMA table_info(openai_gateway_keys)")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()

	found := false
	for rows.Next() {
		var cid int
		var name, columnType string
		var notNull, primaryKey int
		var defaultValue interface{}
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			t.Fatal(err)
		}
		if name == "key_cipher" {
			found = true
		}
	}
	if !found {
		t.Fatal("key_cipher column was not added")
	}
}

func TestGatewayKeyIsStoredAndListedAsPlaintext(t *testing.T) {
	service := New(config.Config{
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})

	createRecorder := httptest.NewRecorder()
	createRequest := httptest.NewRequest(http.MethodPost, "/api/openai/keys", strings.NewReader(`{"name":"desktop client"}`))
	service.ServeHTTP(createRecorder, createRequest)
	if createRecorder.Code != http.StatusCreated {
		t.Fatalf("create gateway key status = %d, body = %s", createRecorder.Code, createRecorder.Body.String())
	}
	var created struct {
		APIKey string `json:"apiKey"`
	}
	mustDecode(t, createRecorder.Body.String(), &created)

	db, err := service.open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var stored string
	if err := db.QueryRow("SELECT key_cipher FROM openai_gateway_keys LIMIT 1").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != created.APIKey {
		t.Fatalf("gateway key was not stored as plaintext: stored=%q created=%q", stored, created.APIKey)
	}

	listRecorder := httptest.NewRecorder()
	listRequest := httptest.NewRequest(http.MethodGet, "/api/openai/keys", nil)
	service.ServeHTTP(listRecorder, listRequest)
	var listed []GatewayKey
	mustDecode(t, listRecorder.Body.String(), &listed)
	if len(listed) != 1 || listed[0].APIKey != created.APIKey {
		t.Fatalf("gateway key list did not return plaintext: %+v", listed)
	}
}

func TestGetModelsListIncludesEnabledEndpointPendingVerification(t *testing.T) {
	service := New(config.Config{
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})
	db, err := service.open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`
		INSERT INTO openai_endpoints (id, name, base_url, api_key, status, enabled, models)
		VALUES ('pending', 'Pending endpoint', 'https://example.com/v1', 'encrypted-placeholder', 'unknown', 1, '["pending-model"]')
	`)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}

	models, err := service.GetModelsList(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0]["id"] != "pending-model" {
		t.Fatalf("unexpected models: %+v", models)
	}
}

func TestOpenAILifecycleAndProxy(t *testing.T) {
	var activeChatRequests int32

	// Spin up a mock upstream OpenAI server
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		authHeader := r.Header.Get("Authorization")
		if authHeader != "Bearer test-api-key" {
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"error":{"message":"Invalid API Key"}}`))
			return
		}

		if r.Method == http.MethodGet && path == "/v1/models" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{
				"object": "list",
				"data": [
					{"id": "gpt-4", "object": "model"},
					{"id": "gpt-3.5-turbo", "object": "model"}
				]
			}`))
			return
		}

		if r.Method == http.MethodPost && path == "/v1/chat/completions" {
			current := atomic.AddInt32(&activeChatRequests, 1)
			defer atomic.AddInt32(&activeChatRequests, -1)

			var body struct {
				Stream bool `json:"stream"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)

			if current > 1 {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTooManyRequests)
				w.Write([]byte(`{"error":{"message":"rate limited"}}`))
				return
			}

			time.Sleep(20 * time.Millisecond)

			if body.Stream {
				w.Header().Set("Content-Type", "text/event-stream")
				w.Header().Set("Cache-Control", "no-cache")
				w.Header().Set("Connection", "keep-alive")
				w.WriteHeader(http.StatusOK)
				w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n"))
				w.Write([]byte("data: [DONE]\n\n"))
			} else {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				w.Write([]byte(`{
					"id": "chatcmpl-123",
					"object": "chat.completion",
					"choices": [
						{"message": {"role": "assistant", "content": "Hello response"}}
					]
				}`))
			}
			return
		}

		w.WriteHeader(http.StatusNotFound)
	}))
	defer mockUpstream.Close()

	service := New(config.Config{
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})

	// 1. List initially empty
	wList := httptest.NewRecorder()
	rList, _ := http.NewRequest("GET", "/api/openai/endpoints", nil)
	service.ServeHTTP(wList, rList)
	if wList.Code != http.StatusOK {
		t.Fatalf("list status = %d body=%s", wList.Code, wList.Body.String())
	}
	var endpoints []Endpoint
	mustDecode(t, wList.Body.String(), &endpoints)
	if len(endpoints) != 0 {
		t.Fatalf("expected 0 endpoints, got %d", len(endpoints))
	}

	// 2. Create endpoint with validation
	createPayload := fmt.Sprintf(`{
		"name": "Test Mock",
		"baseUrl": "%s",
		"apiKey": "test-api-key"
	}`, mockUpstream.URL)

	wCreate := httptest.NewRecorder()
	rCreate, _ := http.NewRequest("POST", "/api/openai/endpoints", strings.NewReader(createPayload))
	service.ServeHTTP(wCreate, rCreate)
	if wCreate.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", wCreate.Code, wCreate.Body.String())
	}

	var createRes struct {
		Success  bool     `json:"success"`
		Endpoint Endpoint `json:"endpoint"`
	}
	mustDecode(t, wCreate.Body.String(), &createRes)
	if !createRes.Success || createRes.Endpoint.ID == "" || createRes.Endpoint.Status != "valid" {
		t.Fatalf("create failed, res: %#v", createRes)
	}

	endpointID := createRes.Endpoint.ID

	// 3. Toggle
	wToggle := httptest.NewRecorder()
	rToggle, _ := http.NewRequest("POST", "/api/openai/endpoints/"+endpointID+"/toggle", strings.NewReader(`{"enabled":false}`))
	service.ServeHTTP(wToggle, rToggle)
	if wToggle.Code != http.StatusOK {
		t.Fatalf("toggle status = %d body=%s", wToggle.Code, wToggle.Body.String())
	}

	// 4. Update
	wUpdate := httptest.NewRecorder()
	rUpdate, _ := http.NewRequest("PUT", "/api/openai/endpoints/"+endpointID, strings.NewReader(`{
		"name": "Test Updated"
	}`))
	service.ServeHTTP(wUpdate, rUpdate)
	if wUpdate.Code != http.StatusOK {
		t.Fatalf("update status = %d body=%s", wUpdate.Code, wUpdate.Body.String())
	}

	// Toggle back on
	wToggleOn := httptest.NewRecorder()
	rToggleOn, _ := http.NewRequest("POST", "/api/openai/endpoints/"+endpointID+"/toggle", strings.NewReader(`{"enabled":true}`))
	service.ServeHTTP(wToggleOn, rToggleOn)

	// 5. Test models proxy (which merges valid/enabled models)
	wModels := httptest.NewRecorder()
	rModels, _ := http.NewRequest("GET", "/v1/models", nil)
	service.ServeHTTP(wModels, rModels)
	if wModels.Code != http.StatusOK {
		t.Fatalf("models proxy status = %d body=%s", wModels.Code, wModels.Body.String())
	}
	var modelsRes struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	mustDecode(t, wModels.Body.String(), &modelsRes)
	if len(modelsRes.Data) != 2 || modelsRes.Data[0].ID != "gpt-3.5-turbo" {
		t.Fatalf("unexpected models list: %#v", modelsRes)
	}

	// 6. Test Chat completions proxy (non-stream)
	wChat := httptest.NewRecorder()
	rChat, _ := http.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{
		"model": "gpt-4",
		"messages": [{"role":"user","content":"hello"}]
	}`))
	rChat.Header.Set("x-endpoint-id", endpointID)
	service.ServeHTTP(wChat, rChat)
	if wChat.Code != http.StatusOK {
		t.Fatalf("chat proxy status = %d body=%s", wChat.Code, wChat.Body.String())
	}

	// 7. Test Chat completions proxy (stream)
	wChatStream := httptest.NewRecorder()
	rChatStream, _ := http.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{
		"model": "gpt-4",
		"messages": [{"role":"user","content":"hello"}],
		"stream": true
	}`))
	rChatStream.Header.Set("x-endpoint-id", endpointID)
	service.ServeHTTP(wChatStream, rChatStream)
	if wChatStream.Code != http.StatusOK {
		t.Fatalf("chat stream proxy status = %d body=%s", wChatStream.Code, wChatStream.Body.String())
	}
	if !strings.Contains(wChatStream.Body.String(), "Hello") {
		t.Fatalf("expected Hello in stream, got %s", wChatStream.Body.String())
	}

	// 8. Health check Single model
	wHealth := httptest.NewRecorder()
	rHealth, _ := http.NewRequest("POST", "/api/openai/endpoints/"+endpointID+"/health-check", strings.NewReader(`{
		"model": "gpt-4",
		"timeout": 5000
	}`))
	service.ServeHTTP(wHealth, rHealth)
	if wHealth.Code != http.StatusOK {
		t.Fatalf("health check status = %d body=%s", wHealth.Code, wHealth.Body.String())
	}
	var healthRes HealthRecord
	mustDecode(t, wHealth.Body.String(), &healthRes)
	if healthRes.Status != "operational" {
		t.Fatalf("expected operational status, got %s error=%s", healthRes.Status, healthRes.Error)
	}

	// 9. Health check all models on one endpoint
	wHealthAll := httptest.NewRecorder()
	rHealthAll, _ := http.NewRequest("POST", "/api/openai/endpoints/"+endpointID+"/health-check-all", strings.NewReader(`{
		"timeout": 5000,
		"concurrency": 1
	}`))
	service.ServeHTTP(wHealthAll, rHealthAll)
	if wHealthAll.Code != http.StatusOK {
		t.Fatalf("health check all status = %d body=%s", wHealthAll.Code, wHealthAll.Body.String())
	}
	var endpointHealthAll struct {
		Success bool          `json:"success"`
		Summary HealthSummary `json:"summary"`
	}
	mustDecode(t, wHealthAll.Body.String(), &endpointHealthAll)
	if !endpointHealthAll.Success || endpointHealthAll.Summary.Operational != 2 || endpointHealthAll.Summary.Failed != 0 {
		t.Fatalf("unexpected endpoint batch health summary: %#v", endpointHealthAll)
	}

	// 10. Health check all enabled endpoints
	wGlobalHealthAll := httptest.NewRecorder()
	rGlobalHealthAll, _ := http.NewRequest("POST", "/api/openai/health-check-all", strings.NewReader(`{
		"timeout": 5000,
		"concurrency": 1
	}`))
	service.ServeHTTP(wGlobalHealthAll, rGlobalHealthAll)
	if wGlobalHealthAll.Code != http.StatusOK {
		t.Fatalf("global health check all status = %d body=%s", wGlobalHealthAll.Code, wGlobalHealthAll.Body.String())
	}
	var globalHealthAll struct {
		Success   bool `json:"success"`
		Endpoints []struct {
			EndpointID  string         `json:"endpointId"`
			Operational int            `json:"operational"`
			Failed      int            `json:"failed"`
			Results     []HealthRecord `json:"results"`
		} `json:"endpoints"`
	}
	mustDecode(t, wGlobalHealthAll.Body.String(), &globalHealthAll)
	if !globalHealthAll.Success || len(globalHealthAll.Endpoints) != 1 {
		t.Fatalf("unexpected global batch health payload: %#v", globalHealthAll)
	}
	if globalHealthAll.Endpoints[0].EndpointID != endpointID || globalHealthAll.Endpoints[0].Operational != 2 || globalHealthAll.Endpoints[0].Failed != 0 {
		t.Fatalf("unexpected global batch health endpoint result: %#v", globalHealthAll.Endpoints[0])
	}

	// 11. Export
	wExport := httptest.NewRecorder()
	rExport, _ := http.NewRequest("GET", "/api/openai/export", nil)
	service.ServeHTTP(wExport, rExport)
	if wExport.Code != http.StatusOK {
		t.Fatalf("export status = %d body=%s", wExport.Code, wExport.Body.String())
	}
	var exportPayload struct {
		Endpoints []Endpoint `json:"endpoints"`
	}
	mustDecode(t, wExport.Body.String(), &exportPayload)
	if len(exportPayload.Endpoints) != 1 {
		t.Fatalf("expected 1 exported endpoint, got %d", len(exportPayload.Endpoints))
	}

	// 12. Import
	wImport := httptest.NewRecorder()
	rImport, _ := http.NewRequest("POST", "/api/openai/import", strings.NewReader(fmt.Sprintf(`{
		"endpoints": [{
			"id": "%s",
			"name": "Imported Endpoint",
			"baseUrl": "%s",
			"apiKey": "test-api-key",
			"enabled": true
		}],
		"overwrite": true
	}`, endpointID, mockUpstream.URL)))
	service.ServeHTTP(wImport, rImport)
	if wImport.Code != http.StatusOK {
		t.Fatalf("import status = %d body=%s", wImport.Code, wImport.Body.String())
	}

	// Delete
	wDel := httptest.NewRecorder()
	rDel, _ := http.NewRequest("DELETE", "/api/openai/endpoints/"+endpointID, nil)
	service.ServeHTTP(wDel, rDel)
	if wDel.Code != http.StatusOK {
		t.Fatalf("delete status = %d body=%s", wDel.Code, wDel.Body.String())
	}
}

func TestHealthCheckAcceptsEmptyOutput(t *testing.T) {
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-api-key" {
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"error":{"message":"Invalid API Key"}}`))
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
			w.WriteHeader(http.StatusNotFound)
			return
		}

		var body struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		switch body.Model {
		case "empty-model":
			w.Write([]byte(`{
				"id": "chatcmpl-empty",
				"object": "chat.completion",
				"choices": [
					{"message": {"role": "assistant", "content": "   "}}
				]
			}`))
		case "array-model":
			w.Write([]byte(`{
				"id": "chatcmpl-array",
				"object": "chat.completion",
				"choices": [
					{"message": {"role": "assistant", "content": [{"type":"text","text":"ok"}]}}
				]
			}`))
		default:
			w.Write([]byte(`{
				"id": "chatcmpl-default",
				"object": "chat.completion",
				"choices": [
					{"message": {"role": "assistant", "content": "hello"}}
				]
			}`))
		}
	}))
	defer mockUpstream.Close()

	service := New(config.Config{
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})

	success := service.healthCheckSingleModel(
		context.Background(),
		"",
		mockUpstream.URL+"/v1",
		"test-api-key",
		"array-model",
		5*time.Second,
		nil,
	)
	if success.Status == "failed" || success.Error != "" {
		t.Fatalf("expected valid output to pass, got status=%s error=%s", success.Status, success.Error)
	}

	failed := service.healthCheckSingleModel(
		context.Background(),
		"",
		mockUpstream.URL+"/v1",
		"test-api-key",
		"empty-model",
		5*time.Second,
		nil,
	)
	if failed.Status == "failed" {
		t.Fatalf("expected empty output to count as healthy, got status=%s error=%s", failed.Status, failed.Error)
	}
}

func TestHealthCheckRejects200WithErrorBody(t *testing.T) {
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"error":{"message":"Model temporarily unavailable"}}`))
	}))
	defer mockUpstream.Close()

	service := New(config.Config{
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})

	record := service.healthCheckSingleModel(
		context.Background(),
		"",
		mockUpstream.URL+"/v1",
		"test-api-key",
		"broken-model",
		5*time.Second,
		nil,
	)
	if record.Status != "failed" {
		t.Fatalf("expected 200-with-error-body to fail, got status=%s", record.Status)
	}
	if !strings.Contains(record.Error, "Model temporarily unavailable") {
		t.Fatalf("expected upstream error message, got error=%q", record.Error)
	}
}

func mustDecode(t *testing.T, body string, v interface{}) {
	if err := json.Unmarshal([]byte(body), v); err != nil {
		t.Fatalf("json decode failed: %v body=%q", err, body)
	}
}

func TestEndpointCustomHeadersForwardedToUpstream(t *testing.T) {
	gotHeaders := make(chan map[string]string, 16)

	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/chat/completions") {
			headers := map[string]string{
				"X-Custom-Header": r.Header.Get("X-Custom-Header"),
				"CF-Access-Key":   r.Header.Get("CF-Access-Key"),
				"HTTP-Referer":    r.Header.Get("HTTP-Referer"),
				"User-Agent":      r.Header.Get("User-Agent"),
			}
			gotHeaders <- headers
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == "/v1/models" {
			if r.Header.Get("X-Custom-Header") != "from-endpoint" {
				w.WriteHeader(http.StatusUnauthorized)
				w.Write([]byte(`{"error":{"message":"missing custom header"}}`))
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"data":[{"id":"gpt-4","object":"model"}]}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer mockUpstream.Close()

	service := New(config.Config{
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})

	createPayload := fmt.Sprintf(`{
		"name": "Headers Mock",
		"baseUrl": "%s",
		"apiKey": "test-api-key",
		"headers": [
			{"name": "X-Custom-Header", "value": "from-endpoint"},
			{"name": "CF-Access-Key", "value": "secret-token"},
			{"name": "HTTP-Referer", "value": "https://api-monitor.local"},
			{"name": "User-Agent", "value": "api-monitor-test/1.0"}
		]
	}`, mockUpstream.URL)

	wCreate := httptest.NewRecorder()
	rCreate, _ := http.NewRequest("POST", "/api/openai/endpoints", strings.NewReader(createPayload))
	service.ServeHTTP(wCreate, rCreate)
	if wCreate.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", wCreate.Code, wCreate.Body.String())
	}

	var createRes struct {
		Success  bool     `json:"success"`
		Endpoint Endpoint `json:"endpoint"`
	}
	mustDecode(t, wCreate.Body.String(), &createRes)
	if !createRes.Success || createRes.Endpoint.Status != "valid" {
		t.Fatalf("create with headers failed (verify should forward custom headers): %#v", createRes)
	}

	// Chat completions proxy should carry custom headers upstream.
	wChat := httptest.NewRecorder()
	rChat, _ := http.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{
		"model": "gpt-4",
		"messages": [{"role":"user","content":"hello"}]
	}`))
	rChat.Header.Set("x-endpoint-id", createRes.Endpoint.ID)
	service.ServeHTTP(wChat, rChat)
	if wChat.Code != http.StatusOK {
		t.Fatalf("chat proxy status = %d body=%s", wChat.Code, wChat.Body.String())
	}

	select {
	case headers := <-gotHeaders:
		if headers["X-Custom-Header"] != "from-endpoint" {
			t.Errorf("X-Custom-Header = %q, want from-endpoint", headers["X-Custom-Header"])
		}
		if headers["CF-Access-Key"] != "secret-token" {
			t.Errorf("CF-Access-Key = %q, want secret-token", headers["CF-Access-Key"])
		}
		if headers["HTTP-Referer"] != "https://api-monitor.local" {
			t.Errorf("HTTP-Referer = %q, want https://api-monitor.local", headers["HTTP-Referer"])
		}
		if headers["User-Agent"] != "api-monitor-test/1.0" {
			t.Errorf("User-Agent = %q, want api-monitor-test/1.0", headers["User-Agent"])
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for upstream headers")
	}

	// Listed endpoint should expose stored headers.
	wList := httptest.NewRecorder()
	rList, _ := http.NewRequest("GET", "/api/openai/endpoints", nil)
	service.ServeHTTP(wList, rList)
	var endpoints []Endpoint
	mustDecode(t, wList.Body.String(), &endpoints)
	found := false
	for _, ep := range endpoints {
		if ep.ID == createRes.Endpoint.ID {
			found = true
			if len(ep.Headers) != 4 {
				t.Fatalf("expected 4 stored headers, got %#v", ep.Headers)
			}
		}
	}
	if !found {
		t.Fatal("created endpoint not found in list")
	}
}

func TestEndpointModelEnableToggleFiltersRouting(t *testing.T) {
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/v1/models" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"data":[{"id":"gpt-4","object":"model"},{"id":"gpt-4-mini","object":"model"}]}`))
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/v1/chat/completions" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer mockUpstream.Close()

	service := New(config.Config{
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})

	createPayload := fmt.Sprintf(`{
		"name": "Model Switch Mock",
		"baseUrl": "%s",
		"apiKey": "test-api-key",
		"skipVerify": true
	}`, mockUpstream.URL)

	wCreate := httptest.NewRecorder()
	rCreate, _ := http.NewRequest("POST", "/api/openai/endpoints", strings.NewReader(createPayload))
	service.ServeHTTP(wCreate, rCreate)
	if wCreate.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", wCreate.Code, wCreate.Body.String())
	}
	var createRes struct {
		Success  bool     `json:"success"`
		Endpoint Endpoint `json:"endpoint"`
	}
	mustDecode(t, wCreate.Body.String(), &createRes)
	endpointID := createRes.Endpoint.ID

	// 手动插入模型列表，模拟已刷新过模型。
	db, err := service.open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`UPDATE openai_endpoints SET models = ? WHERE id = ?`, `["gpt-4","gpt-4-mini"]`, endpointID)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}

	// 通过路由 toggle 禁用 gpt-4。
	wToggle := httptest.NewRecorder()
	rToggle, _ := http.NewRequest("POST", "/api/openai/endpoints/"+endpointID+"/models/toggle", strings.NewReader(`{"model":"gpt-4","enabled":false}`))
	service.ServeHTTP(wToggle, rToggle)
	if wToggle.Code != http.StatusOK {
		t.Fatalf("toggle status = %d body=%s", wToggle.Code, wToggle.Body.String())
	}
	var toggleRes struct {
		Success        bool     `json:"success"`
		Enabled        bool     `json:"enabled"`
		DisabledModels []string `json:"disabledModels"`
	}
	mustDecode(t, wToggle.Body.String(), &toggleRes)
	if !toggleRes.Success || toggleRes.Enabled {
		t.Fatalf("toggle response unexpected: %#v", toggleRes)
	}
	if len(toggleRes.DisabledModels) != 1 || toggleRes.DisabledModels[0] != "gpt-4" {
		t.Fatalf("disabled models = %#v", toggleRes.DisabledModels)
	}

	// 再次开启 gpt-4-mini 保持启用，断言 disabled 不再包含它。
	wToggle2 := httptest.NewRecorder()
	rToggle2, _ := http.NewRequest("POST", "/api/openai/endpoints/"+endpointID+"/models/toggle", strings.NewReader(`{"model":"gpt-4-mini","enabled":true}`))
	service.ServeHTTP(wToggle2, rToggle2)
	if wToggle2.Code != http.StatusOK {
		t.Fatalf("toggle2 status = %d body=%s", wToggle2.Code, wToggle2.Body.String())
	}

	// /v1/models 不应再包含被禁用的 gpt-4。
	wModels := httptest.NewRecorder()
	rModels, _ := http.NewRequest("GET", "/v1/models", nil)
	service.ServeHTTP(wModels, rModels)
	if wModels.Code != http.StatusOK {
		t.Fatalf("models proxy status = %d body=%s", wModels.Code, wModels.Body.String())
	}
	var modelsRes struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	mustDecode(t, wModels.Body.String(), &modelsRes)
	foundIDs := map[string]bool{}
	for _, m := range modelsRes.Data {
		foundIDs[m.ID] = true
	}
	if foundIDs["gpt-4"] {
		t.Fatalf("disabled model gpt-4 should not appear in /v1/models, got %#v", modelsRes.Data)
	}
	if !foundIDs["gpt-4-mini"] {
		t.Fatalf("enabled model gpt-4-mini should appear in /v1/models, got %#v", modelsRes.Data)
	}

	// 指定端点请求被禁用模型应失败，被启用模型应成功。
	wChatDisabled := httptest.NewRecorder()
	rChatDisabled, _ := http.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{
		"model": "gpt-4",
		"messages": [{"role":"user","content":"hello"}]
	}`))
	rChatDisabled.Header.Set("x-endpoint-id", endpointID)
	service.ServeHTTP(wChatDisabled, rChatDisabled)
	if wChatDisabled.Code == http.StatusOK {
		t.Fatalf("disabled model request should fail, got %d body=%s", wChatDisabled.Code, wChatDisabled.Body.String())
	}

	wChatEnabled := httptest.NewRecorder()
	rChatEnabled, _ := http.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{
		"model": "gpt-4-mini",
		"messages": [{"role":"user","content":"hello"}]
	}`))
	rChatEnabled.Header.Set("x-endpoint-id", endpointID)
	service.ServeHTTP(wChatEnabled, rChatEnabled)
	if wChatEnabled.Code != http.StatusOK {
		t.Fatalf("enabled model request failed: %d body=%s", wChatEnabled.Code, wChatEnabled.Body.String())
	}
}

func TestConvertNodeToProxy(t *testing.T) {
	cases := []struct {
		nodeType, raw, server string
		port                  int
		wantPrefix            string
	}{
		{"socks", "socks://user:pass@1.2.3.4:1080#台湾-01", "", 0, "socks5://user:pass@1.2.3.4:1080"},
		{"http", "http://u:p@5.6.7.8:8080#HK", "", 0, "http://u:p@5.6.7.8:8080"},
		{"socks", "socks5://1.2.3.4:1081#Socks", "", 0, "socks5://1.2.3.4:1081"},
		{"http", "", "9.9.9.9", 8899, "socks5://9.9.9.9:8899"},
	}
	for _, tc := range cases {
		proxy, _, ok := convertNodeToProxy(tc.nodeType, tc.raw, tc.server, tc.port, "节点")
		if !ok {
			t.Fatalf("convertNodeToProxy(%q) returned ok=false", tc.raw)
		}
		if !strings.HasPrefix(proxy, tc.wantPrefix) {
			t.Errorf("proxy = %q, want prefix %q", proxy, tc.wantPrefix)
		}
	}
}

func TestProxyPoolRotationAndAutoSwitch(t *testing.T) {
	// 第一个代理命中限流（429），第二个代理正常。网关应在第一次 429 后自动切到第二个。
	var proxy1Hits, proxy2Hits int32

	proxy1 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&proxy1Hits, 1)
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"error":{"message":"rate limited"}}`))
	}))
	defer proxy1.Close()

	proxy2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&proxy2Hits, 1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer proxy2.Close()

	// 上游 /v1/models 需要一个正常响应以确认端点验证；chat 请求会经代理池转发。
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"data":[{"id":"gpt-4","object":"model"}]}`))
	}))
	defer mockUpstream.Close()

	service := New(config.Config{
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})

	createPayload := fmt.Sprintf(`{
		"name": "Proxy Switch Mock",
		"baseUrl": "%s",
		"apiKey": "test-api-key",
		"skipVerify": true,
		"proxyPool": ["%s", "%s"],
		"proxyEnabled": true,
		"autoSwitch": true
	}`, mockUpstream.URL, proxy1.URL, proxy2.URL)

	wCreate := httptest.NewRecorder()
	rCreate, _ := http.NewRequest("POST", "/api/openai/endpoints", strings.NewReader(createPayload))
	service.ServeHTTP(wCreate, rCreate)
	if wCreate.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", wCreate.Code, wCreate.Body.String())
	}
	var createRes struct {
		Success  bool     `json:"success"`
		Endpoint Endpoint `json:"endpoint"`
	}
	mustDecode(t, wCreate.Body.String(), &createRes)
	if len(createRes.Endpoint.ProxyPool) != 2 || !createRes.Endpoint.AutoSwitch {
		t.Fatalf("proxy pool not persisted: %#v", createRes.Endpoint)
	}

	// 写入 models，绕过前面手动确认端点模型列表。
	db, err := service.open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`UPDATE openai_endpoints SET models = ? WHERE id = ?`, `["gpt-4"]`, createRes.Endpoint.ID)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}

	// 触发 /v1/chat/completions：第一次请求经 proxy1 拿 429，网关应切到 proxy2 并成功返回 200。
	wChat := httptest.NewRecorder()
	rChat, _ := http.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{
		"model": "gpt-4",
		"messages": [{"role":"user","content":"hello"}]
	}`))
	rChat.Header.Set("x-endpoint-id", createRes.Endpoint.ID)
	service.ServeHTTP(wChat, rChat)

	// 最终响应必须是 200（来自 proxy2）。
	if wChat.Code != http.StatusOK {
		t.Fatalf("chat via proxy pool failed: code=%d body=%s", wChat.Code, wChat.Body.String())
	}
	if atomic.LoadInt32(&proxy1Hits) < 1 {
		t.Fatalf("proxy1 was never used, expected first attempt to hit it")
	}
	if atomic.LoadInt32(&proxy2Hits) < 1 {
		t.Fatalf("proxy2 was never used, expected retry to hit it")
	}
}

func TestWeightedProxyPick(t *testing.T) {
	// 快代理应被更频繁选中，但慢代理仍有机会出现（不独占）。
	fast, slow := 400, 3000
	candidates := []proxyCandidate{
		{idx: 0, ttfb: int64(fast), known: true},
		{idx: 1, ttfb: int64(slow), known: true},
	}
	fastCount, slowCount := 0, 0
	trials := 20000
	for i := 0; i < trials; i++ {
		if weightedProxyPick(candidates) == 0 {
			fastCount++
		} else {
			slowCount++
		}
	}
	// 快代理权重明显更高（400 vs 3000 毫秒 => 权重 14 vs 1），应占绝大多数。
	if fastCount <= slowCount {
		t.Fatalf("expected fast proxy to dominate, fast=%d slow=%d", fastCount, slowCount)
	}
	if slowCount == 0 {
		t.Fatalf("expected slow proxy to still get occasional pick, slow=%d", slowCount)
	}
	// 全部冷却退化的场景：单候选直接返回。
	if weightedProxyPick([]proxyCandidate{{idx: 2, ttfb: 100, known: true}}) != 2 {
		t.Fatalf("single candidate should be picked directly")
	}
}

func TestProxyPoolAutoSwitchOn5xx(t *testing.T) {
	// 第一个代理返回 502（上游故障），第二个代理正常。网关应切到第二个并成功返回 200。
	var proxy1Hits, proxy2Hits int32

	proxy1 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&proxy1Hits, 1)
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte(`{"error":{"message":"upstream exploded"}}`))
	}))
	defer proxy1.Close()

	proxy2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&proxy2Hits, 1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer proxy2.Close()

	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"data":[{"id":"gpt-4","object":"model"}]}`))
	}))
	defer mockUpstream.Close()

	service := New(config.Config{
		DataDir: t.TempDir(),
		DBName:  "data.db",
	})

	createPayload := fmt.Sprintf(`{
		"name": "Proxy 5xx Switch Mock",
		"baseUrl": "%s",
		"apiKey": "test-api-key",
		"skipVerify": true,
		"proxyPool": ["%s", "%s"],
		"proxyEnabled": true,
		"autoSwitch": true
	}`, mockUpstream.URL, proxy1.URL, proxy2.URL)

	wCreate := httptest.NewRecorder()
	rCreate, _ := http.NewRequest("POST", "/api/openai/endpoints", strings.NewReader(createPayload))
	service.ServeHTTP(wCreate, rCreate)
	if wCreate.Code != http.StatusOK {
		t.Fatalf("create status = %d body=%s", wCreate.Code, wCreate.Body.String())
	}
	var createRes struct {
		Success  bool     `json:"success"`
		Endpoint Endpoint `json:"endpoint"`
	}
	mustDecode(t, wCreate.Body.String(), &createRes)

	db, err := service.open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`UPDATE openai_endpoints SET models = ? WHERE id = ?`, `["gpt-4"]`, createRes.Endpoint.ID)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}

	wChat := httptest.NewRecorder()
	rChat, _ := http.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{
		"model": "gpt-4",
		"messages": [{"role":"user","content":"hello"}]
	}`))
	rChat.Header.Set("x-endpoint-id", createRes.Endpoint.ID)
	service.ServeHTTP(wChat, rChat)

	if wChat.Code != http.StatusOK {
		t.Fatalf("chat via proxy pool failed: code=%d body=%s", wChat.Code, wChat.Body.String())
	}
	if atomic.LoadInt32(&proxy1Hits) < 1 {
		t.Fatalf("proxy1 was never used, expected first attempt to hit it")
	}
	if atomic.LoadInt32(&proxy2Hits) < 1 {
		t.Fatalf("proxy2 was never used, expected 5xx retry to hit it")
	}
}

func TestIsRetryableUpstreamResponse(t *testing.T) {
	// 限流类：应重试。
	for _, code := range []int{429, 439, 503, 529} {
		resp := &http.Response{StatusCode: code}
		if !isRetryableUpstreamResponse(resp, nil) {
			t.Fatalf("status %d should be retryable", code)
		}
	}
	// 常见 5xx：应重试。
	for _, code := range []int{500, 502, 504, 599} {
		resp := &http.Response{StatusCode: code}
		if !isRetryableUpstreamResponse(resp, nil) {
			t.Fatalf("status %d should be retryable", code)
		}
	}
	// 语义错误/成功：不重试。
	for _, code := range []int{200, 400, 401, 403, 404, 501, 505} {
		resp := &http.Response{StatusCode: code}
		if isRetryableUpstreamResponse(resp, nil) {
			t.Fatalf("status %d should not be retryable", code)
		}
	}
	// 限流关键词兜底：正文命中关键词时重试。
	bodyResp := &http.Response{StatusCode: 200}
	if !isRetryableUpstreamResponse(bodyResp, []byte(`{"error":"rate_limit exceeded"}`)) {
		t.Fatalf("rate limit keyword in body should be retryable")
	}
}

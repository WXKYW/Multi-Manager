package github

import (
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/iwvw/api-monitor/backend-go/internal/config"
	"github.com/iwvw/api-monitor/backend-go/internal/secure"
)

func TestParseRepoInput(t *testing.T) {
	tests := []struct {
		input string
		owner string
		repo  string
	}{
		{"openai/codex", "openai", "codex"},
		{"https://github.com/openai/codex", "openai", "codex"},
		{"https://github.com/openai/codex/", "openai", "codex"},
		{"https://github.com/openai/codex/actions/runs/1", "openai", "codex"},
		{"git@github.com:openai/codex.git", "openai", "codex"},
	}
	for _, tt := range tests {
		owner, repo := parseRepoInput(tt.input)
		if owner != tt.owner || repo != tt.repo {
			t.Fatalf("parseRepoInput(%q) = %q/%q, want %q/%q", tt.input, owner, repo, tt.owner, tt.repo)
		}
	}
}

func TestParseRepoInputRejectsNonGitHubURL(t *testing.T) {
	owner, repo := parseRepoInput("https://example.com/openai/codex")
	if owner != "" || repo != "" {
		t.Fatalf("expected non-GitHub URL to be rejected, got %q/%q", owner, repo)
	}
}

func TestVerifySignature(t *testing.T) {
	body := []byte(`{"zen":"Keep it logically awesome."}`)
	secret := "secret"
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	valid := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if !verifySignature(body, secret, valid) {
		t.Fatal("expected signature to be valid")
	}
	if verifySignature(body, secret, "sha256=bad") {
		t.Fatal("expected bad signature to be rejected")
	}
}

func TestPublicPageEventPayloadOnlyExposesVisibleRepositoryIdentity(t *testing.T) {
	visibleRepositories := map[int64]struct{}{42: {}}
	payload, visible := publicPageEventPayload(visibleRepositories, map[string]interface{}{
		"kind":          "repository_actions_refresh",
		"repository_id": int64(42),
		"token":         "must-not-leak",
	})
	if !visible {
		t.Fatal("expected event for a public repository to be visible")
	}
	if payload["repository_id"] != int64(42) || payload["kind"] != "repository_actions_refresh" {
		t.Fatalf("unexpected public event payload: %#v", payload)
	}
	if _, leaked := payload["token"]; leaked {
		t.Fatalf("public event leaked private fields: %#v", payload)
	}

	if payload, visible := publicPageEventPayload(visibleRepositories, map[string]interface{}{
		"kind":          "repository_refresh",
		"repository_id": int64(7),
	}); visible || payload != nil {
		t.Fatalf("event for an unbound repository must stay private: %#v", payload)
	}
}

func TestRefreshActionsPublishesCommittedUpdate(t *testing.T) {
	githubAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/openai/codex/actions/runs" {
			t.Fatalf("unexpected GitHub API path: %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"total_count": 1,
			"workflow_runs": []map[string]interface{}{{
				"id": 42, "name": "CI", "status": "in_progress", "head_branch": "main",
				"run_started_at": "2026-07-16T00:00:00Z", "updated_at": "2026-07-16T00:01:00Z",
			}},
		})
	}))
	defer githubAPI.Close()

	cfg := config.Config{DataDir: t.TempDir(), DBName: "test.db"}
	service := New(cfg)
	defer service.Stop()
	service.client.baseURL = githubAPI.URL

	db, err := service.open(t.Context())
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	result, err := db.Exec(`INSERT INTO github_repositories (owner, name, full_name) VALUES ('openai', 'codex', 'openai/codex')`)
	if err != nil {
		db.Close()
		t.Fatalf("insert repository: %v", err)
	}
	repoID, _ := result.LastInsertId()
	db.Close()

	events, cancel := service.subscribe()
	defer cancel()
	if err := service.refreshActionsRepositoryByID(t.Context(), repoID, "test"); err != nil {
		t.Fatalf("refresh actions: %v", err)
	}

	select {
	case event := <-events:
		if event["kind"] != "repository_actions_refresh" || event["repository_id"] != repoID {
			t.Fatalf("unexpected refresh event: %#v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("missing repository actions refresh event")
	}

	db, err = service.open(t.Context())
	if err != nil {
		t.Fatalf("reopen database: %v", err)
	}
	defer db.Close()
	var status string
	if err := db.QueryRow(`SELECT latest_action_status FROM github_repositories WHERE id = ?`, repoID).Scan(&status); err != nil {
		t.Fatalf("read repository action status: %v", err)
	}
	if status != "in_progress" {
		t.Fatalf("unexpected latest action status: %q", status)
	}
	item, _, _, ok, err := service.publicRepositorySummaryItem(t.Context(), db, repoID)
	if err != nil || !ok {
		t.Fatalf("read public repository summary: ok=%v err=%v", ok, err)
	}
	if asString(item["updated_at"]) == "" {
		t.Fatalf("public repository summary must expose its data timestamp: %#v", item)
	}
}

func TestServiceCreateRepositoryFromURL(t *testing.T) {
	githubAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/openai/codex":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"id": 1, "name": "codex", "full_name": "openai/codex", "html_url": "https://github.com/openai/codex",
				"description": "Code agent", "default_branch": "main", "language": "Go",
				"stargazers_count": 100, "forks_count": 5, "watchers_count": 9, "open_issues_count": 3,
			})
		case "/search/issues":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"total_count": 2})
		case "/repos/openai/codex/releases/latest":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"tag_name": "v1.0.0", "html_url": "https://github.com/openai/codex/releases/tag/v1.0.0"})
		case "/repos/openai/codex/commits":
			_ = json.NewEncoder(w).Encode([]map[string]interface{}{{"sha": "a"}, {"sha": "b"}})
		case "/repos/openai/codex/contributors":
			_ = json.NewEncoder(w).Encode([]map[string]interface{}{{"login": "alice", "contributions": 10}})
		case "/repos/openai/codex/actions/runs":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"total_count": 1,
				"workflow_runs": []map[string]interface{}{{
					"id": 42, "name": "CI", "status": "completed", "conclusion": "success", "html_url": "https://example.test/run/42",
					"head_commit": map[string]interface{}{"message": "feat: add workflow commit details"},
				}},
			})
		case "/repos/openai/codex/traffic/views", "/repos/openai/codex/traffic/clones":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"count": 7, "uniques": 4})
		default:
			t.Fatalf("unexpected GitHub API path: %s", r.URL.Path)
		}
	}))
	defer githubAPI.Close()

	service := New(config.Config{DataDir: t.TempDir(), DBName: "test.db"})
	defer service.Stop()
	service.client.baseURL = githubAPI.URL

	req := httptest.NewRequest(http.MethodPost, "/api/github/repositories", strings.NewReader(`{"url":"https://github.com/openai/codex","collect_interval_seconds":60,"retention_days":30}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	service.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("create repository status=%d body=%s", rec.Code, rec.Body.String())
	}
	var envelope struct {
		Success bool       `json:"success"`
		Data    Repository `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !envelope.Success || envelope.Data.FullName != "openai/codex" || envelope.Data.Stars != 100 {
		t.Fatalf("unexpected repository response: %#v", envelope)
	}
}

func TestTokenTestCanBindRepositoryCredential(t *testing.T) {
	githubAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/user":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"login": "iwvw"})
		case "/rate_limit":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"resources": map[string]interface{}{}})
		case "/repos/iwvw/API-Monitor":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"id": 1, "name": "API-Monitor", "full_name": "iwvw/API-Monitor",
				"owner": map[string]interface{}{"login": "iwvw"},
			})
		case "/repos/iwvw/API-Monitor/actions/runs":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"total_count": 0, "workflow_runs": []interface{}{}})
		case "/repos/iwvw/API-Monitor/traffic/views", "/repos/iwvw/API-Monitor/traffic/clones":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"count": 0, "uniques": 0})
		default:
			t.Fatalf("unexpected GitHub API path: %s", r.URL.Path)
		}
	}))
	defer githubAPI.Close()

	cfg := config.Config{DataDir: t.TempDir(), DBName: "test.db"}
	service := New(cfg)
	defer service.Stop()
	service.client.baseURL = githubAPI.URL

	encrypted, err := secure.SecureEncrypt("token-1")
	if err != nil {
		t.Fatalf("encrypt token: %v", err)
	}
	db, err := sql.Open("sqlite", cfg.DatabasePath())
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	if err := ensureSchema(t.Context(), db); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	tokenResult, err := db.Exec(`INSERT INTO github_tokens (name, token_encrypted) VALUES ('primary', ?)`, encrypted)
	if err != nil {
		t.Fatalf("insert token: %v", err)
	}
	tokenID, _ := tokenResult.LastInsertId()
	repoResult, err := db.Exec(`INSERT INTO github_repositories (owner, name, full_name) VALUES ('iwvw', 'API-Monitor', 'iwvw/API-Monitor')`)
	if err != nil {
		t.Fatalf("insert repository: %v", err)
	}
	repoID, _ := repoResult.LastInsertId()
	db.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/github/tokens/1/test?repositoryId=1&bind=true", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	service.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("test token status=%d body=%s", rec.Code, rec.Body.String())
	}

	db, err = sql.Open("sqlite", cfg.DatabasePath())
	if err != nil {
		t.Fatalf("reopen database: %v", err)
	}
	defer db.Close()
	var boundTokenID sql.NullInt64
	var ownedByToken int
	if err := db.QueryRow(`SELECT token_id, owned_by_token FROM github_repositories WHERE id = ?`, repoID).Scan(&boundTokenID, &ownedByToken); err != nil {
		t.Fatalf("read repository binding: %v", err)
	}
	if !boundTokenID.Valid || boundTokenID.Int64 != tokenID || ownedByToken != 1 {
		t.Fatalf("unexpected binding token=%v owned=%d", boundTokenID, ownedByToken)
	}
}

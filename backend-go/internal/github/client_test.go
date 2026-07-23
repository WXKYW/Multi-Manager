package github

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAPIClientFetchRepositoryAndRateLimit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer token-1" {
			t.Fatalf("missing bearer token: %q", r.Header.Get("Authorization"))
		}
		if r.Header.Get("X-GitHub-Api-Version") == "" {
			t.Fatal("missing GitHub API version header")
		}
		if r.URL.Path != "/repos/openai/codex" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("X-RateLimit-Limit", "5000")
		w.Header().Set("X-RateLimit-Remaining", "4999")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"id": 1, "name": "codex", "full_name": "openai/codex", "html_url": "https://github.com/openai/codex",
			"stargazers_count": 123, "forks_count": 4, "watchers_count": 12, "open_issues_count": 7,
		})
	}))
	defer server.Close()

	client := newAPIClient()
	client.baseURL = server.URL
	repo, rate, err := client.fetchRepository(context.Background(), "token-1", "openai", "codex")
	if err != nil {
		t.Fatalf("fetchRepository: %v", err)
	}
	if repo.FullName != "openai/codex" || repo.StargazersCount != 123 {
		t.Fatalf("unexpected repo: %#v", repo)
	}
	if rate.Limit != 5000 || rate.Remaining != 4999 {
		t.Fatalf("unexpected rate limit: %#v", rate)
	}
}

func TestAPIClientWorkflowOperations(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.Path)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := newAPIClient()
	client.baseURL = server.URL
	if _, err := client.rerunWorkflowRun(context.Background(), "token", "openai", "codex", 42, false); err != nil {
		t.Fatalf("rerun: %v", err)
	}
	if _, err := client.rerunWorkflowRun(context.Background(), "token", "openai", "codex", 42, true); err != nil {
		t.Fatalf("rerun failed jobs: %v", err)
	}
	if _, err := client.cancelWorkflowRun(context.Background(), "token", "openai", "codex", 42); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if _, err := client.dispatchWorkflow(context.Background(), "token", "openai", "codex", "ci.yml", "main", nil); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	joined := strings.Join(seen, "\n")
	for _, want := range []string{
		"POST /repos/openai/codex/actions/runs/42/rerun",
		"POST /repos/openai/codex/actions/runs/42/rerun-failed-jobs",
		"POST /repos/openai/codex/actions/runs/42/cancel",
		"POST /repos/openai/codex/actions/workflows/ci.yml/dispatches",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in:\n%s", want, joined)
		}
	}
}

func TestAPIClientFetchWorkflows(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/repos/openai/codex/actions/workflows" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.URL.Query().Get("per_page") != "100" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"total_count": 1,
			"workflows": []map[string]interface{}{{
				"id": 7, "name": "CI", "path": ".github/workflows/ci.yml", "state": "active",
			}},
		})
	}))
	defer server.Close()

	client := newAPIClient()
	client.baseURL = server.URL
	workflows, _, err := client.fetchWorkflows(context.Background(), "token", "openai", "codex")
	if err != nil {
		t.Fatalf("fetch workflows: %v", err)
	}
	if workflows.TotalCount != 1 || len(workflows.Workflows) != 1 || workflows.Workflows[0].Path != ".github/workflows/ci.yml" {
		t.Fatalf("unexpected workflows: %#v", workflows)
	}
}

func TestAPIClientFetchWorkflowFile(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/repos/openai/codex/contents/.github/workflows/ci.yml" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.URL.Query().Get("ref") != "dev/branch" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"path":     ".github/workflows/ci.yml",
			"encoding": "base64",
			"content":  base64.StdEncoding.EncodeToString([]byte("jobs:\n  build:\n    runs-on: ubuntu-latest\n")),
		})
	}))
	defer server.Close()

	client := newAPIClient()
	client.baseURL = server.URL
	raw, file, _, err := client.fetchWorkflowFile(context.Background(), "token", "openai", "codex", ".github/workflows/ci.yml", "dev/branch")
	if err != nil {
		t.Fatalf("fetch workflow file: %v", err)
	}
	if file.Path != ".github/workflows/ci.yml" || !strings.Contains(raw, "build") {
		t.Fatalf("unexpected workflow file path=%q raw=%q", file.Path, raw)
	}
}

func TestAPIClientFetchBranches(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/repos/openai/codex/branches" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if r.URL.Query().Get("per_page") != "100" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode([]map[string]interface{}{{"name": "main", "protected": true}})
	}))
	defer server.Close()

	client := newAPIClient()
	client.baseURL = server.URL
	branches, _, err := client.fetchBranches(context.Background(), "token", "openai", "codex")
	if err != nil {
		t.Fatalf("fetch branches: %v", err)
	}
	if len(branches) != 1 || branches[0].Name != "main" || !branches[0].Protected {
		t.Fatalf("unexpected branches: %#v", branches)
	}
}

func TestAPIClientFetchWorkflowRunsIncludesCommitMessage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"total_count": 1,
			"workflow_runs": []map[string]interface{}{{
				"id":          42,
				"head_commit": map[string]interface{}{"message": "feat: add workflow commit details"},
			}},
		})
	}))
	defer server.Close()

	client := newAPIClient()
	client.baseURL = server.URL
	runs, _, err := client.fetchWorkflowRuns(context.Background(), "token", "openai", "codex", 1)
	if err != nil {
		t.Fatalf("fetch workflow runs: %v", err)
	}
	if len(runs.WorkflowRuns) != 1 || runs.WorkflowRuns[0].HeadCommit.Message != "feat: add workflow commit details" {
		t.Fatalf("unexpected workflow runs: %#v", runs)
	}
}

func TestAPIClientConfigureWebhookUpdatesMatchingHook(t *testing.T) {
	var updated bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET /repos/openai/codex/hooks":
			_ = json.NewEncoder(w).Encode([]map[string]interface{}{{"id": 9, "config": map[string]interface{}{"url": "https://monitor.example/api/github/webhook/1"}}})
		case "PATCH /repos/openai/codex/hooks/9":
			var body map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			config := body["config"].(map[string]interface{})
			if config["secret"] != "secret-1" || config["content_type"] != "json" {
				t.Fatalf("unexpected hook config: %#v", body)
			}
			updated = true
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	client := newAPIClient()
	client.baseURL = server.URL
	hookID, created, _, err := client.configureWebhook(context.Background(), "token", "openai", "codex", "https://monitor.example/api/github/webhook/1", "secret-1")
	if err != nil || hookID != 9 || created || !updated {
		t.Fatalf("unexpected webhook result id=%d created=%v updated=%v err=%v", hookID, created, updated, err)
	}
}

func TestProbeRepositoryPermissionsChecksWebhookRead(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/openai/codex":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"full_name": "openai/codex"})
		case "/repos/openai/codex/actions/runs":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"total_count": 0, "workflow_runs": []interface{}{}})
		case "/repos/openai/codex/traffic/views", "/repos/openai/codex/traffic/clones":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"count": 0, "uniques": 0})
		case "/repos/openai/codex/hooks":
			http.Error(w, `{"message":"Resource not accessible by personal access token"}`, http.StatusForbidden)
		default:
			t.Fatalf("unexpected request: %s", r.URL.String())
		}
	}))
	defer server.Close()

	client := newAPIClient()
	client.baseURL = server.URL
	checks := client.probeRepositoryPermissions(context.Background(), "token", Repository{Owner: "openai", Name: "codex"})
	var webhookCheck map[string]interface{}
	for _, check := range checks {
		if check["key"] == "webhooks_read" {
			webhookCheck = check
			break
		}
	}
	if webhookCheck == nil || webhookCheck["status"] != "failed" {
		t.Fatalf("expected failed webhook permission check, got %#v", checks)
	}
}

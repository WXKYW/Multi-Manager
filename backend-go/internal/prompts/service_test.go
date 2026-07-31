package prompts

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/iwvw/api-monitor/backend-go/internal/config"
)

func newTestService(t *testing.T) *Service {
	t.Helper()
	return New(config.Config{DataDir: t.TempDir(), DBName: "test.db"})
}

func TestDraftPublishAndPublicLinks(t *testing.T) {
	service := newTestService(t)
	entry, err := service.store.CreateEntry(context.Background(), CreateEntryRequest{Title: "发布测试", TagsJSON: "[]", Visibility: "unlisted"})
	if err != nil {
		t.Fatal(err)
	}
	draft, revision, err := service.store.SaveDraft(context.Background(), entry.ID, SaveDraftRequest{ContentMD: "# Role\n\nHello **world**", ExpectedDraftRev: 1})
	if err != nil || draft.ContentText != "Role\n\nHello world" || revision != 2 {
		t.Fatalf("save draft: draft=%#v revision=%d err=%v", draft, revision, err)
	}
	if _, _, err := service.store.SaveDraft(context.Background(), entry.ID, SaveDraftRequest{ContentMD: "stale", ExpectedDraftRev: 1}); err == nil {
		t.Fatal("expected optimistic lock conflict")
	}
	if _, err := service.store.PublishVersion(context.Background(), entry.ID, PublishRequest{ExpectedDraftRev: revision}); err != nil {
		t.Fatal(err)
	}

	page := httptest.NewRecorder()
	service.ServePublic(page, httptest.NewRequest(http.MethodGet, "/api/prompts/public/"+entry.PublicID, nil))
	if page.Code != http.StatusOK {
		t.Fatalf("public page status=%d body=%s", page.Code, page.Body.String())
	}
	var pageData PublicPageData
	if err := json.Unmarshal(page.Body.Bytes(), &pageData); err != nil || pageData.ContentMD != draft.ContentMD {
		t.Fatalf("public payload=%#v err=%v", pageData, err)
	}

	direct := httptest.NewRecorder()
	service.ServePublic(direct, httptest.NewRequest(http.MethodGet, "/api/prompts/d/"+entry.PublicID+"?format=markdown", nil))
	if direct.Code != http.StatusOK || direct.Body.String() != draft.ContentMD || !strings.HasPrefix(direct.Header().Get("Content-Type"), "text/markdown") {
		t.Fatalf("direct response status=%d type=%q body=%q", direct.Code, direct.Header().Get("Content-Type"), direct.Body.String())
	}
}

func TestPrivateEntryIsNotPublic(t *testing.T) {
	service := newTestService(t)
	entry, err := service.store.CreateEntry(context.Background(), CreateEntryRequest{Title: "私有", TagsJSON: "[]", Visibility: "private"})
	if err != nil {
		t.Fatal(err)
	}
	_, revision, _ := service.store.SaveDraft(context.Background(), entry.ID, SaveDraftRequest{ContentMD: "secret", ExpectedDraftRev: 1})
	service.store.PublishVersion(context.Background(), entry.ID, PublishRequest{ExpectedDraftRev: revision})
	recorder := httptest.NewRecorder()
	service.ServePublic(recorder, httptest.NewRequest(http.MethodGet, "/api/prompts/d/"+entry.PublicID, nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("private direct link status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

package drawio

import (
	"bytes"
	"compress/flate"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/iwvw/api-monitor/backend-go/internal/config"
)

func testService(t *testing.T) *Service {
	t.Helper()
	service := New(config.Config{DataDir: t.TempDir(), DBName: "test.db"})
	t.Cleanup(service.Stop)
	return service
}

func TestDocumentRoutesAndDraftConflict(t *testing.T) {
	service := testService(t)
	create := httptest.NewRequest(http.MethodPost, "/api/drawio/documents", strings.NewReader(`{"title":"架构图","tags_json":"[]"}`))
	created := httptest.NewRecorder()
	service.ServeHTTP(created, create)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", created.Code, created.Body.String())
	}
	var payload struct {
		Document DocumentDetail `json:"document"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}

	get := httptest.NewRecorder()
	service.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/api/drawio/documents/1", nil))
	if get.Code != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", get.Code, get.Body.String())
	}

	firstXML := strings.Replace(DefaultBlankMXFile(), "Page-1", "第一版", 1)
	first := httptest.NewRecorder()
	service.ServeHTTP(first, httptest.NewRequest(http.MethodPut, "/api/drawio/documents/1/draft", strings.NewReader(`{"xml_content":`+strconvQuote(firstXML)+`,"expected_draft_rev":1}`)))
	if first.Code != http.StatusOK {
		t.Fatalf("first save status = %d, body = %s", first.Code, first.Body.String())
	}

	conflict := httptest.NewRecorder()
	service.ServeHTTP(conflict, httptest.NewRequest(http.MethodPut, "/api/drawio/documents/1/draft", strings.NewReader(`{"xml_content":"bad","expected_draft_rev":1}`)))
	if conflict.Code != http.StatusConflict {
		t.Fatalf("conflict status = %d, body = %s", conflict.Code, conflict.Body.String())
	}
	draft, err := service.store.GetDraft(context.Background(), payload.Document.ID)
	if err != nil || draft.XMLContent != firstXML {
		t.Fatalf("conflict changed draft: err=%v xml=%q", err, draft.XMLContent)
	}
}

func TestNormalizeCompressedDrawio(t *testing.T) {
	page := `<mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>`
	var compressed bytes.Buffer
	w, _ := flate.NewWriter(&compressed, flate.DefaultCompression)
	w.Write([]byte(url.QueryEscape(page)))
	w.Close()
	raw := `<mxfile><diagram id="p1" name="Page-1">` + base64.StdEncoding.EncodeToString(compressed.Bytes()) + `</diagram></mxfile>`
	normalized, err := NormalizeXML(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(normalized, page) {
		t.Fatalf("normalized XML did not contain page model: %s", normalized)
	}
	pages, _, name := ParsePageInfo(normalized)
	if len(pages) != 1 || name != "Page-1" {
		t.Fatalf("unexpected page info: %#v %q", pages, name)
	}
}

func strconvQuote(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

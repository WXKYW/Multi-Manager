package prompts

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
)

// HashIP 对 IP 地址做简单哈希（用于访问日志，不存原始 IP）
func HashIP(ip string) string {
	h := sha256.New()
	h.Write([]byte(ip))
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// ServePublic 公开路由处理
func (s *Service) ServePublic(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/prompts/public/")
	path = strings.TrimPrefix(path, "/api/prompts/d/")

	// Direct link: /api/prompts/d/{publicId}
	if strings.HasPrefix(r.URL.Path, "/api/prompts/d/") {
		s.serveDirectLink(w, r)
		return
	}

	// Public page: /api/prompts/public/{publicId}
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 1 {
		s.servePublicPage(w, r, parts[0])
		return
	}

	http.NotFound(w, r)
}

func (s *Service) servePublicPage(w http.ResponseWriter, r *http.Request, publicID string) {
	entry, err := s.store.GetEntryByPublicID(r.Context(), publicID)
	if err != nil || entry == nil {
		http.NotFound(w, r)
		return
	}

	if entry.LatestPublishedVersionID == nil {
		http.NotFound(w, r)
		return
	}

	version, err := s.store.GetVersion(r.Context(), *entry.LatestPublishedVersionID)
	if err != nil || version == nil {
		http.NotFound(w, r)
		return
	}

	// Log access
	go s.store.LogAccess(r.Context(), entry.ID, entry.LatestPublishedVersionID, "public_page", "html",
		HashIP(r.RemoteAddr), r.UserAgent())

	// Render markdown as HTML using a simple approach
	html := RenderMarkdownToHTML(version.ContentMD)

	data := PublicPageData{
		Title:       entry.Title,
		ContentHTML: html,
		ContentMD:   version.ContentMD,
		VersionNo:   version.VersionNo,
		PublishedAt: version.CreatedAt,
		TagsJSON:    entry.TagsJSON,
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	fmt.Fprintf(w, `{"title":"%s","content_html":"%s","content_md":"%s","version_no":%d,"published_at":"%s","tags_json":%s}`,
		escapeJSON(data.Title), escapeJSON(data.ContentHTML), escapeJSON(data.ContentMD),
		data.VersionNo, data.PublishedAt, data.TagsJSON)
}

func (s *Service) serveDirectLink(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/prompts/d/")
	parts := strings.Split(strings.Trim(path, "/"), "/")

	if len(parts) == 0 {
		http.NotFound(w, r)
		return
	}

	publicID := parts[0]
	entry, err := s.store.GetEntryByPublicID(r.Context(), publicID)
	if err != nil || entry == nil {
		http.NotFound(w, r)
		return
	}

	var version *VersionPayload
	if len(parts) >= 3 && parts[1] == "versions" {
		// Version-specific direct link
		var versionNo int
		fmt.Sscanf(parts[2], "%d", &versionNo)
		version, err = s.store.GetPublishedVersionByNo(r.Context(), entry.ID, versionNo)
	} else {
		version, err = s.store.GetPublishedVersion(r.Context(), entry.ID)
	}

	if err != nil || version == nil {
		http.NotFound(w, r)
		return
	}

	// Log access
	routeKind := "direct_latest"
	if len(parts) >= 3 {
		routeKind = "direct_version"
	}
	go s.store.LogAccess(r.Context(), entry.ID, &version.ID, routeKind, "text",
		HashIP(r.RemoteAddr), r.UserAgent())

	// Output format
	format := r.URL.Query().Get("format")
	switch format {
	case "markdown":
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		w.Write([]byte(version.ContentMD))
	case "json":
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		fmt.Fprintf(w, `{"title":"%s","content":"%s","version":%d}`,
			escapeJSON(entry.Title), escapeJSON(version.ContentMD), version.VersionNo)
	default:
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte(version.ContentText))
	}
}

// RenderMarkdownToHTML 将 Markdown 渲染为 HTML（简单实现）
func RenderMarkdownToHTML(md string) string {
	html := strings.ReplaceAll(md, "\n", "\\n")
	html = strings.ReplaceAll(html, "\r", "")
	html = strings.ReplaceAll(html, "\"", "\\\"")
	html = strings.ReplaceAll(html, "\t", "\\t")
	return html
}

func escapeJSON(s string) string {
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, "\"", "\\\"")
	s = strings.ReplaceAll(s, "\n", "\\n")
	s = strings.ReplaceAll(s, "\r", "\\r")
	s = strings.ReplaceAll(s, "\t", "\\t")
	return s
}

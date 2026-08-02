package prompts

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func HashIP(remoteAddr string) string {
	if host, _, err := net.SplitHostPort(remoteAddr); err == nil {
		remoteAddr = host
	}
	hash := sha256.Sum256([]byte(remoteAddr))
	return hex.EncodeToString(hash[:])[:16]
}

func (s *Service) ServePublic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/prompts/d/") {
		s.serveDirectLink(w, r)
		return
	}
	publicID := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/prompts/public/"), "/")
	if publicID == "" || strings.Contains(publicID, "/") {
		http.NotFound(w, r)
		return
	}
	s.servePublicPage(w, r, publicID)
}

func (s *Service) servePublicPage(w http.ResponseWriter, r *http.Request, publicID string) {
	settings, err := s.store.GetSettings(r.Context())
	if err != nil || !settings.AllowPublicPages {
		http.NotFound(w, r)
		return
	}
	entry, err := s.store.GetEntryByPublicID(r.Context(), publicID)
	if err != nil || entry == nil || entry.LatestPublishedVersionID == nil {
		http.NotFound(w, r)
		return
	}
	version, err := s.store.GetVersion(r.Context(), *entry.LatestPublishedVersionID)
	if err != nil || version == nil {
		http.NotFound(w, r)
		return
	}

	s.logPublicAccess(entry.ID, entry.LatestPublishedVersionID, "public_page", "json", r)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(PublicPageData{
		Title: entry.Title, ContentMD: version.ContentMD, VersionNo: version.VersionNo,
		PublishedAt: version.CreatedAt, TagsJSON: entry.TagsJSON,
	})
}

func (s *Service) serveDirectLink(w http.ResponseWriter, r *http.Request) {
	settings, err := s.store.GetSettings(r.Context())
	if err != nil || !settings.AllowDirectLinks {
		http.NotFound(w, r)
		return
	}
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/prompts/d/"), "/"), "/")
	if len(parts) != 1 && !(len(parts) == 3 && parts[1] == "versions") {
		http.NotFound(w, r)
		return
	}
	entry, err := s.store.GetEntryByPublicID(r.Context(), parts[0])
	if err != nil || entry == nil {
		http.NotFound(w, r)
		return
	}

	var version *VersionPayload
	routeKind := "direct_latest"
	if len(parts) == 3 {
		versionNo, parseErr := strconv.Atoi(parts[2])
		if parseErr != nil || versionNo < 1 {
			http.NotFound(w, r)
			return
		}
		version, err = s.store.GetPublishedVersionByNo(r.Context(), entry.ID, versionNo)
		routeKind = "direct_version"
	} else {
		version, err = s.store.GetPublishedVersion(r.Context(), entry.ID)
	}
	if err != nil || version == nil {
		http.NotFound(w, r)
		return
	}

	format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
	if format == "" {
		format = settings.DefaultDirectFormat
	}
	s.logPublicAccess(entry.ID, &version.ID, routeKind, format, r)
	switch format {
	case "markdown":
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		w.Write([]byte(version.ContentMD))
	case "json":
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"title": entry.Title, "content": version.ContentMD, "version": version.VersionNo,
		})
	default:
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write([]byte(version.ContentText))
	}
}

func (s *Service) logPublicAccess(entryID int64, versionID *int64, routeKind, format string, r *http.Request) {
	remoteAddr := r.RemoteAddr
	userAgent := r.UserAgent()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	s.store.LogAccess(ctx, entryID, versionID, routeKind, format, HashIP(remoteAddr), userAgent)
}

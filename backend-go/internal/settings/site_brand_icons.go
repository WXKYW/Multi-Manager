package settings

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/iwvw/api-monitor/backend-go/internal/response"
)

const maxSiteBrandIconBytes = 600 * 1024

type siteBrandIconRecord struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Ext         string `json:"ext"`
	ContentType string `json:"content_type"`
	CreatedAt   string `json:"created_at"`
}

func (s *Service) listSiteBrandIcons(w http.ResponseWriter, r *http.Request) {
	records, err := s.loadSiteBrandIconRecords()
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	sort.Slice(records, func(i, j int) bool {
		if records[i].CreatedAt == records[j].CreatedAt {
			return records[i].Name < records[j].Name
		}
		return records[i].CreatedAt > records[j].CreatedAt
	})
	items := make([]map[string]string, 0, len(records))
	for _, item := range records {
		items = append(items, s.siteBrandIconResponse(item))
	}
	response.OK(w, items)
}

func (s *Service) uploadSiteBrandIcon(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 768*1024)
	if err := r.ParseMultipartForm(768 * 1024); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid upload payload")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		response.Error(w, http.StatusBadRequest, "missing upload file")
		return
	}
	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, maxSiteBrandIconBytes+1))
	if err != nil {
		response.Error(w, http.StatusBadRequest, "read upload failed")
		return
	}
	if len(data) == 0 {
		response.Error(w, http.StatusBadRequest, "empty upload file")
		return
	}
	if len(data) > maxSiteBrandIconBytes {
		response.Error(w, http.StatusBadRequest, "image exceeds 600 KB")
		return
	}

	ext, contentType, err := detectSiteBrandIconFormat(data, header.Header.Get("Content-Type"), header.Filename)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	if ext == ".svg" && !isSafeSiteBrandSVG(data) {
		response.Error(w, http.StatusBadRequest, "unsupported svg")
		return
	}

	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" {
		name = strings.TrimSpace(header.Filename)
	}
	if name == "" {
		name = "站点图标"
	}

	item, err := s.saveSiteBrandIcon(data, name, ext, contentType)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, item)
}

func (s *Service) serveSiteBrandIcon(w http.ResponseWriter, r *http.Request, id string) {
	record, path, ok, err := s.findSiteBrandIcon(strings.TrimSpace(id))
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		response.Error(w, http.StatusNotFound, "icon not found")
		return
	}
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if record.ContentType != "" {
		w.Header().Set("Content-Type", record.ContentType)
	}
	http.ServeFile(w, r, path)
}

func (s *Service) deleteSiteBrandIcon(w http.ResponseWriter, r *http.Request, id string) {
	recordID := strings.TrimSpace(id)
	if recordID == "" {
		response.Error(w, http.StatusNotFound, "icon not found")
		return
	}

	records, err := s.loadSiteBrandIconRecords()
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	index := -1
	var record siteBrandIconRecord
	for i, item := range records {
		if item.ID != recordID {
			continue
		}
		index = i
		record = item
		break
	}
	if index < 0 {
		response.Error(w, http.StatusNotFound, "icon not found")
		return
	}

	path := filepath.Join(s.siteBrandIconDir(), record.ID+record.Ext)
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		response.Error(w, http.StatusInternalServerError, fmt.Errorf("delete icon asset: %w", err).Error())
		return
	}

	records = append(records[:index], records[index+1:]...)
	if err := s.saveSiteBrandIconRecords(records); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	if db, err := s.store.Open(r.Context()); err == nil {
		_, _ = db.ExecContext(r.Context(), `UPDATE user_settings SET site_brand_icon_id = NULL WHERE id = 1 AND site_brand_icon_id = ?`, record.ID)
		_ = db.Close()
	}

	response.OK(w, map[string]string{
		"id": record.ID,
	})
}

func (s *Service) ServePublicSiteBrandIconAsset(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	if !strings.HasPrefix(r.URL.Path, "/site-brand-icons/") {
		return false
	}
	id := strings.TrimPrefix(r.URL.Path, "/site-brand-icons/")
	record, path, ok, err := s.findSiteBrandIcon(strings.TrimSpace(id))
	if err != nil || !ok {
		return false
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if record.ContentType != "" {
		w.Header().Set("Content-Type", record.ContentType)
	}
	http.ServeFile(w, r, path)
	return true
}

func (s *Service) saveSiteBrandIcon(data []byte, name, ext, contentType string) (map[string]string, error) {
	records, err := s.loadSiteBrandIconRecords()
	if err != nil {
		return nil, err
	}
	token, err := randomToken()
	if err != nil {
		return nil, err
	}
	record := siteBrandIconRecord{
		ID:          "site-" + strings.ToLower(token[:12]),
		Name:        strings.TrimSpace(name),
		Ext:         ext,
		ContentType: contentType,
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}
	if err := os.MkdirAll(s.siteBrandIconDir(), 0o755); err != nil {
		return nil, fmt.Errorf("prepare icon storage: %w", err)
	}
	path := filepath.Join(s.siteBrandIconDir(), record.ID+record.Ext)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return nil, fmt.Errorf("write icon asset: %w", err)
	}
	records = append(records, record)
	if err := s.saveSiteBrandIconRecords(records); err != nil {
		_ = os.Remove(path)
		return nil, err
	}
	return s.siteBrandIconResponse(record), nil
}

func (s *Service) selectedSiteBrandIcon(ctx context.Context) (siteBrandIconRecord, string, bool, error) {
	db, err := s.store.Open(ctx)
	if err != nil {
		return siteBrandIconRecord{}, "", false, err
	}
	defer db.Close()

	settings, err := loadUserSettings(ctx, db)
	if err != nil {
		return siteBrandIconRecord{}, "", false, err
	}
	id := strings.TrimSpace(fmt.Sprint(settings["siteBrandIconId"]))
	if id == "" || id == "<nil>" {
		return siteBrandIconRecord{}, "", false, nil
	}
	return s.findSiteBrandIcon(id)
}

func (s *Service) findSiteBrandIcon(id string) (siteBrandIconRecord, string, bool, error) {
	if id == "" || strings.Contains(id, "/") || strings.Contains(id, "\\") || strings.Contains(id, "..") {
		return siteBrandIconRecord{}, "", false, nil
	}
	records, err := s.loadSiteBrandIconRecords()
	if err != nil {
		return siteBrandIconRecord{}, "", false, err
	}
	for _, item := range records {
		if item.ID != id {
			continue
		}
		path := filepath.Join(s.siteBrandIconDir(), item.ID+item.Ext)
		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			return siteBrandIconRecord{}, "", false, nil
		}
		return item, path, true, nil
	}
	return siteBrandIconRecord{}, "", false, nil
}

func (s *Service) loadSiteBrandIconRecords() ([]siteBrandIconRecord, error) {
	path := s.siteBrandIconMetaPath()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []siteBrandIconRecord{}, nil
		}
		return nil, fmt.Errorf("read site brand icons: %w", err)
	}
	var records []siteBrandIconRecord
	if err := json.Unmarshal(data, &records); err != nil {
		return nil, fmt.Errorf("decode site brand icons: %w", err)
	}
	filtered := make([]siteBrandIconRecord, 0, len(records))
	for _, item := range records {
		if strings.TrimSpace(item.ID) == "" || strings.TrimSpace(item.Ext) == "" {
			continue
		}
		filtered = append(filtered, item)
	}
	return filtered, nil
}

func (s *Service) saveSiteBrandIconRecords(records []siteBrandIconRecord) error {
	if err := os.MkdirAll(filepath.Dir(s.siteBrandIconMetaPath()), 0o755); err != nil {
		return fmt.Errorf("prepare site brand icon metadata: %w", err)
	}
	data, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return fmt.Errorf("encode site brand icons: %w", err)
	}
	tmp := s.siteBrandIconMetaPath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("write site brand icon metadata: %w", err)
	}
	if err := os.Rename(tmp, s.siteBrandIconMetaPath()); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("replace site brand icon metadata: %w", err)
	}
	return nil
}

func (s *Service) siteBrandIconMetaPath() string {
	return filepath.Join(s.cfg.DataDir, "site-brand", "icons.json")
}

func (s *Service) siteBrandIconDir() string {
	return filepath.Join(s.cfg.DataDir, "site-brand", "icons")
}

func (s *Service) siteBrandIconResponse(record siteBrandIconRecord) map[string]string {
	return map[string]string{
		"id":          record.ID,
		"name":        record.Name,
		"ext":         record.Ext,
		"url":         "/api/settings/site-brand/icons/" + record.ID,
		"createdAt":   record.CreatedAt,
		"contentType": record.ContentType,
	}
}

func detectSiteBrandIconFormat(data []byte, declaredContentType string, fileName string) (string, string, error) {
	text := strings.ToLower(strings.TrimSpace(string(data)))
	if strings.Contains(text, "<svg") && strings.Contains(text, "</svg>") {
		return ".svg", "image/svg+xml; charset=utf-8", nil
	}
	contentType := http.DetectContentType(data)
	switch contentType {
	case "image/png":
		return ".png", contentType, nil
	case "image/jpeg":
		return ".jpg", contentType, nil
	case "image/gif":
		return ".gif", contentType, nil
	case "image/webp":
		return ".webp", contentType, nil
	}
	lowerName := strings.ToLower(fileName)
	switch {
	case strings.HasSuffix(lowerName, ".svg"):
		return ".svg", "image/svg+xml; charset=utf-8", nil
	case strings.HasSuffix(lowerName, ".png"):
		return ".png", "image/png", nil
	case strings.HasSuffix(lowerName, ".jpg"), strings.HasSuffix(lowerName, ".jpeg"):
		return ".jpg", "image/jpeg", nil
	case strings.HasSuffix(lowerName, ".gif"):
		return ".gif", "image/gif", nil
	case strings.HasSuffix(lowerName, ".webp"):
		return ".webp", "image/webp", nil
	}
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(declaredContentType)), "image/") {
		return "", "", fmt.Errorf("unsupported image type")
	}
	return "", "", fmt.Errorf("unsupported file type, only svg/png/jpg/webp/gif are allowed")
}

func isSafeSiteBrandSVG(data []byte) bool {
	text := strings.ToLower(strings.TrimSpace(string(data)))
	if !strings.Contains(text, "<svg") || !strings.Contains(text, "</svg>") {
		return false
	}
	blocked := []string{"<script", "<foreignobject", " onload=", " onclick=", "javascript:", "data:text/html"}
	for _, item := range blocked {
		if strings.Contains(text, item) {
			return false
		}
	}
	return true
}

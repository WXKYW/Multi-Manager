package totp

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/iwvw/api-monitor/backend-go/internal/response"
)

type customBrandIconRecord struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Issuer      string `json:"issuer,omitempty"`
	Color       string `json:"color,omitempty"`
	Ext         string `json:"ext"`
	ContentType string `json:"content_type"`
	CreatedAt   string `json:"created_at"`
}

func (s *Service) listCustomBrandIcons(w http.ResponseWriter, r *http.Request) {
	records, err := s.loadCustomBrandIconRecords()
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
		items = append(items, map[string]string{
			"id":         item.ID,
			"icon":       "custom:" + item.ID,
			"name":       item.Name,
			"issuer":     item.Issuer,
			"color":      item.Color,
			"source":     "custom",
			"license":    "User Upload",
			"url":        "/api/totp/icons/custom-" + item.ID,
			"created_at": item.CreatedAt,
		})
	}
	response.OK(w, items)
}

func (s *Service) uploadCustomBrandIcon(w http.ResponseWriter, r *http.Request) {
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

	data, err := io.ReadAll(io.LimitReader(file, 600*1024))
	if err != nil {
		response.Error(w, http.StatusBadRequest, "read upload failed")
		return
	}
	if len(data) == 0 {
		response.Error(w, http.StatusBadRequest, "empty upload file")
		return
	}

	ext, contentType, err := detectCustomBrandIconFormat(data, header.Header.Get("Content-Type"), header.Filename)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	if ext == ".svg" && !isSafeSVG(data) {
		response.Error(w, http.StatusBadRequest, "unsupported svg")
		return
	}

	records, err := s.loadCustomBrandIconRecords()
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	baseName := strings.TrimSpace(r.FormValue("name"))
	if baseName == "" {
		baseName = strings.TrimSuffix(header.Filename, filepath.Ext(header.Filename))
	}
	if baseName == "" {
		baseName = "自定义图标"
	}
	id := uniqueCustomBrandIconID(records, baseName)
	color := strings.TrimSpace(r.FormValue("color"))
	issuer := strings.TrimSpace(r.FormValue("issuer"))
	record := customBrandIconRecord{
		ID:          id,
		Name:        baseName,
		Issuer:      issuer,
		Color:       color,
		Ext:         ext,
		ContentType: contentType,
		CreatedAt:   nowISO(),
	}

	if err := os.MkdirAll(s.customBrandIconDir(), 0o755); err != nil {
		response.Error(w, http.StatusInternalServerError, "prepare icon storage failed")
		return
	}
	if err := writeFileAtomically(recordPathForCustomBrandIcon(s.customBrandIconDir(), record)+".tmp", recordPathForCustomBrandIcon(s.customBrandIconDir(), record), data); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	records = append(records, record)
	if err := s.saveCustomBrandIconRecords(records); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	response.OK(w, map[string]string{
		"id":      record.ID,
		"icon":    "custom:" + record.ID,
		"name":    record.Name,
		"issuer":  record.Issuer,
		"color":   record.Color,
		"source":  "custom",
		"license": "User Upload",
		"url":     "/api/totp/icons/custom-" + record.ID,
	})
}

func (s *Service) serveCustomBrandIcon(w http.ResponseWriter, r *http.Request, id string) {
	if !safeBrandIconKeyPattern.MatchString(id) {
		response.Error(w, http.StatusBadRequest, "invalid custom icon key")
		return
	}
	records, err := s.loadCustomBrandIconRecords()
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	var found *customBrandIconRecord
	for i := range records {
		if records[i].ID == id {
			found = &records[i]
			break
		}
	}
	if found == nil {
		response.Error(w, http.StatusNotFound, "icon not found")
		return
	}
	path := recordPathForCustomBrandIcon(s.customBrandIconDir(), *found)
	if _, err := os.Stat(path); err != nil {
		response.Error(w, http.StatusNotFound, "icon file missing")
		return
	}
	w.Header().Set("Content-Type", defaultString(found.ContentType, "image/svg+xml; charset=utf-8"))
	w.Header().Set("Cache-Control", "public, max-age=604800")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, path)
}

func (s *Service) loadCustomBrandIconRecords() ([]customBrandIconRecord, error) {
	path := s.customBrandIconMetaPath()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []customBrandIconRecord{}, nil
		}
		return nil, fmt.Errorf("read custom icon metadata: %w", err)
	}
	var records []customBrandIconRecord
	if err := json.Unmarshal(data, &records); err != nil {
		return nil, fmt.Errorf("parse custom icon metadata: %w", err)
	}
	filtered := make([]customBrandIconRecord, 0, len(records))
	for _, item := range records {
		if !safeBrandIconKeyPattern.MatchString(item.ID) {
			continue
		}
		if item.Ext == "" || item.ContentType == "" {
			continue
		}
		filtered = append(filtered, item)
	}
	return filtered, nil
}

func (s *Service) saveCustomBrandIconRecords(records []customBrandIconRecord) error {
	if err := os.MkdirAll(filepath.Dir(s.customBrandIconMetaPath()), 0o755); err != nil {
		return fmt.Errorf("prepare custom icon metadata: %w", err)
	}
	data, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return fmt.Errorf("encode custom icon metadata: %w", err)
	}
	return writeFileAtomically(s.customBrandIconMetaPath()+".tmp", s.customBrandIconMetaPath(), data)
}

func (s *Service) customBrandIconMetaPath() string {
	return filepath.Join(s.cfg.DataDir, "totp-icons", "custom-icons.json")
}

func (s *Service) customBrandIconDir() string {
	return filepath.Join(s.cfg.DataDir, "totp-icons", "custom")
}

func detectCustomBrandIconFormat(data []byte, declaredContentType string, fileName string) (string, string, error) {
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

func uniqueCustomBrandIconID(records []customBrandIconRecord, name string) string {
	base := slugifyCustomBrandIconID(name)
	if base == "" {
		base = randomID("icon")
		base = strings.TrimPrefix(base, "icon_")
		base = strings.ReplaceAll(base, "_", "-")
	}
	exists := map[string]bool{}
	for _, item := range records {
		exists[item.ID] = true
	}
	if !exists[base] {
		return base
	}
	for i := 2; i < 1000; i += 1 {
		candidate := fmt.Sprintf("%s-%d", base, i)
		if !exists[candidate] {
			return candidate
		}
	}
	return base + "-" + strings.ReplaceAll(randomID("x"), "_", "-")
}

func slugifyCustomBrandIconID(value string) string {
	var builder strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(strings.TrimSpace(value)) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			builder.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			builder.WriteByte('-')
			lastDash = true
		}
	}
	id := strings.Trim(builder.String(), "-")
	if len(id) > 72 {
		id = strings.Trim(id[:72], "-")
	}
	if !safeBrandIconKeyPattern.MatchString(id) {
		return ""
	}
	return id
}

func recordPathForCustomBrandIcon(dir string, record customBrandIconRecord) string {
	return filepath.Join(dir, record.ID+record.Ext)
}

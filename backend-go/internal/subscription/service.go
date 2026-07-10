package subscription

import (
	"context"
	"crypto/rand"
	"database/sql"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/iwvw/api-monitor/backend-go/internal/config"
	"github.com/iwvw/api-monitor/backend-go/internal/database"
	"github.com/iwvw/api-monitor/backend-go/internal/response"
	"github.com/iwvw/api-monitor/backend-go/internal/secure"
	"gopkg.in/yaml.v3"
)

const (
	defaultTemplateID   = "builtin_mihomo_default"
	rawTemplateID       = "builtin_raw_uri"
	base64TemplateID    = "builtin_base64_uri"
	defaultNodeLibrary  = "sub_default_nodes"
	defaultLimitPerMin  = 30
	defaultRefreshHours = 24
)

var nodeLinkPattern = regexp.MustCompile(`(?im)(vmess|vless|trojan|ss|hysteria2|hy2|tuic|socks|http)://[^\s'"<>]+`)

//go:embed templates/default-mihomo.yaml
var defaultMihomoTemplateEmbedded string

type Service struct {
	cfg        config.Config
	store      *database.Store
	client     *http.Client
	refreshMu  sync.Mutex
	stopAuto   context.CancelFunc
	autoClosed chan struct{}
}

type Subscription struct {
	ID                    string           `json:"id"`
	ProfileID             string           `json:"profile_id"`
	Name                  string           `json:"name"`
	Remark                string           `json:"remark"`
	Enabled               bool             `json:"enabled"`
	PublicToken           string           `json:"public_token"`
	TemplateID            string           `json:"template_id"`
	TrafficSource         string           `json:"traffic_source"`
	TrafficServerID       string           `json:"traffic_server_id,omitempty"`
	UpstreamURL           string           `json:"upstream_url,omitempty"`
	UpstreamEnabled       bool             `json:"upstream_enabled"`
	UpstreamRefreshHours  int              `json:"upstream_refresh_hours"`
	UpstreamStatus        string           `json:"upstream_status,omitempty"`
	UpstreamLastError     string           `json:"upstream_last_error,omitempty"`
	UpstreamLastRefreshAt string           `json:"upstream_last_refresh_at,omitempty"`
	TotalBytes            int64            `json:"total_bytes"`
	ManualUploadBytes     int64            `json:"manual_upload_bytes"`
	ManualDownloadBytes   int64            `json:"manual_download_bytes"`
	ExpireAt              string           `json:"expire_at,omitempty"`
	CycleType             string           `json:"cycle_type"`
	CycleDay              int              `json:"cycle_day"`
	CycleStart            string           `json:"cycle_start,omitempty"`
	CycleEnd              string           `json:"cycle_end,omitempty"`
	BaselineUploadBytes   int64            `json:"baseline_upload_bytes"`
	BaselineDownloadBytes int64            `json:"baseline_download_bytes"`
	RateLimitEnabled      bool             `json:"rate_limit_enabled"`
	RateLimitPerMinute    int              `json:"rate_limit_per_minute"`
	NodeFilterIDs         []string         `json:"node_filter_ids,omitempty"`
	CreatedAt             string           `json:"created_at"`
	UpdatedAt             string           `json:"updated_at"`
	NodeCount             int              `json:"node_count"`
	AccessCountToday      int              `json:"access_count_today"`
	LastAccessAt          string           `json:"last_access_at,omitempty"`
	Traffic               TrafficInfo      `json:"traffic"`
	Quality               []QualitySummary `json:"quality,omitempty"`
}

type NodeLibrary struct {
	ID                    string      `json:"id"`
	Name                  string      `json:"name"`
	Remark                string      `json:"remark"`
	Enabled               bool        `json:"enabled"`
	TemplateID            string      `json:"template_id"`
	TrafficSource         string      `json:"traffic_source"`
	TrafficServerID       string      `json:"traffic_server_id,omitempty"`
	UpstreamURL           string      `json:"upstream_url,omitempty"`
	UpstreamEnabled       bool        `json:"upstream_enabled"`
	UpstreamRefreshHours  int         `json:"upstream_refresh_hours"`
	UpstreamStatus        string      `json:"upstream_status,omitempty"`
	UpstreamLastError     string      `json:"upstream_last_error,omitempty"`
	UpstreamLastRefreshAt string      `json:"upstream_last_refresh_at,omitempty"`
	UpstreamUserinfo      string      `json:"upstream_userinfo,omitempty"`
	TotalBytes            int64       `json:"total_bytes"`
	ManualUploadBytes     int64       `json:"manual_upload_bytes"`
	ManualDownloadBytes   int64       `json:"manual_download_bytes"`
	ExpireAt              string      `json:"expire_at,omitempty"`
	CycleType             string      `json:"cycle_type"`
	CycleDay              int         `json:"cycle_day"`
	CycleStart            string      `json:"cycle_start,omitempty"`
	CycleEnd              string      `json:"cycle_end,omitempty"`
	BaselineUploadBytes   int64       `json:"baseline_upload_bytes"`
	BaselineDownloadBytes int64       `json:"baseline_download_bytes"`
	RateLimitEnabled      bool        `json:"rate_limit_enabled"`
	RateLimitPerMinute    int         `json:"rate_limit_per_minute"`
	NodeFilterTags        string      `json:"node_filter_tags,omitempty"`
	SortOrder             int         `json:"sort_order"`
	CreatedAt             string      `json:"created_at"`
	UpdatedAt             string      `json:"updated_at"`
	NodeCount             int         `json:"node_count"`
	SubscriptionCount     int         `json:"subscription_count"`
	Traffic               TrafficInfo `json:"traffic"`
}

type Node struct {
	ID              string           `json:"id"`
	SubscriptionID  string           `json:"subscription_id"`
	ProfileID       string           `json:"profile_id"`
	Name            string           `json:"name"`
	Type            string           `json:"type"`
	Server          string           `json:"server"`
	Port            int              `json:"port"`
	CountryCode     string           `json:"country_code,omitempty"`
	Location        string           `json:"location,omitempty"`
	Tags            string           `json:"tags,omitempty"`
	TrafficServerID string           `json:"traffic_server_id,omitempty"`
	Enabled         bool             `json:"enabled"`
	Stable          bool             `json:"stable"`
	SortOrder       int              `json:"sort_order"`
	Raw             string           `json:"raw,omitempty"`
	ConfigJSON      string           `json:"config_json,omitempty"`
	Source          string           `json:"source,omitempty"`
	CreatedAt       string           `json:"created_at"`
	UpdatedAt       string           `json:"updated_at"`
	Quality         []QualitySummary `json:"quality,omitempty"`
}

type Template struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Format      string `json:"format"`
	Content     string `json:"content"`
	Builtin     bool   `json:"builtin"`
	IsDefault   bool   `json:"is_default"`
	Description string `json:"description"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

type TrafficInfo struct {
	Upload   int64   `json:"upload"`
	Download int64   `json:"download"`
	Total    int64   `json:"total"`
	Expire   int64   `json:"expire"`
	Percent  float64 `json:"percent"`
	Source   string  `json:"source"`
	Status   string  `json:"status"`
}

type QualitySummary struct {
	Name         string  `json:"name"`
	LatencyMS    float64 `json:"latency_ms"`
	AvgLatencyMS float64 `json:"avg_latency_ms"`
	JitterMS     float64 `json:"jitter_ms"`
	LossRate     float64 `json:"loss_rate"`
	SampledAt    string  `json:"sampled_at"`
}

type Settings struct {
	DefaultTemplateID       string `json:"default_template_id"`
	DefaultRateLimitEnabled bool   `json:"default_rate_limit_enabled"`
	DefaultRateLimitPerMin  int    `json:"default_rate_limit_per_minute"`
	DefaultRefreshHours     int    `json:"default_refresh_hours"`
	GeoIPEnabled            bool   `json:"geoip_enabled"`
}

func New(cfg config.Config) *Service {
	return &Service{
		cfg:    cfg,
		store:  database.New(cfg),
		client: &http.Client{Timeout: 20 * time.Second},
	}
}

func (s *Service) StartAutoRefresh(ctx context.Context) {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	if s.stopAuto != nil {
		return
	}
	runCtx, cancel := context.WithCancel(ctx)
	s.stopAuto = cancel
	s.autoClosed = make(chan struct{})
	go s.autoRefreshLoop(runCtx)
}

func (s *Service) StopAutoRefresh() {
	s.refreshMu.Lock()
	cancel := s.stopAuto
	closed := s.autoClosed
	s.stopAuto = nil
	s.autoClosed = nil
	s.refreshMu.Unlock()
	if cancel != nil {
		cancel()
	}
	if closed != nil {
		<-closed
	}
}

func (s *Service) autoRefreshLoop(ctx context.Context) {
	defer close(s.autoClosed)
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	s.refreshDueUpstreams(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.refreshDueUpstreams(ctx)
		}
	}
}

func (s *Service) refreshDueUpstreams(ctx context.Context) {
	db, err := s.open(ctx)
	if err != nil {
		return
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, `SELECT s.id
		FROM subscription_subscriptions s
		LEFT JOIN subscription_upstreams u ON u.profile_id = COALESCE(s.profile_id, s.id)
		WHERE s.enabled = 1
			AND COALESCE(u.enabled, s.upstream_enabled, 0) = 1
			AND COALESCE(u.url, s.upstream_url, '') != ''
			AND (
				COALESCE(u.last_refresh_at, s.upstream_last_refresh_at, '') = ''
				OR datetime(COALESCE(u.last_refresh_at, s.upstream_last_refresh_at)) <= datetime('now', '-' || COALESCE(NULLIF(u.refresh_hours, 0), NULLIF(s.upstream_refresh_hours, 0), 24) || ' hours')
			)
		ORDER BY s.updated_at ASC
		LIMIT 10`)
	if err != nil {
		return
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil && id != "" {
			ids = append(ids, id)
		}
	}
	_ = rows.Close()
	for _, id := range ids {
		if ctx.Err() != nil {
			return
		}
		_ = s.refreshUpstreamNow(ctx, db, id)
	}
}

func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/sub/") {
		s.servePublicSubscription(w, r)
		return
	}

	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/subscription"), "/")
	parts := []string{}
	if path != "" {
		parts = strings.Split(path, "/")
	}

	db, err := s.open(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer db.Close()

	switch {
	case len(parts) == 0 || (len(parts) == 1 && parts[0] == "summary"):
		s.summary(w, r, db)
	case len(parts) == 1 && parts[0] == "profiles":
		switch r.Method {
		case http.MethodGet:
			s.listProfiles(w, r, db)
		case http.MethodPost:
			s.createProfile(w, r, db)
		default:
			response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	case len(parts) == 2 && parts[0] == "profiles":
		switch r.Method {
		case http.MethodGet:
			s.getProfile(w, r, db, parts[1])
		case http.MethodPut:
			s.updateProfile(w, r, db, parts[1])
		case http.MethodDelete:
			s.deleteProfile(w, r, db, parts[1])
		default:
			response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	case len(parts) == 3 && parts[0] == "profiles" && parts[2] == "refresh-upstream":
		if r.Method != http.MethodPost {
			response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.refreshProfileUpstream(w, r, db, parts[1])
	case len(parts) == 1 && parts[0] == "subscriptions":
		switch r.Method {
		case http.MethodGet:
			s.listSubscriptions(w, r, db)
		case http.MethodPost:
			s.createSubscription(w, r, db)
		default:
			response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	case len(parts) == 2 && parts[0] == "subscriptions":
		switch r.Method {
		case http.MethodGet:
			s.getSubscription(w, r, db, parts[1])
		case http.MethodPut:
			s.updateSubscription(w, r, db, parts[1])
		case http.MethodDelete:
			s.deleteSubscription(w, r, db, parts[1])
		default:
			response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	case len(parts) == 3 && parts[0] == "subscriptions" && parts[2] == "reset-token":
		if r.Method != http.MethodPost {
			response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.resetToken(w, r, db, parts[1])
	case len(parts) == 3 && parts[0] == "subscriptions" && parts[2] == "refresh-upstream":
		if r.Method != http.MethodPost {
			response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.refreshUpstream(w, r, db, parts[1])
	case len(parts) == 1 && parts[0] == "nodes":
		if r.Method != http.MethodGet {
			response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.listNodes(w, r, db)
	case len(parts) == 2 && parts[0] == "nodes" && parts[1] == "reorder":
		if r.Method != http.MethodPost {
			response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.reorderNodes(w, r, db)
	case len(parts) == 2 && parts[0] == "nodes":
		switch r.Method {
		case http.MethodPut:
			s.updateNode(w, r, db, parts[1])
		case http.MethodDelete:
			s.deleteNode(w, r, db, parts[1])
		default:
			response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	case len(parts) == 2 && parts[0] == "import" && parts[1] == "preview":
		if r.Method != http.MethodPost {
			response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.importPreview(w, r)
	case len(parts) == 2 && parts[0] == "import" && parts[1] == "commit":
		if r.Method != http.MethodPost {
			response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.importCommit(w, r, db)
	case len(parts) == 1 && parts[0] == "templates":
		switch r.Method {
		case http.MethodGet:
			s.listTemplates(w, r, db)
		case http.MethodPost:
			s.createTemplate(w, r, db)
		default:
			response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	case len(parts) == 2 && parts[0] == "templates":
		switch r.Method {
		case http.MethodPut:
			s.updateTemplate(w, r, db, parts[1])
		case http.MethodDelete:
			s.deleteTemplate(w, r, db, parts[1])
		default:
			response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	case len(parts) == 3 && parts[0] == "templates" && parts[2] == "default":
		if r.Method != http.MethodPost {
			response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.setDefaultTemplate(w, r, db, parts[1])
	case len(parts) == 2 && parts[0] == "templates" && parts[1] == "restore-builtins":
		if r.Method != http.MethodPost {
			response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		if err := ensureBuiltins(r.Context(), db, true); err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		response.OK(w, map[string]bool{"restored": true})
	case len(parts) == 1 && parts[0] == "logs":
		if r.Method != http.MethodGet {
			response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.listLogs(w, r, db)
	case len(parts) == 1 && parts[0] == "settings":
		switch r.Method {
		case http.MethodGet:
			s.getSettings(w, r, db)
		case http.MethodPut:
			s.updateSettings(w, r, db)
		default:
			response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	case len(parts) == 1 && parts[0] == "servers":
		if r.Method != http.MethodGet {
			response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.listServers(w, r, db)
	case len(parts) == 1 && parts[0] == "export":
		if r.Method != http.MethodGet {
			response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.exportAll(w, r, db)
	default:
		response.Error(w, http.StatusNotFound, "subscription route not found")
	}
}

func (s *Service) open(ctx context.Context) (*sql.DB, error) {
	db, err := s.store.Open(ctx)
	if err != nil {
		return nil, err
	}
	if err := ensureSchema(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	if err := ensureBuiltins(ctx, db, false); err != nil {
		db.Close()
		return nil, err
	}
	if err := ensureDefaultNodeLibrary(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func ensureSchema(ctx context.Context, db *sql.DB) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS subscription_settings (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			default_template_id TEXT DEFAULT 'builtin_mihomo_default',
			default_rate_limit_enabled INTEGER DEFAULT 1,
			default_rate_limit_per_minute INTEGER DEFAULT 30,
			default_refresh_hours INTEGER DEFAULT 24,
			geoip_enabled INTEGER DEFAULT 1,
			updated_at TEXT DEFAULT (datetime('now'))
		)`,
		`INSERT OR IGNORE INTO subscription_settings (id) VALUES (1)`,
		`CREATE TABLE IF NOT EXISTS subscription_templates (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			format TEXT NOT NULL,
			content TEXT NOT NULL,
			builtin INTEGER DEFAULT 0,
			is_default INTEGER DEFAULT 0,
			description TEXT,
			created_at TEXT DEFAULT (datetime('now')),
			updated_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE TABLE IF NOT EXISTS subscription_profiles (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			remark TEXT,
			enabled INTEGER DEFAULT 1,
			template_id TEXT DEFAULT 'builtin_mihomo_default',
			traffic_source TEXT DEFAULT 'manual',
			traffic_server_id TEXT,
			total_bytes INTEGER DEFAULT 0,
			manual_upload_bytes INTEGER DEFAULT 0,
			manual_download_bytes INTEGER DEFAULT 0,
			expire_at TEXT,
			cycle_type TEXT DEFAULT 'none',
			cycle_day INTEGER DEFAULT 1,
			cycle_start TEXT,
			cycle_end TEXT,
			baseline_upload_bytes INTEGER DEFAULT 0,
			baseline_download_bytes INTEGER DEFAULT 0,
			rate_limit_enabled INTEGER DEFAULT 1,
			rate_limit_per_minute INTEGER DEFAULT 30,
			node_filter_tags TEXT DEFAULT '',
			sort_order INTEGER DEFAULT 0,
			created_at TEXT DEFAULT (datetime('now')),
			updated_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE TABLE IF NOT EXISTS subscription_upstreams (
			id TEXT PRIMARY KEY,
			profile_id TEXT NOT NULL,
			name TEXT NOT NULL,
			url TEXT NOT NULL,
			enabled INTEGER DEFAULT 1,
			refresh_hours INTEGER DEFAULT 24,
			status TEXT,
			last_error TEXT,
			last_refresh_at TEXT,
			userinfo TEXT,
			created_at TEXT DEFAULT (datetime('now')),
			updated_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE TABLE IF NOT EXISTS subscription_subscriptions (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			remark TEXT,
			enabled INTEGER DEFAULT 1,
			public_token TEXT NOT NULL UNIQUE,
			template_id TEXT DEFAULT 'builtin_mihomo_default',
			traffic_source TEXT DEFAULT 'manual',
			traffic_server_id TEXT,
			upstream_url TEXT,
			upstream_enabled INTEGER DEFAULT 0,
			upstream_refresh_hours INTEGER DEFAULT 24,
			upstream_status TEXT,
			upstream_last_error TEXT,
			upstream_last_refresh_at TEXT,
			upstream_userinfo TEXT,
			total_bytes INTEGER DEFAULT 0,
			manual_upload_bytes INTEGER DEFAULT 0,
			manual_download_bytes INTEGER DEFAULT 0,
			expire_at TEXT,
			cycle_type TEXT DEFAULT 'none',
			cycle_day INTEGER DEFAULT 1,
			cycle_start TEXT,
			cycle_end TEXT,
			baseline_upload_bytes INTEGER DEFAULT 0,
			baseline_download_bytes INTEGER DEFAULT 0,
			rate_limit_enabled INTEGER DEFAULT 1,
			rate_limit_per_minute INTEGER DEFAULT 30,
			node_filter_ids TEXT DEFAULT '',
			created_at TEXT DEFAULT (datetime('now')),
			updated_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_subscriptions_token ON subscription_subscriptions(public_token)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_upstreams_profile ON subscription_upstreams(profile_id)`,
		`CREATE TABLE IF NOT EXISTS subscription_nodes (
			id TEXT PRIMARY KEY,
			subscription_id TEXT NOT NULL,
			name TEXT NOT NULL,
			type TEXT,
			server TEXT,
			port INTEGER DEFAULT 0,
			country_code TEXT,
			location TEXT,
			tags TEXT,
			traffic_server_id TEXT,
			enabled INTEGER DEFAULT 1,
			stable INTEGER DEFAULT 0,
			sort_order INTEGER DEFAULT 0,
			raw_encrypted TEXT,
			config_encrypted TEXT,
			fingerprint TEXT,
			source TEXT DEFAULT 'manual',
			created_at TEXT DEFAULT (datetime('now')),
			updated_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_nodes_subscription ON subscription_nodes(subscription_id, sort_order)`,
		`CREATE TABLE IF NOT EXISTS subscription_access_logs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			subscription_id TEXT,
			public_token TEXT,
			ip_address TEXT,
			user_agent TEXT,
			format TEXT,
			success INTEGER DEFAULT 0,
			status_code INTEGER DEFAULT 200,
			error_message TEXT,
			node_count INTEGER DEFAULT 0,
			upload_bytes INTEGER DEFAULT 0,
			download_bytes INTEGER DEFAULT 0,
			total_bytes INTEGER DEFAULT 0,
			expire_at INTEGER DEFAULT 0,
			created_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_subscription_access_logs_subscription ON subscription_access_logs(subscription_id, created_at)`,
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("ensure subscription schema: %w", err)
		}
	}
	if err := ensureColumn(ctx, db, "subscription_subscriptions", "profile_id", "ALTER TABLE subscription_subscriptions ADD COLUMN profile_id TEXT"); err != nil {
		return err
	}
	if err := ensureColumn(ctx, db, "subscription_nodes", "profile_id", "ALTER TABLE subscription_nodes ADD COLUMN profile_id TEXT"); err != nil {
		return err
	}
	if err := ensureColumn(ctx, db, "subscription_nodes", "traffic_server_id", "ALTER TABLE subscription_nodes ADD COLUMN traffic_server_id TEXT"); err != nil {
		return err
	}
	if err := ensureColumn(ctx, db, "subscription_subscriptions", "node_filter_ids", "ALTER TABLE subscription_subscriptions ADD COLUMN node_filter_ids TEXT DEFAULT ''"); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_subscription_subscriptions_profile ON subscription_subscriptions(profile_id)`); err != nil {
		return fmt.Errorf("create subscription profile index: %w", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE subscription_subscriptions SET profile_id = id WHERE COALESCE(profile_id, '') = ''`); err != nil {
		return fmt.Errorf("normalize subscription profile ids: %w", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE subscription_nodes SET profile_id = subscription_id WHERE COALESCE(profile_id, '') = ''`); err != nil {
		return fmt.Errorf("normalize node profile ids: %w", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT OR IGNORE INTO subscription_profiles (
			id, name, remark, enabled, template_id, traffic_source, traffic_server_id,
			total_bytes, manual_upload_bytes, manual_download_bytes, expire_at, cycle_type,
			cycle_day, cycle_start, cycle_end, baseline_upload_bytes, baseline_download_bytes,
			rate_limit_enabled, rate_limit_per_minute, created_at, updated_at
		)
		SELECT profile_id, name, remark, enabled, template_id, traffic_source, traffic_server_id,
			total_bytes, manual_upload_bytes, manual_download_bytes, expire_at, cycle_type,
			cycle_day, cycle_start, cycle_end, baseline_upload_bytes, baseline_download_bytes,
			rate_limit_enabled, rate_limit_per_minute, created_at, updated_at
		FROM subscription_subscriptions
		WHERE COALESCE(profile_id, '') != ''`); err != nil {
		return fmt.Errorf("seed subscription profiles: %w", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT OR IGNORE INTO subscription_upstreams (
			id, profile_id, name, url, enabled, refresh_hours, status, last_error, last_refresh_at, userinfo, created_at, updated_at
		)
		SELECT 'up_' || profile_id, profile_id, '默认上游', upstream_url, upstream_enabled, upstream_refresh_hours,
			upstream_status, upstream_last_error, upstream_last_refresh_at, upstream_userinfo, created_at, updated_at
		FROM subscription_subscriptions
		WHERE COALESCE(profile_id, '') != '' AND COALESCE(upstream_url, '') != ''`); err != nil {
		return fmt.Errorf("seed subscription upstreams: %w", err)
	}
	return nil
}

func ensureColumn(ctx context.Context, db *sql.DB, tableName, columnName, alterSQL string) error {
	rows, err := db.QueryContext(ctx, fmt.Sprintf(`PRAGMA table_info(%s)`, tableName))
	if err != nil {
		return fmt.Errorf("inspect %s columns: %w", tableName, err)
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, typ string
		var notNull int
		var defaultValue sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &pk); err != nil {
			return fmt.Errorf("scan %s columns: %w", tableName, err)
		}
		if name == columnName {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate %s columns: %w", tableName, err)
	}
	if _, err := db.ExecContext(ctx, alterSQL); err != nil {
		return fmt.Errorf("add %s.%s: %w", tableName, columnName, err)
	}
	return nil
}

func ensureDefaultNodeLibrary(ctx context.Context, db *sql.DB) error {
	var count int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM subscription_subscriptions`).Scan(&count); err != nil {
		return fmt.Errorf("count node libraries: %w", err)
	}
	if count > 0 {
		return nil
	}
	token := randomToken()
	_, err := db.ExecContext(ctx, `INSERT INTO subscription_subscriptions (
			id, profile_id, name, remark, enabled, public_token, template_id, traffic_source,
			upstream_enabled, upstream_refresh_hours, rate_limit_enabled, rate_limit_per_minute, updated_at
		) VALUES (?, ?, '默认节点库', '系统默认节点接管空间', 1, ?, ?, 'manual', 0, 24, 0, 30, datetime('now'))`,
		defaultNodeLibrary, defaultNodeLibrary, token, rawTemplateID)
	if err != nil {
		return fmt.Errorf("create default node library: %w", err)
	}
	input := Subscription{Name: "默认节点库", Remark: "系统默认节点接管空间", Enabled: true}
	if err := upsertProfile(ctx, db, defaultNodeLibrary, input, rawTemplateID, "manual", "none", 1, defaultLimitPerMin); err != nil {
		return err
	}
	return nil
}

func ensureBuiltins(ctx context.Context, db *sql.DB, overwrite bool) error {
	defaultTemplate := loadDefaultMihomoTemplate()
	templates := []Template{
		{ID: rawTemplateID, Name: "Raw URI List", Format: "raw", Content: "{{ raw_uri_list }}", Builtin: true, Description: "一行一个节点链接"},
		{ID: base64TemplateID, Name: "Base64 URI List", Format: "base64", Content: "{{ raw_uri_list }}", Builtin: true, Description: "v2rayN 常用 Base64 订阅"},
	}
	if strings.TrimSpace(defaultTemplate) != "" {
		templates = append([]Template{{ID: defaultTemplateID, Name: "默认 Mihomo/Clash YAML", Format: "clash", Content: defaultTemplate, Builtin: true, IsDefault: true, Description: "基于项目默认三网分流配置的 Mihomo 模板"}}, templates...)
	}
	for _, tpl := range templates {
		if overwrite {
			_, err := db.ExecContext(ctx, `INSERT INTO subscription_templates (id, name, format, content, builtin, is_default, description, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
				ON CONFLICT(id) DO UPDATE SET name = excluded.name, format = excluded.format, content = excluded.content, builtin = excluded.builtin, description = excluded.description, updated_at = datetime('now')`,
				tpl.ID, tpl.Name, tpl.Format, tpl.Content, boolToInt(tpl.Builtin), boolToInt(tpl.IsDefault), tpl.Description)
			if err != nil {
				return err
			}
			continue
		}
		_, err := db.ExecContext(ctx, `INSERT OR IGNORE INTO subscription_templates (id, name, format, content, builtin, is_default, description)
			VALUES (?, ?, ?, ?, ?, ?, ?)`, tpl.ID, tpl.Name, tpl.Format, tpl.Content, boolToInt(tpl.Builtin), boolToInt(tpl.IsDefault), tpl.Description)
		if err != nil {
			return err
		}
	}
	_, _ = db.ExecContext(ctx, `UPDATE subscription_templates SET is_default = CASE WHEN id = (SELECT default_template_id FROM subscription_settings WHERE id = 1) THEN 1 ELSE 0 END`)
	return nil
}

func (s *Service) summary(w http.ResponseWriter, r *http.Request, db *sql.DB) {
	var total, enabled, expired, exhausted, today int
	_ = db.QueryRowContext(r.Context(), `SELECT COUNT(*), COALESCE(SUM(enabled), 0) FROM subscription_subscriptions`).Scan(&total, &enabled)
	_ = db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM subscription_subscriptions WHERE expire_at IS NOT NULL AND expire_at != '' AND datetime(expire_at) < datetime('now')`).Scan(&expired)
	_ = db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM subscription_access_logs WHERE date(created_at) = date('now')`).Scan(&today)
	subs, _ := loadSubscriptions(r.Context(), db, "")
	for _, sub := range subs {
		if sub.Traffic.Total > 0 && sub.Traffic.Upload+sub.Traffic.Download >= sub.Traffic.Total {
			exhausted++
		}
	}
	response.OK(w, map[string]interface{}{"total": total, "enabled": enabled, "expired": expired, "exhausted": exhausted, "todayAccess": today})
}

func (s *Service) listSubscriptions(w http.ResponseWriter, r *http.Request, db *sql.DB) {
	subs, err := loadSubscriptions(r.Context(), db, "")
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, subs)
}

func (s *Service) listProfiles(w http.ResponseWriter, r *http.Request, db *sql.DB) {
	items, err := loadProfiles(r.Context(), db, "")
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, items)
}

func (s *Service) getProfile(w http.ResponseWriter, r *http.Request, db *sql.DB, id string) {
	items, err := loadProfiles(r.Context(), db, id)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if len(items) == 0 {
		response.Error(w, http.StatusNotFound, "node library not found")
		return
	}
	response.OK(w, items[0])
}

func (s *Service) createProfile(w http.ResponseWriter, r *http.Request, db *sql.DB) {
	var input NodeLibrary
	if !decodeJSON(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.Name) == "" {
		response.Error(w, http.StatusBadRequest, "节点库名称不能为空")
		return
	}
	settings, _ := loadSettings(r.Context(), db)
	id := firstNonEmpty(input.ID, randomID("profile"))
	subInput := subscriptionFromProfile(input)
	subInput.Enabled = input.Enabled || !isExplicitFalse(r, "enabled")
	subInput.RateLimitEnabled = input.RateLimitEnabled || settings.DefaultRateLimitEnabled
	templateID := firstNonEmpty(input.TemplateID, settings.DefaultTemplateID, defaultTemplateID)
	trafficSource := normalizeTrafficSource(input.TrafficSource)
	cycleType := normalizeCycleType(input.CycleType)
	cycleDay := input.CycleDay
	if cycleDay <= 0 {
		cycleDay = 1
	}
	refreshHours := input.UpstreamRefreshHours
	if refreshHours <= 0 {
		refreshHours = settings.DefaultRefreshHours
	}
	limitPerMin := input.RateLimitPerMinute
	if limitPerMin <= 0 {
		limitPerMin = settings.DefaultRateLimitPerMin
	}
	if err := upsertProfile(r.Context(), db, id, subInput, templateID, trafficSource, cycleType, cycleDay, limitPerMin); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := upsertDefaultUpstream(r.Context(), db, id, subInput, refreshHours); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	items, _ := loadProfiles(r.Context(), db, id)
	response.OK(w, firstProfile(items))
}

func (s *Service) updateProfile(w http.ResponseWriter, r *http.Request, db *sql.DB, id string) {
	var input NodeLibrary
	if !decodeJSON(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.Name) == "" {
		response.Error(w, http.StatusBadRequest, "节点库名称不能为空")
		return
	}
	if !profileExists(r.Context(), db, id) {
		response.Error(w, http.StatusNotFound, "node library not found")
		return
	}
	subInput := subscriptionFromProfile(input)
	cycleDay := input.CycleDay
	if cycleDay <= 0 {
		cycleDay = 1
	}
	templateID := firstNonEmpty(input.TemplateID, defaultTemplateID)
	trafficSource := normalizeTrafficSource(input.TrafficSource)
	cycleType := normalizeCycleType(input.CycleType)
	refreshHours := intDefault(input.UpstreamRefreshHours, defaultRefreshHours)
	limitPerMin := intDefault(input.RateLimitPerMinute, defaultLimitPerMin)
	if err := upsertProfile(r.Context(), db, id, subInput, templateID, trafficSource, cycleType, cycleDay, limitPerMin); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := upsertDefaultUpstream(r.Context(), db, id, subInput, refreshHours); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	items, _ := loadProfiles(r.Context(), db, id)
	response.OK(w, firstProfile(items))
}

func (s *Service) deleteProfile(w http.ResponseWriter, r *http.Request, db *sql.DB, id string) {
	var nodeCount, linkCount int
	_ = db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM subscription_nodes WHERE COALESCE(profile_id, subscription_id) = ?`, id).Scan(&nodeCount)
	_ = db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM subscription_subscriptions WHERE COALESCE(profile_id, id) = ? AND id != COALESCE(profile_id, id)`, id).Scan(&linkCount)
	force := r.URL.Query().Get("force") == "1" || strings.EqualFold(r.URL.Query().Get("force"), "true")
	if (nodeCount > 0 || linkCount > 0) && !force {
		response.Error(w, http.StatusConflict, "节点库仍包含节点或对外订阅，不能删除")
		return
	}
	tx, err := db.BeginTx(r.Context(), nil)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer tx.Rollback()
	if force {
		_, _ = tx.ExecContext(r.Context(), `DELETE FROM subscription_access_logs WHERE subscription_id IN (
			SELECT id FROM subscription_subscriptions WHERE COALESCE(profile_id, id) = ?
		)`, id)
		_, _ = tx.ExecContext(r.Context(), `DELETE FROM subscription_nodes WHERE COALESCE(profile_id, subscription_id) = ?`, id)
		_, _ = tx.ExecContext(r.Context(), `DELETE FROM subscription_subscriptions WHERE COALESCE(profile_id, id) = ?`, id)
	} else {
		_, _ = tx.ExecContext(r.Context(), `DELETE FROM subscription_subscriptions WHERE id = ? AND id = COALESCE(profile_id, id)`, id)
	}
	_, _ = tx.ExecContext(r.Context(), `DELETE FROM subscription_upstreams WHERE profile_id = ?`, id)
	if _, err := tx.ExecContext(r.Context(), `DELETE FROM subscription_profiles WHERE id = ?`, id); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := tx.Commit(); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, map[string]interface{}{"deleted": true, "forced": force})
}

func (s *Service) refreshProfileUpstream(w http.ResponseWriter, r *http.Request, db *sql.DB, id string) {
	if err := s.refreshUpstreamNow(r.Context(), db, id); err != nil {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	response.OK(w, map[string]bool{"refreshed": true})
}

func (s *Service) getSubscription(w http.ResponseWriter, r *http.Request, db *sql.DB, id string) {
	subs, err := loadSubscriptions(r.Context(), db, id)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if len(subs) == 0 {
		response.Error(w, http.StatusNotFound, "subscription not found")
		return
	}
	nodes, _ := loadNodes(r.Context(), db, firstNonEmpty(subs[0].ProfileID, id), true)
	response.OK(w, map[string]interface{}{"subscription": subs[0], "nodes": nodes})
}

func (s *Service) createSubscription(w http.ResponseWriter, r *http.Request, db *sql.DB) {
	var input Subscription
	if !decodeJSON(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.Name) == "" {
		response.Error(w, http.StatusBadRequest, "订阅名称不能为空")
		return
	}
	settings, _ := loadSettings(r.Context(), db)
	id := randomID("sub")
	profileID := firstNonEmpty(input.ProfileID, id)
	token := randomToken()
	templateID := firstNonEmpty(input.TemplateID, settings.DefaultTemplateID, defaultTemplateID)
	trafficSource := normalizeTrafficSource(input.TrafficSource)
	cycleType := normalizeCycleType(input.CycleType)
	cycleDay := input.CycleDay
	if cycleDay <= 0 {
		cycleDay = 1
	}
	refreshHours := input.UpstreamRefreshHours
	if refreshHours <= 0 {
		refreshHours = settings.DefaultRefreshHours
	}
	limitPerMin := input.RateLimitPerMinute
	if limitPerMin <= 0 {
		limitPerMin = settings.DefaultRateLimitPerMin
	}
	effectiveEnabled := input.Enabled || !isExplicitFalse(r, "enabled")
	effectiveRateLimitEnabled := input.RateLimitEnabled || settings.DefaultRateLimitEnabled
	input.Enabled = effectiveEnabled
	input.RateLimitEnabled = effectiveRateLimitEnabled
	_, err := db.ExecContext(r.Context(), `INSERT INTO subscription_subscriptions (
		id, profile_id, name, remark, enabled, public_token, template_id, traffic_source, traffic_server_id,
		upstream_url, upstream_enabled, upstream_refresh_hours, total_bytes, manual_upload_bytes,
		manual_download_bytes, expire_at, cycle_type, cycle_day, cycle_start, cycle_end,
		rate_limit_enabled, rate_limit_per_minute, node_filter_ids, updated_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
		id, profileID, input.Name, input.Remark, boolToInt(effectiveEnabled), token, templateID, trafficSource, nullString(input.TrafficServerID),
		nullString(input.UpstreamURL), boolToInt(input.UpstreamEnabled), refreshHours, input.TotalBytes, input.ManualUploadBytes,
		input.ManualDownloadBytes, nullString(input.ExpireAt), cycleType, cycleDay, nullString(input.CycleStart), nullString(input.CycleEnd),
		boolToInt(effectiveRateLimitEnabled), limitPerMin, encodeNodeFilterIDs(input.NodeFilterIDs))
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if profileID == id || !profileExists(r.Context(), db, profileID) {
		if err := upsertProfile(r.Context(), db, profileID, input, templateID, trafficSource, cycleType, cycleDay, limitPerMin); err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if err := upsertDefaultUpstream(r.Context(), db, profileID, input, refreshHours); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if strings.TrimSpace(input.UpstreamURL) != "" && input.UpstreamEnabled {
		_ = s.refreshUpstreamNow(r.Context(), db, id)
	}
	subs, _ := loadSubscriptions(r.Context(), db, id)
	response.OK(w, firstSub(subs))
}

func (s *Service) updateSubscription(w http.ResponseWriter, r *http.Request, db *sql.DB, id string) {
	var input Subscription
	if !decodeJSON(w, r, &input) {
		return
	}
	if strings.TrimSpace(input.Name) == "" {
		response.Error(w, http.StatusBadRequest, "订阅名称不能为空")
		return
	}
	cycleDay := input.CycleDay
	if cycleDay <= 0 {
		cycleDay = 1
	}
	profileID := firstNonEmpty(input.ProfileID, profileIDForSubscription(r.Context(), db, id), id)
	templateID := firstNonEmpty(input.TemplateID, defaultTemplateID)
	trafficSource := normalizeTrafficSource(input.TrafficSource)
	cycleType := normalizeCycleType(input.CycleType)
	refreshHours := intDefault(input.UpstreamRefreshHours, defaultRefreshHours)
	limitPerMin := intDefault(input.RateLimitPerMinute, defaultLimitPerMin)
	_, err := db.ExecContext(r.Context(), `UPDATE subscription_subscriptions SET
		profile_id = ?, name = ?, remark = ?, enabled = ?, template_id = ?, traffic_source = ?, traffic_server_id = ?,
		upstream_url = ?, upstream_enabled = ?, upstream_refresh_hours = ?, total_bytes = ?,
		manual_upload_bytes = ?, manual_download_bytes = ?, expire_at = ?, cycle_type = ?, cycle_day = ?,
		cycle_start = ?, cycle_end = ?, rate_limit_enabled = ?, rate_limit_per_minute = ?, node_filter_ids = ?, updated_at = datetime('now')
		WHERE id = ?`,
		profileID, input.Name, input.Remark, boolToInt(input.Enabled), templateID, trafficSource, nullString(input.TrafficServerID),
		nullString(input.UpstreamURL), boolToInt(input.UpstreamEnabled), refreshHours, input.TotalBytes,
		input.ManualUploadBytes, input.ManualDownloadBytes, nullString(input.ExpireAt), cycleType, cycleDay,
		nullString(input.CycleStart), nullString(input.CycleEnd), boolToInt(input.RateLimitEnabled), limitPerMin, encodeNodeFilterIDs(input.NodeFilterIDs), id)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if profileID == id || !profileExists(r.Context(), db, profileID) {
		if err := upsertProfile(r.Context(), db, profileID, input, templateID, trafficSource, cycleType, cycleDay, limitPerMin); err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		if err := upsertDefaultUpstream(r.Context(), db, profileID, input, refreshHours); err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	subs, _ := loadSubscriptions(r.Context(), db, id)
	response.OK(w, firstSub(subs))
}

func (s *Service) deleteSubscription(w http.ResponseWriter, r *http.Request, db *sql.DB, id string) {
	profileID := firstNonEmpty(profileIDForSubscription(r.Context(), db, id), id)
	tx, err := db.BeginTx(r.Context(), nil)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer tx.Rollback()
	_, _ = tx.ExecContext(r.Context(), `DELETE FROM subscription_nodes WHERE subscription_id = ? AND COALESCE(profile_id, '') IN ('', ?)`, id, id)
	_, _ = tx.ExecContext(r.Context(), `DELETE FROM subscription_access_logs WHERE subscription_id = ?`, id)
	if _, err := tx.ExecContext(r.Context(), `DELETE FROM subscription_subscriptions WHERE id = ?`, id); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	var remainingLinks int
	_ = tx.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM subscription_subscriptions WHERE COALESCE(profile_id, id) = ?`, profileID).Scan(&remainingLinks)
	if remainingLinks == 0 {
		_, _ = tx.ExecContext(r.Context(), `DELETE FROM subscription_nodes WHERE COALESCE(profile_id, subscription_id) = ?`, profileID)
		_, _ = tx.ExecContext(r.Context(), `DELETE FROM subscription_upstreams WHERE profile_id = ?`, profileID)
		_, _ = tx.ExecContext(r.Context(), `DELETE FROM subscription_profiles WHERE id = ?`, profileID)
	}
	if err := tx.Commit(); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, map[string]bool{"deleted": true})
}

func upsertProfile(ctx context.Context, db *sql.DB, id string, input Subscription, templateID, trafficSource, cycleType string, cycleDay, limitPerMin int) error {
	if strings.TrimSpace(id) == "" {
		return fmt.Errorf("profile id is required")
	}
	_, err := db.ExecContext(ctx, `INSERT INTO subscription_profiles (
			id, name, remark, enabled, template_id, traffic_source, traffic_server_id,
			total_bytes, manual_upload_bytes, manual_download_bytes, expire_at, cycle_type,
			cycle_day, cycle_start, cycle_end, baseline_upload_bytes, baseline_download_bytes,
			rate_limit_enabled, rate_limit_per_minute, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			remark = excluded.remark,
			enabled = excluded.enabled,
			template_id = excluded.template_id,
			traffic_source = excluded.traffic_source,
			traffic_server_id = excluded.traffic_server_id,
			total_bytes = excluded.total_bytes,
			manual_upload_bytes = excluded.manual_upload_bytes,
			manual_download_bytes = excluded.manual_download_bytes,
			expire_at = excluded.expire_at,
			cycle_type = excluded.cycle_type,
			cycle_day = excluded.cycle_day,
			cycle_start = excluded.cycle_start,
			cycle_end = excluded.cycle_end,
			baseline_upload_bytes = excluded.baseline_upload_bytes,
			baseline_download_bytes = excluded.baseline_download_bytes,
			rate_limit_enabled = excluded.rate_limit_enabled,
			rate_limit_per_minute = excluded.rate_limit_per_minute,
			updated_at = datetime('now')`,
		id, input.Name, input.Remark, boolToInt(input.Enabled), templateID, trafficSource, nullString(input.TrafficServerID),
		input.TotalBytes, input.ManualUploadBytes, input.ManualDownloadBytes, nullString(input.ExpireAt), cycleType,
		cycleDay, nullString(input.CycleStart), nullString(input.CycleEnd), input.BaselineUploadBytes, input.BaselineDownloadBytes,
		boolToInt(input.RateLimitEnabled), limitPerMin)
	if err != nil {
		return fmt.Errorf("upsert subscription profile: %w", err)
	}
	return nil
}

func upsertDefaultUpstream(ctx context.Context, db *sql.DB, profileID string, input Subscription, refreshHours int) error {
	upstreamURL := strings.TrimSpace(input.UpstreamURL)
	upstreamID := "up_" + profileID
	if upstreamURL == "" {
		if _, err := db.ExecContext(ctx, `DELETE FROM subscription_upstreams WHERE id = ?`, upstreamID); err != nil {
			return fmt.Errorf("delete default upstream: %w", err)
		}
		return nil
	}
	_, err := db.ExecContext(ctx, `INSERT INTO subscription_upstreams (
			id, profile_id, name, url, enabled, refresh_hours, status, last_error, last_refresh_at, updated_at
		) VALUES (?, ?, '默认上游', ?, ?, ?, ?, ?, ?, datetime('now'))
		ON CONFLICT(id) DO UPDATE SET
			profile_id = excluded.profile_id,
			url = excluded.url,
			enabled = excluded.enabled,
			refresh_hours = excluded.refresh_hours,
			status = excluded.status,
			last_error = excluded.last_error,
			last_refresh_at = excluded.last_refresh_at,
			updated_at = datetime('now')`,
		upstreamID, profileID, upstreamURL, boolToInt(input.UpstreamEnabled), refreshHours, input.UpstreamStatus, input.UpstreamLastError, nullString(input.UpstreamLastRefreshAt))
	if err != nil {
		return fmt.Errorf("upsert default upstream: %w", err)
	}
	return nil
}

func profileIDForSubscription(ctx context.Context, db *sql.DB, id string) string {
	var profileID string
	_ = db.QueryRowContext(ctx, `SELECT COALESCE(profile_id, '') FROM subscription_subscriptions WHERE id = ?`, id).Scan(&profileID)
	return profileID
}

func profileExists(ctx context.Context, db *sql.DB, id string) bool {
	if strings.TrimSpace(id) == "" {
		return false
	}
	var count int
	_ = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM subscription_profiles WHERE id = ?`, id).Scan(&count)
	return count > 0
}

func (s *Service) resetToken(w http.ResponseWriter, r *http.Request, db *sql.DB, id string) {
	token := randomToken()
	if _, err := db.ExecContext(r.Context(), `UPDATE subscription_subscriptions SET public_token = ?, updated_at = datetime('now') WHERE id = ?`, token, id); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, map[string]string{"public_token": token})
}

func (s *Service) refreshUpstream(w http.ResponseWriter, r *http.Request, db *sql.DB, id string) {
	if err := s.refreshUpstreamNow(r.Context(), db, id); err != nil {
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	response.OK(w, map[string]bool{"refreshed": true})
}

func (s *Service) refreshUpstreamNow(ctx context.Context, db *sql.DB, id string) error {
	profileID := firstNonEmpty(profileIDForSubscription(ctx, db, id), id)
	var upstreamURL string
	err := db.QueryRowContext(ctx, `SELECT COALESCE(url, '') FROM subscription_upstreams WHERE profile_id = ? AND enabled = 1 ORDER BY updated_at DESC LIMIT 1`, profileID).Scan(&upstreamURL)
	if err == sql.ErrNoRows {
		err = db.QueryRowContext(ctx, `SELECT COALESCE(upstream_url, '') FROM subscription_subscriptions WHERE id = ?`, id).Scan(&upstreamURL)
	}
	if err != nil {
		return err
	}
	if strings.TrimSpace(upstreamURL) == "" {
		return fmt.Errorf("未配置托管源 URL")
	}
	bodyText, userinfo, err := s.fetchManagedSource(ctx, upstreamURL)
	if err != nil {
		msg := err.Error()
		_, _ = db.ExecContext(ctx, `UPDATE subscription_subscriptions SET upstream_status = 'failed', upstream_last_error = ?, updated_at = datetime('now') WHERE id = ?`, msg, id)
		_, _ = db.ExecContext(ctx, `UPDATE subscription_upstreams SET status = 'failed', last_error = ?, updated_at = datetime('now') WHERE profile_id = ?`, msg, profileID)
		return err
	}
	nodes := parseImportText(bodyText)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := mergeManagedNodes(ctx, tx, profileID, nodes); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE subscription_subscriptions SET upstream_status = 'ok', upstream_last_error = '', upstream_last_refresh_at = datetime('now'), upstream_userinfo = ?, updated_at = datetime('now') WHERE id = ?`, userinfo, id)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE subscription_upstreams SET status = 'ok', last_error = '', last_refresh_at = datetime('now'), userinfo = ?, updated_at = datetime('now') WHERE profile_id = ?`, userinfo, profileID)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Service) fetchManagedSource(ctx context.Context, sourceURL string) (string, string, error) {
	sourceURL = strings.TrimSpace(sourceURL)
	if sourceURL == "" {
		return "", "", fmt.Errorf("托管源 URL 不能为空")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, sourceURL, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("User-Agent", "API-Monitor-Subscription/1.0")
	resp, err := s.client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", fmt.Errorf("托管源返回 HTTP %d", resp.StatusCode)
	}
	return string(body), resp.Header.Get("Subscription-Userinfo"), nil
}

func (s *Service) listNodes(w http.ResponseWriter, r *http.Request, db *sql.DB) {
	filterID := r.URL.Query().Get("subscription_id")
	if filterID != "" {
		filterID = firstNonEmpty(profileIDForSubscription(r.Context(), db, filterID), filterID)
	}
	nodes, err := loadNodes(r.Context(), db, filterID, true)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, nodes)
}

func (s *Service) updateNode(w http.ResponseWriter, r *http.Request, db *sql.DB, id string) {
	var node Node
	if !decodeJSON(w, r, &node) {
		return
	}
	rawEnc, _ := secure.SecureEncrypt(node.Raw)
	cfgEnc, _ := secure.SecureEncrypt(node.ConfigJSON)
	_, err := db.ExecContext(r.Context(), `UPDATE subscription_nodes SET name = ?, type = ?, server = ?, port = ?, country_code = ?, location = ?, tags = ?, traffic_server_id = ?, enabled = ?, stable = ?, sort_order = ?, raw_encrypted = ?, config_encrypted = ?, updated_at = datetime('now') WHERE id = ?`,
		node.Name, node.Type, node.Server, node.Port, node.CountryCode, node.Location, node.Tags, nullString(node.TrafficServerID), boolToInt(node.Enabled), boolToInt(node.Stable), node.SortOrder, rawEnc, cfgEnc, id)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, map[string]bool{"updated": true})
}

func (s *Service) deleteNode(w http.ResponseWriter, r *http.Request, db *sql.DB, id string) {
	_, err := db.ExecContext(r.Context(), `DELETE FROM subscription_nodes WHERE id = ?`, id)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, map[string]bool{"deleted": true})
}

func (s *Service) reorderNodes(w http.ResponseWriter, r *http.Request, db *sql.DB) {
	var payload struct {
		IDs []string `json:"ids"`
	}
	if !decodeJSON(w, r, &payload) {
		return
	}
	tx, err := db.BeginTx(r.Context(), nil)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer tx.Rollback()
	for i, id := range payload.IDs {
		_, _ = tx.ExecContext(r.Context(), `UPDATE subscription_nodes SET sort_order = ?, updated_at = datetime('now') WHERE id = ?`, i+1, id)
	}
	if err := tx.Commit(); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, map[string]bool{"updated": true})
}

func (s *Service) importPreview(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Text      string `json:"text"`
		SourceURL string `json:"source_url"`
	}
	if !decodeJSON(w, r, &payload) {
		return
	}
	text := payload.Text
	if strings.TrimSpace(payload.SourceURL) != "" {
		fetched, _, err := s.fetchManagedSource(r.Context(), payload.SourceURL)
		if err != nil {
			response.Error(w, http.StatusBadGateway, err.Error())
			return
		}
		text = fetched
	}
	response.OK(w, parseImportText(text))
}

func (s *Service) importCommit(w http.ResponseWriter, r *http.Request, db *sql.DB) {
	var payload struct {
		SubscriptionID string `json:"subscription_id"`
		Text           string `json:"text"`
		SourceURL      string `json:"source_url"`
		Nodes          []Node `json:"nodes"`
		Replace        bool   `json:"replace"`
	}
	if !decodeJSON(w, r, &payload) {
		return
	}
	if payload.SubscriptionID == "" {
		response.Error(w, http.StatusBadRequest, "缺少订阅 ID")
		return
	}
	profileID := firstNonEmpty(profileIDForSubscription(r.Context(), db, payload.SubscriptionID), payload.SubscriptionID)
	sourceURL := strings.TrimSpace(payload.SourceURL)
	text := payload.Text
	var userinfo string
	if sourceURL != "" {
		fetched, header, err := s.fetchManagedSource(r.Context(), sourceURL)
		if err != nil {
			response.Error(w, http.StatusBadGateway, err.Error())
			return
		}
		text = fetched
		userinfo = header
	}
	nodes := payload.Nodes
	if len(nodes) == 0 {
		nodes = parseImportText(text)
	}
	tx, err := db.BeginTx(r.Context(), nil)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer tx.Rollback()
	if payload.Replace {
		if sourceURL != "" {
			_, _ = tx.ExecContext(r.Context(), `DELETE FROM subscription_nodes WHERE COALESCE(profile_id, subscription_id) = ? AND source IN ('managed', 'upstream')`, profileID)
		} else {
			_, _ = tx.ExecContext(r.Context(), `DELETE FROM subscription_nodes WHERE COALESCE(profile_id, subscription_id) = ? AND source = 'manual'`, profileID)
		}
	}
	var maxOrder int
	_ = tx.QueryRowContext(r.Context(), `SELECT COALESCE(MAX(sort_order), 0) FROM subscription_nodes WHERE COALESCE(profile_id, subscription_id) = ?`, profileID).Scan(&maxOrder)
	for i := range nodes {
		nodes[i].SubscriptionID = profileID
		nodes[i].ProfileID = profileID
		if sourceURL != "" {
			nodes[i].Source = "managed"
		} else {
			nodes[i].Source = "manual"
		}
		nodes[i].SortOrder = maxOrder + i + 1
		if err := insertNode(r.Context(), tx, nodes[i]); err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if sourceURL != "" {
		refreshHours := defaultRefreshHours
		_ = tx.QueryRowContext(r.Context(), `SELECT COALESCE(default_refresh_hours, 24) FROM subscription_settings WHERE id = 1`).Scan(&refreshHours)
		if _, err := tx.ExecContext(r.Context(), `UPDATE subscription_subscriptions SET upstream_url = ?, upstream_enabled = 1, upstream_refresh_hours = ?, upstream_status = 'ok', upstream_last_error = '', upstream_last_refresh_at = datetime('now'), upstream_userinfo = ?, updated_at = datetime('now') WHERE id = ?`, sourceURL, refreshHours, userinfo, payload.SubscriptionID); err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		if _, err := tx.ExecContext(r.Context(), `INSERT INTO subscription_upstreams (
				id, profile_id, name, url, enabled, refresh_hours, status, last_error, last_refresh_at, userinfo, updated_at
			) VALUES (?, ?, '托管源', ?, 1, ?, 'ok', '', datetime('now'), ?, datetime('now'))
			ON CONFLICT(id) DO UPDATE SET
				profile_id = excluded.profile_id,
				name = excluded.name,
				url = excluded.url,
				enabled = 1,
				refresh_hours = excluded.refresh_hours,
				status = 'ok',
				last_error = '',
				last_refresh_at = datetime('now'),
				userinfo = excluded.userinfo,
				updated_at = datetime('now')`, "up_"+profileID, profileID, sourceURL, refreshHours, userinfo); err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	if err := tx.Commit(); err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, map[string]interface{}{"imported": len(nodes)})
}

func (s *Service) listTemplates(w http.ResponseWriter, r *http.Request, db *sql.DB) {
	items, err := loadTemplates(r.Context(), db)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, items)
}

func (s *Service) createTemplate(w http.ResponseWriter, r *http.Request, db *sql.DB) {
	var tpl Template
	if !decodeJSON(w, r, &tpl) {
		return
	}
	if tpl.Name == "" || tpl.Content == "" {
		response.Error(w, http.StatusBadRequest, "模板名称和内容不能为空")
		return
	}
	if tpl.ID == "" {
		tpl.ID = randomID("tpl")
	}
	if tpl.Format == "" {
		tpl.Format = "clash"
	}
	_, err := db.ExecContext(r.Context(), `INSERT INTO subscription_templates (id, name, format, content, builtin, is_default, description) VALUES (?, ?, ?, ?, 0, 0, ?)`,
		tpl.ID, tpl.Name, tpl.Format, tpl.Content, tpl.Description)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, tpl)
}

func (s *Service) updateTemplate(w http.ResponseWriter, r *http.Request, db *sql.DB, id string) {
	var tpl Template
	if !decodeJSON(w, r, &tpl) {
		return
	}
	_, err := db.ExecContext(r.Context(), `UPDATE subscription_templates SET name = ?, format = ?, content = ?, description = ?, updated_at = datetime('now') WHERE id = ? AND builtin = 0`,
		tpl.Name, tpl.Format, tpl.Content, tpl.Description, id)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, map[string]bool{"updated": true})
}

func (s *Service) deleteTemplate(w http.ResponseWriter, r *http.Request, db *sql.DB, id string) {
	_, err := db.ExecContext(r.Context(), `DELETE FROM subscription_templates WHERE id = ? AND builtin = 0`, id)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, map[string]bool{"deleted": true})
}

func (s *Service) setDefaultTemplate(w http.ResponseWriter, r *http.Request, db *sql.DB, id string) {
	_, err := db.ExecContext(r.Context(), `UPDATE subscription_settings SET default_template_id = ?, updated_at = datetime('now') WHERE id = 1`, id)
	if err == nil {
		_, err = db.ExecContext(r.Context(), `UPDATE subscription_templates SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END`, id)
	}
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, map[string]bool{"updated": true})
}

func (s *Service) listLogs(w http.ResponseWriter, r *http.Request, db *sql.DB) {
	limit := intDefault(queryInt(r, "limit"), 200)
	rows, err := db.QueryContext(r.Context(), `SELECT id, subscription_id, public_token, ip_address, user_agent, format, success, status_code, COALESCE(error_message, ''), node_count, upload_bytes, download_bytes, total_bytes, expire_at, created_at FROM subscription_access_logs ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]interface{}{}
	for rows.Next() {
		var id, status, nodeCount int
		var subID, token, ip, ua, format, errMsg, created string
		var success int
		var up, down, total, expire int64
		_ = rows.Scan(&id, &subID, &token, &ip, &ua, &format, &success, &status, &errMsg, &nodeCount, &up, &down, &total, &expire, &created)
		items = append(items, map[string]interface{}{"id": id, "subscription_id": subID, "public_token": token, "ip_address": ip, "user_agent": ua, "format": format, "success": success == 1, "status_code": status, "error_message": errMsg, "node_count": nodeCount, "upload_bytes": up, "download_bytes": down, "total_bytes": total, "expire_at": expire, "created_at": created})
	}
	response.OK(w, items)
}

func (s *Service) getSettings(w http.ResponseWriter, r *http.Request, db *sql.DB) {
	settings, err := loadSettings(r.Context(), db)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, settings)
}

func (s *Service) updateSettings(w http.ResponseWriter, r *http.Request, db *sql.DB) {
	var settings Settings
	if !decodeJSON(w, r, &settings) {
		return
	}
	_, err := db.ExecContext(r.Context(), `UPDATE subscription_settings SET default_template_id = ?, default_rate_limit_enabled = ?, default_rate_limit_per_minute = ?, default_refresh_hours = ?, geoip_enabled = ?, updated_at = datetime('now') WHERE id = 1`,
		firstNonEmpty(settings.DefaultTemplateID, defaultTemplateID), boolToInt(settings.DefaultRateLimitEnabled), intDefault(settings.DefaultRateLimitPerMin, defaultLimitPerMin), intDefault(settings.DefaultRefreshHours, defaultRefreshHours), boolToInt(settings.GeoIPEnabled))
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, settings)
}

func (s *Service) listServers(w http.ResponseWriter, r *http.Request, db *sql.DB) {
	rows, err := db.QueryContext(r.Context(), `SELECT id, name, host, COALESCE(resolved_country, ''), traffic_limit_bytes, COALESCE(cached_info, '{}') FROM server_accounts ORDER BY order_index ASC, created_at DESC`)
	if err != nil {
		response.OK(w, []map[string]interface{}{})
		return
	}
	defer rows.Close()
	items := []map[string]interface{}{}
	for rows.Next() {
		var id, name, host, location, cached string
		var limit int64
		_ = rows.Scan(&id, &name, &host, &location, &limit, &cached)
		items = append(items, map[string]interface{}{"id": id, "name": name, "host": host, "location": location, "traffic_limit_bytes": limit})
	}
	response.OK(w, items)
}

func (s *Service) exportAll(w http.ResponseWriter, r *http.Request, db *sql.DB) {
	subs, _ := loadSubscriptions(r.Context(), db, "")
	nodes, _ := loadNodes(r.Context(), db, "", true)
	templates, _ := loadTemplates(r.Context(), db)
	response.OK(w, map[string]interface{}{"type": "api-monitor-subscription-backup", "version": 1, "exportedAt": time.Now().UTC().Format(time.RFC3339), "subscriptions": subs, "nodes": nodes, "templates": templates})
}

func (s *Service) servePublicSubscription(w http.ResponseWriter, r *http.Request) {
	token := strings.Trim(strings.TrimPrefix(r.URL.Path, "/sub/"), "/")
	format := r.URL.Query().Get("format")
	db, err := s.open(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer db.Close()

	statusCode := http.StatusOK
	success := false
	errMsg := ""
	nodeCount := 0
	var sub Subscription
	var traffic TrafficInfo
	defer func() {
		s.logAccess(r.Context(), db, sub.ID, token, clientIP(r), r.UserAgent(), format, success, statusCode, errMsg, nodeCount, traffic)
	}()

	subs, err := loadSubscriptionByToken(r.Context(), db, token)
	if err != nil || len(subs) == 0 {
		statusCode = http.StatusNotFound
		errMsg = "subscription not found"
		response.Error(w, statusCode, errMsg)
		return
	}
	sub = subs[0]
	if !sub.Enabled {
		statusCode = http.StatusForbidden
		errMsg = "subscription disabled"
		response.Error(w, statusCode, errMsg)
		return
	}
	if sub.RateLimitEnabled && isRateLimited(r.Context(), db, sub.ID, clientIP(r), sub.RateLimitPerMinute) {
		statusCode = http.StatusTooManyRequests
		errMsg = "rate limited"
		response.Error(w, statusCode, errMsg)
		return
	}
	nodes, _ := loadNodes(r.Context(), db, firstNonEmpty(sub.ProfileID, sub.ID), true)
	nodes = filterNodesByIDs(nodes, sub.NodeFilterIDs)
	traffic = sub.Traffic
	blocked := traffic.Status == "expired" || traffic.Status == "exhausted"
	if blocked {
		nodes = []Node{}
	}
	if format == "" {
		format = templateFormat(r.Context(), db, sub.TemplateID)
	}
	body, contentType, err := renderOutput(r.Context(), db, sub, nodes, format, blocked)
	if err != nil {
		statusCode = http.StatusInternalServerError
		errMsg = err.Error()
		response.Error(w, statusCode, errMsg)
		return
	}
	nodeCount = len(nodes)
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": subscriptionOutputFilename(sub)}))
	w.Header().Set("Profile-Title", subscriptionProfileTitle(sub))
	w.Header().Set("Subscription-Userinfo", fmt.Sprintf("upload=%d; download=%d; total=%d; expire=%d", traffic.Upload, traffic.Download, traffic.Total, traffic.Expire))
	w.Header().Set("Profile-Update-Interval", "24")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(body))
	success = true
}

func subscriptionProfileTitle(sub Subscription) string {
	title := strings.TrimSpace(sub.Name)
	if title == "" {
		title = strings.TrimSpace(sub.ID)
	}
	if title == "" {
		title = "subscription"
	}
	return "base64:" + base64.StdEncoding.EncodeToString([]byte(title))
}

func subscriptionOutputFilename(sub Subscription) string {
	name := strings.TrimSpace(sub.Name)
	if name == "" {
		name = strings.TrimSpace(sub.ID)
	}
	if name == "" {
		name = "subscription"
	}

	replacer := strings.NewReplacer(
		`"`, "",
		`\`, "-",
		"/", "-",
		":", "-",
		"*", "-",
		"?", "",
		"<", "",
		">", "",
		"|", "-",
		"\r", " ",
		"\n", " ",
		"\t", " ",
	)
	name = strings.Join(strings.Fields(replacer.Replace(name)), " ")
	if name == "" {
		name = "subscription"
	}
	return name
}

func loadProfiles(ctx context.Context, db *sql.DB, id string) ([]NodeLibrary, error) {
	where := ""
	args := []interface{}{}
	if id != "" {
		where = "WHERE p.id = ?"
		args = append(args, id)
	}
	rows, err := db.QueryContext(ctx, `SELECT
			p.id, p.name, COALESCE(p.remark, ''), p.enabled, COALESCE(p.template_id, ''),
			COALESCE(p.traffic_source, 'manual'), COALESCE(p.traffic_server_id, ''),
			COALESCE(u.url, ''), COALESCE(u.enabled, 0), COALESCE(u.refresh_hours, 24),
			COALESCE(u.status, ''), COALESCE(u.last_error, ''), COALESCE(u.last_refresh_at, ''), COALESCE(u.userinfo, ''),
			p.total_bytes, p.manual_upload_bytes, p.manual_download_bytes, COALESCE(p.expire_at, ''),
			COALESCE(p.cycle_type, 'none'), COALESCE(p.cycle_day, 1), COALESCE(p.cycle_start, ''), COALESCE(p.cycle_end, ''),
			p.baseline_upload_bytes, p.baseline_download_bytes, p.rate_limit_enabled, COALESCE(p.rate_limit_per_minute, 30),
			COALESCE(p.node_filter_tags, ''), COALESCE(p.sort_order, 0), p.created_at, p.updated_at
		FROM subscription_profiles p
		LEFT JOIN subscription_upstreams u ON u.id = (
			SELECT id FROM subscription_upstreams
			WHERE profile_id = p.id
			ORDER BY updated_at DESC, created_at DESC
			LIMIT 1
		)
		`+where+`
		ORDER BY p.sort_order ASC, p.updated_at DESC`, args...)
	if err != nil {
		return nil, err
	}
	items := []NodeLibrary{}
	for rows.Next() {
		var item NodeLibrary
		var enabled, upstreamEnabled, rateEnabled int
		if err := rows.Scan(&item.ID, &item.Name, &item.Remark, &enabled, &item.TemplateID, &item.TrafficSource, &item.TrafficServerID, &item.UpstreamURL, &upstreamEnabled, &item.UpstreamRefreshHours, &item.UpstreamStatus, &item.UpstreamLastError, &item.UpstreamLastRefreshAt, &item.UpstreamUserinfo, &item.TotalBytes, &item.ManualUploadBytes, &item.ManualDownloadBytes, &item.ExpireAt, &item.CycleType, &item.CycleDay, &item.CycleStart, &item.CycleEnd, &item.BaselineUploadBytes, &item.BaselineDownloadBytes, &rateEnabled, &item.RateLimitPerMinute, &item.NodeFilterTags, &item.SortOrder, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		item.Enabled = enabled == 1
		item.UpstreamEnabled = upstreamEnabled == 1
		item.RateLimitEnabled = rateEnabled == 1
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for i := range items {
		_ = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM subscription_nodes WHERE COALESCE(profile_id, subscription_id) = ?`, items[i].ID).Scan(&items[i].NodeCount)
		_ = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM subscription_subscriptions WHERE COALESCE(profile_id, id) = ? AND id != COALESCE(profile_id, id)`, items[i].ID).Scan(&items[i].SubscriptionCount)
		items[i].Traffic = computeTraffic(ctx, db, Subscription{
			ID:                    items[i].ID,
			ProfileID:             items[i].ID,
			Name:                  items[i].Name,
			Enabled:               items[i].Enabled,
			TrafficSource:         items[i].TrafficSource,
			TrafficServerID:       items[i].TrafficServerID,
			TotalBytes:            items[i].TotalBytes,
			ManualUploadBytes:     items[i].ManualUploadBytes,
			ManualDownloadBytes:   items[i].ManualDownloadBytes,
			ExpireAt:              items[i].ExpireAt,
			CycleType:             items[i].CycleType,
			CycleDay:              items[i].CycleDay,
			CycleStart:            items[i].CycleStart,
			CycleEnd:              items[i].CycleEnd,
			BaselineUploadBytes:   items[i].BaselineUploadBytes,
			BaselineDownloadBytes: items[i].BaselineDownloadBytes,
		})
	}
	return items, nil
}

func loadSubscriptions(ctx context.Context, db *sql.DB, id string) ([]Subscription, error) {
	where := ""
	args := []interface{}{}
	if id != "" {
		where = "WHERE id = ?"
		args = append(args, id)
	}
	rows, err := db.QueryContext(ctx, `SELECT id, COALESCE(profile_id, id), name, COALESCE(remark, ''), enabled, public_token, COALESCE(template_id, ''), COALESCE(traffic_source, 'manual'), COALESCE(traffic_server_id, ''), COALESCE(upstream_url, ''), upstream_enabled, COALESCE(upstream_refresh_hours, 24), COALESCE(upstream_status, ''), COALESCE(upstream_last_error, ''), COALESCE(upstream_last_refresh_at, ''), total_bytes, manual_upload_bytes, manual_download_bytes, COALESCE(expire_at, ''), COALESCE(cycle_type, 'none'), COALESCE(cycle_day, 1), COALESCE(cycle_start, ''), COALESCE(cycle_end, ''), baseline_upload_bytes, baseline_download_bytes, rate_limit_enabled, COALESCE(rate_limit_per_minute, 30), COALESCE(node_filter_ids, ''), created_at, updated_at FROM subscription_subscriptions `+where+` ORDER BY updated_at DESC`, args...)
	if err != nil {
		return nil, err
	}
	items := []Subscription{}
	for rows.Next() {
		var sub Subscription
		var enabled, upstreamEnabled, rateEnabled int
		var nodeFilterIDs string
		if err := rows.Scan(&sub.ID, &sub.ProfileID, &sub.Name, &sub.Remark, &enabled, &sub.PublicToken, &sub.TemplateID, &sub.TrafficSource, &sub.TrafficServerID, &sub.UpstreamURL, &upstreamEnabled, &sub.UpstreamRefreshHours, &sub.UpstreamStatus, &sub.UpstreamLastError, &sub.UpstreamLastRefreshAt, &sub.TotalBytes, &sub.ManualUploadBytes, &sub.ManualDownloadBytes, &sub.ExpireAt, &sub.CycleType, &sub.CycleDay, &sub.CycleStart, &sub.CycleEnd, &sub.BaselineUploadBytes, &sub.BaselineDownloadBytes, &rateEnabled, &sub.RateLimitPerMinute, &nodeFilterIDs, &sub.CreatedAt, &sub.UpdatedAt); err != nil {
			return nil, err
		}
		sub.Enabled = enabled == 1
		sub.UpstreamEnabled = upstreamEnabled == 1
		sub.RateLimitEnabled = rateEnabled == 1
		sub.NodeFilterIDs = decodeNodeFilterIDs(nodeFilterIDs)
		items = append(items, sub)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for i := range items {
		_ = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM subscription_nodes WHERE COALESCE(profile_id, subscription_id) = ?`, firstNonEmpty(items[i].ProfileID, items[i].ID)).Scan(&items[i].NodeCount)
		_ = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM subscription_access_logs WHERE subscription_id = ? AND date(created_at) = date('now')`, items[i].ID).Scan(&items[i].AccessCountToday)
		_ = db.QueryRowContext(ctx, `SELECT COALESCE(MAX(created_at), '') FROM subscription_access_logs WHERE subscription_id = ?`, items[i].ID).Scan(&items[i].LastAccessAt)
		items[i].Traffic = computeTraffic(ctx, db, items[i])
		items[i].Quality = loadQuality(ctx, db, items[i].TrafficServerID)
	}
	return items, nil
}

func loadSubscriptionByToken(ctx context.Context, db *sql.DB, token string) ([]Subscription, error) {
	var id string
	err := db.QueryRowContext(ctx, `SELECT id FROM subscription_subscriptions WHERE public_token = ?`, token).Scan(&id)
	if err != nil {
		return nil, err
	}
	return loadSubscriptions(ctx, db, id)
}

func loadNodes(ctx context.Context, db *sql.DB, subscriptionID string, decrypt bool) ([]Node, error) {
	where := ""
	args := []interface{}{}
	if subscriptionID != "" {
		where = "WHERE COALESCE(profile_id, subscription_id) = ?"
		args = append(args, subscriptionID)
	}
	rows, err := db.QueryContext(ctx, `SELECT id, subscription_id, COALESCE(profile_id, subscription_id), name, COALESCE(type, ''), COALESCE(server, ''), COALESCE(port, 0), COALESCE(country_code, ''), COALESCE(location, ''), COALESCE(tags, ''), COALESCE(traffic_server_id, ''), enabled, stable, sort_order, COALESCE(raw_encrypted, ''), COALESCE(config_encrypted, ''), created_at, updated_at FROM subscription_nodes `+where+` ORDER BY COALESCE(profile_id, subscription_id) ASC, sort_order ASC, created_at ASC`, args...)
	if err != nil {
		return nil, err
	}
	nodes := []Node{}
	for rows.Next() {
		var node Node
		var enabled, stable int
		if err := rows.Scan(&node.ID, &node.SubscriptionID, &node.ProfileID, &node.Name, &node.Type, &node.Server, &node.Port, &node.CountryCode, &node.Location, &node.Tags, &node.TrafficServerID, &enabled, &stable, &node.SortOrder, &node.Raw, &node.ConfigJSON, &node.CreatedAt, &node.UpdatedAt); err != nil {
			return nil, err
		}
		node.Enabled = enabled == 1
		node.Stable = stable == 1
		if decrypt {
			node.Raw = secure.SecureDecrypt(node.Raw)
			node.ConfigJSON = secure.SecureDecrypt(node.ConfigJSON)
		} else {
			node.Raw = ""
			node.ConfigJSON = ""
		}
		nodes = append(nodes, node)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range nodes {
		if nodes[i].TrafficServerID != "" {
			nodes[i].Quality = loadQuality(ctx, db, nodes[i].TrafficServerID)
		}
	}
	return nodes, nil
}

func insertNode(ctx context.Context, tx *sql.Tx, node Node) error {
	if node.ID == "" {
		node.ID = randomID("node")
	}
	if strings.TrimSpace(node.Name) == "" {
		node.Name = firstNonEmpty(node.Server, "未命名节点")
	}
	node.ProfileID = firstNonEmpty(node.ProfileID, node.SubscriptionID)
	rawEnc, err := secure.SecureEncrypt(node.Raw)
	if err != nil {
		return err
	}
	cfgEnc, err := secure.SecureEncrypt(node.ConfigJSON)
	if err != nil {
		return err
	}
	fingerprint := nodeFingerprint(node)
	_, err = tx.ExecContext(ctx, `INSERT INTO subscription_nodes (id, subscription_id, profile_id, name, type, server, port, country_code, location, tags, traffic_server_id, enabled, stable, sort_order, raw_encrypted, config_encrypted, fingerprint, source, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
		node.ID, node.SubscriptionID, node.ProfileID, node.Name, node.Type, node.Server, node.Port, node.CountryCode, node.Location, node.Tags, nullString(node.TrafficServerID), boolToInt(node.Enabled || !strings.EqualFold(node.Name, "__disabled__")), boolToInt(node.Stable), node.SortOrder, rawEnc, cfgEnc, fingerprint, firstNonEmpty(node.Source, "manual"))
	return err
}

func mergeManagedNodes(ctx context.Context, tx *sql.Tx, profileID string, incoming []Node) error {
	existing, err := loadManagedNodeFingerprints(ctx, tx, profileID)
	if err != nil {
		return err
	}
	seenIDs := map[string]bool{}
	for i := range incoming {
		node := incoming[i]
		node.SubscriptionID = profileID
		node.ProfileID = profileID
		node.Source = "managed"
		if node.SortOrder == 0 {
			node.SortOrder = i + 1
		}
		fingerprint := nodeFingerprint(node)
		if current, ok := existing[fingerprint]; ok {
			node.ID = current.ID
			node.Name = firstNonEmpty(current.Name, node.Name)
			node.CountryCode = firstNonEmpty(current.CountryCode, node.CountryCode)
			node.Location = firstNonEmpty(current.Location, node.Location)
			node.Tags = firstNonEmpty(current.Tags, node.Tags)
			node.TrafficServerID = current.TrafficServerID
			node.Enabled = current.Enabled
			node.Stable = current.Stable
			node.SortOrder = current.SortOrder
			if err := updateManagedNode(ctx, tx, node, fingerprint); err != nil {
				return err
			}
			seenIDs[node.ID] = true
			continue
		}
		if err := insertNode(ctx, tx, node); err != nil {
			return err
		}
		seenIDs[node.ID] = true
	}
	for _, node := range existing {
		if !seenIDs[node.ID] {
			if _, err := tx.ExecContext(ctx, `DELETE FROM subscription_nodes WHERE id = ?`, node.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

func loadManagedNodeFingerprints(ctx context.Context, tx *sql.Tx, profileID string) (map[string]Node, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id, subscription_id, COALESCE(profile_id, subscription_id), name, COALESCE(type, ''), COALESCE(server, ''), COALESCE(port, 0), COALESCE(country_code, ''), COALESCE(location, ''), COALESCE(tags, ''), COALESCE(traffic_server_id, ''), enabled, stable, sort_order, COALESCE(fingerprint, '')
		FROM subscription_nodes
		WHERE COALESCE(profile_id, subscription_id) = ? AND source IN ('managed', 'upstream')`, profileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	nodes := map[string]Node{}
	for rows.Next() {
		var node Node
		var enabled, stable int
		var fingerprint string
		if err := rows.Scan(&node.ID, &node.SubscriptionID, &node.ProfileID, &node.Name, &node.Type, &node.Server, &node.Port, &node.CountryCode, &node.Location, &node.Tags, &node.TrafficServerID, &enabled, &stable, &node.SortOrder, &fingerprint); err != nil {
			return nil, err
		}
		node.Enabled = enabled == 1
		node.Stable = stable == 1
		fingerprint = firstNonEmpty(fingerprint, nodeFingerprint(node))
		if fingerprint != "" {
			nodes[fingerprint] = node
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return nodes, nil
}

func updateManagedNode(ctx context.Context, tx *sql.Tx, node Node, fingerprint string) error {
	rawEnc, err := secure.SecureEncrypt(node.Raw)
	if err != nil {
		return err
	}
	cfgEnc, err := secure.SecureEncrypt(node.ConfigJSON)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE subscription_nodes SET subscription_id = ?, profile_id = ?, name = ?, type = ?, server = ?, port = ?, country_code = ?, location = ?, tags = ?, traffic_server_id = ?, enabled = ?, stable = ?, sort_order = ?, raw_encrypted = ?, config_encrypted = ?, fingerprint = ?, source = 'managed', updated_at = datetime('now') WHERE id = ?`,
		node.SubscriptionID, node.ProfileID, node.Name, node.Type, node.Server, node.Port, node.CountryCode, node.Location, node.Tags, nullString(node.TrafficServerID), boolToInt(node.Enabled), boolToInt(node.Stable), node.SortOrder, rawEnc, cfgEnc, fingerprint, node.ID)
	return err
}

func loadTemplates(ctx context.Context, db *sql.DB) ([]Template, error) {
	rows, err := db.QueryContext(ctx, `SELECT id, name, format, content, builtin, is_default, COALESCE(description, ''), created_at, updated_at FROM subscription_templates ORDER BY is_default DESC, builtin DESC, name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Template{}
	for rows.Next() {
		var tpl Template
		var builtin, def int
		if err := rows.Scan(&tpl.ID, &tpl.Name, &tpl.Format, &tpl.Content, &builtin, &def, &tpl.Description, &tpl.CreatedAt, &tpl.UpdatedAt); err != nil {
			return nil, err
		}
		tpl.Builtin = builtin == 1
		tpl.IsDefault = def == 1
		items = append(items, tpl)
	}
	return items, rows.Err()
}

func loadSettings(ctx context.Context, db *sql.DB) (Settings, error) {
	var settings Settings
	var limitEnabled, geo int
	err := db.QueryRowContext(ctx, `SELECT COALESCE(default_template_id, 'builtin_mihomo_default'), default_rate_limit_enabled, COALESCE(default_rate_limit_per_minute, 30), COALESCE(default_refresh_hours, 24), geoip_enabled FROM subscription_settings WHERE id = 1`).Scan(&settings.DefaultTemplateID, &limitEnabled, &settings.DefaultRateLimitPerMin, &settings.DefaultRefreshHours, &geo)
	settings.DefaultRateLimitEnabled = limitEnabled == 1
	settings.GeoIPEnabled = geo == 1
	if settings.DefaultTemplateID == "" {
		settings.DefaultTemplateID = defaultTemplateID
	}
	return settings, err
}

func computeTraffic(ctx context.Context, db *sql.DB, sub Subscription) TrafficInfo {
	info := TrafficInfo{Total: sub.TotalBytes, Source: sub.TrafficSource, Status: "active"}
	if sub.ExpireAt != "" {
		if t, err := parseTime(sub.ExpireAt); err == nil {
			info.Expire = t.Unix()
			if time.Now().After(t) {
				info.Status = "expired"
			}
		}
	}
	switch sub.TrafficSource {
	case "server":
		up, down := serverTraffic(ctx, db, sub.TrafficServerID)
		info.Upload = maxInt64(0, up-sub.BaselineUploadBytes)
		info.Download = maxInt64(0, down-sub.BaselineDownloadBytes)
		if info.Total <= 0 {
			var limit int64
			_ = db.QueryRowContext(ctx, `SELECT traffic_limit_bytes FROM server_accounts WHERE id = ?`, sub.TrafficServerID).Scan(&limit)
			info.Total = limit
		}
	case "node_servers":
		up, down, total := nodeServerTraffic(ctx, db, sub)
		info.Upload = maxInt64(0, up-sub.BaselineUploadBytes)
		info.Download = maxInt64(0, down-sub.BaselineDownloadBytes)
		if info.Total <= 0 {
			info.Total = total
		}
	case "upstream":
		var raw string
		profileID := firstNonEmpty(sub.ProfileID, sub.ID)
		_ = db.QueryRowContext(ctx, `SELECT COALESCE(userinfo, '') FROM subscription_upstreams WHERE profile_id = ? AND COALESCE(userinfo, '') != '' ORDER BY updated_at DESC LIMIT 1`, profileID).Scan(&raw)
		if raw == "" {
			_ = db.QueryRowContext(ctx, `SELECT COALESCE(upstream_userinfo, '') FROM subscription_subscriptions WHERE id = ?`, sub.ID).Scan(&raw)
		}
		if parsed := parseUserInfo(raw); parsed.Total > 0 {
			info = parsed
			info.Source = "upstream"
		}
	default:
		info.Upload = sub.ManualUploadBytes
		info.Download = sub.ManualDownloadBytes
	}
	used := info.Upload + info.Download
	if info.Total > 0 {
		info.Percent = float64(used) / float64(info.Total) * 100
		if used >= info.Total && info.Status == "active" {
			info.Status = "exhausted"
		}
	}
	return info
}

func nodeServerTraffic(ctx context.Context, db *sql.DB, sub Subscription) (int64, int64, int64) {
	profileID := firstNonEmpty(sub.ProfileID, sub.ID)
	if profileID == "" {
		return 0, 0, 0
	}
	where := `WHERE COALESCE(profile_id, subscription_id) = ? AND enabled = 1 AND COALESCE(traffic_server_id, '') != ''`
	args := []interface{}{profileID}
	if len(sub.NodeFilterIDs) > 0 {
		placeholders := make([]string, 0, len(sub.NodeFilterIDs))
		for _, id := range sub.NodeFilterIDs {
			id = strings.TrimSpace(id)
			if id == "" {
				continue
			}
			placeholders = append(placeholders, "?")
			args = append(args, id)
		}
		if len(placeholders) > 0 {
			where += ` AND id IN (` + strings.Join(placeholders, ",") + `)`
		}
	}
	rows, err := db.QueryContext(ctx, `SELECT DISTINCT traffic_server_id FROM subscription_nodes `+where, args...)
	if err != nil {
		return 0, 0, 0
	}
	serverIDs := []string{}
	for rows.Next() {
		var serverID string
		if err := rows.Scan(&serverID); err != nil || strings.TrimSpace(serverID) == "" {
			continue
		}
		serverIDs = append(serverIDs, strings.TrimSpace(serverID))
	}
	if err := rows.Close(); err != nil {
		return 0, 0, 0
	}
	if err := rows.Err(); err != nil {
		return 0, 0, 0
	}

	var upload, download, total int64
	for _, serverID := range serverIDs {
		up, down := serverTraffic(ctx, db, serverID)
		upload += up
		download += down
		var limit int64
		_ = db.QueryRowContext(ctx, `SELECT traffic_limit_bytes FROM server_accounts WHERE id = ?`, serverID).Scan(&limit)
		total += maxInt64(0, limit)
	}
	return upload, download, total
}

func serverTraffic(ctx context.Context, db *sql.DB, serverID string) (int64, int64) {
	if serverID == "" {
		return 0, 0
	}
	var cached string
	_ = db.QueryRowContext(ctx, `SELECT COALESCE(cached_info, '{}') FROM server_accounts WHERE id = ?`, serverID).Scan(&cached)
	var m map[string]interface{}
	_ = json.Unmarshal([]byte(cached), &m)
	network, _ := m["network"].(map[string]interface{})
	rx := int64(floatVal(network["rx_total_bytes"]))
	tx := int64(floatVal(network["tx_total_bytes"]))
	if rx == 0 {
		rx = int64(floatVal(m["net_in_transfer"]))
	}
	if tx == 0 {
		tx = int64(floatVal(m["net_out_transfer"]))
	}
	return rx, tx
}

func loadQuality(ctx context.Context, db *sql.DB, serverID string) []QualitySummary {
	if serverID == "" {
		return nil
	}
	rows, err := db.QueryContext(ctx, `SELECT target_name, success, COALESCE(latency_ms, 0), checked_at FROM server_network_quality_samples WHERE server_id = ? AND checked_at >= datetime('now', '-1 day') ORDER BY checked_at DESC`, serverID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	type agg struct {
		name        string
		count       int
		success     int
		total       float64
		prev        float64
		jitter      float64
		jitterCount int
		latest      float64
		sampledAt   string
	}
	items := map[string]*agg{}
	for rows.Next() {
		var name, checked string
		var success int
		var latency float64
		_ = rows.Scan(&name, &success, &latency, &checked)
		a := items[name]
		if a == nil {
			a = &agg{name: name, latest: latency, sampledAt: checked, prev: -1}
			items[name] = a
		}
		a.count++
		if success == 1 {
			a.success++
			a.total += latency
			if a.prev >= 0 {
				a.jitter += absFloat(latency - a.prev)
				a.jitterCount++
			}
			a.prev = latency
		}
	}
	out := []QualitySummary{}
	for _, a := range items {
		avg := 0.0
		if a.success > 0 {
			avg = a.total / float64(a.success)
		}
		jitter := 0.0
		if a.jitterCount > 0 {
			jitter = a.jitter / float64(a.jitterCount)
		}
		loss := 0.0
		if a.count > 0 {
			loss = (1 - float64(a.success)/float64(a.count)) * 100
		}
		out = append(out, QualitySummary{Name: a.name, LatencyMS: avg, AvgLatencyMS: avg, JitterMS: jitter, LossRate: loss, SampledAt: a.sampledAt})
	}
	return out
}

func renderOutput(ctx context.Context, db *sql.DB, sub Subscription, nodes []Node, format string, blocked bool) (string, string, error) {
	if format == "" || format == "clash" || format == "mihomo" {
		tpl := loadDefaultMihomoTemplate()
		if sub.TemplateID != "" {
			var customTemplate string
			_ = db.QueryRowContext(ctx, `SELECT content FROM subscription_templates WHERE id = ?`, sub.TemplateID).Scan(&customTemplate)
			if strings.TrimSpace(customTemplate) != "" {
				tpl = customTemplate
			}
		}
		body := renderTemplate(tpl, sub, nodes)
		if blocked {
			body = "# Subscription is " + sub.Traffic.Status + ". Nodes are hidden.\n" + body
		}
		return body, "text/yaml; charset=utf-8", nil
	}
	raw := rawURIList(nodes)
	if format == "base64" {
		return base64.StdEncoding.EncodeToString([]byte(raw)), "text/plain; charset=utf-8", nil
	}
	return raw, "text/plain; charset=utf-8", nil
}

func renderTemplate(tpl string, sub Subscription, nodes []Node) string {
	replacements := map[string]string{
		"{{ subscription.name }}":                  sub.Name,
		"{{ subscription.expire_at }}":             sub.ExpireAt,
		"{{ traffic.upload }}":                     strconv.FormatInt(sub.Traffic.Upload, 10),
		"{{ traffic.download }}":                   strconv.FormatInt(sub.Traffic.Download, 10),
		"{{ traffic.total }}":                      strconv.FormatInt(sub.Traffic.Total, 10),
		"{{ proxies_yaml }}":                       proxiesYAML(nodes, 2),
		"{{ proxy_names_yaml | indent 6 }}":        proxyNamesYAML(nodes, false, 6),
		"{{ stable_proxy_names_yaml | indent 6 }}": stableProxyNamesYAML(nodes, 6),
		"{{ raw_uri_list }}":                       rawURIList(nodes),
	}
	out := tpl
	for key, value := range replacements {
		out = strings.ReplaceAll(out, key, value)
	}
	return out
}

func proxiesYAML(nodes []Node, indent int) string {
	lines := []string{}
	pad := strings.Repeat(" ", indent)
	for _, node := range nodes {
		if !node.Enabled {
			continue
		}
		proxy := nodeProxyConfig(node)
		if len(proxy) == 0 {
			continue
		}
		encoded, err := yaml.Marshal([]interface{}{proxy})
		if err != nil {
			continue
		}
		for _, line := range strings.Split(strings.TrimRight(string(encoded), "\n"), "\n") {
			lines = append(lines, pad+line)
		}
	}
	if len(lines) == 0 {
		return pad + "[]"
	}
	return strings.Join(lines, "\n")
}

func proxyNamesYAML(nodes []Node, stableOnly bool, indent int) string {
	lines := []string{}
	for _, node := range nodes {
		if !node.Enabled || (stableOnly && !node.Stable) {
			continue
		}
		lines = append(lines, yamlStringListItem(node.Name, indent))
	}
	if stableOnly && len(lines) == 0 {
		lines = append(lines, yamlStringListItem("🚀 手动", indent))
	}
	if len(lines) == 0 {
		lines = append(lines, yamlStringListItem("DIRECT", indent))
	}
	return strings.Join(lines, "\n")
}

func stableProxyNamesYAML(nodes []Node, indent int) string {
	lines := []string{}
	seen := map[string]bool{}
	for _, node := range nodes {
		if !node.Enabled || !node.Stable || seen[node.Name] {
			continue
		}
		lines = append(lines, yamlStringListItem(node.Name, indent))
		seen[node.Name] = true
	}
	if !seen["🚀 手动"] {
		lines = append(lines, yamlStringListItem("🚀 手动", indent))
	}
	return strings.Join(lines, "\n")
}

func yamlStringListItem(value string, indent int) string {
	encoded, err := yaml.Marshal([]string{value})
	if err != nil {
		return strings.Repeat(" ", indent) + "- " + value
	}
	line := strings.TrimSpace(strings.Split(strings.TrimRight(string(encoded), "\n"), "\n")[0])
	return strings.Repeat(" ", indent) + line
}

func nodeProxyConfig(node Node) map[string]interface{} {
	cfg := strings.TrimSpace(node.ConfigJSON)
	if cfg != "" {
		var parsed interface{}
		if json.Unmarshal([]byte(cfg), &parsed) == nil {
			if proxy, ok := normalizeStringMap(parsed).(map[string]interface{}); ok {
				return proxy
			}
		}
		if yaml.Unmarshal([]byte(cfg), &parsed) == nil {
			if proxy, ok := normalizeStringMap(parsed).(map[string]interface{}); ok {
				return proxy
			}
		}
	}
	return uriToClashMap(node)
}

func rawURIList(nodes []Node) string {
	lines := []string{}
	for _, node := range nodes {
		if node.Enabled && strings.TrimSpace(node.Raw) != "" {
			lines = append(lines, strings.TrimSpace(node.Raw))
		}
	}
	return strings.Join(lines, "\n")
}

func filterNodesByIDs(nodes []Node, ids []string) []Node {
	if len(ids) == 0 {
		return nodes
	}
	allowed := map[string]bool{}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id != "" {
			allowed[id] = true
		}
	}
	if len(allowed) == 0 {
		return nodes
	}
	out := make([]Node, 0, len(nodes))
	for _, node := range nodes {
		if allowed[node.ID] {
			out = append(out, node)
		}
	}
	return out
}

func encodeNodeFilterIDs(ids []string) string {
	clean := []string{}
	seen := map[string]bool{}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		clean = append(clean, id)
	}
	if len(clean) == 0 {
		return ""
	}
	encoded, _ := json.Marshal(clean)
	return string(encoded)
}

func decodeNodeFilterIDs(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var ids []string
	if json.Unmarshal([]byte(raw), &ids) == nil {
		return compactStringList(ids)
	}
	return compactStringList(strings.Split(raw, ","))
}

func compactStringList(values []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func parseImportText(text string) []Node {
	return parseImportTextDepth(text, 0)
}

func parseImportTextDepth(text string, depth int) []Node {
	if nodes := parseClashProxyNodes(text); len(nodes) > 0 {
		return nodes
	}
	nodes := parseNodeURIs(text)
	if len(nodes) > 0 {
		return nodes
	}
	if len(nodes) == 0 && depth < 2 {
		if decoded, ok := decodeSubscriptionBase64(text); ok {
			return parseImportTextDepth(decoded, depth+1)
		}
	}
	return nodes
}

func parseClashProxyNodes(text string) []Node {
	var doc map[string]interface{}
	if err := yaml.Unmarshal([]byte(text), &doc); err != nil {
		return nil
	}
	rawProxies, ok := doc["proxies"].([]interface{})
	if !ok || len(rawProxies) == 0 {
		return nil
	}
	nodes := []Node{}
	for _, item := range rawProxies {
		proxy, ok := normalizeStringMap(item).(map[string]interface{})
		if !ok {
			continue
		}
		name := stringVal(proxy["name"])
		server := stringVal(proxy["server"])
		typ := strings.ToLower(stringVal(proxy["type"]))
		if name == "" || server == "" || typ == "" {
			continue
		}
		countryCode := countryCodeFromNodeName(name)
		cfg, _ := json.Marshal(proxy)
		nodes = append(nodes, Node{
			ID:          randomID("node"),
			Name:        name,
			Type:        typ,
			Server:      server,
			Port:        int(floatVal(proxy["port"])),
			CountryCode: countryCode,
			Enabled:     true,
			ConfigJSON:  string(cfg),
			SortOrder:   len(nodes) + 1,
			Source:      "managed",
		})
	}
	return nodes
}

func parseNodeURIs(text string) []Node {
	nodes := []Node{}
	seen := map[string]bool{}
	for _, candidate := range nodeURICandidates(text) {
		clean := cleanNodeURI(candidate)
		if clean == "" || seen[clean] || isLikelyPlainHTTPAsset(clean) {
			continue
		}
		seen[clean] = true
		nodes = append(nodes, parseURI(clean, len(nodes)+1))
	}
	return nodes
}

func nodeURICandidates(text string) []string {
	candidates := []string{}
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if loc := nodeLinkPattern.FindStringIndex(trimmed); loc != nil {
			candidates = append(candidates, trimmed[loc[0]:])
		}
	}
	if len(candidates) > 0 {
		return candidates
	}
	return nodeLinkPattern.FindAllString(text, -1)
}

func cleanNodeURI(value string) string {
	clean := strings.TrimSpace(value)
	clean = strings.TrimLeft(clean, "- ")
	clean = strings.Trim(clean, `"' ,`)
	return strings.TrimSpace(clean)
}

func normalizeStringMap(value interface{}) interface{} {
	switch v := value.(type) {
	case map[string]interface{}:
		out := map[string]interface{}{}
		for key, item := range v {
			out[key] = normalizeStringMap(item)
		}
		return out
	case map[interface{}]interface{}:
		out := map[string]interface{}{}
		for key, item := range v {
			out[fmt.Sprint(key)] = normalizeStringMap(item)
		}
		return out
	case []interface{}:
		out := make([]interface{}, 0, len(v))
		for _, item := range v {
			out = append(out, normalizeStringMap(item))
		}
		return out
	default:
		return value
	}
}

func isLikelyPlainHTTPAsset(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return false
	}
	query := strings.ToLower(parsed.RawQuery)
	fragment := strings.TrimSpace(parsed.Fragment)
	if strings.Contains(query, "type=") || strings.Contains(query, "server=") || fragment != "" {
		return false
	}
	path := strings.ToLower(parsed.Path)
	return strings.HasSuffix(path, ".yaml") ||
		strings.HasSuffix(path, ".yml") ||
		strings.HasSuffix(path, ".txt") ||
		strings.Contains(path, "/ruleset/") ||
		strings.Contains(path, "clash-rules")
}

func decodeSubscriptionBase64(text string) (string, bool) {
	clean := strings.TrimSpace(text)
	if clean == "" || strings.Contains(clean, "\n") && strings.Contains(clean, "://") {
		return "", false
	}
	clean = strings.NewReplacer("\r", "", "\n", "", " ", "", "\t", "").Replace(clean)
	encodings := []*base64.Encoding{
		base64.StdEncoding,
		base64.RawStdEncoding,
		base64.URLEncoding,
		base64.RawURLEncoding,
	}
	for _, encoding := range encodings {
		if decoded, err := encoding.DecodeString(clean); err == nil && strings.Contains(string(decoded), "://") {
			return string(decoded), true
		}
	}
	if remainder := len(clean) % 4; remainder != 0 {
		padded := clean + strings.Repeat("=", 4-remainder)
		if decoded, err := base64.StdEncoding.DecodeString(padded); err == nil && strings.Contains(string(decoded), "://") {
			return string(decoded), true
		}
	}
	return "", false
}

func parseURI(raw string, order int) Node {
	node := Node{ID: randomID("node"), Raw: raw, Enabled: true, SortOrder: order}
	parsed, err := url.Parse(raw)
	if err != nil {
		node.Name = fmt.Sprintf("节点 %d", order)
		return node
	}
	node.Type = strings.ToLower(parsed.Scheme)
	if node.Type == "hy2" {
		node.Type = "hysteria2"
	}
	if parsed.Fragment != "" {
		if name, err := url.QueryUnescape(parsed.Fragment); err == nil {
			node.Name = name
		}
	}
	if countryCode, displayName := normalizeImportedNodeName(node.Name); countryCode != "" {
		node.CountryCode = countryCode
		node.Name = displayName
	} else if countryCode := countryCodePrefix(node.Name); countryCode != "" {
		node.CountryCode = countryCode
	}
	if node.Name == "" {
		node.Name = fmt.Sprintf("%s-%d", node.Type, order)
	}
	node.Server = parsed.Hostname()
	if p, _ := strconv.Atoi(parsed.Port()); p > 0 {
		node.Port = p
	}
	if node.Type == "vmess" && parsed.Host == "" {
		if parsedNode, ok := parseVMessBase64URI(raw, order); ok {
			return parsedNode
		}
	}
	if cfg := uriToClashMap(node); len(cfg) > 0 {
		if encoded, err := json.Marshal(cfg); err == nil {
			node.ConfigJSON = string(encoded)
		}
	}
	return node
}

func countryCodeFromNodeName(name string) string {
	if countryCode, _ := normalizeImportedNodeName(name); countryCode != "" {
		return countryCode
	}
	return countryCodePrefix(name)
}

func normalizeImportedNodeName(name string) (string, string) {
	name = strings.TrimSpace(name)
	runes := []rune(name)
	if len(runes) < 2 || !isRegionalIndicator(runes[0]) || !isRegionalIndicator(runes[1]) {
		return "", name
	}
	code := string([]rune{'A' + (runes[0] - 0x1F1E6), 'A' + (runes[1] - 0x1F1E6)})
	return code, name
}

func isRegionalIndicator(value rune) bool {
	return value >= 0x1F1E6 && value <= 0x1F1FF
}

func countryCodePrefix(name string) string {
	name = strings.TrimSpace(name)
	if len(name) < 2 {
		return ""
	}
	prefix := name[:2]
	if !regexp.MustCompile(`^[A-Za-z]{2}$`).MatchString(prefix) {
		return ""
	}
	if len(name) == 2 {
		return strings.ToUpper(prefix)
	}
	next := rune(name[2])
	if next == ' ' || next == '_' || next == '-' || (next >= 0x4e00 && next <= 0x9fff) {
		return strings.ToUpper(prefix)
	}
	return ""
}

func uriToClashJSON(node Node) string {
	m := uriToClashMap(node)
	b, _ := json.Marshal(m)
	return string(b)
}

func uriToClashMap(node Node) map[string]interface{} {
	m := map[string]interface{}{
		"name":   node.Name,
		"type":   node.Type,
		"server": node.Server,
		"port":   node.Port,
	}
	parsed, err := url.Parse(node.Raw)
	if err != nil {
		return m
	}
	query := parsed.Query()
	switch node.Type {
	case "vless":
		m["uuid"] = parsed.User.Username()
		if value := firstNonEmpty(query.Get("encryption"), "none"); value != "" {
			m["encryption"] = value
		}
		network := firstNonEmpty(query.Get("type"), query.Get("network"))
		if network != "" && network != "tcp" {
			m["network"] = network
		}
		if strings.EqualFold(query.Get("security"), "tls") {
			m["tls"] = true
		}
		if value := firstNonEmpty(query.Get("sni"), query.Get("servername")); value != "" {
			m["servername"] = value
			m["sni"] = value
		}
		if value := query.Get("fp"); value != "" {
			m["client-fingerprint"] = value
		}
		if queryBool(query, "allowInsecure") || queryBool(query, "skip-cert-verify") {
			m["skip-cert-verify"] = true
		}
		if network == "ws" {
			wsOpts := map[string]interface{}{}
			if value := query.Get("path"); value != "" {
				wsOpts["path"] = value
			}
			if value := firstNonEmpty(query.Get("host"), query.Get("Host"), query.Get("sni"), query.Get("servername")); value != "" {
				wsOpts["headers"] = map[string]interface{}{"Host": value}
			}
			if len(wsOpts) > 0 {
				m["ws-opts"] = wsOpts
			}
		}
	case "trojan":
		m["password"] = parsed.User.Username()
		if value := firstNonEmpty(query.Get("sni"), query.Get("peer"), query.Get("servername")); value != "" {
			sni, embeddedALPN := splitSNIAndEmbeddedALPN(value)
			m["sni"] = sni
			if len(embeddedALPN) > 0 {
				m["alpn"] = embeddedALPN
			}
		}
		m["tls"] = true
		if queryBool(query, "allowInsecure") || queryBool(query, "skip-cert-verify") {
			m["skip-cert-verify"] = true
		}
		if alpn := splitCSV(query.Get("alpn")); len(alpn) > 0 {
			m["alpn"] = alpn
		}
		if network := firstNonEmpty(query.Get("type"), query.Get("network")); network != "" {
			m["network"] = network
		}
		if value := query.Get("fp"); value != "" {
			m["client-fingerprint"] = value
		}
	case "hysteria2":
		m["password"] = parsed.User.Username()
		if value := firstNonEmpty(query.Get("sni"), query.Get("peer"), query.Get("servername")); value != "" {
			m["sni"] = value
		}
		if queryBool(query, "insecure") || queryBool(query, "allowInsecure") || queryBool(query, "skip-cert-verify") {
			m["skip-cert-verify"] = true
		}
		if alpn := splitCSV(query.Get("alpn")); len(alpn) > 0 {
			m["alpn"] = alpn
		}
	case "ss":
		if user := parsed.User.String(); user != "" {
			if decoded, ok := decodeMaybeBase64(user); ok {
				parts := strings.SplitN(decoded, ":", 2)
				if len(parts) == 2 {
					m["cipher"] = parts[0]
					m["password"] = parts[1]
				}
			}
		}
	}
	return m
}

func queryBool(values url.Values, key string) bool {
	value := strings.ToLower(strings.TrimSpace(values.Get(key)))
	return value == "1" || value == "true" || value == "yes"
}

func splitSNIAndEmbeddedALPN(value string) (string, []string) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	markers := []string{"h3,", "h2,", "http/1.1"}
	cut := -1
	for _, marker := range markers {
		if idx := strings.Index(value, marker); idx >= 0 && (cut == -1 || idx < cut) {
			cut = idx
		}
	}
	if cut <= 0 {
		return value, nil
	}
	sni := strings.TrimSpace(strings.TrimRight(value[:cut], ","))
	alpn := splitCSV(value[cut:])
	if sni == "" {
		return value, nil
	}
	return sni, alpn
}

func splitCSV(value string) []string {
	parts := strings.Split(value, ",")
	out := []string{}
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func decodeMaybeBase64(value string) (string, bool) {
	if decoded, err := base64.RawURLEncoding.DecodeString(value); err == nil {
		return string(decoded), true
	}
	if decoded, err := base64.RawStdEncoding.DecodeString(value); err == nil {
		return string(decoded), true
	}
	if decoded, err := base64.StdEncoding.DecodeString(value); err == nil {
		return string(decoded), true
	}
	return "", false
}

func parseVMessBase64URI(raw string, order int) (Node, bool) {
	payload := strings.TrimPrefix(raw, "vmess://")
	decoded, ok := decodeMaybeBase64(payload)
	if !ok {
		return Node{}, false
	}
	var cfg map[string]interface{}
	if json.Unmarshal([]byte(decoded), &cfg) != nil {
		return Node{}, false
	}
	name := firstNonEmpty(stringVal(cfg["ps"]), fmt.Sprintf("vmess-%d", order))
	server := stringVal(cfg["add"])
	port, _ := strconv.Atoi(stringVal(cfg["port"]))
	proxy := map[string]interface{}{
		"name":    name,
		"type":    "vmess",
		"server":  server,
		"port":    port,
		"uuid":    stringVal(cfg["id"]),
		"alterId": int(floatVal(cfg["aid"])),
		"cipher":  firstNonEmpty(stringVal(cfg["scy"]), "auto"),
	}
	if network := stringVal(cfg["net"]); network != "" && network != "tcp" {
		proxy["network"] = network
	}
	if tls := stringVal(cfg["tls"]); tls == "tls" {
		proxy["tls"] = true
	}
	if sni := stringVal(cfg["sni"]); sni != "" {
		proxy["servername"] = sni
	}
	if stringVal(cfg["net"]) == "ws" {
		wsOpts := map[string]interface{}{}
		if path := stringVal(cfg["path"]); path != "" {
			wsOpts["path"] = path
		}
		if host := stringVal(cfg["host"]); host != "" {
			wsOpts["headers"] = map[string]interface{}{"Host": host}
		}
		if len(wsOpts) > 0 {
			proxy["ws-opts"] = wsOpts
		}
	}
	encoded, _ := json.Marshal(proxy)
	return Node{ID: randomID("node"), Raw: raw, Enabled: true, SortOrder: order, Name: name, Type: "vmess", Server: server, Port: port, ConfigJSON: string(encoded)}, true
}

func parseUserInfo(raw string) TrafficInfo {
	info := TrafficInfo{Status: "active"}
	for _, part := range strings.Split(raw, ";") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 {
			continue
		}
		value, _ := strconv.ParseInt(strings.TrimSpace(kv[1]), 10, 64)
		switch strings.TrimSpace(kv[0]) {
		case "upload":
			info.Upload = value
		case "download":
			info.Download = value
		case "total":
			info.Total = value
		case "expire":
			info.Expire = value
		}
	}
	return info
}

func templateFormat(ctx context.Context, db *sql.DB, id string) string {
	var format string
	_ = db.QueryRowContext(ctx, `SELECT format FROM subscription_templates WHERE id = ?`, id).Scan(&format)
	return format
}

func isRateLimited(ctx context.Context, db *sql.DB, subID, ip string, perMin int) bool {
	if perMin <= 0 {
		perMin = defaultLimitPerMin
	}
	var count int
	_ = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM subscription_access_logs WHERE subscription_id = ? AND ip_address = ? AND created_at >= datetime('now', '-1 minute')`, subID, ip).Scan(&count)
	return count >= perMin
}

func (s *Service) logAccess(ctx context.Context, db *sql.DB, subID, token, ip, ua, format string, success bool, statusCode int, errMsg string, nodeCount int, traffic TrafficInfo) {
	_, _ = db.ExecContext(ctx, `INSERT INTO subscription_access_logs (subscription_id, public_token, ip_address, user_agent, format, success, status_code, error_message, node_count, upload_bytes, download_bytes, total_bytes, expire_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		subID, token, ip, ua, format, boolToInt(success), statusCode, nullString(errMsg), nodeCount, traffic.Upload, traffic.Download, traffic.Total, traffic.Expire)
}

func queryInt(r *http.Request, key string) int {
	value, _ := strconv.Atoi(r.URL.Query().Get(key))
	return value
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target interface{}) bool {
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		if w != nil {
			response.Error(w, http.StatusBadRequest, "request parameter validation failed")
		}
		return false
	}
	return true
}

func randomID(prefix string) string {
	return prefix + "_" + strconv.FormatInt(time.Now().UnixMilli(), 10) + "_" + randomHex(4)
}

func randomToken() string {
	return randomHex(24)
}

func randomHex(n int) string {
	buf := make([]byte, n)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

func clientIP(r *http.Request) string {
	for _, header := range []string{"CF-Connecting-IP", "X-Forwarded-For", "X-Real-IP"} {
		value := strings.TrimSpace(r.Header.Get(header))
		if value != "" {
			return strings.TrimSpace(strings.Split(value, ",")[0])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func nullString(value string) interface{} {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func intDefault(value, fallback int) int {
	if value <= 0 {
		return fallback
	}
	return value
}

func firstSub(items []Subscription) interface{} {
	if len(items) == 0 {
		return nil
	}
	return items[0]
}

func firstProfile(items []NodeLibrary) interface{} {
	if len(items) == 0 {
		return nil
	}
	return items[0]
}

func subscriptionFromProfile(input NodeLibrary) Subscription {
	return Subscription{
		ProfileID:             input.ID,
		Name:                  input.Name,
		Remark:                input.Remark,
		Enabled:               input.Enabled,
		TemplateID:            input.TemplateID,
		TrafficSource:         input.TrafficSource,
		TrafficServerID:       input.TrafficServerID,
		UpstreamURL:           input.UpstreamURL,
		UpstreamEnabled:       input.UpstreamEnabled,
		UpstreamRefreshHours:  input.UpstreamRefreshHours,
		UpstreamStatus:        input.UpstreamStatus,
		UpstreamLastError:     input.UpstreamLastError,
		UpstreamLastRefreshAt: input.UpstreamLastRefreshAt,
		TotalBytes:            input.TotalBytes,
		ManualUploadBytes:     input.ManualUploadBytes,
		ManualDownloadBytes:   input.ManualDownloadBytes,
		ExpireAt:              input.ExpireAt,
		CycleType:             input.CycleType,
		CycleDay:              input.CycleDay,
		CycleStart:            input.CycleStart,
		CycleEnd:              input.CycleEnd,
		BaselineUploadBytes:   input.BaselineUploadBytes,
		BaselineDownloadBytes: input.BaselineDownloadBytes,
		RateLimitEnabled:      input.RateLimitEnabled,
		RateLimitPerMinute:    input.RateLimitPerMinute,
	}
}

func normalizeTrafficSource(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "server", "node_servers", "upstream":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "manual"
	}
}

func normalizeCycleType(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "monthly", "custom":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "none"
	}
}

func isExplicitFalse(r *http.Request, field string) bool {
	return false
}

func stringVal(value interface{}) string {
	switch v := value.(type) {
	case string:
		return v
	case json.Number:
		return v.String()
	default:
		return strings.TrimSpace(fmt.Sprint(value))
	}
}

func floatVal(value interface{}) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case int64:
		return float64(v)
	case int:
		return float64(v)
	case json.Number:
		f, _ := v.Float64()
		return f
	case string:
		f, _ := strconv.ParseFloat(v, 64)
		return f
	default:
		return 0
	}
}

func nodeFingerprint(node Node) string {
	return strings.ToLower(fmt.Sprintf("%s|%s|%d|%s", node.Type, node.Server, node.Port, node.Name))
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func parseTime(value string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339, value); err == nil {
		return t, nil
	}
	if t, err := time.Parse("2006-01-02", value); err == nil {
		return t.Add(24*time.Hour - time.Second), nil
	}
	return time.Parse("2006-01-02 15:04:05", value)
}

func absFloat(value float64) float64 {
	if value < 0 {
		return -value
	}
	return value
}

func loadDefaultMihomoTemplate() string {
	if strings.TrimSpace(defaultMihomoTemplateEmbedded) != "" {
		return defaultMihomoTemplateEmbedded
	}
	for _, candidate := range []string{
		filepath.Join("backend-go", "internal", "subscription", "templates", "default-mihomo.yaml"),
		filepath.Join("internal", "subscription", "templates", "default-mihomo.yaml"),
		filepath.Join("data", "subscription", "default-mihomo.yaml"),
	} {
		if data, err := os.ReadFile(candidate); err == nil {
			return string(data)
		}
	}
	return ""
}

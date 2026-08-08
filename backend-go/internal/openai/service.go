package openai

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/iwvw/api-monitor/backend-go/internal/apikeys"
	"github.com/iwvw/api-monitor/backend-go/internal/applog"
	"github.com/iwvw/api-monitor/backend-go/internal/config"
	"github.com/iwvw/api-monitor/backend-go/internal/database"
	"github.com/iwvw/api-monitor/backend-go/internal/response"
	"github.com/iwvw/api-monitor/backend-go/internal/secure"
)

const (
	defaultTimeout           = 60 * time.Second
	degradedThreshold        = 3 * time.Second
	healthTimeoutDefault     = 30 * time.Second
	healthConcurrencyDefault = 4
	healthConcurrencyMax     = 200
)

// 热路径正则预编译：chat completion 每请求都会用到，避免逐请求编译。
var (
	localURLRegex         = regexp.MustCompile(`(?i)^https?://(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)`)
	promptTokensRegex     = regexp.MustCompile(`"prompt_tokens"\s*:\s*(\d+)`)
	completionTokensRegex = regexp.MustCompile(`"completion_tokens"\s*:\s*(\d+)`)
	totalTokensRegex      = regexp.MustCompile(`"total_tokens"\s*:\s*(\d+)`)
	versionPathRegex      = regexp.MustCompile(`(?i)/v\d+/?`)
)

type HeaderItem struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type Endpoint struct {
	ID             string       `json:"id"`
	Name           string       `json:"name"`
	BaseURL        string       `json:"baseUrl"`
	APIKey         string       `json:"apiKey"`
	Notes          string       `json:"notes"`
	Status         string       `json:"status"`
	Enabled        bool         `json:"enabled"`
	Models         []string     `json:"models"`
	Headers        []HeaderItem `json:"headers,omitempty"`
	DisabledModels []string     `json:"disabledModels,omitempty"`
	ProxyPool      []string     `json:"proxyPool,omitempty"`
	AutoSwitch     bool         `json:"autoSwitch"`
	CreatedAt      string       `json:"createdAt"`
	LastUsed       *string      `json:"lastUsed"`
	LastChecked    *string      `json:"lastChecked"`
	HealthStatus   string       `json:"healthStatus,omitempty"`
}

type HealthRecord struct {
	Model      string `json:"model"`
	Status     string `json:"status"`
	Latency    int64  `json:"latency"`
	StatusCode int    `json:"statusCode"`
	Error      string `json:"error,omitempty"`
	CheckedAt  string `json:"checkedAt"`
}

type HealthSummary struct {
	TotalModels   int            `json:"totalModels"`
	Operational   int            `json:"operational"`
	Degraded      int            `json:"degraded"`
	Failed        int            `json:"failed"`
	OverallStatus string         `json:"overallStatus"`
	Results       []HealthRecord `json:"results"`
	CheckedAt     string         `json:"checkedAt"`
}

type Service struct {
	cfg        config.Config
	store      *database.Store
	client     *http.Client
	apiKeys    *apikeys.Manager
	schemaOnce sync.Once
	schemaErr  error

	// proxyStateByEndpoint 记录每个端点的代理池运行时状态（当前游标、冷却中的代理）。
	proxyMu         sync.Mutex
	proxyStateByEndpoint map[string]*endpointProxyState
}

type endpointProxyState struct {
	cursor   int
	cooldown map[string]time.Time
}

func New(cfg config.Config) *Service {
	tr := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          500,
		MaxIdleConnsPerHost:   100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	s := &Service{
		cfg:                   cfg,
		store:                 database.New(cfg),
		client:                &http.Client{Transport: tr, Timeout: defaultTimeout},
		apiKeys:               apikeys.New(cfg),
		proxyStateByEndpoint:  make(map[string]*endpointProxyState),
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if db, err := s.open(ctx); err == nil {
		db.Close()
	}
	return s
}

func (s *Service) open(ctx context.Context) (*sql.DB, error) {
	db, err := s.store.Open(ctx)
	if err != nil {
		return nil, err
	}
	// schema 幂等且启动后不变，进程内只执行一次，避免每次打开连接都重放 DDL。
	s.schemaOnce.Do(func() {
		s.schemaErr = ensureSchema(ctx, db)
	})
	if s.schemaErr != nil {
		db.Close()
		return nil, s.schemaErr
	}
	return db, nil
}

func ensureSchema(ctx context.Context, db *sql.DB) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS openai_endpoints (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			base_url TEXT NOT NULL,
			api_key TEXT NOT NULL,
			headers TEXT,
			disabled_models TEXT,
			proxy_pool TEXT,
			auto_switch INTEGER DEFAULT 0,
			status TEXT DEFAULT 'unknown',
			enabled INTEGER DEFAULT 1,
			models TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			last_used DATETIME,
			last_checked DATETIME
		)`,
		`CREATE TABLE IF NOT EXISTS openai_health_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			endpoint_id TEXT NOT NULL,
			status TEXT NOT NULL,
			response_time INTEGER,
			error_message TEXT,
			checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (endpoint_id) REFERENCES openai_endpoints(id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_openai_endpoints_status ON openai_endpoints(status)`,
		`CREATE INDEX IF NOT EXISTS idx_openai_health_endpoint ON openai_health_history(endpoint_id, checked_at)`,
		`CREATE TABLE IF NOT EXISTS openai_chat_personas (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			icon TEXT,
			system_prompt TEXT NOT NULL,
			is_default INTEGER DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS openai_chat_sessions (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			model TEXT,
			endpoint_id TEXT,
			persona_id TEXT,
			system_prompt TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS openai_chat_messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			reasoning TEXT,
			timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (session_id) REFERENCES openai_chat_sessions(id) ON DELETE CASCADE
		)`,
		`CREATE TABLE IF NOT EXISTS openai_gateway_analytics (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			endpoint_id TEXT,
			gateway_key_id TEXT,
			route TEXT NOT NULL DEFAULT 'chat.completions',
			model TEXT NOT NULL,
			status_code INTEGER NOT NULL,
			latency_ms INTEGER NOT NULL,
			prompt_tokens INTEGER DEFAULT 0,
			completion_tokens INTEGER DEFAULT 0,
			total_tokens INTEGER DEFAULT 0,
			timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS openai_gateway_keys (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			key_hash TEXT NOT NULL UNIQUE,
			key_cipher TEXT,
			key_prefix TEXT NOT NULL,
			key_suffix TEXT NOT NULL,
			enabled INTEGER DEFAULT 1,
			is_default INTEGER NOT NULL DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			last_used DATETIME,
			expires_at DATETIME,
			request_count INTEGER DEFAULT 0
		)`,
		`CREATE INDEX IF NOT EXISTS idx_openai_analytics_timestamp ON openai_gateway_analytics(timestamp)`,
		`CREATE INDEX IF NOT EXISTS idx_openai_gateway_keys_hash ON openai_gateway_keys(key_hash)`,
		`INSERT OR IGNORE INTO openai_chat_personas (id, name, icon, system_prompt, is_default)
		 VALUES ('1', '默认助手', 'fa-robot', '你是一个有用的 AI 助手。', 1)`,
	}
	for _, stmt := range statements {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("openai ensure schema: %w", err)
		}
	}
	if err := ensureSQLiteColumn(ctx, db, "openai_gateway_analytics", "gateway_key_id", "TEXT"); err != nil {
		return err
	}
	if err := ensureSQLiteColumn(ctx, db, "openai_gateway_analytics", "route", "TEXT NOT NULL DEFAULT 'chat.completions'"); err != nil {
		return err
	}
	if err := ensureSQLiteColumn(ctx, db, "openai_gateway_keys", "key_cipher", "TEXT"); err != nil {
		return err
	}
	if err := ensureSQLiteColumn(ctx, db, "openai_gateway_keys", "is_default", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := ensureSQLiteColumn(ctx, db, "openai_endpoints", "headers", "TEXT"); err != nil {
		return err
	}
	if err := ensureSQLiteColumn(ctx, db, "openai_endpoints", "disabled_models", "TEXT"); err != nil {
		return err
	}
	if err := ensureSQLiteColumn(ctx, db, "openai_endpoints", "proxy_pool", "TEXT"); err != nil {
		return err
	}
	if err := ensureSQLiteColumn(ctx, db, "openai_endpoints", "auto_switch", "INTEGER DEFAULT 0"); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_openai_analytics_gateway_key ON openai_gateway_analytics(gateway_key_id, timestamp)`); err != nil {
		return fmt.Errorf("openai ensure schema: %w", err)
	}
	return nil
}

func ensureSQLiteColumn(ctx context.Context, db *sql.DB, table, column, definition string) error {
	rows, err := db.QueryContext(ctx, "PRAGMA table_info("+table+")")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, columnType string
		var notNull, primaryKey int
		var defaultValue interface{}
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return err
		}
		if name == column {
			return nil
		}
	}
	_, err = db.ExecContext(ctx, "ALTER TABLE "+table+" ADD COLUMN "+column+" "+definition)
	return err
}

func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	method := r.Method

	// Completions proxy (intelligent routing or specific load balancer)
	if method == http.MethodPost && (path == "/v1/chat/completions" || path == "/chat/completions" || path == "/api/openai" || path == "/api/openai/v1/chat/completions" || path == "/api/openai/chat/completions") {
		s.proxyChatCompletions(w, r)
		return
	}

	// Models proxy
	if method == http.MethodGet && (path == "/v1/models" || path == "/models" || path == "/api/openai/v1/models" || path == "/api/openai/models") {
		s.proxyModels(w, r)
		return
	}

	// Admin CRUD prefix
	adminPath := strings.TrimPrefix(path, "/api/openai")
	adminPath = strings.Trim(adminPath, "/")
	parts := []string{}
	if adminPath != "" {
		parts = strings.Split(adminPath, "/")
	}

	switch {
	case len(parts) == 1 && parts[0] == "endpoints" && method == http.MethodGet:
		s.listEndpoints(w, r)
	case len(parts) == 1 && parts[0] == "endpoints" && method == http.MethodPost:
		s.createEndpoint(w, r)
	case len(parts) == 2 && parts[0] == "endpoints" && method == http.MethodPut:
		s.updateEndpoint(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "endpoints" && parts[2] == "toggle" && method == http.MethodPost:
		s.toggleEndpoint(w, r, parts[1])
	case len(parts) == 2 && parts[0] == "endpoints" && method == http.MethodDelete:
		s.deleteEndpoint(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "endpoints" && parts[2] == "verify" && method == http.MethodPost:
		s.verifyEndpoint(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "endpoints" && parts[2] == "models" && method == http.MethodGet:
		s.getEndpointModels(w, r, parts[1])
	case len(parts) == 4 && parts[0] == "endpoints" && parts[2] == "models" && parts[3] == "toggle" && method == http.MethodPost:
		s.toggleEndpointModel(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "endpoints" && parts[2] == "test" && method == http.MethodPost:
		s.testEndpointChat(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "endpoints" && parts[2] == "health-check" && method == http.MethodPost:
		s.healthCheckModelRoute(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "endpoints" && parts[2] == "health-check-all" && method == http.MethodPost:
		s.healthCheckAllModelsRoute(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "endpoints" && parts[2] == "health" && method == http.MethodGet:
		s.getEndpointHealthRoute(w, r, parts[1])
	case len(parts) == 2 && parts[0] == "endpoints" && (parts[1] == "refresh" || parts[1] == "refresh-all") && method == http.MethodPost:
		s.refreshAllEndpointsRoute(w, r)
	case len(parts) == 1 && parts[0] == "health-check-all" && method == http.MethodPost:
		s.healthCheckAllRoute(w, r)
	case len(parts) == 1 && parts[0] == "keys" && method == http.MethodGet:
		s.listGatewayKeys(w, r)
	case len(parts) == 1 && parts[0] == "keys" && method == http.MethodPost:
		s.createGatewayKey(w, r)
	case len(parts) == 2 && parts[0] == "keys" && method == http.MethodPut:
		s.updateGatewayKey(w, r, parts[1])
	case len(parts) == 2 && parts[0] == "keys" && method == http.MethodDelete:
		s.deleteGatewayKey(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "keys" && parts[2] == "toggle" && method == http.MethodPost:
		s.toggleGatewayKey(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "keys" && parts[2] == "rotate" && method == http.MethodPost:
		s.rotateGatewayKey(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "keys" && parts[2] == "default" && method == http.MethodPut:
		s.setDefaultGatewayKey(w, r, parts[1])
	case len(parts) == 1 && parts[0] == "export" && method == http.MethodGet:
		s.exportEndpointsRoute(w, r)
	case len(parts) == 1 && parts[0] == "import" && method == http.MethodPost:
		s.importEndpointsRoute(w, r)
	case len(parts) == 2 && parts[0] == "proxies" && parts[1] == "subscription-nodes" && method == http.MethodGet:
		s.listSubscriptionSocksProxies(w, r)
	case len(parts) == 2 && parts[0] == "analytics" && parts[1] == "summary" && method == http.MethodGet:
		s.getAnalyticsSummary(w, r)
	case len(parts) == 2 && parts[0] == "analytics" && parts[1] == "charts" && method == http.MethodGet:
		s.getAnalyticsCharts(w, r)
	case len(parts) == 2 && parts[0] == "analytics" && parts[1] == "logs" && method == http.MethodGet:
		s.getAnalyticsLogs(w, r)
	case len(parts) == 1 && parts[0] == "personas" && method == http.MethodGet:
		s.listPersonas(w, r)
	case len(parts) == 1 && parts[0] == "personas" && method == http.MethodPost:
		s.createPersona(w, r)
	case len(parts) == 2 && parts[0] == "personas" && method == http.MethodPut:
		s.updatePersona(w, r, parts[1])
	case len(parts) == 2 && parts[0] == "personas" && method == http.MethodDelete:
		s.deletePersona(w, r, parts[1])
	case len(parts) == 1 && parts[0] == "sessions" && method == http.MethodGet:
		s.listSessions(w, r)
	case len(parts) == 1 && parts[0] == "sessions" && method == http.MethodPost:
		s.createSession(w, r)
	case len(parts) == 1 && parts[0] == "sessions" && method == http.MethodDelete:
		s.clearSessions(w, r)
	case len(parts) == 2 && parts[0] == "sessions" && method == http.MethodPut:
		s.updateSession(w, r, parts[1])
	case len(parts) == 2 && parts[0] == "sessions" && method == http.MethodDelete:
		s.deleteSession(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "sessions" && parts[2] == "messages" && method == http.MethodGet:
		s.listSessionMessages(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "sessions" && parts[2] == "messages" && method == http.MethodPost:
		s.createSessionMessage(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "sessions" && parts[2] == "messages" && method == http.MethodDelete:
		s.clearSessionMessages(w, r, parts[1])
	case len(parts) == 4 && parts[0] == "sessions" && parts[2] == "messages" && method == http.MethodDelete:
		s.deleteSessionMessage(w, r, parts[1], parts[3])
	default:
		response.Error(w, http.StatusNotFound, "openai admin route not found")
	}
}

func (s *Service) listEndpoints(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, "SELECT id, name, base_url, api_key, headers, disabled_models, proxy_pool, auto_switch, status, enabled, models, created_at, last_used, last_checked FROM openai_endpoints")
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	endpoints := []Endpoint{}
	for rows.Next() {
		var ep Endpoint
		var headersRaw, modelsRaw, disabledRaw, proxyRaw sql.NullString
		var created, used, checked sql.NullString
		var enabledInt, autoSwitchInt int

		err := rows.Scan(&ep.ID, &ep.Name, &ep.BaseURL, &ep.APIKey, &headersRaw, &disabledRaw, &proxyRaw, &autoSwitchInt, &ep.Status, &enabledInt, &modelsRaw, &created, &used, &checked)
		if err != nil {
			response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}

		ep.APIKey = secure.SecureDecrypt(ep.APIKey)
		ep.Enabled = enabledInt == 1
		ep.AutoSwitch = autoSwitchInt == 1
		ep.CreatedAt = created.String
		if used.Valid {
			v := used.String
			ep.LastUsed = &v
		}
		if checked.Valid {
			v := checked.String
			ep.LastChecked = &v
		}

		ep.Models = []string{}
		if modelsRaw.Valid && modelsRaw.String != "" {
			_ = json.Unmarshal([]byte(modelsRaw.String), &ep.Models)
		}
		ep.Headers = []HeaderItem{}
		if headersRaw.Valid && headersRaw.String != "" {
			_ = json.Unmarshal([]byte(headersRaw.String), &ep.Headers)
		}
		ep.DisabledModels = []string{}
		if disabledRaw.Valid && disabledRaw.String != "" {
			_ = json.Unmarshal([]byte(disabledRaw.String), &ep.DisabledModels)
		}
		ep.ProxyPool = []string{}
		if proxyRaw.Valid && proxyRaw.String != "" {
			_ = json.Unmarshal([]byte(proxyRaw.String), &ep.ProxyPool)
		}
		endpoints = append(endpoints, ep)
	}

	response.JSON(w, http.StatusOK, endpoints)
}

func (s *Service) createEndpoint(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name       string       `json:"name"`
		BaseURL    string       `json:"baseUrl"`
		APIKey     string       `json:"apiKey"`
		Notes      string       `json:"notes"`
		Headers    []HeaderItem `json:"headers"`
		ProxyPool  []string     `json:"proxyPool"`
		AutoSwitch bool         `json:"autoSwitch"`
		SkipVerify bool         `json:"skipVerify"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if req.Name == "" || req.BaseURL == "" || req.APIKey == "" {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "名称、API 地址和 API Key 必填"})
		return
	}

	normalizedURL := s.normalizeBaseURL(req.BaseURL)
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	headersJSON, _ := json.Marshal(cleanHeaders(req.Headers))
	proxyJSON, _ := json.Marshal(cleanProxyPool(req.ProxyPool))
	autoSwitchInt := boolToInt(req.AutoSwitch)

	id := fmt.Sprintf("oai_%d_%s", time.Now().UnixNano(), s.randString(9))
	status := "unknown"
	modelsList := []string{}
	var verification map[string]interface{}

	if !req.SkipVerify {
		vOk, count, err := s.verifyAPIKeyRaw(ctx, normalizedURL, req.APIKey, cleanHeaders(req.Headers))
		if err == nil && vOk {
			status = "valid"
			verification = map[string]interface{}{
				"valid":       true,
				"modelsCount": count,
			}
			mList, mErr := s.listModelsRaw(ctx, normalizedURL, req.APIKey, cleanHeaders(req.Headers))
			if mErr == nil {
				modelsList = mList
			}
		} else {
			status = "invalid"
			errMsg := "API Key 验证失败"
			if err != nil {
				errMsg = err.Error()
			}
			verification = map[string]interface{}{
				"valid": false,
				"error": errMsg,
			}
		}
	}

	modelsJSON, _ := json.Marshal(modelsList)
	createdAt := time.Now().Format(time.RFC3339)
	var lastCheckedVal interface{} = nil
	if !req.SkipVerify {
		lastCheckedVal = createdAt
	}

	encryptedKey, err := secure.SecureEncrypt(req.APIKey)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": "数据加密失败"})
		return
	}
	_, err = db.ExecContext(ctx, `
		INSERT INTO openai_endpoints (id, name, base_url, api_key, headers, disabled_models, proxy_pool, auto_switch, status, enabled, models, created_at, last_checked)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, req.Name, normalizedURL, encryptedKey, string(headersJSON), "[]", string(proxyJSON), autoSwitchInt, status, 1, string(modelsJSON), createdAt, lastCheckedVal)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	var checkedStr *string
	if !req.SkipVerify {
		checkedStr = &createdAt
	}

	resEndpoint := Endpoint{
		ID:          id,
		Name:        req.Name,
		BaseURL:     normalizedURL,
		APIKey:      req.APIKey,
		Notes:       req.Notes,
		Headers:     cleanHeaders(req.Headers),
		ProxyPool:   cleanProxyPool(req.ProxyPool),
		AutoSwitch:  req.AutoSwitch,
		Status:      status,
		Enabled:     true,
		Models:      modelsList,
		CreatedAt:   createdAt,
		LastChecked: checkedStr,
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"success":      true,
		"endpoint":     resEndpoint,
		"verification": verification,
	})
}

func (s *Service) updateEndpoint(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Name       string        `json:"name"`
		BaseURL    string        `json:"baseUrl"`
		APIKey     string        `json:"apiKey"`
		Notes      string        `json:"notes"`
		Headers    *[]HeaderItem `json:"headers"`
		ProxyPool  *[]string     `json:"proxyPool"`
		AutoSwitch *bool         `json:"autoSwitch"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	var currentBaseURL, currentAPIKey string
	err = db.QueryRowContext(ctx, "SELECT base_url, api_key FROM openai_endpoints WHERE id = ?", id).Scan(&currentBaseURL, &currentAPIKey)
	if err != nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "端点不存在"})
		return
	}
	currentAPIKey = secure.SecureDecrypt(currentAPIKey)

	targetBaseURL := currentBaseURL
	if req.BaseURL != "" {
		targetBaseURL = s.normalizeBaseURL(req.BaseURL)
	}
	targetAPIKey := currentAPIKey
	if req.APIKey != "" {
		targetAPIKey = req.APIKey
	}
	headersJSON, _ := json.Marshal([]HeaderItem{})
	headersChanged := false
	if req.Headers != nil {
		headersJSON, _ = json.Marshal(cleanHeaders(*req.Headers))
		headersChanged = true
	}
	proxyJSON, _ := json.Marshal([]string{})
	proxyChanged := false
	if req.ProxyPool != nil {
		proxyJSON, _ = json.Marshal(cleanProxyPool(*req.ProxyPool))
		proxyChanged = true
	}
	autoSwitchInt := 0
	autoSwitchChanged := false
	if req.AutoSwitch != nil {
		autoSwitchInt = boolToInt(*req.AutoSwitch)
		autoSwitchChanged = true
	}

	if req.APIKey != "" || req.BaseURL != "" {
		status := "unknown"
		modelsList := []string{}

		verifyHeaders := []HeaderItem(nil)
		if req.Headers != nil {
			verifyHeaders = cleanHeaders(*req.Headers)
		}

		vOk, _, err := s.verifyAPIKeyRaw(ctx, targetBaseURL, targetAPIKey, verifyHeaders)
		if err == nil && vOk {
			status = "valid"
			mList, mErr := s.listModelsRaw(ctx, targetBaseURL, targetAPIKey, verifyHeaders)
			if mErr == nil {
				modelsList = mList
			}
		} else {
			status = "invalid"
		}

		modelsJSON, _ := json.Marshal(modelsList)
		encryptedKey, err := secure.SecureEncrypt(targetAPIKey)
		if err != nil {
			response.JSON(w, http.StatusInternalServerError, map[string]string{"error": "数据加密失败"})
			return
		}
		lastChecked := time.Now().Format(time.RFC3339)

		_, err = db.ExecContext(ctx, `
			UPDATE openai_endpoints
			SET name = ?, base_url = ?, api_key = ?, headers = ?, proxy_pool = ?, auto_switch = ?, status = ?, models = ?, last_checked = ?
			WHERE id = ?`,
			req.Name, targetBaseURL, encryptedKey, string(headersJSON), string(proxyJSON), autoSwitchInt, status, string(modelsJSON), lastChecked, id)
		if err != nil {
			response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	} else if headersChanged || proxyChanged || autoSwitchChanged {
		_, err = db.ExecContext(ctx, "UPDATE openai_endpoints SET name = ?, headers = ?, proxy_pool = ?, auto_switch = ? WHERE id = ?",
			req.Name, string(headersJSON), string(proxyJSON), autoSwitchInt, id)
		if err != nil {
			response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	} else {
		_, err = db.ExecContext(ctx, "UPDATE openai_endpoints SET name = ? WHERE id = ?", req.Name, id)
		if err != nil {
			response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

func cleanProxyPool(pool []string) []string {
	out := make([]string, 0, len(pool))
	seen := make(map[string]bool, len(pool))
	for _, raw := range pool {
		entry := strings.TrimSpace(raw)
		if entry == "" {
			continue
		}
		if seen[entry] {
			continue
		}
		seen[entry] = true
		out = append(out, entry)
	}
	return out
}

func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

// proxyCooldown 是一个代理被标记限流/失败后的冷却间隔，避免立即又被选回。
const proxyCooldown = 60 * time.Second

// clientForEndpoint 按端点代理池选择下一个可用代理，返回绑定该代理的 http.Client。
// pool 为空时回退到默认客户端（直连 / 环境代理）。
func (s *Service) clientForEndpoint(endpointID string, pool []string, _ bool) (*http.Client, string) {
	if len(pool) == 0 {
		return s.client, ""
	}
	cleaned := cleanProxyPool(pool)
	if len(cleaned) == 0 {
		return s.client, ""
	}
	now := time.Now()

	s.proxyMu.Lock()
	state, ok := s.proxyStateByEndpoint[endpointID]
	if !ok {
		state = &endpointProxyState{cursor: 0, cooldown: make(map[string]time.Time)}
		s.proxyStateByEndpoint[endpointID] = state
	}
	if state.cursor >= len(cleaned) || state.cursor < 0 {
		state.cursor = 0
	}
	selected := -1
	for i := 0; i < len(cleaned); i++ {
		idx := (state.cursor + i) % len(cleaned)
		if until, cooled := state.cooldown[cleaned[idx]]; !cooled || now.After(until) {
			selected = idx
			break
		}
	}
	if selected < 0 {
		selected = state.cursor % len(cleaned)
	}
	state.cursor = (selected + 1) % len(cleaned)
	selectedProxy := cleaned[selected]
	s.proxyMu.Unlock()

	client, err := s.proxyClient(selectedProxy)
	if err != nil {
		return s.client, selectedProxy
	}
	return client, selectedProxy
}

// markProxyFailed 将某个代理标记为冷却，后续选择会跳过它。
func (s *Service) markProxyFailed(endpointID, proxy string) {
	if proxy == "" {
		return
	}
	s.proxyMu.Lock()
	defer s.proxyMu.Unlock()
	state, ok := s.proxyStateByEndpoint[endpointID]
	if !ok {
		return
	}
	state.cooldown[proxy] = time.Now().Add(proxyCooldown)
}

// proxyClients 按代理 URL 缓存 http.Client，避免每次请求重建 transport。
var proxyClients = struct {
	sync.Mutex
	m map[string]*http.Client
}{m: make(map[string]*http.Client)}

func (s *Service) proxyClient(proxyURL string) (*http.Client, error) {
	u, err := url.Parse(proxyURL)
	if err != nil {
		return nil, err
	}
	switch u.Scheme {
	case "socks5":
		u.Scheme = "socks5"
	case "":
		// 裸地址（host:port）默认按 socks5 处理，便于直接粘贴节点地址。
		u = &url.URL{Scheme: "socks5", Host: proxyURL}
	default:
		if u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "socks5h" {
			return nil, fmt.Errorf("不支持的代理协议: %s", u.Scheme)
		}
	}
	proxyClients.Lock()
	defer proxyClients.Unlock()
	if c, ok := proxyClients.m[proxyURL]; ok {
		return c, nil
	}
	tr := &http.Transport{
		Proxy: http.ProxyURL(u),
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          500,
		MaxIdleConnsPerHost:   100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	c := &http.Client{Transport: tr, Timeout: s.client.Timeout}
	proxyClients.m[proxyURL] = c
	return c, nil
}

// isRateLimitResponse 判断上游响应是否命中限流（429/439/503/529 或正文含限流关键词）。
func isRateLimitResponse(resp *http.Response, body []byte) bool {
	switch resp.StatusCode {
	case http.StatusTooManyRequests, 439, http.StatusServiceUnavailable, 529:
		return true
	}
	if len(body) > 0 {
		lower := strings.ToLower(string(body))
		for _, keyword := range []string{"rate limit", "rate_limit", "too many requests", "overloaded", "throttled"} {
			if strings.Contains(lower, keyword) {
				return true
			}
		}
	}
	return false
}

// cleanHeaders 过滤掉空名称的条目，其余原样保留。
func cleanHeaders(headers []HeaderItem) []HeaderItem {
	out := make([]HeaderItem, 0, len(headers))
	for _, h := range headers {
		name := strings.TrimSpace(h.Name)
		if name == "" {
			continue
		}
		out = append(out, HeaderItem{Name: name, Value: h.Value})
	}
	return out
}

// isModelDisabled 判断给定模型是否在端点禁用的模型列表中。
func isModelDisabled(disabled []string, model string) bool {
	for _, m := range disabled {
		if m == model {
			return true
		}
	}
	return false
}

// decodeEndpointHeaders 从数据库的 headers JSON 列还原自定义请求头。
func decodeEndpointHeaders(raw sql.NullString) []HeaderItem {
	headers := []HeaderItem{}
	if raw.Valid && raw.String != "" {
		_ = json.Unmarshal([]byte(raw.String), &headers)
	}
	return cleanHeaders(headers)
}

// applyCustomHeaders 把端点配置的自定义请求头写入待发请求。
// 网关自身的鉴权（Authorization 等）在调用方设置，自定义头允许覆盖非鉴权头。
func applyCustomHeaders(req *http.Request, headers []HeaderItem) {
	for _, h := range headers {
		name := strings.TrimSpace(h.Name)
		if name == "" {
			continue
		}
		req.Header.Set(name, h.Value)
	}
}

func (s *Service) toggleEndpoint(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	var exists int
	err = db.QueryRowContext(ctx, "SELECT COUNT(*) FROM openai_endpoints WHERE id = ?", id).Scan(&exists)
	if err != nil || exists == 0 {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "端点不存在"})
		return
	}

	enabledVal := 0
	if req.Enabled {
		enabledVal = 1
	}

	_, err = db.ExecContext(ctx, "UPDATE openai_endpoints SET enabled = ? WHERE id = ?", enabledVal, id)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true, "enabled": req.Enabled})
}

func (s *Service) deleteEndpoint(w http.ResponseWriter, r *http.Request, id string) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	res, err := db.ExecContext(ctx, "DELETE FROM openai_endpoints WHERE id = ?", id)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	rows, err := res.RowsAffected()
	if err != nil || rows == 0 {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "端点不存在"})
		return
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

func (s *Service) verifyEndpoint(w http.ResponseWriter, r *http.Request, id string) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	var name, baseURL, apiKey string
	var headersRaw sql.NullString
	err = db.QueryRowContext(ctx, "SELECT name, base_url, api_key, headers FROM openai_endpoints WHERE id = ?", id).Scan(&name, &baseURL, &apiKey, &headersRaw)
	if err != nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "端点不存在"})
		return
	}
	apiKey = secure.SecureDecrypt(apiKey)
	headers := decodeEndpointHeaders(headersRaw)

	startTime := time.Now()
	status := "invalid"
	modelsList := []string{}
	var errMsg string

	vOk, _, vErr := s.verifyAPIKeyRaw(ctx, baseURL, apiKey, headers)
	responseTime := time.Since(startTime).Milliseconds()

	if vErr == nil && vOk {
		status = "valid"
		mList, mErr := s.listModelsRaw(ctx, baseURL, apiKey, headers)
		if mErr == nil {
			modelsList = mList
		}
	} else if vErr != nil {
		errMsg = vErr.Error()
	}

	checkedAt := time.Now().Format(time.RFC3339)
	modelsJSON, _ := json.Marshal(modelsList)

	_, err = db.ExecContext(ctx, `
		UPDATE openai_endpoints
		SET status = ?, models = ?, last_checked = ?
		WHERE id = ?`,
		status, string(modelsJSON), checkedAt, id)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	res := map[string]interface{}{
		"status":       status,
		"responseTime": responseTime,
		"modelsCount":  len(modelsList),
		"models":       modelsList,
		"checkedAt":    checkedAt,
		"valid":        status == "valid",
	}
	if errMsg != "" {
		res["error"] = errMsg
	}

	response.JSON(w, http.StatusOK, res)
}

func (s *Service) getEndpointModels(w http.ResponseWriter, r *http.Request, id string) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	var baseURL, apiKey string
	var headersRaw sql.NullString
	err = db.QueryRowContext(ctx, "SELECT base_url, api_key, headers FROM openai_endpoints WHERE id = ?", id).Scan(&baseURL, &apiKey, &headersRaw)
	if err != nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "端点不存在"})
		return
	}
	apiKey = secure.SecureDecrypt(apiKey)

	modelsList, err := s.listModelsRaw(ctx, baseURL, apiKey, decodeEndpointHeaders(headersRaw))
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	modelsJSON, _ := json.Marshal(modelsList)
	checkedAt := time.Now().Format(time.RFC3339)

	_, _ = db.ExecContext(ctx, "UPDATE openai_endpoints SET models = ?, last_checked = ? WHERE id = ?", string(modelsJSON), checkedAt, id)

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"models":  modelsList,
	})
}

func (s *Service) toggleEndpointModel(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Model   string `json:"model"`
		Enabled bool   `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	model := strings.TrimSpace(req.Model)
	if model == "" {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "模型名称必填"})
		return
	}

	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	var disabledRaw sql.NullString
	err = db.QueryRowContext(ctx, "SELECT disabled_models FROM openai_endpoints WHERE id = ?", id).Scan(&disabledRaw)
	if err != nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "端点不存在"})
		return
	}

	disabled := []string{}
	if disabledRaw.Valid && disabledRaw.String != "" {
		_ = json.Unmarshal([]byte(disabledRaw.String), &disabled)
	}

	disabledSet := make(map[string]bool, len(disabled)+1)
	for _, m := range disabled {
		disabledSet[m] = true
	}
	if req.Enabled {
		delete(disabledSet, model)
	} else {
		disabledSet[model] = true
	}

	next := make([]string, 0, len(disabledSet))
	for m := range disabledSet {
		next = append(next, m)
	}
	sort.Strings(next)

	disabledJSON, _ := json.Marshal(next)
	_, err = db.ExecContext(ctx, "UPDATE openai_endpoints SET disabled_models = ? WHERE id = ?", string(disabledJSON), id)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"success":        true,
		"model":          model,
		"enabled":        req.Enabled,
		"disabledModels": next,
	})
}

// subscriptionProxy 描述一个可从订阅节点导入到端点代理池的 socks/http 出口。
type subscriptionProxy struct {
	NodeID   string `json:"nodeId"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Server   string `json:"server"`
	Port     int    `json:"port"`
	Proxy    string `json:"proxy"`
	Location string `json:"location,omitempty"`
}

// listSubscriptionSocksProxies 读取订阅板块中的 socks/http 协议节点，转换为可直接使用的代理 URL。
func (s *Service) listSubscriptionSocksProxies(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, `SELECT id, COALESCE(name,''), COALESCE(type,''), COALESCE(server,''), COALESCE(port,0), COALESCE(location,''), COALESCE(raw_encrypted,'') FROM subscription_nodes WHERE enabled = 1`)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	proxies := []subscriptionProxy{}
	seen := make(map[string]bool)
	for rows.Next() {
		var item subscriptionProxy
		var rawEnc string
		if err := rows.Scan(&item.NodeID, &item.Name, &item.Type, &item.Server, &item.Port, &item.Location, &rawEnc); err != nil {
			continue
		}
		item.Type = strings.ToLower(strings.TrimSpace(item.Type))
		if item.Type != "socks" && item.Type != "socks5" && item.Type != "http" && item.Type != "https" {
			continue
		}
		raw := secure.SecureDecrypt(rawEnc)
		proxy, name, ok := convertNodeToProxy(item.Type, raw, item.Server, item.Port, item.Name)
		if !ok || proxy == "" {
			continue
		}
		item.Proxy = proxy
		item.Name = name
		if seen[proxy] {
			continue
		}
		seen[proxy] = true
		proxies = append(proxies, item)
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true, "proxies": proxies})
}

// convertNodeToProxy 把订阅节点 raw URI 转换为网关可用的 socks5/http 代理 URL。
// 优先复用 raw 中的用户凭据；raw 无法解析时回退为 server:port。
func convertNodeToProxy(nodeType, raw, server string, port int, fallbackName string) (proxy, name string, ok bool) {
	name = strings.TrimSpace(fallbackName)
	if name == "" {
		name = server
	}
	trimmed := strings.TrimSpace(raw)
	if strings.HasPrefix(strings.ToLower(trimmed), "socks://") ||
		strings.HasPrefix(strings.ToLower(trimmed), "socks5://") ||
		strings.HasPrefix(strings.ToLower(trimmed), "http://") ||
		strings.HasPrefix(strings.ToLower(trimmed), "https://") {
		u, err := url.Parse(trimmed)
		if err == nil && u.Host != "" {
			scheme := u.Scheme
			if scheme == "socks" || scheme == "socks5" {
				scheme = "socks5"
			}
			u.Scheme = scheme
			// 去掉 fragment（节点名常放在 # 后）。
			u.Fragment = ""
			if fragName := parseNodeFragment(trimmed); fragName != "" {
				name = fragName
			}
			return u.String(), name, true
		}
	}
	// 无 raw 或解析失败：直接用 server:port 构造成 socks5。
	if server == "" || port < 1 || port > 65535 {
		return "", name, false
	}
	return fmt.Sprintf("socks5://%s", net.JoinHostPort(server, strconv.Itoa(port))), name, true
}

func parseNodeFragment(raw string) string {
	idx := strings.LastIndex(raw, "#")
	if idx < 0 || idx+1 >= len(raw) {
		return ""
	}
	name := strings.TrimSpace(raw[idx+1:])
	name = strings.Trim(name, "\"")
	return name
}

func (s *Service) testEndpointChat(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Model string `json:"model"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	modelName := req.Model
	if modelName == "" {
		modelName = "gpt-3.5-turbo"
	}

	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	var baseURL, apiKey string
	var headersRaw sql.NullString
	err = db.QueryRowContext(ctx, "SELECT base_url, api_key, headers FROM openai_endpoints WHERE id = ?", id).Scan(&baseURL, &apiKey, &headersRaw)
	if err != nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "端点不存在"})
		return
	}
	apiKey = secure.SecureDecrypt(apiKey)

	// Touch endpoint
	_, _ = db.ExecContext(ctx, "UPDATE openai_endpoints SET last_used = ? WHERE id = ?", time.Now().Format(time.RFC3339), id)

	chatPayload := map[string]interface{}{
		"model": modelName,
		"messages": []map[string]string{
			{"role": "user", "content": "Say \"Hello, API test successful!\" in exactly those words."},
		},
		"max_tokens": 50,
	}
	bodyBytes, _ := json.Marshal(chatPayload)

	reqURL := fmt.Sprintf("%s/chat/completions", strings.TrimSuffix(baseURL, "/"))
	httpReq, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(bodyBytes))
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")
	applyCustomHeaders(httpReq, decodeEndpointHeaders(headersRaw))

	resp, err := s.client.Do(httpReq)
	if err != nil {
		response.JSON(w, http.StatusOK, map[string]interface{}{"success": false, "error": err.Error()})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBytes, _ := io.ReadAll(resp.Body)
		response.JSON(w, http.StatusOK, map[string]interface{}{"success": false, "error": fmt.Sprintf("HTTP %d: %s", resp.StatusCode, string(respBytes))})
		return
	}

	var chatResponse struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage interface{} `json:"usage"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&chatResponse); err != nil {
		response.JSON(w, http.StatusOK, map[string]interface{}{"success": false, "error": "无法解析响应 JSON"})
		return
	}

	reply := ""
	if len(chatResponse.Choices) > 0 {
		reply = chatResponse.Choices[0].Message.Content
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"response": reply,
		"usage":    chatResponse.Usage,
	})
}

func (s *Service) healthCheckModelRoute(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Model   string `json:"model"`
		Timeout int    `json:"timeout"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if req.Model == "" {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "模型名称必填"})
		return
	}

	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	var baseURL, apiKey string
	var headersRaw sql.NullString
	err = db.QueryRowContext(ctx, "SELECT base_url, api_key, headers FROM openai_endpoints WHERE id = ?", id).Scan(&baseURL, &apiKey, &headersRaw)
	if err != nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "端点不存在"})
		return
	}
	apiKey = secure.SecureDecrypt(apiKey)

	timeoutDuration := healthTimeoutDefault
	if req.Timeout > 0 {
		timeoutDuration = time.Duration(req.Timeout) * time.Millisecond
	}

	// Touch endpoint
	_, _ = db.ExecContext(ctx, "UPDATE openai_endpoints SET last_used = ? WHERE id = ?", time.Now().Format(time.RFC3339), id)

	result := s.healthCheckSingleModel(ctx, id, baseURL, apiKey, req.Model, timeoutDuration, decodeEndpointHeaders(headersRaw))

	// Save check to health history
	var errMsg sql.NullString
	if result.Error != "" {
		errMsg.Valid = true
		errMsg.String = result.Error
	}
	_, _ = db.ExecContext(ctx, `
		INSERT INTO openai_health_history (endpoint_id, status, response_time, error_message, checked_at)
		VALUES (?, ?, ?, ?, ?)`,
		id, result.Status, result.Latency, errMsg, result.CheckedAt)

	response.JSON(w, http.StatusOK, result)
}

func (s *Service) healthCheckAllModelsRoute(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Timeout     int `json:"timeout"`
		Concurrency int `json:"concurrency"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	var baseURL, apiKey, modelsRaw string
	var headersRaw sql.NullString
	err = db.QueryRowContext(ctx, "SELECT base_url, api_key, models, headers FROM openai_endpoints WHERE id = ?", id).Scan(&baseURL, &apiKey, &modelsRaw, &headersRaw)
	if err != nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "端点不存在"})
		return
	}
	apiKey = secure.SecureDecrypt(apiKey)
	endpointHeaders := decodeEndpointHeaders(headersRaw)

	var models []string
	if modelsRaw != "" {
		models = parseModelIDsFromRaw(modelsRaw)
	}

	if len(models) == 0 {
		response.JSON(w, http.StatusOK, map[string]interface{}{
			"success":     true,
			"totalModels": 0,
			"message":     "该端点没有模型可供检测",
		})
		return
	}

	// Touch endpoint
	_, _ = db.ExecContext(ctx, "UPDATE openai_endpoints SET last_used = ? WHERE id = ?", time.Now().Format(time.RFC3339), id)

	timeoutDuration := healthTimeoutDefault
	if req.Timeout > 0 {
		timeoutDuration = time.Duration(req.Timeout) * time.Millisecond
	}

	concurrency := healthConcurrencyDefault
	if req.Concurrency > 0 {
		concurrency = req.Concurrency
	}
	concurrency = min(max(concurrency, 1), healthConcurrencyMax)

	summary := s.runBatchHealthCheck(ctx, id, baseURL, apiKey, models, timeoutDuration, concurrency, endpointHeaders)

	// Save check results to db history
	for _, result := range summary.Results {
		var errMsg sql.NullString
		if result.Error != "" {
			errMsg.Valid = true
			errMsg.String = result.Error
		}
		_, _ = db.ExecContext(ctx, `
			INSERT INTO openai_health_history (endpoint_id, status, response_time, error_message, checked_at)
			VALUES (?, ?, ?, ?, ?)`,
			id, result.Status, result.Latency, errMsg, result.CheckedAt)
	}

	// Update endpoint status
	_, _ = db.ExecContext(ctx, `
		UPDATE openai_endpoints
		SET status = ?, last_checked = ?
		WHERE id = ?`,
		summary.OverallStatus, summary.CheckedAt, id)

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"summary": summary,
	})
}

func (s *Service) getEndpointHealthRoute(w http.ResponseWriter, r *http.Request, id string) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	var status, lastChecked sql.NullString
	err = db.QueryRowContext(ctx, "SELECT status, last_checked FROM openai_endpoints WHERE id = ?", id).Scan(&status, &lastChecked)
	if err != nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "端点不存在"})
		return
	}

	// Fetch health history per model
	rows, err := db.QueryContext(ctx, `
		SELECT h.status, h.response_time, h.error_message, h.checked_at
		FROM openai_health_history h
		WHERE h.endpoint_id = ?
		ORDER BY h.checked_at DESC
		LIMIT 100`, id)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	history := []map[string]interface{}{}
	for rows.Next() {
		var hStatus, checked string
		var respTime sql.NullInt64
		var errMsg sql.NullString
		if err := rows.Scan(&hStatus, &respTime, &errMsg, &checked); err == nil {
			item := map[string]interface{}{
				"status":    hStatus,
				"checkedAt": checked,
			}
			if respTime.Valid {
				item["responseTime"] = respTime.Int64
			}
			if errMsg.Valid {
				item["errorMessage"] = errMsg.String
			}
			history = append(history, item)
		}
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"endpointId":      id,
		"healthStatus":    status.String,
		"lastHealthCheck": lastChecked.String,
		"history":         history,
	})
}

func (s *Service) refreshAllEndpointsRoute(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, "SELECT id, name, base_url, api_key, headers FROM openai_endpoints WHERE enabled = 1")
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	type item struct {
		id, name, url, key string
		headers            []HeaderItem
	}
	items := []item{}
	for rows.Next() {
		var it item
		var headersRaw sql.NullString
		if err := rows.Scan(&it.id, &it.name, &it.url, &it.key, &headersRaw); err == nil {
			it.key = secure.SecureDecrypt(it.key)
			it.headers = decodeEndpointHeaders(headersRaw)
			items = append(items, it)
		}
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	results := []map[string]interface{}{}

	for _, it := range items {
		wg.Add(1)
		go func(it item) {
			defer wg.Done()
			status := "invalid"
			modelsList := []string{}
			var errStr string

			vOk, _, err := s.verifyAPIKeyRaw(ctx, it.url, it.key, it.headers)
			if err == nil && vOk {
				status = "valid"
				mList, mErr := s.listModelsRaw(ctx, it.url, it.key, it.headers)
				if mErr == nil {
					modelsList = mList
				}
			} else if err != nil {
				errStr = err.Error()
			}

			checkedAt := time.Now().Format(time.RFC3339)
			modelsJSON, _ := json.Marshal(modelsList)

			// Update in DB
			if dbConn, dbErr := s.open(ctx); dbErr == nil {
				defer dbConn.Close()
				_, _ = dbConn.ExecContext(ctx, `
					UPDATE openai_endpoints
					SET status = ?, models = ?, last_checked = ?
					WHERE id = ?`,
					status, string(modelsJSON), checkedAt, it.id)
			}

			mu.Lock()
			res := map[string]interface{}{
				"id":          it.id,
				"name":        it.name,
				"success":     status == "valid",
				"modelsCount": len(modelsList),
			}
			if errStr != "" {
				res["error"] = errStr
			}
			results = append(results, res)
			mu.Unlock()
		}(it)
	}

	wg.Wait()
	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true, "results": results})
}

func (s *Service) healthCheckAllRoute(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Timeout     int `json:"timeout"`
		Concurrency int `json:"concurrency"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, "SELECT id, name, base_url, api_key, models, headers FROM openai_endpoints WHERE enabled = 1")
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	type item struct {
		id, name, url, key, modelsRaw string
		headers                       []HeaderItem
	}
	items := []item{}
	for rows.Next() {
		var it item
		var headersRaw sql.NullString
		if err := rows.Scan(&it.id, &it.name, &it.url, &it.key, &it.modelsRaw, &headersRaw); err == nil {
			it.key = secure.SecureDecrypt(it.key)
			it.headers = decodeEndpointHeaders(headersRaw)
			items = append(items, it)
		}
	}

	timeoutDuration := healthTimeoutDefault
	if req.Timeout > 0 {
		timeoutDuration = time.Duration(req.Timeout) * time.Millisecond
	}

	concurrency := healthConcurrencyDefault
	if req.Concurrency > 0 {
		concurrency = req.Concurrency
	}
	concurrency = min(max(concurrency, 1), healthConcurrencyMax)

	type endpointTarget struct {
		item
		models []string
	}
	targets := make([]endpointTarget, 0, len(items))
	for _, it := range items {
		models := parseModelIDsFromRaw(it.modelsRaw)
		targets = append(targets, endpointTarget{item: it, models: models})
	}

	resultsByEndpoint := make(map[string][]HealthRecord, len(targets))
	var resultsMu sync.Mutex
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup

	for _, target := range targets {
		for _, model := range target.models {
			wg.Add(1)
			go func(target endpointTarget, model string) {
				defer wg.Done()
				select {
				case sem <- struct{}{}:
				case <-ctx.Done():
					return
				}
				defer func() { <-sem }()

				result := s.healthCheckSingleModel(ctx, target.id, target.url, target.key, model, timeoutDuration, target.headers)
				resultsMu.Lock()
				resultsByEndpoint[target.id] = append(resultsByEndpoint[target.id], result)
				resultsMu.Unlock()
			}(target, model)
		}
	}
	wg.Wait()

	results := make([]map[string]interface{}, 0, len(targets))
	for _, target := range targets {
		if len(target.models) == 0 {
			results = append(results, map[string]interface{}{
				"endpointId":  target.id,
				"name":        target.name,
				"totalModels": 0,
				"skipped":     true,
			})
			continue
		}

		summary := summarizeHealthResults(target.models, resultsByEndpoint[target.id])
		for _, result := range summary.Results {
			var errMsg sql.NullString
			if result.Error != "" {
				errMsg.Valid = true
				errMsg.String = result.Error
			}
			_, _ = db.ExecContext(ctx, `
				INSERT INTO openai_health_history (endpoint_id, status, response_time, error_message, checked_at)
				VALUES (?, ?, ?, ?, ?)`,
				target.id, result.Status, result.Latency, errMsg, result.CheckedAt)
		}
		_, _ = db.ExecContext(ctx, `
			UPDATE openai_endpoints
			SET status = ?, last_checked = ?
			WHERE id = ?`,
			summary.OverallStatus, summary.CheckedAt, target.id)

		results = append(results, map[string]interface{}{
			"endpointId":  target.id,
			"name":        target.name,
			"totalModels": summary.TotalModels,
			"operational": summary.Operational,
			"degraded":    summary.Degraded,
			"failed":      summary.Failed,
			"results":     summary.Results,
		})
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"success":   true,
		"checkedAt": time.Now().Format(time.RFC3339),
		"endpoints": results,
	})
}

func (s *Service) exportEndpointsRoute(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, "SELECT id, name, base_url, api_key, headers, disabled_models, proxy_pool, auto_switch, status, enabled, models, created_at, last_used, last_checked FROM openai_endpoints")
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	endpoints := []Endpoint{}
	for rows.Next() {
		var ep Endpoint
		var headersRaw, modelsRaw, disabledRaw, proxyRaw sql.NullString
		var created, used, checked sql.NullString
		var enabledInt, autoSwitchInt int

		err := rows.Scan(&ep.ID, &ep.Name, &ep.BaseURL, &ep.APIKey, &headersRaw, &disabledRaw, &proxyRaw, &autoSwitchInt, &ep.Status, &enabledInt, &modelsRaw, &created, &used, &checked)
		if err != nil {
			response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}

		ep.APIKey = secure.SecureDecrypt(ep.APIKey)
		ep.Enabled = enabledInt == 1
		ep.AutoSwitch = autoSwitchInt == 1
		ep.CreatedAt = created.String
		if used.Valid {
			v := used.String
			ep.LastUsed = &v
		}
		if checked.Valid {
			v := checked.String
			ep.LastChecked = &v
		}

		ep.Models = []string{}
		if modelsRaw.Valid && modelsRaw.String != "" {
			_ = json.Unmarshal([]byte(modelsRaw.String), &ep.Models)
		}
		ep.Headers = []HeaderItem{}
		if headersRaw.Valid && headersRaw.String != "" {
			_ = json.Unmarshal([]byte(headersRaw.String), &ep.Headers)
		}
		ep.DisabledModels = []string{}
		if disabledRaw.Valid && disabledRaw.String != "" {
			_ = json.Unmarshal([]byte(disabledRaw.String), &ep.DisabledModels)
		}
		ep.ProxyPool = []string{}
		if proxyRaw.Valid && proxyRaw.String != "" {
			_ = json.Unmarshal([]byte(proxyRaw.String), &ep.ProxyPool)
		}
		endpoints = append(endpoints, ep)
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"success":    true,
		"endpoints":  endpoints,
		"exportedAt": time.Now().Format(time.RFC3339),
	})
}

func (s *Service) importEndpointsRoute(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Endpoints []Endpoint `json:"endpoints"`
		Overwrite bool       `json:"overwrite"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer tx.Rollback()

	if req.Overwrite {
		_, err = tx.ExecContext(ctx, "DELETE FROM openai_endpoints")
		if err != nil {
			response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	}

	importedCount := 0
	skippedCount := 0

	for _, ep := range req.Endpoints {
		if ep.Name == "" || ep.BaseURL == "" || ep.APIKey == "" {
			skippedCount++
			continue
		}

		if !req.Overwrite {
			var exists int
			_ = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM openai_endpoints WHERE base_url = ?", ep.BaseURL).Scan(&exists)
			if exists > 0 {
				skippedCount++
				continue
			}
		}

		id := ep.ID
		if id == "" {
			id = fmt.Sprintf("oai_%d_%s", time.Now().UnixNano(), s.randString(9))
		}

		enabledInt := 0
		if ep.Enabled {
			enabledInt = 1
		}
		status := ep.Status
		if status == "" {
			status = "unknown"
		}
		createdAt := ep.CreatedAt
		if createdAt == "" {
			createdAt = time.Now().Format(time.RFC3339)
		}
		var modelsJSON []byte
		if len(ep.Models) > 0 {
			modelsJSON, _ = json.Marshal(ep.Models)
		} else {
			modelsJSON = []byte("[]")
		}

		var encryptedKey, err_enc = secure.SecureEncrypt(ep.APIKey)
		if err_enc != nil {
			skippedCount++
			continue
		}
		headersJSON, _ := json.Marshal([]HeaderItem{})
		if len(ep.Headers) > 0 {
			headersJSON, _ = json.Marshal(cleanHeaders(ep.Headers))
		}
		disabledJSON, _ := json.Marshal([]string{})
		if len(ep.DisabledModels) > 0 {
			disabledJSON, _ = json.Marshal(ep.DisabledModels)
		}
		proxyJSON, _ := json.Marshal([]string{})
		if len(ep.ProxyPool) > 0 {
			proxyJSON, _ = json.Marshal(cleanProxyPool(ep.ProxyPool))
		}
		autoSwitchInt := boolToInt(ep.AutoSwitch)
		_, err = tx.ExecContext(ctx, `
			INSERT OR REPLACE INTO openai_endpoints (id, name, base_url, api_key, headers, disabled_models, proxy_pool, auto_switch, status, enabled, models, created_at, last_used, last_checked)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, ep.Name, ep.BaseURL, encryptedKey, string(headersJSON), string(disabledJSON), string(proxyJSON), autoSwitchInt, status, enabledInt, string(modelsJSON), createdAt, ep.LastUsed, ep.LastChecked)
		if err != nil {
			response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		importedCount++
	}

	if err := tx.Commit(); err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"imported": importedCount,
		"skipped":  skippedCount,
		"total":    importedCount + skippedCount,
	})
}

func (s *Service) proxyChatCompletions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	requestStarted := time.Now()
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		s.RecordAnalytics(ctx, "chat.completions", "", "", http.StatusBadRequest, time.Since(requestStarted).Milliseconds(), 0, 0, 0)
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	var parsedBody map[string]interface{}
	if err := json.Unmarshal(bodyBytes, &parsedBody); err != nil {
		s.RecordAnalytics(ctx, "chat.completions", "", "", http.StatusBadRequest, time.Since(requestStarted).Milliseconds(), 0, 0, 0)
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	model, _ := parsedBody["model"].(string)
	stream, _ := parsedBody["stream"].(bool)
	targetEndpointID := r.Header.Get("x-endpoint-id")

	db, err := s.open(ctx)
	if err != nil {
		s.RecordAnalytics(ctx, "chat.completions", "", model, http.StatusInternalServerError, time.Since(requestStarted).Milliseconds(), 0, 0, 0)
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	var selected Endpoint
	var found bool

	if targetEndpointID != "" {
		var ep Endpoint
		var headersRaw, modelsRaw, disabledRaw, proxyRaw sql.NullString
		var enabledInt, autoSwitchInt int
		err := db.QueryRowContext(ctx, `
			SELECT id, name, base_url, api_key, headers, disabled_models, proxy_pool, auto_switch, status, enabled, models
			FROM openai_endpoints WHERE id = ? AND enabled = 1`, targetEndpointID).
			Scan(&ep.ID, &ep.Name, &ep.BaseURL, &ep.APIKey, &headersRaw, &disabledRaw, &proxyRaw, &autoSwitchInt, &ep.Status, &enabledInt, &modelsRaw)

		if err == nil {
			ep.APIKey = secure.SecureDecrypt(ep.APIKey)
			ep.Enabled = enabledInt == 1
			ep.AutoSwitch = autoSwitchInt == 1
			if modelsRaw.Valid {
				_ = json.Unmarshal([]byte(modelsRaw.String), &ep.Models)
			}
			ep.Headers = []HeaderItem{}
			if headersRaw.Valid && headersRaw.String != "" {
				_ = json.Unmarshal([]byte(headersRaw.String), &ep.Headers)
			}
			ep.DisabledModels = []string{}
			if disabledRaw.Valid && disabledRaw.String != "" {
				_ = json.Unmarshal([]byte(disabledRaw.String), &ep.DisabledModels)
			}
			ep.ProxyPool = []string{}
			if proxyRaw.Valid && proxyRaw.String != "" {
				_ = json.Unmarshal([]byte(proxyRaw.String), &ep.ProxyPool)
			}
			if !isModelDisabled(ep.DisabledModels, model) {
				selected = ep
				found = true
			}
		}
	}

	if !found {
		// Enabled is the administrator's routing decision; status is the latest verification result.
		rows, err := db.QueryContext(ctx, `
			SELECT id, name, base_url, api_key, headers, disabled_models, proxy_pool, auto_switch, status, enabled, models
			FROM openai_endpoints WHERE enabled = 1`)
		if err == nil {
			defer rows.Close()
			endpoints := []Endpoint{}
			for rows.Next() {
				var ep Endpoint
				var headersRaw, modelsRaw, disabledRaw, proxyRaw sql.NullString
				var enabledInt, autoSwitchInt int
				if errScan := rows.Scan(&ep.ID, &ep.Name, &ep.BaseURL, &ep.APIKey, &headersRaw, &disabledRaw, &proxyRaw, &autoSwitchInt, &ep.Status, &enabledInt, &modelsRaw); errScan == nil {
					ep.APIKey = secure.SecureDecrypt(ep.APIKey)
					ep.Enabled = enabledInt == 1
					ep.AutoSwitch = autoSwitchInt == 1
					if modelsRaw.Valid {
						_ = json.Unmarshal([]byte(modelsRaw.String), &ep.Models)
					}
					ep.Headers = []HeaderItem{}
					if headersRaw.Valid && headersRaw.String != "" {
						_ = json.Unmarshal([]byte(headersRaw.String), &ep.Headers)
					}
					ep.DisabledModels = []string{}
					if disabledRaw.Valid && disabledRaw.String != "" {
						_ = json.Unmarshal([]byte(disabledRaw.String), &ep.DisabledModels)
					}
					ep.ProxyPool = []string{}
					if proxyRaw.Valid && proxyRaw.String != "" {
						_ = json.Unmarshal([]byte(proxyRaw.String), &ep.ProxyPool)
					}
					endpoints = append(endpoints, ep)
				}
			}

			eligible := []Endpoint{}
			for _, ep := range endpoints {
				for _, m := range ep.Models {
					if m == model && !isModelDisabled(ep.DisabledModels, model) {
						eligible = append(eligible, ep)
						break
					}
				}
			}

			targets := eligible
			if len(targets) == 0 {
				// 兜底：模型列表尚未刷新时仍尝试已启用端点，但跳过已禁用该模型的端点。
				for _, ep := range endpoints {
					if !isModelDisabled(ep.DisabledModels, model) {
						targets = append(targets, ep)
					}
				}
			}

			if len(targets) > 0 {
				nBig, _ := rand.Int(rand.Reader, big.NewInt(int64(len(targets))))
				selected = targets[nBig.Int64()]
				found = true
			}
		}
	}

	if !found {
		s.RecordAnalytics(ctx, "chat.completions", "", model, http.StatusServiceUnavailable, time.Since(requestStarted).Milliseconds(), 0, 0, 0)
		response.JSON(w, http.StatusServiceUnavailable, map[string]interface{}{
			"error": map[string]string{
				"message": "No valid OpenAI endpoints available",
				"type":    "service_unavailable",
			},
		})
		return
	}

	// Format base url
	fullURL := strings.TrimSuffix(selected.BaseURL, "/")
	if !strings.HasSuffix(strings.ToLower(fullURL), "/v1") && !strings.Contains(strings.ToLower(fullURL), "/v1/") {
		fullURL += "/v1"
	}
	fullURL += "/chat/completions"

	isLocal := localURLRegex.MatchString(fullURL)

	if !isLocal {
		if messages, ok := parsedBody["messages"].([]interface{}); ok {
			for _, msg := range messages {
				if msgMap, ok := msg.(map[string]interface{}); ok {
					if contentArr, ok := msgMap["content"].([]interface{}); ok {
						for _, part := range contentArr {
							if partMap, ok := part.(map[string]interface{}); ok {
								if partMap["type"] == "image_url" {
									if imgURLMap, ok := partMap["image_url"].(map[string]interface{}); ok {
										if imgURL, ok := imgURLMap["url"].(string); ok && strings.HasPrefix(imgURL, "/uploads/") {
											relativePath := strings.TrimPrefix(imgURL, "/")
											filePath := filepath.Join(s.cfg.DataDir, relativePath)

											if fileBytes, err := os.ReadFile(filePath); err == nil {
												ext := strings.ToLower(filepath.Ext(filePath))
												mimeType := "image/jpeg"
												switch ext {
												case ".png":
													mimeType = "image/png"
												case ".webp":
													mimeType = "image/webp"
												case ".gif":
													mimeType = "image/gif"
												}
												b64 := base64.StdEncoding.EncodeToString(fileBytes)
												imgURLMap["url"] = fmt.Sprintf("data:%s;base64,%s", mimeType, b64)
												imgURLMap["_original_url"] = imgURL
											}
										}
									}
								}
							}
						}
					}
				}
			}
		}
	}

	upstreamBodyBytes, _ := json.Marshal(parsedBody)

	startTime := time.Now()

	// 代理池选择 + 限流自动切换：最多尝试 len(pool) 个代理，池为空时只尝试一次。
	maxProxyAttempts := len(selected.ProxyPool)
	if maxProxyAttempts == 0 {
		maxProxyAttempts = 1
	}
	// 未开启自动切换时，即使有代理池也只试一次（仍按池轮换，但不因限流重试）。
	if !selected.AutoSwitch {
		maxProxyAttempts = 1
	}

	var resp *http.Response
	var lastErr error
	var attempt int

	for attempt = 0; attempt < maxProxyAttempts; attempt++ {
		client, currentProxy := s.clientForEndpoint(selected.ID, selected.ProxyPool, attempt == 0)

		httpReq, err := http.NewRequestWithContext(ctx, "POST", fullURL, bytes.NewReader(upstreamBodyBytes))
		if err != nil {
			s.RecordAnalytics(ctx, "chat.completions", selected.ID, model, http.StatusInternalServerError, time.Since(requestStarted).Milliseconds(), 0, 0, 0)
			response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		httpReq.Header.Set("Authorization", "Bearer "+selected.APIKey)
		httpReq.Header.Set("Content-Type", "application/json")
		if stream {
			httpReq.Header.Set("Accept", "text/event-stream")
		} else {
			httpReq.Header.Set("Accept", "application/json")
		}
		applyCustomHeaders(httpReq, selected.Headers)

		resp, lastErr = client.Do(httpReq)
		if lastErr != nil {
			// 连接失败（例如该代理不可用）：标记失败，若有池则切下一个继续。
			s.markProxyFailed(selected.ID, currentProxy)
			if attempt+1 < maxProxyAttempts {
				continue
			}
			break
		}

		// 非流式：读取正文判断限流，失败时在循环内重试。
		if !stream && selected.AutoSwitch && attempt+1 < maxProxyAttempts {
			bodyBytesRead, readErr := io.ReadAll(resp.Body)
			resp.Body.Close()
			if readErr == nil && isRateLimitResponse(resp, bodyBytesRead) {
				s.markProxyFailed(selected.ID, currentProxy)
				continue
			}
			// 不是限流：重建带正文的响应继续处理。
			resp.Body = io.NopCloser(bytes.NewReader(bodyBytesRead))
			break
		}

		// 流式：仅按状态码判断，限流时切换代理重试一次。
		if stream && selected.AutoSwitch && attempt+1 < maxProxyAttempts && isRateLimitResponse(resp, nil) {
			resp.Body.Close()
			s.markProxyFailed(selected.ID, currentProxy)
			continue
		}
		break
	}

	if lastErr != nil && resp == nil {
		s.RecordAnalytics(ctx, "chat.completions", selected.ID, model, http.StatusBadGateway, time.Since(startTime).Milliseconds(), 0, 0, 0)
		response.JSON(w, http.StatusBadGateway, map[string]interface{}{"error": map[string]string{"message": lastErr.Error(), "type": "proxy_error"}})
		return
	}
	defer resp.Body.Close()

	// Update last used timestamp
	_, _ = db.ExecContext(ctx, "UPDATE openai_endpoints SET last_used = ? WHERE id = ?", time.Now().Format(time.RFC3339), selected.ID)

	if stream {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(resp.StatusCode)

		flusher, ok := w.(http.Flusher)
		buf := make([]byte, 4096)
		// usage 信息总在最后一个 SSE chunk 里，只保留响应尾部即可，
		// 避免长对话把整个流式响应累积在内存中。
		const usageTailLimit = 64 * 1024
		tail := make([]byte, 0, usageTailLimit)
		for {
			n, err := resp.Body.Read(buf)
			if n > 0 {
				_, _ = w.Write(buf[:n])
				tail = append(tail, buf[:n]...)
				if len(tail) > usageTailLimit {
					tail = tail[len(tail)-usageTailLimit:]
				}
				if ok {
					flusher.Flush()
				}
			}
			if err != nil {
				break
			}
		}
		latencyMs := time.Since(startTime).Milliseconds()

		promptTokens := 0
		completionTokens := 0
		totalTokens := 0

		accumulatedStr := string(tail)
		if matches := promptTokensRegex.FindStringSubmatch(accumulatedStr); len(matches) > 1 {
			promptTokens, _ = strconv.Atoi(matches[1])
		}
		if matches := completionTokensRegex.FindStringSubmatch(accumulatedStr); len(matches) > 1 {
			completionTokens, _ = strconv.Atoi(matches[1])
		}
		if matches := totalTokensRegex.FindStringSubmatch(accumulatedStr); len(matches) > 1 {
			totalTokens, _ = strconv.Atoi(matches[1])
		} else if promptTokens > 0 || completionTokens > 0 {
			totalTokens = promptTokens + completionTokens
		}

		s.RecordAnalytics(ctx, "chat.completions", selected.ID, model, resp.StatusCode, latencyMs, promptTokens, completionTokens, totalTokens)
	} else {
		respBodyBytes, _ := io.ReadAll(resp.Body)
		latencyMs := time.Since(startTime).Milliseconds()

		var usageInfo struct {
			Usage struct {
				PromptTokens     int `json:"prompt_tokens"`
				CompletionTokens int `json:"completion_tokens"`
				TotalTokens      int `json:"total_tokens"`
			} `json:"usage"`
		}
		_ = json.Unmarshal(respBodyBytes, &usageInfo)

		s.RecordAnalytics(ctx, "chat.completions", selected.ID, model, resp.StatusCode, latencyMs, usageInfo.Usage.PromptTokens, usageInfo.Usage.CompletionTokens, usageInfo.Usage.TotalTokens)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(respBodyBytes)
	}
}

func (s *Service) GetModelsList(ctx context.Context) ([]map[string]interface{}, error) {
	db, err := s.open(ctx)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, "SELECT name, enabled, status, models, disabled_models FROM openai_endpoints WHERE enabled = 1")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	modelMap := make(map[string]map[string]interface{})
	for rows.Next() {
		var name, status, modelsRaw string
		var enabledInt int
		var disabledRaw sql.NullString
		if err := rows.Scan(&name, &enabledInt, &status, &modelsRaw, &disabledRaw); err == nil {
			var models []string
			if modelsRaw != "" {
				_ = json.Unmarshal([]byte(modelsRaw), &models)
			}
			disabled := []string{}
			if disabledRaw.Valid && disabledRaw.String != "" {
				_ = json.Unmarshal([]byte(disabledRaw.String), &disabled)
			}
			for _, mID := range models {
				if isModelDisabled(disabled, mID) {
					continue
				}
				if _, ok := modelMap[mID]; !ok {
					modelMap[mID] = map[string]interface{}{
						"id":       mID,
						"object":   "model",
						"created":  time.Now().Unix(),
						"owned_by": name,
					}
				}
			}
		}
	}

	modelList := []map[string]interface{}{}
	for _, m := range modelMap {
		modelList = append(modelList, m)
	}
	return modelList, nil
}

func (s *Service) proxyModels(w http.ResponseWriter, r *http.Request) {
	modelList, err := s.GetModelsList(r.Context())
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	sort.Slice(modelList, func(i, j int) bool {
		idI, _ := modelList[i]["id"].(string)
		idJ, _ := modelList[j]["id"].(string)
		return idI < idJ
	})

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"object": "list",
		"data":   modelList,
	})
}

// ==================== Helper methods ====================

func (s *Service) normalizeBaseURL(u string) string {
	u = strings.TrimSpace(u)
	u = strings.TrimSuffix(u, "/")

	stripSuffixes := []string{"/chat/completions", "/completions", "/models", "/embeddings"}
	for _, suffix := range stripSuffixes {
		if strings.HasSuffix(strings.ToLower(u), suffix) {
			u = u[:len(u)-len(suffix)]
			u = strings.TrimSuffix(u, "/")
		}
	}

	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		u = "https://" + u
	}

	// Append version path if missing
	hasVersion := false
	if reg := versionPathRegex; reg.MatchString(u) {
		hasVersion = true
	}
	if !hasVersion {
		u += "/v1"
	}

	return u
}

func (s *Service) verifyAPIKeyRaw(ctx context.Context, u string, key string, headers ...[]HeaderItem) (bool, int, error) {
	reqURL := fmt.Sprintf("%s/models", strings.TrimSuffix(u, "/"))
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return false, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	if len(headers) > 0 {
		applyCustomHeaders(req, headers[0])
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return false, 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return false, 0, fmt.Errorf("verify failed: HTTP %d", resp.StatusCode)
	}

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, 0, err
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(bodyBytes, &parsed); err == nil {
		if dataArr, ok := parsed["data"].([]interface{}); ok {
			return true, len(dataArr), nil
		}
	}

	var parsedArr []interface{}
	if err := json.Unmarshal(bodyBytes, &parsedArr); err == nil {
		return true, len(parsedArr), nil
	}

	return true, 0, nil
}

func (s *Service) listModelsRaw(ctx context.Context, u string, key string, headers ...[]HeaderItem) ([]string, error) {
	reqURL := fmt.Sprintf("%s/models", strings.TrimSuffix(u, "/"))
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	if len(headers) > 0 {
		applyCustomHeaders(req, headers[0])
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("list models failed: HTTP %d", resp.StatusCode)
	}

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	models := []string{}
	var parsed map[string]interface{}
	if err := json.Unmarshal(bodyBytes, &parsed); err == nil {
		// OpenAI structure
		if dataArr, ok := parsed["data"].([]interface{}); ok {
			for _, item := range dataArr {
				if itemMap, ok := item.(map[string]interface{}); ok {
					if id, ok := itemMap["id"].(string); ok {
						models = append(models, id)
					}
				}
			}
			return models, nil
		}
		// Custom models key
		if modelsArr, ok := parsed["models"].([]interface{}); ok {
			for _, item := range modelsArr {
				if itemMap, ok := item.(map[string]interface{}); ok {
					if id, ok := itemMap["id"].(string); ok {
						models = append(models, id)
					} else if name, ok := itemMap["name"].(string); ok {
						models = append(models, name)
					}
				}
			}
			return models, nil
		}
	}

	var parsedArr []interface{}
	if err := json.Unmarshal(bodyBytes, &parsedArr); err == nil {
		for _, item := range parsedArr {
			if itemMap, ok := item.(map[string]interface{}); ok {
				if id, ok := itemMap["id"].(string); ok {
					models = append(models, id)
				}
			}
		}
		return models, nil
	}

	return nil, fmt.Errorf("unexpected models structure")
}

func parseModelIDsFromRaw(raw string) []string {
	if raw == "" {
		return nil
	}
	var strList []string
	if err := json.Unmarshal([]byte(raw), &strList); err == nil && len(strList) > 0 {
		out := make([]string, 0, len(strList))
		for _, s := range strList {
			if trimmed := strings.TrimSpace(s); trimmed != "" {
				out = append(out, trimmed)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	var anyList []interface{}
	if err := json.Unmarshal([]byte(raw), &anyList); err == nil {
		out := make([]string, 0, len(anyList))
		for _, item := range anyList {
			switch v := item.(type) {
			case string:
				if trimmed := strings.TrimSpace(v); trimmed != "" {
					out = append(out, trimmed)
				}
			case map[string]interface{}:
				if id, ok := v["id"].(string); ok {
					if trimmed := strings.TrimSpace(id); trimmed != "" {
						out = append(out, trimmed)
					}
				} else if name, ok := v["name"].(string); ok {
					if trimmed := strings.TrimSpace(name); trimmed != "" {
						out = append(out, trimmed)
					}
				}
			}
		}
		return out
	}
	return nil
}

func (s *Service) healthCheckSingleModel(ctx context.Context, endpointID, baseURL, apiKey, model string, timeout time.Duration, headers ...[]HeaderItem) HealthRecord {
	startTime := time.Now()
	record := HealthRecord{
		Model:     model,
		Status:    "failed",
		CheckedAt: startTime.Format(time.RFC3339),
	}

	reqURL := fmt.Sprintf("%s/chat/completions", strings.TrimSuffix(baseURL, "/"))
	payload := map[string]interface{}{
		"model":      model,
		"messages":   []map[string]string{{"role": "user", "content": "Reply with any short non-empty text."}},
		"stream":     false,
		"max_tokens": 16,
	}
	bodyBytes, _ := json.Marshal(payload)

	childCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(childCtx, "POST", reqURL, bytes.NewReader(bodyBytes))
	if err != nil {
		record.Error = err.Error()
		return record
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json, text/event-stream")
	if len(headers) > 0 {
		applyCustomHeaders(httpReq, headers[0])
	}

	resp, err := s.client.Do(httpReq)
	if err != nil {
		record.Error = err.Error()
		record.Latency = time.Since(startTime).Milliseconds()
		return record
	}
	defer resp.Body.Close()

	record.StatusCode = resp.StatusCode

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBytes, _ := io.ReadAll(resp.Body)
		record.Error = fmt.Sprintf("HTTP %d: %s", resp.StatusCode, string(respBytes))
		record.Latency = time.Since(startTime).Milliseconds()
		return record
	}

	latency := time.Since(startTime)
	record.Latency = latency.Milliseconds()
	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		record.Error = err.Error()
		return record
	}
	if output := extractHealthCheckOutput(respBytes); output == "" {
		record.Error = "模型未返回有效输出"
		return record
	}
	if latency <= degradedThreshold {
		record.Status = "operational"
	} else {
		record.Status = "degraded"
	}

	return record
}

func extractHealthCheckOutput(body []byte) string {
	trimmedBody := strings.TrimSpace(string(body))
	if trimmedBody == "" {
		return ""
	}

	if strings.Contains(trimmedBody, "data:") {
		if output := extractHealthCheckOutputFromSSE(trimmedBody); output != "" {
			return output
		}
	}

	var parsed interface{}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return ""
	}
	return extractHealthCheckOutputValue(parsed)
}

func extractHealthCheckOutputFromSSE(body string) string {
	parts := []string{}
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var parsed interface{}
		if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
			continue
		}
		if text := extractHealthCheckOutputValue(parsed); text != "" {
			parts = append(parts, text)
		}
	}
	return strings.TrimSpace(strings.Join(parts, " "))
}

func extractHealthCheckOutputValue(value interface{}) string {
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v)
	case []interface{}:
		parts := make([]string, 0, len(v))
		for _, item := range v {
			if text := extractHealthCheckOutputValue(item); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.TrimSpace(strings.Join(parts, " "))
	case map[string]interface{}:
		for _, key := range []string{
			"choices",
			"output",
			"message",
			"delta",
			"content",
			"text",
			"output_text",
			"reasoning_content",
			"refusal",
		} {
			if text := extractHealthCheckOutputValue(v[key]); text != "" {
				return text
			}
		}
	}
	return ""
}

func (s *Service) runBatchHealthCheck(ctx context.Context, endpointID, baseURL, apiKey string, models []string, timeout time.Duration, concurrency int, headers ...[]HeaderItem) HealthSummary {
	var mu sync.Mutex
	results := []HealthRecord{}

	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup

	for _, model := range models {
		wg.Add(1)
		go func(m string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			res := s.healthCheckSingleModel(ctx, endpointID, baseURL, apiKey, m, timeout, headers...)

			mu.Lock()
			results = append(results, res)
			mu.Unlock()
		}(model)
	}

	wg.Wait()

	return summarizeHealthResults(models, results)
}

func summarizeHealthResults(models []string, results []HealthRecord) HealthSummary {
	sort.Slice(results, func(i, j int) bool {
		return results[i].Model < results[j].Model
	})

	operationalCount := 0
	degradedCount := 0
	failedCount := 0

	for _, r := range results {
		switch r.Status {
		case "operational":
			operationalCount++
		case "degraded":
			degradedCount++
		default:
			failedCount++
		}
	}

	overall := "unknown"
	if len(results) > 0 {
		if failedCount == len(results) {
			overall = "failed"
		} else if operationalCount == len(results) {
			overall = "operational"
		} else {
			overall = "degraded"
		}
	}

	return HealthSummary{
		TotalModels:   len(models),
		Operational:   operationalCount,
		Degraded:      degradedCount,
		Failed:        failedCount,
		OverallStatus: overall,
		Results:       results,
		CheckedAt:     time.Now().Format(time.RFC3339),
	}
}

func (s *Service) randString(n int) string {
	const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, n)
	for i := range b {
		num, err := rand.Int(rand.Reader, big.NewInt(int64(len(letters))))
		if err != nil {
			applog.Warn(context.Background(), "openai", "secure random failed, using timestamp fallback", "error", err.Error())
			b[i] = letters[time.Now().UnixNano()%int64(len(letters))]
			continue
		}
		b[i] = letters[num.Int64()]
	}
	return string(b)
}

// Personas Handlers
func (s *Service) listPersonas(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, "SELECT id, name, icon, system_prompt, is_default, created_at FROM openai_chat_personas ORDER BY is_default DESC, created_at DESC")
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	type Persona struct {
		ID           string `json:"id"`
		Name         string `json:"name"`
		Icon         string `json:"icon"`
		SystemPrompt string `json:"system_prompt"`
		IsDefault    int    `json:"is_default"`
		CreatedAt    string `json:"created_at"`
	}

	var list []Persona
	for rows.Next() {
		var p Persona
		var icon sql.NullString
		if err := rows.Scan(&p.ID, &p.Name, &icon, &p.SystemPrompt, &p.IsDefault, &p.CreatedAt); err == nil {
			p.Icon = icon.String
			list = append(list, p)
		}
	}
	response.JSON(w, http.StatusOK, list)
}

func (s *Service) createPersona(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var body struct {
		ID           string `json:"id"`
		Name         string `json:"name"`
		Icon         string `json:"icon"`
		SystemPrompt string `json:"system_prompt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	if body.Name == "" || body.SystemPrompt == "" {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "name and system_prompt are required"})
		return
	}

	id := body.ID
	if id == "" {
		id = uuid.NewString()
	}

	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	createdAt := time.Now().Format(time.RFC3339)
	_, err = db.ExecContext(ctx, "INSERT INTO openai_chat_personas (id, name, icon, system_prompt, is_default, created_at) VALUES (?, ?, ?, ?, 0, ?)",
		id, body.Name, body.Icon, body.SystemPrompt, createdAt)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true, "id": id})
}

func (s *Service) updatePersona(w http.ResponseWriter, r *http.Request, id string) {
	ctx := r.Context()
	var body struct {
		Name         string `json:"name"`
		Icon         string `json:"icon"`
		SystemPrompt string `json:"system_prompt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	if body.Name == "" || body.SystemPrompt == "" {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "name and system_prompt are required"})
		return
	}

	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	_, err = db.ExecContext(ctx, "UPDATE openai_chat_personas SET name = ?, icon = ?, system_prompt = ? WHERE id = ?",
		body.Name, body.Icon, body.SystemPrompt, id)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

func (s *Service) deletePersona(w http.ResponseWriter, r *http.Request, id string) {
	ctx := r.Context()
	if id == "1" {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "cannot delete default persona"})
		return
	}

	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	_, err = db.ExecContext(ctx, "DELETE FROM openai_chat_personas WHERE id = ?", id)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

// Sessions Handlers
func (s *Service) listSessions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, "SELECT id, title, model, endpoint_id, persona_id, system_prompt, created_at, updated_at FROM openai_chat_sessions ORDER BY updated_at DESC")
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	type Session struct {
		ID           string `json:"id"`
		Title        string `json:"title"`
		Model        string `json:"model"`
		EndpointID   string `json:"endpoint_id"`
		PersonaID    string `json:"persona_id"`
		SystemPrompt string `json:"system_prompt"`
		CreatedAt    string `json:"created_at"`
		UpdatedAt    string `json:"updated_at"`
	}

	var list []Session
	for rows.Next() {
		var s Session
		var model, epID, persID, sysPrompt sql.NullString
		if err := rows.Scan(&s.ID, &s.Title, &model, &epID, &persID, &sysPrompt, &s.CreatedAt, &s.UpdatedAt); err == nil {
			s.Model = model.String
			s.EndpointID = epID.String
			s.PersonaID = persID.String
			s.SystemPrompt = sysPrompt.String
			list = append(list, s)
		}
	}
	response.JSON(w, http.StatusOK, list)
}

func (s *Service) createSession(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var body struct {
		ID           string `json:"id"`
		Title        string `json:"title"`
		Model        string `json:"model"`
		EndpointID   string `json:"endpoint_id"`
		PersonaID    string `json:"persona_id"`
		SystemPrompt string `json:"system_prompt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	id := body.ID
	if id == "" {
		id = uuid.NewString()
	}

	title := body.Title
	if title == "" {
		title = "新对话"
	}

	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	now := time.Now().Format(time.RFC3339)
	_, err = db.ExecContext(ctx, "INSERT INTO openai_chat_sessions (id, title, model, endpoint_id, persona_id, system_prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		id, title, body.Model, body.EndpointID, body.PersonaID, body.SystemPrompt, now, now)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true, "id": id})
}

func (s *Service) updateSession(w http.ResponseWriter, r *http.Request, id string) {
	ctx := r.Context()
	var body struct {
		Title        *string `json:"title"`
		Model        *string `json:"model"`
		EndpointID   *string `json:"endpoint_id"`
		PersonaID    *string `json:"persona_id"`
		SystemPrompt *string `json:"system_prompt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	// Fetch current session values first
	var currentTitle, currentModel, currentEpID, currentPersID, currentSysPrompt string
	err = db.QueryRowContext(ctx, "SELECT title, model, endpoint_id, persona_id, system_prompt FROM openai_chat_sessions WHERE id = ?", id).
		Scan(&currentTitle, &currentModel, &currentEpID, &currentPersID, &currentSysPrompt)
	if err != nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
		return
	}

	title := currentTitle
	if body.Title != nil {
		title = *body.Title
	}
	model := currentModel
	if body.Model != nil {
		model = *body.Model
	}
	epID := currentEpID
	if body.EndpointID != nil {
		epID = *body.EndpointID
	}
	persID := currentPersID
	if body.PersonaID != nil {
		persID = *body.PersonaID
	}
	sysPrompt := currentSysPrompt
	if body.SystemPrompt != nil {
		sysPrompt = *body.SystemPrompt
	}

	now := time.Now().Format(time.RFC3339)
	_, err = db.ExecContext(ctx, "UPDATE openai_chat_sessions SET title = ?, model = ?, endpoint_id = ?, persona_id = ?, system_prompt = ?, updated_at = ? WHERE id = ?",
		title, model, epID, persID, sysPrompt, now, id)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

func (s *Service) deleteSession(w http.ResponseWriter, r *http.Request, id string) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	_, err = db.ExecContext(ctx, "DELETE FROM openai_chat_sessions WHERE id = ?", id)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

func (s *Service) clearSessions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	_, err = db.ExecContext(ctx, "DELETE FROM openai_chat_sessions")
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

// Messages Handlers
func (s *Service) listSessionMessages(w http.ResponseWriter, r *http.Request, sessionId string) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, "SELECT id, role, content, reasoning, timestamp FROM openai_chat_messages WHERE session_id = ? ORDER BY timestamp ASC", sessionId)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	type Message struct {
		ID        string `json:"id"`
		Role      string `json:"role"`
		Content   string `json:"content"`
		Reasoning string `json:"reasoning,omitempty"`
		Timestamp string `json:"timestamp"`
	}

	var list []Message
	for rows.Next() {
		var m Message
		var reasoning sql.NullString
		if err := rows.Scan(&m.ID, &m.Role, &m.Content, &reasoning, &m.Timestamp); err == nil {
			m.Reasoning = reasoning.String
			list = append(list, m)
		}
	}
	response.JSON(w, http.StatusOK, list)
}

func (s *Service) createSessionMessage(w http.ResponseWriter, r *http.Request, sessionId string) {
	ctx := r.Context()
	var body struct {
		ID        string `json:"id"`
		Role      string `json:"role"`
		Content   string `json:"content"`
		Reasoning string `json:"reasoning"`
		Timestamp string `json:"timestamp"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	if body.Role == "" || body.Content == "" {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "role and content are required"})
		return
	}

	id := body.ID
	if id == "" {
		id = uuid.NewString()
	}

	timestamp := body.Timestamp
	if timestamp == "" {
		timestamp = time.Now().Format(time.RFC3339)
	}

	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	// Insert message
	_, err = db.ExecContext(ctx, "INSERT INTO openai_chat_messages (id, session_id, role, content, reasoning, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
		id, sessionId, body.Role, body.Content, body.Reasoning, timestamp)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// Update session updated_at timestamp
	now := time.Now().Format(time.RFC3339)
	_, _ = db.ExecContext(ctx, "UPDATE openai_chat_sessions SET updated_at = ? WHERE id = ?", now, sessionId)

	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true, "id": id})
}

func (s *Service) deleteSessionMessage(w http.ResponseWriter, r *http.Request, sessionId, msgId string) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	_, err = db.ExecContext(ctx, "DELETE FROM openai_chat_messages WHERE session_id = ? AND id = ?", sessionId, msgId)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

func (s *Service) clearSessionMessages(w http.ResponseWriter, r *http.Request, sessionId string) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	_, err = db.ExecContext(ctx, "DELETE FROM openai_chat_messages WHERE session_id = ?", sessionId)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true})
}

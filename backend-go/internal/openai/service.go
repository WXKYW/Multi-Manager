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
	"golang.org/x/net/proxy"
)

const (
	degradedThreshold        = 3 * time.Second
	healthTimeoutDefault     = 3 * time.Second
	healthConcurrencyDefault = 30
	healthConcurrencyMax     = 200
	// firstTokenTimeout 是流式请求等待首个字节的上限。超时后视为该代理出网链路
	// 不可用，网关会取消当前连接并切换下一个代理（仅在代理池+自动切换启用时生效）。
	firstTokenTimeout = 20 * time.Second
	// streamWriteDeadline 是流式响应的写超时窗口。http.Server 的 WriteTimeout
	// 覆盖整个响应写入时间，长流式对话可能远超该值；每次写前延长 deadline，
	// 使长对话不被 WriteTimeout 掐断，同时保留慢客户端保护（长时间无进展才断）。
	streamWriteDeadline = 5 * time.Minute
)

// 热路径正则预编译：chat completion 每请求都会用到，避免逐请求编译。
var (
	localURLRegex         = regexp.MustCompile(`(?i)^https?://(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)`)
	promptTokensRegex     = regexp.MustCompile(`"prompt_tokens"\s*:\s*(\d+)`)
	completionTokensRegex = regexp.MustCompile(`"completion_tokens"\s*:\s*(\d+)`)
	totalTokensRegex      = regexp.MustCompile(`"total_tokens"\s*:\s*(\d+)`)
	cachedTokensRegex     = regexp.MustCompile(`"cached_tokens"\s*:\s*(\d+)`)
	versionPathRegex      = regexp.MustCompile(`(?i)/v\d+/?`)
)

type HeaderItem struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type Endpoint struct {
	ID             string            `json:"id"`
	Name           string            `json:"name"`
	BaseURL        string            `json:"baseUrl"`
	APIKey         string            `json:"apiKey"`
	Notes          string            `json:"notes"`
	Status         string            `json:"status"`
	Enabled        bool              `json:"enabled"`
	Models         []string          `json:"models"`
	Headers        []HeaderItem      `json:"headers,omitempty"`
	DisabledModels []string          `json:"disabledModels,omitempty"`
	ProxyPool      []string          `json:"proxyPool,omitempty"`
	ProxyEnabled   bool              `json:"proxyEnabled"`
	AutoSwitch     bool              `json:"autoSwitch"`
	ForceProxy     bool              `json:"forceProxy"`
	ModelMappings  map[string]string `json:"modelMappings,omitempty"`
	CreatedAt      string            `json:"createdAt"`
	LastUsed       *string           `json:"lastUsed"`
	LastChecked    *string           `json:"lastChecked"`
	HealthStatus   string            `json:"healthStatus,omitempty"`
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
	proxyMu              sync.Mutex
	proxyStateByEndpoint map[string]*endpointProxyState

	// endpointLatency 记录每个端点最近一次转发的响应延迟（毫秒），
	// 供多端点同模型时的延迟加权分流（健康快的端点被选中概率更高）。
	latencyMu         sync.RWMutex
	endpointLatency   map[string]int64
	endpointLatencyOK map[string]bool

	// warmupMu 保护预热 goroutine 只启动一次。
	warmupOnce sync.Once
}

type endpointProxyState struct {
	cursor   int
	cooldown map[string]time.Time
	// lastTTFB 记录每个代理最近一次请求的首字耗时（毫秒），用于择优选择延迟最低的代理。
	// 尚未产生记录的代理按 cursor 轮询，保证首次使用可测出延迟。
	lastTTFB map[string]int64
}

func New(cfg config.Config) *Service {
	tr := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   4 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          500,
		MaxIdleConnsPerHost:   100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		// 只限制「等待响应头」的时间，不限制整个请求（流式响应体可能远长于 60s）。
		ResponseHeaderTimeout: 30 * time.Second,
	}
	s := &Service{
		cfg:                  cfg,
		store:                database.New(cfg),
		client:               &http.Client{Transport: tr},
		apiKeys:              apikeys.New(cfg),
		proxyStateByEndpoint: make(map[string]*endpointProxyState),
		endpointLatency:      make(map[string]int64),
		endpointLatencyOK:    make(map[string]bool),
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if db, err := s.open(ctx); err == nil {
		db.Close()
	}
	return s
}

// warmupInterval 是代理池预热的保活周期。
const warmupInterval = 10 * time.Minute

// StartWarmup 在后台周期性地对启用了代理池的端点发起轻量 /models 请求，
// 预建立 SOCKS5/TLS 连接并复用连接池，避免首次请求承受完整的冷启动握手。
// 进程结束前保持运行；端点或代理池为空时自动跳过。
func (s *Service) StartWarmup(ctx context.Context) {
	s.warmupOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(warmupInterval)
			defer ticker.Stop()
			s.warmupOnceNow(ctx)
			for {
				select {
				case <-ticker.C:
					s.warmupOnceNow(ctx)
				case <-ctx.Done():
					return
				}
			}
		}()
	})
}

// warmupOnceNow 对每个启用了代理池的端点，尝试通过每个代理建连一次。
func (s *Service) warmupOnceNow(ctx context.Context) {
	db, err := s.open(ctx)
	if err != nil {
		return
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, `
		SELECT id, base_url, api_key, proxy_pool
		FROM openai_endpoints WHERE enabled = 1 AND proxy_pool IS NOT NULL AND proxy_pool != ''`)
	if err != nil {
		return
	}
	defer rows.Close()

	for rows.Next() {
		var id, baseURL, apiKey string
		var proxyRaw string
		if err := rows.Scan(&id, &baseURL, &apiKey, &proxyRaw); err != nil {
			continue
		}
		var pool []string
		if err := json.Unmarshal([]byte(proxyRaw), &pool); err != nil {
			continue
		}
		pool = cleanProxyPool(pool)
		if len(pool) == 0 {
			continue
		}
		for _, proxyURL := range pool {
			if ctx.Err() != nil {
				return
			}
			s.warmProxyConnection(ctx, baseURL, apiKey, proxyURL)
		}
	}
}

// warmProxyConnection 通过指定代理向端点的 models 地址发起一次请求，触发连接建立。
func (s *Service) warmProxyConnection(ctx context.Context, baseURL, apiKey, proxyURL string) {
	client, err := s.proxyClient(proxyURL)
	if err != nil {
		return
	}
	fullURL := strings.TrimSuffix(baseURL, "/")
	if !strings.HasSuffix(strings.ToLower(fullURL), "/v1") && !strings.Contains(strings.ToLower(fullURL), "/v1/") {
		fullURL += "/v1"
	}
	fullURL += "/models"

	reqCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, fullURL, nil)
	if err != nil {
		return
	}
	if apiKey != "" && apiKey != "public" {
		req.Header.Set("Authorization", "Bearer "+secure.SecureDecrypt(apiKey))
	}
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	// 读取并关闭响应，让连接回到空闲连接池供后续复用。
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 16*1024))
	resp.Body.Close()
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
			proxy_enabled INTEGER DEFAULT 0,
			force_proxy INTEGER DEFAULT 0,
			status TEXT DEFAULT 'unknown',
			enabled INTEGER DEFAULT 1,
			models TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			last_used DATETIME,
			last_checked DATETIME,
			sort_order INTEGER DEFAULT 0
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
			ttfb_ms INTEGER DEFAULT 0,
			prompt_tokens INTEGER DEFAULT 0,
			completion_tokens INTEGER DEFAULT 0,
			total_tokens INTEGER DEFAULT 0,
			cached_tokens INTEGER DEFAULT 0,
			client_ip TEXT,
			upstream_ip TEXT,
			stream INTEGER DEFAULT 0,
			via_proxy INTEGER DEFAULT 0,
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
	if err := ensureSQLiteColumn(ctx, db, "openai_gateway_analytics", "ttfb_ms", "INTEGER DEFAULT 0"); err != nil {
		return err
	}
	if err := ensureSQLiteColumn(ctx, db, "openai_gateway_analytics", "cached_tokens", "INTEGER DEFAULT 0"); err != nil {
		return err
	}
	if err := ensureSQLiteColumn(ctx, db, "openai_gateway_analytics", "client_ip", "TEXT"); err != nil {
		return err
	}
	if err := ensureSQLiteColumn(ctx, db, "openai_gateway_analytics", "upstream_ip", "TEXT"); err != nil {
		return err
	}
	if err := ensureSQLiteColumn(ctx, db, "openai_gateway_analytics", "stream", "INTEGER DEFAULT 0"); err != nil {
		return err
	}
	if err := ensureSQLiteColumn(ctx, db, "openai_gateway_analytics", "via_proxy", "INTEGER DEFAULT 0"); err != nil {
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
	if err := ensureSQLiteColumn(ctx, db, "openai_endpoints", "model_mappings", "TEXT"); err != nil {
		return err
	}
	if err := ensureSQLiteColumn(ctx, db, "openai_endpoints", "sort_order", "INTEGER DEFAULT 0"); err != nil {
		return err
	}
	if err := ensureSQLiteColumn(ctx, db, "openai_endpoints", "force_proxy", "INTEGER DEFAULT 0"); err != nil {
		return err
	}
	if err := ensureSQLiteColumn(ctx, db, "openai_endpoints", "proxy_enabled", "INTEGER DEFAULT 0"); err != nil {
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

	// Responses proxy (OpenAI Responses API)
	if method == http.MethodPost && (path == "/v1/responses" || path == "/responses") {
		s.proxyResponses(w, r)
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
	case len(parts) == 4 && parts[0] == "endpoints" && parts[2] == "models" && parts[3] == "toggle-batch" && method == http.MethodPost:
		s.toggleEndpointModelsBatch(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "endpoints" && parts[2] == "model-mappings" && method == http.MethodPut:
		s.updateModelMappings(w, r, parts[1])
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
	case len(parts) == 2 && parts[0] == "endpoints" && parts[1] == "reorder" && method == http.MethodPost:
		s.reorderEndpoints(w, r)
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
	case len(parts) == 2 && parts[0] == "proxies" && parts[1] == "resolve-subscription" && method == http.MethodPost:
		s.resolveSubscriptionProxies(w, r)
	case len(parts) == 2 && parts[0] == "analytics" && parts[1] == "summary" && method == http.MethodGet:
		s.getAnalyticsSummary(w, r)
	case len(parts) == 2 && parts[0] == "analytics" && parts[1] == "charts" && method == http.MethodGet:
		s.getAnalyticsCharts(w, r)
	case len(parts) == 2 && parts[0] == "analytics" && parts[1] == "logs" && method == http.MethodGet:
		s.getAnalyticsLogs(w, r)
	case len(parts) == 2 && parts[0] == "analytics" && parts[1] == "clear" && method == http.MethodPost:
		s.clearAnalyticsLogs(w, r)
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

func (s *Service) resolveEndpointModel(ep Endpoint, requested string) (string, bool) {
	for real, alias := range ep.ModelMappings {
		if alias == requested {
			return real, true
		}
	}
	return requested, false
}

func (s *Service) endpointHasModel(ep Endpoint, requested string) bool {
	for _, m := range ep.Models {
		if m == requested {
			return true
		}
	}
	for _, alias := range ep.ModelMappings {
		if alias == requested {
			return true
		}
	}
	return false
}

func (s *Service) updateModelMappings(w http.ResponseWriter, r *http.Request, endpointID string) {
	ctx := r.Context()
	var payload struct {
		Mappings map[string]string `json:"mappings"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "请求体解析失败"})
		return
	}
	clean := map[string]string{}
	for real, alias := range payload.Mappings {
		real = strings.TrimSpace(real)
		alias = strings.TrimSpace(alias)
		if real != "" && alias != "" {
			clean[real] = alias
		}
	}
	data, _ := json.Marshal(clean)
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()
	if _, err := db.ExecContext(ctx, "UPDATE openai_endpoints SET model_mappings = ? WHERE id = ?", string(data), endpointID); err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true, "modelMappings": clean})
}

func (s *Service) listEndpoints(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, "SELECT id, name, base_url, api_key, headers, disabled_models, proxy_pool, auto_switch, proxy_enabled, force_proxy, status, enabled, models, created_at, last_used, last_checked, model_mappings, sort_order FROM openai_endpoints ORDER BY sort_order ASC, created_at ASC")
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	endpoints := []Endpoint{}
	for rows.Next() {
		var ep Endpoint
		var headersRaw, modelsRaw, disabledRaw, proxyRaw, mappingsRaw sql.NullString
		var created, used, checked sql.NullString
		var enabledInt, autoSwitchInt, proxyEnabledInt, forceProxyInt, sortOrder int

		err := rows.Scan(&ep.ID, &ep.Name, &ep.BaseURL, &ep.APIKey, &headersRaw, &disabledRaw, &proxyRaw, &autoSwitchInt, &proxyEnabledInt, &forceProxyInt, &ep.Status, &enabledInt, &modelsRaw, &created, &used, &checked, &mappingsRaw, &sortOrder)
		if err != nil {
			response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}

		ep.APIKey = secure.SecureDecrypt(ep.APIKey)
		ep.Enabled = enabledInt == 1
		ep.AutoSwitch = autoSwitchInt == 1
		ep.ProxyEnabled = proxyEnabledInt == 1
		ep.ForceProxy = forceProxyInt == 1
		if mappingsRaw.Valid && mappingsRaw.String != "" {
			_ = json.Unmarshal([]byte(mappingsRaw.String), &ep.ModelMappings)
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
		Name         string       `json:"name"`
		BaseURL      string       `json:"baseUrl"`
		APIKey       string       `json:"apiKey"`
		Notes        string       `json:"notes"`
		Headers      []HeaderItem `json:"headers"`
		ProxyPool    []string     `json:"proxyPool"`
		AutoSwitch   bool         `json:"autoSwitch"`
		ProxyEnabled bool         `json:"proxyEnabled"`
		ForceProxy   bool         `json:"forceProxy"`
		SkipVerify   bool         `json:"skipVerify"`
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
		vOk, count, err := s.verifyAPIKeyRaw(ctx, normalizedURL, req.APIKey, cleanProxyPool(req.ProxyPool), cleanHeaders(req.Headers))
		if err == nil && vOk {
			status = "valid"
			verification = map[string]interface{}{
				"valid":       true,
				"modelsCount": count,
			}
			mList, mErr := s.listModelsRaw(ctx, normalizedURL, req.APIKey, cleanProxyPool(req.ProxyPool), cleanHeaders(req.Headers))
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
		INSERT INTO openai_endpoints (id, name, base_url, api_key, headers, disabled_models, proxy_pool, auto_switch, proxy_enabled, force_proxy, status, enabled, models, created_at, last_checked, sort_order)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, req.Name, normalizedURL, encryptedKey, string(headersJSON), "[]", string(proxyJSON), autoSwitchInt, boolToInt(req.ProxyEnabled), boolToInt(req.ForceProxy), status, 1, string(modelsJSON), createdAt, lastCheckedVal, time.Now().UnixMilli())
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
		Name         string        `json:"name"`
		BaseURL      string        `json:"baseUrl"`
		APIKey       string        `json:"apiKey"`
		Notes        string        `json:"notes"`
		Headers      *[]HeaderItem `json:"headers"`
		ProxyPool    *[]string     `json:"proxyPool"`
		AutoSwitch   *bool         `json:"autoSwitch"`
		ProxyEnabled *bool         `json:"proxyEnabled"`
		ForceProxy   *bool         `json:"forceProxy"`
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
	proxyEnabledInt := 0
	proxyEnabledChanged := false
	if req.ProxyEnabled != nil {
		proxyEnabledInt = boolToInt(*req.ProxyEnabled)
		proxyEnabledChanged = true
	}
	forceProxyInt := 0
	forceProxyChanged := false
	if req.ForceProxy != nil {
		forceProxyInt = boolToInt(*req.ForceProxy)
		forceProxyChanged = true
	}

	if req.APIKey != "" || req.BaseURL != "" {
		status := "unknown"
		modelsList := []string{}

		verifyHeaders := []HeaderItem(nil)
		if req.Headers != nil {
			verifyHeaders = cleanHeaders(*req.Headers)
		}
		verifyPool := []string(nil)
		if req.ProxyPool != nil {
			verifyPool = cleanProxyPool(*req.ProxyPool)
		}

		vOk, _, err := s.verifyAPIKeyRaw(ctx, targetBaseURL, targetAPIKey, verifyPool, verifyHeaders)
		if err == nil && vOk {
			status = "valid"
			mList, mErr := s.listModelsRaw(ctx, targetBaseURL, targetAPIKey, verifyPool, verifyHeaders)
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
			SET name = ?, base_url = ?, api_key = ?, headers = ?, proxy_pool = ?, auto_switch = ?, proxy_enabled = ?, force_proxy = ?, status = ?, models = ?, last_checked = ?
			WHERE id = ?`,
			req.Name, targetBaseURL, encryptedKey, string(headersJSON), string(proxyJSON), autoSwitchInt, proxyEnabledInt, forceProxyInt, status, string(modelsJSON), lastChecked, id)
		if err != nil {
			response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	} else if headersChanged || proxyChanged || autoSwitchChanged || proxyEnabledChanged || forceProxyChanged {
		_, err = db.ExecContext(ctx, "UPDATE openai_endpoints SET name = ?, headers = ?, proxy_pool = ?, auto_switch = ?, proxy_enabled = ?, force_proxy = ? WHERE id = ?",
			req.Name, string(headersJSON), string(proxyJSON), autoSwitchInt, proxyEnabledInt, forceProxyInt, id)
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

// recordEndpointLatency 记录端点最近一次转发延迟（毫秒），供延迟加权分流使用。
func (s *Service) recordEndpointLatency(endpointID string, latencyMs int64) {
	if endpointID == "" || latencyMs <= 0 {
		return
	}
	s.latencyMu.Lock()
	s.endpointLatency[endpointID] = latencyMs
	s.endpointLatencyOK[endpointID] = true
	s.latencyMu.Unlock()
}

// getEndpointLatency 读取端点最近转发延迟；无记录时返回 (0, false)。
func (s *Service) getEndpointLatency(endpointID string) (int64, bool) {
	s.latencyMu.RLock()
	defer s.latencyMu.RUnlock()
	ok := s.endpointLatencyOK[endpointID]
	return s.endpointLatency[endpointID], ok
}

// weightedEndpointPick 在可服务同一模型的端点中按延迟加权随机选择：
// 权重 = 1 + (maxLatency - latency) / 200，延迟越低的端点权重越高，
// 健康快的端点被选中概率更高；尚无延迟记录的端点按中等延迟（maxLatency）
// 参与，保证首次使用也有机会被选中。返回选中下标。
func weightedEndpointPick(latencies []int64, known []bool) int {
	maxLatency := int64(0)
	for i, latency := range latencies {
		if known[i] && latency > maxLatency {
			maxLatency = latency
		}
	}
	if maxLatency == 0 {
		maxLatency = 1000
	}

	total := int64(0)
	weights := make([]int64, len(latencies))
	for i, latency := range latencies {
		effective := latency
		if !known[i] {
			// 无记录端点视为中等延迟，避免被饿死。
			effective = maxLatency
		}
		weight := int64(1) + (maxLatency-effective)/200
		if weight < 1 {
			weight = 1
		}
		weights[i] = weight
		total += weight
	}
	if total <= 0 {
		return 0
	}
	n, _ := rand.Int(rand.Reader, big.NewInt(total))
	acc := int64(0)
	for i, w := range weights {
		acc += w
		if n.Int64() < acc {
			return i
		}
	}
	return len(latencies) - 1
}

// clientForEndpoint 按端点代理池选择下一个可用代理，返回绑定该代理的 http.Client。
// 规则：
//   - proxyEnabled 关闭：忽略代理池，直接返回直连客户端
//   - proxyEnabled 开启且池为空：forceProxy 开启时报错（禁止直连），否则回退直连
//   - proxyEnabled 开启且有池：按池选择代理
func (s *Service) clientForEndpoint(endpointID string, pool []string, proxyEnabled, forceProxy bool) (*http.Client, string, error) {
	if !proxyEnabled {
		return s.client, "", nil
	}
	cleaned := cleanProxyPool(pool)
	if len(cleaned) == 0 {
		if forceProxy {
			return nil, "", fmt.Errorf("端点配置为强制走代理，但代理池为空")
		}
		return s.client, "", nil
	}
	now := time.Now()

	s.proxyMu.Lock()
	state, ok := s.proxyStateByEndpoint[endpointID]
	if !ok {
		state = &endpointProxyState{cursor: 0, cooldown: make(map[string]time.Time), lastTTFB: make(map[string]int64)}
		s.proxyStateByEndpoint[endpointID] = state
	}
	if state.cursor >= len(cleaned) || state.cursor < 0 {
		state.cursor = 0
	}

	// 可用代理：未在冷却中的代理集合。
	candidates := []proxyCandidate{}
	for i := range cleaned {
		if until, cooled := state.cooldown[cleaned[i]]; cooled && !now.After(until) {
			continue
		}
		ttfb, known := state.lastTTFB[cleaned[i]]
		candidates = append(candidates, proxyCandidate{idx: i, ttfb: ttfb, known: known})
	}

	// 从候选集中选一个：优先让没有延迟记录的代理进入轮询（探索），
	// 全部已知后按延迟加权选择，避免单个最快代理独占全部流量。
	selectedIdx := -1
	switch {
	case len(candidates) == 0:
		// 全部冷却：退化为 cursor 轮询，先满足请求再说。
		selectedIdx = state.cursor % len(cleaned)
	case len(candidates) == 1:
		selectedIdx = candidates[0].idx
	default:
		unknownAny := false
		for _, c := range candidates {
			if !c.known {
				unknownAny = true
				break
			}
		}
		if unknownAny {
			// 探索：在候选（未冷却）集合内按 cursor 轮询，绝不选中冷却代理。
			cursorPos := state.cursor % len(candidates)
			selectedIdx = candidates[cursorPos].idx
		} else {
			// 全部已知：延迟加权随机。延迟越低权重越高，但保留次优代理出现的机会，
			// 兼顾「选快代理」与「多代理分摊流量」。
			selectedIdx = weightedProxyPick(candidates)
		}
	}
	state.cursor = (selectedIdx + 1) % len(cleaned)
	selectedProxy := cleaned[selectedIdx]
	s.proxyMu.Unlock()

	client, err := s.proxyClient(selectedProxy)
	if err != nil {
		return s.client, selectedProxy, err
	}
	return client, selectedProxy, nil
}

// auxClientForPool 为辅助请求（验证、模型列表、健康检测等）选择代理 client。
// 与 clientForEndpoint 的区别：不推进端点的游标、不写 TTFB、不写冷却，
// 只读取冷却状态做跳过，避免辅助请求污染真实转发的择优状态。
func (s *Service) auxClientForPool(endpointID string, pool []string) (*http.Client, string) {
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
	selectedProxy := ""
	for _, candidate := range cleaned {
		if ok && state.cooldown[candidate] != (time.Time{}) && !now.After(state.cooldown[candidate]) {
			continue
		}
		selectedProxy = candidate
		break
	}
	if selectedProxy == "" {
		// 全部冷却：退化为池内第一个，先满足请求再说。
		selectedProxy = cleaned[0]
	}
	s.proxyMu.Unlock()

	client, err := s.proxyClient(selectedProxy)
	if err != nil {
		return s.client, selectedProxy
	}
	return client, selectedProxy
}

// proxyCandidate 是择优时的候选代理：idx 为 cleaned 池中的下标，ttfb 为最近一次
// 首字耗时（毫秒），known 表示是否已产生过 TTFB 记录。
type proxyCandidate struct {
	idx   int
	ttfb  int64
	known bool
}

// weightedProxyPick 在全部已知延迟的候选代理中做加权选择：
// 权重 = 1 + (maxTTFB - ttfb) / 200，延迟越低的代理权重越高。
// 权重差按 200ms 为一档，既能让几百毫秒的快慢差异被感知，又不会让
// 极端慢代理彻底失去机会，从而兼顾「优先选快代理」与「多代理分摊流量」。
func weightedProxyPick(candidates []proxyCandidate) int {
	maxTTFB := int64(0)
	for _, c := range candidates {
		if c.ttfb > maxTTFB {
			maxTTFB = c.ttfb
		}
	}
	total := int64(0)
	weights := make([]int64, len(candidates))
	for i, c := range candidates {
		weight := int64(1) + (maxTTFB-c.ttfb)/200
		if weight < 1 {
			weight = 1
		}
		weights[i] = weight
		total += weight
	}
	if total <= 0 {
		return candidates[0].idx
	}
	n, _ := rand.Int(rand.Reader, big.NewInt(total))
	acc := int64(0)
	for i, w := range weights {
		acc += w
		if n.Int64() < acc {
			return candidates[i].idx
		}
	}
	return candidates[len(candidates)-1].idx
}

// recordProxyTTFB 记录某端点下某代理的一次首字耗时，供后续请求择优。
func (s *Service) recordProxyTTFB(endpointID, proxy string, ttfbMs int64) {
	if endpointID == "" || proxy == "" || ttfbMs <= 0 {
		return
	}
	s.proxyMu.Lock()
	defer s.proxyMu.Unlock()
	state, ok := s.proxyStateByEndpoint[endpointID]
	if !ok {
		state = &endpointProxyState{cursor: 0, cooldown: make(map[string]time.Time), lastTTFB: make(map[string]int64)}
		s.proxyStateByEndpoint[endpointID] = state
	}
	state.lastTTFB[proxy] = ttfbMs
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

// normalizeProxyURL 校验并规范化代理 URL：
//   - socks://socks5://socks5h:// 与裸 host:port 统一为 socks5（远端解析域名）
//   - 仅接受 socks5 与 http/https 代理，其余协议报错
func normalizeProxyURL(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, err
	}
	switch u.Scheme {
	case "socks5", "socks", "socks5h":
		// socks:// 是常见订阅节点前缀，socks5h 表示远端解析域名，均按 SOCKS5 处理。
		u.Scheme = "socks5"
	case "":
		// 裸地址（host:port）默认按 socks5 处理，便于直接粘贴节点地址。
		u = &url.URL{Scheme: "socks5", Host: strings.TrimSpace(raw)}
	default:
		if u.Scheme != "http" && u.Scheme != "https" {
			return nil, fmt.Errorf("不支持的代理协议: %s", u.Scheme)
		}
	}
	if u.Host == "" {
		return nil, fmt.Errorf("代理地址缺少 host:port: %s", raw)
	}
	return u, nil
}

// configureProxyTransport 把代理绑定到 transport（复刻 New API 的渠道代理隔离做法）：
//   - socks5：用 x/net/proxy 构造支持 context 取消的拨号器，替代标准库不支持的 http.ProxyURL
//   - http/https：直接使用 http.ProxyURL
//
// 返回的 transport 在启用代理后不依赖环境变量（HTTP_PROXY/HTTPS_PROXY），
// 保证出口严格落在显式配置的代理上，避免「代理池外 IP」出现。
func configureProxyTransport(tr *http.Transport, u *url.URL) error {
	switch u.Scheme {
	case "http", "https":
		tr.Proxy = http.ProxyURL(u)
		return nil
	case "socks5":
		tr.Proxy = nil
		forwardDialer := &net.Dialer{
			Timeout:   4 * time.Second,
			KeepAlive: 30 * time.Second,
		}
		dialer, err := proxy.FromURL(u, forwardDialer)
		if err != nil {
			return err
		}
		contextDialer, ok := dialer.(proxy.ContextDialer)
		if !ok {
			return fmt.Errorf("SOCKS5 代理拨号器不支持 context 取消")
		}
		tr.DialContext = contextDialer.DialContext
		return nil
	default:
		return fmt.Errorf("不支持的代理协议: %s", u.Scheme)
	}
}

// proxyClients 按代理 URL 缓存 http.Client，避免每次请求重建 transport。
var proxyClients = struct {
	sync.Mutex
	m map[string]*http.Client
}{m: make(map[string]*http.Client)}

func (s *Service) proxyClient(proxyURL string) (*http.Client, error) {
	u, err := normalizeProxyURL(proxyURL)
	if err != nil {
		return nil, err
	}
	proxyClients.Lock()
	defer proxyClients.Unlock()
	if c, ok := proxyClients.m[proxyURL]; ok {
		return c, nil
	}
	tr := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   4 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          500,
		MaxIdleConnsPerHost:   100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		// 只限制等待响应头，不限制整个请求（流式响应体可能远长于 60s）。
		ResponseHeaderTimeout: 30 * time.Second,
	}
	if err := configureProxyTransport(tr, u); err != nil {
		return nil, err
	}
	c := &http.Client{Transport: tr}
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

// decodeProxyPool 从数据库读取端点代理池（JSON 字符串数组）。
func decodeProxyPool(raw sql.NullString) []string {
	pool := []string{}
	if raw.Valid && raw.String != "" {
		_ = json.Unmarshal([]byte(raw.String), &pool)
	}
	return cleanProxyPool(pool)
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

// reorderEndpoints 保存端点拖拽排序结果：按传入顺序重写 sort_order。
// 使用事务保证全部成功或全部失败；仅校验 id 存在，不要求全部端点都在列表内。
func (s *Service) reorderEndpoints(w http.ResponseWriter, r *http.Request) {
	var req struct {
		EndpointIDs []string `json:"endpointIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if len(req.EndpointIDs) == 0 {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "endpointIds 不能为空"})
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

	for idx, endpointID := range req.EndpointIDs {
		res, err := tx.ExecContext(ctx,
			"UPDATE openai_endpoints SET sort_order = ? WHERE id = ?",
			(idx+1)*1000, endpointID)
		if err != nil {
			response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if affected, _ := res.RowsAffected(); affected == 0 {
			response.JSON(w, http.StatusNotFound, map[string]string{"error": fmt.Sprintf("端点不存在: %s", endpointID)})
			return
		}
	}

	if err := tx.Commit(); err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
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

	// 验证类请求使用独立短超时，避免上游无响应时拖住整个操作。
	verifyCtx, verifyCancel := context.WithTimeout(ctx, 10*time.Second)
	defer verifyCancel()

	var name, baseURL, apiKey string
	var headersRaw, proxyRaw sql.NullString
	err = db.QueryRowContext(ctx, "SELECT name, base_url, api_key, headers, proxy_pool FROM openai_endpoints WHERE id = ?", id).Scan(&name, &baseURL, &apiKey, &headersRaw, &proxyRaw)
	if err != nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "端点不存在"})
		return
	}
	apiKey = secure.SecureDecrypt(apiKey)
	headers := decodeEndpointHeaders(headersRaw)
	pool := decodeProxyPool(proxyRaw)

	startTime := time.Now()
	status := "invalid"
	modelsList := []string{}
	var errMsg string

	vOk, _, vErr := s.verifyAPIKeyRaw(verifyCtx, baseURL, apiKey, pool, headers)
	responseTime := time.Since(startTime).Milliseconds()

	if vErr == nil && vOk {
		status = "valid"
		mList, mErr := s.listModelsRaw(verifyCtx, baseURL, apiKey, pool, headers)
		if mErr == nil {
			modelsList = mList
		}
	} else if vErr != nil {
		errMsg = vErr.Error()
	}

	checkedAt := time.Now().Format(time.RFC3339)

	// 验证失败时保留旧的模型列表：一次超时/临时网络故障不应清空已获取的模型。
	modelsJSON := "[]"
	if status == "valid" && len(modelsList) > 0 {
		modelsJSONBytes, _ := json.Marshal(modelsList)
		modelsJSON = string(modelsJSONBytes)
	} else if status == "valid" {
		// 验证成功但返回空列表：视为真实空（首次接入或上游确实无模型）。
		modelsJSON = "[]"
	}

	_, err = db.ExecContext(ctx, `
		UPDATE openai_endpoints
		SET status = ?, models = ?, last_checked = ?
		WHERE id = ?`,
		status, modelsJSON, checkedAt, id)
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

	// 模型列表拉取使用独立短超时，避免上游无响应时拖住整个操作。
	modelsCtx, modelsCancel := context.WithTimeout(ctx, 10*time.Second)
	defer modelsCancel()

	var baseURL, apiKey string
	var headersRaw, proxyRaw sql.NullString
	err = db.QueryRowContext(ctx, "SELECT base_url, api_key, headers, proxy_pool FROM openai_endpoints WHERE id = ?", id).Scan(&baseURL, &apiKey, &headersRaw, &proxyRaw)
	if err != nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "端点不存在"})
		return
	}
	apiKey = secure.SecureDecrypt(apiKey)

	modelsList, err := s.listModelsRaw(modelsCtx, baseURL, apiKey, decodeProxyPool(proxyRaw), decodeEndpointHeaders(headersRaw))
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

// toggleEndpointModelsBatch 批量启用/停用端点上的多个模型。
// 单次「读-改-写」原子完成，避免前端并发逐个 toggle 时互相覆盖丢失。
func (s *Service) toggleEndpointModelsBatch(w http.ResponseWriter, r *http.Request, id string) {
	var req struct {
		Models  []string `json:"models"`
		Enabled bool     `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	cleaned := make([]string, 0, len(req.Models))
	seen := make(map[string]bool, len(req.Models))
	for _, m := range req.Models {
		trimmed := strings.TrimSpace(m)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		cleaned = append(cleaned, trimmed)
	}
	if len(cleaned) == 0 {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "模型列表不能为空"})
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

	disabledSet := make(map[string]bool)
	if disabledRaw.Valid && disabledRaw.String != "" {
		var existing []string
		if err := json.Unmarshal([]byte(disabledRaw.String), &existing); err == nil {
			for _, m := range existing {
				disabledSet[m] = true
			}
		}
	}
	for _, m := range cleaned {
		if req.Enabled {
			delete(disabledSet, m)
		} else {
			disabledSet[m] = true
		}
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

// resolveSubscriptionProxies 拉取用户粘贴的订阅链接，解析其中的 socks/http 节点，
// 转换为可直接写入端点代理池的代理 URL。
func (s *Service) resolveSubscriptionProxies(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "请求体解析失败"})
		return
	}
	req.URL = strings.TrimSpace(req.URL)
	if req.URL == "" {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "请填写订阅链接"})
		return
	}
	if !strings.HasPrefix(strings.ToLower(req.URL), "http://") && !strings.HasPrefix(strings.ToLower(req.URL), "https://") {
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": "订阅链接必须以 http:// 或 https:// 开头"})
		return
	}

	ctx := r.Context()
	fetchCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, req.URL, nil)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": "构造请求失败: " + err.Error()})
		return
	}
	httpReq.Header.Set("User-Agent", "API-Monitor-OpenAI/1.0")
	resp, err := s.client.Do(httpReq)
	if err != nil {
		response.JSON(w, http.StatusBadGateway, map[string]string{"error": "拉取订阅失败: " + err.Error()})
		return
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		response.JSON(w, http.StatusBadGateway, map[string]string{"error": fmt.Sprintf("订阅源返回 HTTP %d", resp.StatusCode)})
		return
	}

	proxies := parseSubscriptionProxyText(string(body))
	if len(proxies) == 0 {
		response.JSON(w, http.StatusOK, map[string]interface{}{
			"success": true,
			"proxies": []subscriptionProxy{},
			"message": "订阅内容中没有找到 socks/http 节点",
		})
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"success": true, "proxies": proxies})
}

// parseSubscriptionProxyText 解析订阅内容（可能是 base64 节点列表或纯文本），
// 提取其中的 socks/socks5/http/https 节点为代理 URL。
func parseSubscriptionProxyText(content string) []subscriptionProxy {
	text := strings.TrimSpace(content)
	lines := []string{}
	// 尝试 base64 解码：订阅常见格式是 base64 编码的每行一个节点 URI。
	decoded := decodeBase64Text(text)
	if decoded != "" {
		text = decoded
	}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		lines = append(lines, line)
	}

	proxies := []subscriptionProxy{}
	seen := make(map[string]bool)
	for _, line := range lines {
		proxy, name, ok := convertNodeToProxy("", line, "", 0, "")
		if !ok || proxy == "" {
			continue
		}
		// 仅接受 socks/http 出口；裸 server:port 也归为 socks5 出口。
		scheme := proxy
		if idx := strings.Index(proxy, "://"); idx >= 0 {
			scheme = strings.ToLower(proxy[:idx])
		}
		if scheme != "socks5" && scheme != "http" && scheme != "https" {
			continue
		}
		if seen[proxy] {
			continue
		}
		seen[proxy] = true
		proxies = append(proxies, subscriptionProxy{
			Name:   name,
			Type:   scheme,
			Proxy:  proxy,
			Server: hostFromProxyURL(proxy),
		})
	}
	return proxies
}

// decodeBase64Text 尝试将内容按 base64 解码；成功且结果可读时返回解码文本。
func decodeBase64Text(text string) string {
	compact := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == ' ' || r == '\t' {
			return -1
		}
		return r
	}, text)
	raw, err := base64.StdEncoding.DecodeString(compact)
	if err != nil {
		return ""
	}
	decoded := string(raw)
	if strings.Contains(decoded, "://") || strings.Contains(decoded, "vmess://") || strings.Contains(decoded, "trojan://") || strings.Contains(decoded, "ss://") {
		return decoded
	}
	return ""
}

// hostFromProxyURL 从代理 URL 中提取 host 部分用于展示。
func hostFromProxyURL(proxy string) string {
	u, err := url.Parse(proxy)
	if err != nil {
		return proxy
	}
	return u.Host
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
	// 端点测试使用独立短超时，避免上游无响应时拖住整个操作。
	testCtx, testCancel := context.WithTimeout(ctx, 10*time.Second)
	defer testCancel()

	db, err := s.open(ctx)
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	var baseURL, apiKey string
	var headersRaw, proxyRaw sql.NullString
	err = db.QueryRowContext(ctx, "SELECT base_url, api_key, headers, proxy_pool FROM openai_endpoints WHERE id = ?", id).Scan(&baseURL, &apiKey, &headersRaw, &proxyRaw)
	if err != nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "端点不存在"})
		return
	}
	apiKey = secure.SecureDecrypt(apiKey)
	pool := decodeProxyPool(proxyRaw)

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
	httpReq, err := http.NewRequestWithContext(testCtx, "POST", reqURL, bytes.NewReader(bodyBytes))
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", "application/json")
	applyCustomHeaders(httpReq, decodeEndpointHeaders(headersRaw))

	client := s.client
	if len(pool) > 0 {
		poolClient, _ := s.auxClientForPool(id, pool)
		if poolClient != nil {
			client = poolClient
		}
	}

	resp, err := client.Do(httpReq)
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
	var headersRaw, proxyRaw sql.NullString
	err = db.QueryRowContext(ctx, "SELECT base_url, api_key, headers, proxy_pool FROM openai_endpoints WHERE id = ?", id).Scan(&baseURL, &apiKey, &headersRaw, &proxyRaw)
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

	pool := decodeProxyPool(proxyRaw)
	result := s.healthCheckSingleModel(ctx, id, baseURL, apiKey, req.Model, timeoutDuration, pool, decodeEndpointHeaders(headersRaw))

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
	var headersRaw, proxyRaw sql.NullString
	err = db.QueryRowContext(ctx, "SELECT base_url, api_key, models, headers, proxy_pool FROM openai_endpoints WHERE id = ?", id).Scan(&baseURL, &apiKey, &modelsRaw, &headersRaw, &proxyRaw)
	if err != nil {
		response.JSON(w, http.StatusNotFound, map[string]string{"error": "端点不存在"})
		return
	}
	apiKey = secure.SecureDecrypt(apiKey)
	endpointHeaders := decodeEndpointHeaders(headersRaw)
	endpointPool := decodeProxyPool(proxyRaw)

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


	summary := s.runBatchHealthCheck(ctx, id, baseURL, apiKey, models, timeoutDuration, concurrency, endpointPool, endpointHeaders)

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

	rows, err := db.QueryContext(ctx, "SELECT id, name, base_url, api_key, headers, proxy_pool FROM openai_endpoints WHERE enabled = 1")
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	type item struct {
		id, name, url, key string
		headers            []HeaderItem
		pool               []string
	}
	items := []item{}
	for rows.Next() {
		var it item
		var headersRaw, proxyRaw sql.NullString
		if err := rows.Scan(&it.id, &it.name, &it.url, &it.key, &headersRaw, &proxyRaw); err == nil {
			it.key = secure.SecureDecrypt(it.key)
			it.headers = decodeEndpointHeaders(headersRaw)
			it.pool = decodeProxyPool(proxyRaw)
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

			vOk, _, err := s.verifyAPIKeyRaw(ctx, it.url, it.key, it.pool, it.headers)
			if err == nil && vOk {
				status = "valid"
				mList, mErr := s.listModelsRaw(ctx, it.url, it.key, it.pool, it.headers)
				if mErr == nil {
					modelsList = mList
				}
			} else if err != nil {
				errStr = err.Error()
			}

			checkedAt := time.Now().Format(time.RFC3339)
			// 验证失败时保留旧模型列表：一次超时/临时故障不应清空已获取的模型。
			modelsJSON := "[]"
			if status == "valid" && len(modelsList) > 0 {
				modelsJSONBytes, _ := json.Marshal(modelsList)
				modelsJSON = string(modelsJSONBytes)
			}

			// Update in DB
			if dbConn, dbErr := s.open(ctx); dbErr == nil {
				defer dbConn.Close()
				_, _ = dbConn.ExecContext(ctx, `
					UPDATE openai_endpoints
					SET status = ?, models = ?, last_checked = ?
					WHERE id = ?`,
					status, modelsJSON, checkedAt, it.id)
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

	rows, err := db.QueryContext(ctx, "SELECT id, name, base_url, api_key, models, headers, proxy_pool FROM openai_endpoints WHERE enabled = 1")
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	type item struct {
		id, name, url, key, modelsRaw string
		headers                       []HeaderItem
		pool                          []string
	}
	items := []item{}
	for rows.Next() {
		var it item
		var headersRaw, proxyRaw sql.NullString
		if err := rows.Scan(&it.id, &it.name, &it.url, &it.key, &it.modelsRaw, &headersRaw, &proxyRaw); err == nil {
			it.key = secure.SecureDecrypt(it.key)
			it.headers = decodeEndpointHeaders(headersRaw)
			it.pool = decodeProxyPool(proxyRaw)
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

				result := s.healthCheckSingleModel(ctx, target.id, target.url, target.key, model, timeoutDuration, target.pool, target.headers)
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

	rows, err := db.QueryContext(ctx, "SELECT id, name, base_url, api_key, headers, disabled_models, proxy_pool, auto_switch, status, enabled, models, created_at, last_used, last_checked, model_mappings FROM openai_endpoints ORDER BY sort_order ASC, created_at ASC")
	if err != nil {
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer rows.Close()

	endpoints := []Endpoint{}
	for rows.Next() {
		var ep Endpoint
		var headersRaw, modelsRaw, disabledRaw, proxyRaw, mappingsRaw sql.NullString
		var created, used, checked sql.NullString
		var enabledInt, autoSwitchInt int

		err := rows.Scan(&ep.ID, &ep.Name, &ep.BaseURL, &ep.APIKey, &headersRaw, &disabledRaw, &proxyRaw, &autoSwitchInt, &ep.Status, &enabledInt, &modelsRaw, &created, &used, &checked, &mappingsRaw)
		if err != nil {
			response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}

		ep.APIKey = secure.SecureDecrypt(ep.APIKey)
		ep.Enabled = enabledInt == 1
		ep.AutoSwitch = autoSwitchInt == 1
		if mappingsRaw.Valid && mappingsRaw.String != "" {
			_ = json.Unmarshal([]byte(mappingsRaw.String), &ep.ModelMappings)
		}
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

// selectEndpointForModel 根据模型名从已启用端点中选出一个能服务该模型的端点，
// 优先使用请求头 x-endpoint-id 指定的端点，否则随机选一个可用的。
// 返回选中的端点、上游真实模型名（已应用 model_mappings 别名）、以及是否找到。
func (s *Service) selectEndpointForModel(ctx context.Context, db *sql.DB, model, targetEndpointID string) (Endpoint, string, bool) {
	var selected Endpoint
	var found bool
	selectedModel := model

	loadEndpoint := func(ep *Endpoint, headersRaw, modelsRaw, disabledRaw, proxyRaw, mappingsRaw sql.NullString, enabledInt, autoSwitchInt, proxyEnabledInt, forceProxyInt int) {
		ep.APIKey = secure.SecureDecrypt(ep.APIKey)
		ep.Enabled = enabledInt == 1
		ep.AutoSwitch = autoSwitchInt == 1
		ep.ProxyEnabled = proxyEnabledInt == 1
		ep.ForceProxy = forceProxyInt == 1
		if mappingsRaw.Valid && mappingsRaw.String != "" {
			_ = json.Unmarshal([]byte(mappingsRaw.String), &ep.ModelMappings)
		}
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
	}

	if targetEndpointID != "" {
		var ep Endpoint
		var headersRaw, modelsRaw, disabledRaw, proxyRaw, mappingsRaw sql.NullString
		var enabledInt, autoSwitchInt, proxyEnabledInt, forceProxyInt int
		err := db.QueryRowContext(ctx, `
			SELECT id, name, base_url, api_key, headers, disabled_models, proxy_pool, auto_switch, proxy_enabled, force_proxy, status, enabled, models, model_mappings
			FROM openai_endpoints WHERE id = ? AND enabled = 1`, targetEndpointID).
			Scan(&ep.ID, &ep.Name, &ep.BaseURL, &ep.APIKey, &headersRaw, &disabledRaw, &proxyRaw, &autoSwitchInt, &proxyEnabledInt, &forceProxyInt, &ep.Status, &enabledInt, &modelsRaw, &mappingsRaw)
		if err == nil {
			loadEndpoint(&ep, headersRaw, modelsRaw, disabledRaw, proxyRaw, mappingsRaw, enabledInt, autoSwitchInt, proxyEnabledInt, forceProxyInt)
			if s.endpointHasModel(ep, model) && !isModelDisabled(ep.DisabledModels, model) {
				selected = ep
				selectedModel, _ = s.resolveEndpointModel(ep, model)
				found = true
			}
		}
	}

	if !found {
		// Enabled is the administrator's routing decision; status is the latest verification result.
		rows, err := db.QueryContext(ctx, `
			SELECT id, name, base_url, api_key, headers, disabled_models, proxy_pool, auto_switch, proxy_enabled, force_proxy, status, enabled, models, model_mappings
			FROM openai_endpoints WHERE enabled = 1`)
		if err != nil {
			return selected, selectedModel, false
		}
		defer rows.Close()
		endpoints := []Endpoint{}
		for rows.Next() {
			var ep Endpoint
			var headersRaw, modelsRaw, disabledRaw, proxyRaw, mappingsRaw sql.NullString
			var enabledInt, autoSwitchInt, proxyEnabledInt, forceProxyInt int
			if errScan := rows.Scan(&ep.ID, &ep.Name, &ep.BaseURL, &ep.APIKey, &headersRaw, &disabledRaw, &proxyRaw, &autoSwitchInt, &proxyEnabledInt, &forceProxyInt, &ep.Status, &enabledInt, &modelsRaw, &mappingsRaw); errScan == nil {
				loadEndpoint(&ep, headersRaw, modelsRaw, disabledRaw, proxyRaw, mappingsRaw, enabledInt, autoSwitchInt, proxyEnabledInt, forceProxyInt)
				endpoints = append(endpoints, ep)
			}
		}

		eligible := []Endpoint{}
		for _, ep := range endpoints {
			real, _ := s.resolveEndpointModel(ep, model)
			if s.endpointHasModel(ep, model) && !isModelDisabled(ep.DisabledModels, real) {
				eligible = append(eligible, ep)
			}
		}

		targets := eligible
		if len(targets) == 0 {
			// 兜底：模型列表尚未刷新时仍尝试已启用端点，但跳过已禁用该模型的端点。
			for _, ep := range endpoints {
				if s.endpointHasModel(ep, model) && !isModelDisabled(ep.DisabledModels, model) {
					targets = append(targets, ep)
				}
			}
		}

		if len(targets) > 0 {
			// 延迟加权分流：健康（延迟低）的端点被选中概率更高。
			latencies := make([]int64, len(targets))
			known := make([]bool, len(targets))
			for i, ep := range targets {
				latencies[i], known[i] = s.getEndpointLatency(ep.ID)
			}
			selected = targets[weightedEndpointPick(latencies, known)]
			selectedModel, _ = s.resolveEndpointModel(selected, model)
			found = true
		}
	}

	return selected, selectedModel, found
}

func (s *Service) proxyChatCompletions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	requestStarted := time.Now()
	clientIP := s.resolveClientIP(r)
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		s.RecordAnalytics(ctx, "chat.completions", "", "", http.StatusBadRequest, time.Since(requestStarted).Milliseconds(), 0, 0, 0, 0, 0, 0, 0, clientIP, "")
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	var parsedBody map[string]interface{}
	if err := json.Unmarshal(bodyBytes, &parsedBody); err != nil {
		s.RecordAnalytics(ctx, "chat.completions", "", "", http.StatusBadRequest, time.Since(requestStarted).Milliseconds(), 0, 0, 0, 0, 0, 0, 0, clientIP, "")
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	model, _ := parsedBody["model"].(string)
	stream, _ := parsedBody["stream"].(bool)
	targetEndpointID := r.Header.Get("x-endpoint-id")
	selectedModel := model

	db, err := s.open(ctx)
	if err != nil {
		s.RecordAnalytics(ctx, "chat.completions", "", model, http.StatusInternalServerError, time.Since(requestStarted).Milliseconds(), 0, 0, 0, 0, 0, 0, 0, clientIP, "")
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	selected, selectedModel, found := s.selectEndpointForModel(ctx, db, model, targetEndpointID)
	if !found {
		s.RecordAnalytics(ctx, "chat.completions", "", model, http.StatusServiceUnavailable, time.Since(requestStarted).Milliseconds(), 0, 0, 0, 0, 0, 0, 0, clientIP, "")
		response.JSON(w, http.StatusServiceUnavailable, map[string]interface{}{
			"error": map[string]string{
				"message": "No valid OpenAI endpoints available",
				"type":    "service_unavailable",
			},
		})
		return
	}

	// 记录是否经由本端点配置的代理池出网。
	viaProxy := 0
	if len(selected.ProxyPool) > 0 {
		viaProxy = 1
	}

	// Format base url
	fullURL := strings.TrimSuffix(selected.BaseURL, "/")
	if !strings.HasSuffix(strings.ToLower(fullURL), "/v1") && !strings.Contains(strings.ToLower(fullURL), "/v1/") {
		fullURL += "/v1"
	}
	fullURL += "/chat/completions"

	isLocal := localURLRegex.MatchString(fullURL)

	// 出口 IP：请求实际从哪个地址发往目标。走代理池时随循环内选中的代理更新，
	// 直连时用网关本机出口 IP。该字段用于定位是哪个出口/代理承载了本次请求。
	egressIP := s.egressOutbound()

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

	// 若请求名是对外别名，转发到上游时还原为真实模型名。
	if selectedModel != model && selectedModel != "" {
		parsedBody["model"] = selectedModel
	}

	upstreamBodyBytes, _ := json.Marshal(parsedBody)

	startTime := time.Now()

	// 代理池选择 + 限流自动切换：最多尝试 len(pool) 个代理，池为空或代理未启用时只尝试一次。
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
	// lastProxy 保存最终成功使用的代理（用于 TTFB 择优记录与日志）。
	lastProxy := ""
	// firstChunk 保存流式首字等待阶段读到的首个数据块；无切换机会时首字在循环内读取。
	var firstChunk []byte
	var ttfbMs int64
	firstWritten := false

	// attemptCancel 指向最近一次请求的取消函数，函数返回前统一调用（幂等），
	// 保证所有 attempt context 均被释放。
	var attemptCancel context.CancelFunc
	defer func() {
		if attemptCancel != nil {
			attemptCancel()
		}
	}()

	for attempt = 0; attempt < maxProxyAttempts; attempt++ {
		attemptCtx, cancel := context.WithCancel(ctx)
		attemptCancel = cancel
		client, currentProxy, clientErr := s.clientForEndpoint(selected.ID, selected.ProxyPool, selected.ProxyEnabled, selected.ForceProxy)
		if clientErr != nil {
			cancel()
			lastErr = clientErr
			break
		}
		if currentProxy != "" {
			lastProxy = currentProxy
			egressIP = proxyEndpointAddr(currentProxy)
		}

		httpReq, err := http.NewRequestWithContext(attemptCtx, "POST", fullURL, bytes.NewReader(upstreamBodyBytes))
		if err != nil {
			cancel()
			s.RecordAnalytics(ctx, "chat.completions", selected.ID, model, http.StatusInternalServerError, time.Since(requestStarted).Milliseconds(), 0, 0, 0, 0, 0, 0, 0, clientIP, egressIP)
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
			cancel()
			if attempt+1 < maxProxyAttempts {
				continue
			}
			break
		}

		// 非流式：读取正文判断限流，失败时在循环内重试。
		if !stream && selected.AutoSwitch && attempt+1 < maxProxyAttempts {
			bodyBytesRead, readErr := io.ReadAll(resp.Body)
			resp.Body.Close()
			cancel()
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
			cancel()
			s.markProxyFailed(selected.ID, currentProxy)
			continue
		}

		if stream {
			// 首字等待：若还有可切换的代理，则带超时等待首个字节，
			// 超时或上游提前断流时标记该代理失败并切换下一个。
			waitForFirst := selected.AutoSwitch && attempt+1 < maxProxyAttempts
			if waitForFirst {
				type readRes struct {
					n   int
					err error
				}
				ch := make(chan readRes, 1)
				tmp := make([]byte, 4096)
				go func() {
					n, err := resp.Body.Read(tmp)
					ch <- readRes{n, err}
				}()
				var r readRes
				select {
				case r = <-ch:
				case <-time.After(firstTokenTimeout):
					cancel()
					resp.Body.Close()
					s.markProxyFailed(selected.ID, currentProxy)
					if attempt+1 < maxProxyAttempts {
						continue
					}
					lastErr = fmt.Errorf("上游首字超时（超过 %s）", firstTokenTimeout)
					break
				}
				if r.n > 0 {
					firstChunk = append([]byte(nil), tmp[:r.n]...)
					firstWritten = true
					ttfbMs = time.Since(startTime).Milliseconds()
					break
				}
				cancel()
				resp.Body.Close()
				s.markProxyFailed(selected.ID, currentProxy)
				if attempt+1 < maxProxyAttempts {
					continue
				}
				lastErr = r.err
				if lastErr == nil {
					lastErr = io.EOF
				}
				break
			}

			// 无切换机会：直接阻塞读首块，读取结果留给下方流式循环继续消费。
			tmp := make([]byte, 4096)
			n, err := resp.Body.Read(tmp)
			if n > 0 {
				firstChunk = append([]byte(nil), tmp[:n]...)
				firstWritten = true
				ttfbMs = time.Since(startTime).Milliseconds()
				break
			}
			cancel()
			lastErr = err
			if lastErr == nil {
				lastErr = io.EOF
			}
			break
		}
		break
	}

	if lastErr != nil && resp == nil {
		s.RecordAnalytics(ctx, "chat.completions", selected.ID, model, http.StatusBadGateway, time.Since(startTime).Milliseconds(), 0, 0, 0, 0, 0, 0, 0, clientIP, egressIP)
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

		// 每次写前延长写超时，避免 http.Server.WriteTimeout 掐断长流式响应。
		extendStreamDeadline := func() {
			_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(streamWriteDeadline))
		}

		// 首字等待阶段已读到的数据块，直接作为流式响应的首批内容写回。
		if firstWritten && len(firstChunk) > 0 {
			extendStreamDeadline()
			_, _ = w.Write(firstChunk)
			tail = append(tail, firstChunk...)
			if ok {
				flusher.Flush()
			}
		}

		for {
			n, err := resp.Body.Read(buf)
			if n > 0 {
				extendStreamDeadline()
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
		cachedTokens := 0

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
		if matches := cachedTokensRegex.FindStringSubmatch(accumulatedStr); len(matches) > 1 {
			cachedTokens, _ = strconv.Atoi(matches[1])
		}

		s.recordProxyTTFB(selected.ID, lastProxy, ttfbMs)
		s.RecordAnalytics(ctx, "chat.completions", selected.ID, model, resp.StatusCode, latencyMs, ttfbMs, promptTokens, completionTokens, totalTokens, cachedTokens, boolToInt(stream), viaProxy, clientIP, egressIP)
		s.recordEndpointLatency(selected.ID, latencyMs)
	} else {
		respBodyBytes, _ := io.ReadAll(resp.Body)
		latencyMs := time.Since(startTime).Milliseconds()

		var usageInfo struct {
			Usage struct {
				PromptTokens        int `json:"prompt_tokens"`
				CompletionTokens    int `json:"completion_tokens"`
				TotalTokens         int `json:"total_tokens"`
				PromptTokensDetails struct {
					CachedTokens int `json:"cached_tokens"`
				} `json:"prompt_tokens_details"`
			} `json:"usage"`
		}
		_ = json.Unmarshal(respBodyBytes, &usageInfo)

		s.recordProxyTTFB(selected.ID, lastProxy, latencyMs)
		s.RecordAnalytics(ctx, "chat.completions", selected.ID, model, resp.StatusCode, latencyMs, 0, usageInfo.Usage.PromptTokens, usageInfo.Usage.CompletionTokens, usageInfo.Usage.TotalTokens, usageInfo.Usage.PromptTokensDetails.CachedTokens, boolToInt(stream), viaProxy, clientIP, egressIP)
		s.recordEndpointLatency(selected.ID, latencyMs)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(respBodyBytes)
	}
}

// proxyResponses 代理 OpenAI Responses API（POST /v1/responses）。
// 请求体按不透明 JSON 透传（Responses 的 input/instructions 结构与 chat 不同，
// 网关不做改写），仅复用端点的模型路由、代理池与首字超时切换能力。
func (s *Service) proxyResponses(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	requestStarted := time.Now()
	clientIP := s.resolveClientIP(r)
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		s.RecordAnalytics(ctx, "responses", "", "", http.StatusBadRequest, time.Since(requestStarted).Milliseconds(), 0, 0, 0, 0, 0, 0, 0, clientIP, "")
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	var parsedBody map[string]interface{}
	if err := json.Unmarshal(bodyBytes, &parsedBody); err != nil {
		s.RecordAnalytics(ctx, "responses", "", "", http.StatusBadRequest, time.Since(requestStarted).Milliseconds(), 0, 0, 0, 0, 0, 0, 0, clientIP, "")
		response.JSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	model, _ := parsedBody["model"].(string)
	stream, _ := parsedBody["stream"].(bool)
	targetEndpointID := r.Header.Get("x-endpoint-id")

	db, err := s.open(ctx)
	if err != nil {
		s.RecordAnalytics(ctx, "responses", "", model, http.StatusInternalServerError, time.Since(requestStarted).Milliseconds(), 0, 0, 0, 0, 0, 0, 0, clientIP, "")
		response.JSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	defer db.Close()

	selected, selectedModel, found := s.selectEndpointForModel(ctx, db, model, targetEndpointID)
	if !found {
		s.RecordAnalytics(ctx, "responses", "", model, http.StatusServiceUnavailable, time.Since(requestStarted).Milliseconds(), 0, 0, 0, 0, 0, 0, 0, clientIP, "")
		response.JSON(w, http.StatusServiceUnavailable, map[string]interface{}{
			"error": map[string]string{
				"message": "No valid OpenAI endpoints available",
				"type":    "service_unavailable",
			},
		})
		return
	}

	viaProxy := 0
	if len(selected.ProxyPool) > 0 {
		viaProxy = 1
	}

	// Responses API 的路径为 /responses。
	fullURL := strings.TrimSuffix(selected.BaseURL, "/")
	if !strings.HasSuffix(strings.ToLower(fullURL), "/v1") && !strings.Contains(strings.ToLower(fullURL), "/v1/") {
		fullURL += "/v1"
	}
	fullURL += "/responses"

	egressIP := s.egressOutbound()

	// 若请求模型名是对外别名，转发到上游时还原为真实模型名。
	if selectedModel != model && selectedModel != "" {
		parsedBody["model"] = selectedModel
	}
	upstreamBodyBytes, _ := json.Marshal(parsedBody)

	startTime := time.Now()

	maxProxyAttempts := len(selected.ProxyPool)
	if maxProxyAttempts == 0 {
		maxProxyAttempts = 1
	}
	if !selected.AutoSwitch {
		maxProxyAttempts = 1
	}

	var resp *http.Response
	var lastErr error
	var attempt int
	lastProxy := ""
	var firstChunk []byte
	var ttfbMs int64
	firstWritten := false

	var attemptCancel context.CancelFunc
	defer func() {
		if attemptCancel != nil {
			attemptCancel()
		}
	}()

	for attempt = 0; attempt < maxProxyAttempts; attempt++ {
		attemptCtx, cancel := context.WithCancel(ctx)
		attemptCancel = cancel
		client, currentProxy, clientErr := s.clientForEndpoint(selected.ID, selected.ProxyPool, selected.ProxyEnabled, selected.ForceProxy)
		if clientErr != nil {
			cancel()
			lastErr = clientErr
			break
		}
		if currentProxy != "" {
			lastProxy = currentProxy
			egressIP = proxyEndpointAddr(currentProxy)
		}

		httpReq, err := http.NewRequestWithContext(attemptCtx, http.MethodPost, fullURL, bytes.NewReader(upstreamBodyBytes))
		if err != nil {
			cancel()
			s.RecordAnalytics(ctx, "responses", selected.ID, model, http.StatusInternalServerError, time.Since(requestStarted).Milliseconds(), 0, 0, 0, 0, 0, 0, 0, clientIP, egressIP)
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
			s.markProxyFailed(selected.ID, currentProxy)
			cancel()
			if attempt+1 < maxProxyAttempts {
				continue
			}
			break
		}

		// 非流式：读取正文判断限流，失败时切换代理重试。
		if !stream && selected.AutoSwitch && attempt+1 < maxProxyAttempts {
			bodyBytesRead, readErr := io.ReadAll(resp.Body)
			resp.Body.Close()
			cancel()
			if readErr == nil && isRateLimitResponse(resp, bodyBytesRead) {
				s.markProxyFailed(selected.ID, currentProxy)
				continue
			}
			resp.Body = io.NopCloser(bytes.NewReader(bodyBytesRead))
			break
		}

		// 流式：仅按状态码判断限流。
		if stream && selected.AutoSwitch && attempt+1 < maxProxyAttempts && isRateLimitResponse(resp, nil) {
			resp.Body.Close()
			cancel()
			s.markProxyFailed(selected.ID, currentProxy)
			continue
		}

		if stream {
			waitForFirst := selected.AutoSwitch && attempt+1 < maxProxyAttempts
			if waitForFirst {
				type readRes struct {
					n   int
					err error
				}
				ch := make(chan readRes, 1)
				tmp := make([]byte, 4096)
				go func() {
					n, err := resp.Body.Read(tmp)
					ch <- readRes{n, err}
				}()
				var r readRes
				select {
				case r = <-ch:
				case <-time.After(firstTokenTimeout):
					cancel()
					resp.Body.Close()
					s.markProxyFailed(selected.ID, currentProxy)
					if attempt+1 < maxProxyAttempts {
						continue
					}
					lastErr = fmt.Errorf("上游首字超时（超过 %s）", firstTokenTimeout)
					break
				}
				if r.n > 0 {
					firstChunk = append([]byte(nil), tmp[:r.n]...)
					firstWritten = true
					ttfbMs = time.Since(startTime).Milliseconds()
					break
				}
				cancel()
				resp.Body.Close()
				s.markProxyFailed(selected.ID, currentProxy)
				if attempt+1 < maxProxyAttempts {
					continue
				}
				lastErr = r.err
				if lastErr == nil {
					lastErr = io.EOF
				}
				break
			}

			tmp := make([]byte, 4096)
			n, err := resp.Body.Read(tmp)
			if n > 0 {
				firstChunk = append([]byte(nil), tmp[:n]...)
				firstWritten = true
				ttfbMs = time.Since(startTime).Milliseconds()
				break
			}
			cancel()
			lastErr = err
			if lastErr == nil {
				lastErr = io.EOF
			}
			break
		}
		break
	}

	if lastErr != nil && resp == nil {
		s.RecordAnalytics(ctx, "responses", selected.ID, model, http.StatusBadGateway, time.Since(startTime).Milliseconds(), 0, 0, 0, 0, 0, 0, 0, clientIP, egressIP)
		response.JSON(w, http.StatusBadGateway, map[string]interface{}{"error": map[string]string{"message": lastErr.Error(), "type": "proxy_error"}})
		return
	}
	defer resp.Body.Close()

	_, _ = db.ExecContext(ctx, "UPDATE openai_endpoints SET last_used = ? WHERE id = ?", time.Now().Format(time.RFC3339), selected.ID)

	if stream {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(resp.StatusCode)

		flusher, ok := w.(http.Flusher)
		buf := make([]byte, 4096)
		// 每次写前延长写超时，避免 http.Server.WriteTimeout 掐断长流式响应。
		extendStreamDeadline := func() {
			_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(streamWriteDeadline))
		}
		if firstWritten && len(firstChunk) > 0 {
			extendStreamDeadline()
			_, _ = w.Write(firstChunk)
			if ok {
				flusher.Flush()
			}
		}
		for {
			n, err := resp.Body.Read(buf)
			if n > 0 {
				extendStreamDeadline()
				_, _ = w.Write(buf[:n])
				if ok {
					flusher.Flush()
				}
			}
			if err != nil {
				break
			}
		}
		latencyMs := time.Since(startTime).Milliseconds()

		s.recordProxyTTFB(selected.ID, lastProxy, ttfbMs)
		s.RecordAnalytics(ctx, "responses", selected.ID, model, resp.StatusCode, latencyMs, ttfbMs, 0, 0, 0, 0, boolToInt(stream), viaProxy, clientIP, egressIP)
	} else {
		respBodyBytes, _ := io.ReadAll(resp.Body)
		latencyMs := time.Since(startTime).Milliseconds()

		s.recordProxyTTFB(selected.ID, lastProxy, latencyMs)
		s.RecordAnalytics(ctx, "responses", selected.ID, model, resp.StatusCode, latencyMs, 0, 0, 0, 0, 0, boolToInt(stream), viaProxy, clientIP, egressIP)
		s.recordEndpointLatency(selected.ID, latencyMs)

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

	rows, err := db.QueryContext(ctx, "SELECT name, enabled, status, models, disabled_models, model_mappings FROM openai_endpoints WHERE enabled = 1")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	modelMap := make(map[string]map[string]interface{})
	for rows.Next() {
		var name, status, modelsRaw string
		var enabledInt int
		var disabledRaw, mappingsRaw sql.NullString
		if err := rows.Scan(&name, &enabledInt, &status, &modelsRaw, &disabledRaw, &mappingsRaw); err == nil {
			var models []string
			if modelsRaw != "" {
				_ = json.Unmarshal([]byte(modelsRaw), &models)
			}
			disabled := []string{}
			if disabledRaw.Valid && disabledRaw.String != "" {
				_ = json.Unmarshal([]byte(disabledRaw.String), &disabled)
			}
			mappings := map[string]string{}
			if mappingsRaw.Valid && mappingsRaw.String != "" {
				_ = json.Unmarshal([]byte(mappingsRaw.String), &mappings)
			}
			for _, mID := range models {
				if isModelDisabled(disabled, mID) {
					continue
				}
				// 对外名称：存在映射时使用别名。
				externalID := mID
				if alias := mappings[mID]; alias != "" {
					externalID = alias
				}
				if _, ok := modelMap[externalID]; !ok {
					modelMap[externalID] = map[string]interface{}{
						"id":       externalID,
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

func (s *Service) verifyAPIKeyRaw(ctx context.Context, u string, key string, pool []string, headers ...[]HeaderItem) (bool, int, error) {
	reqURL := fmt.Sprintf("%s/models", strings.TrimSuffix(u, "/"))
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return false, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	if len(headers) > 0 {
		applyCustomHeaders(req, headers[0])
	}

	client := s.client
	if len(pool) > 0 {
		poolClient, _ := s.auxClientForPool("", pool)
		if poolClient != nil {
			client = poolClient
		}
	}

	resp, err := client.Do(req)
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

func (s *Service) listModelsRaw(ctx context.Context, u string, key string, pool []string, headers ...[]HeaderItem) ([]string, error) {
	reqURL := fmt.Sprintf("%s/models", strings.TrimSuffix(u, "/"))
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	if len(headers) > 0 {
		applyCustomHeaders(req, headers[0])
	}

	client := s.client
	if len(pool) > 0 {
		poolClient, _ := s.auxClientForPool("", pool)
		if poolClient != nil {
			client = poolClient
		}
	}

	resp, err := client.Do(req)
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

// healthCheckAttempts 是单个模型健康检测的最大尝试轮数。
// 上游限流（429/5xx/超时）波动大，多轮中任一次成功即视为可用，
// 避免一次抖动就把可用模型误判为失败。
const healthCheckAttempts = 2

// healthCheckFastFailStatuses 是无需重试的确定性失败状态码：
// 权限/不存在等错误不会因重试而好转，直接判定失败以节省时间。
func healthCheckFastFailStatus(statusCode int) bool {
	switch statusCode {
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound,
		http.StatusBadRequest, http.StatusMethodNotAllowed, http.StatusNotImplemented:
		return true
	}
	return false
}

func (s *Service) healthCheckSingleModel(ctx context.Context, endpointID, baseURL, apiKey, model string, timeout time.Duration, pool []string, headers ...[]HeaderItem) HealthRecord {
	startTime := time.Now()
	record := HealthRecord{
		Model:     model,
		Status:    "failed",
		CheckedAt: startTime.Format(time.RFC3339),
	}

	reqURL := fmt.Sprintf("%s/chat/completions", strings.TrimSuffix(baseURL, "/"))

	// 端点配置了代理池时，健康检测与真实转发走同一出口（池内代理），
	// 避免检测请求从网关本机直连出口（出口 IP 不属于代理池）。
	client := s.client
	if len(pool) > 0 {
		poolClient, _ := s.auxClientForPool(endpointID, pool)
		if poolClient != nil {
			client = poolClient
		}
	}

	// 请求体模拟真实客户端常用字段，降低上游对缺字段请求的兼容性误判。
	payload := map[string]interface{}{
		"model":      model,
		"messages":   []map[string]string{{"role": "user", "content": "Reply with any short non-empty text."}},
		"stream":     false,
		"max_tokens": 1,
		"temperature": 0,
	}
	bodyBytes, _ := json.Marshal(payload)

	lastLatency := int64(0)
	var lastError string
	for attempt := 0; attempt < healthCheckAttempts; attempt++ {
		if attempt > 0 {
			// 重试前等待一小段退避，避免在限流窗口内反复撞墙。
			select {
			case <-ctx.Done():
				break
			case <-time.After(300 * time.Millisecond):
			}
		}

		childCtx, cancel := context.WithTimeout(ctx, timeout)
		httpReq, err := http.NewRequestWithContext(childCtx, "POST", reqURL, bytes.NewReader(bodyBytes))
		if err != nil {
			cancel()
			record.Error = err.Error()
			record.Latency = time.Since(startTime).Milliseconds()
			return record
		}
		httpReq.Header.Set("Authorization", "Bearer "+apiKey)
		httpReq.Header.Set("Content-Type", "application/json")
		httpReq.Header.Set("Accept", "application/json, text/event-stream")
		if len(headers) > 0 {
			applyCustomHeaders(httpReq, headers[0])
		}

		resp, err := client.Do(httpReq)
		if err != nil {
			cancel()
			lastLatency = time.Since(startTime).Milliseconds()
			if childCtx.Err() != nil {
				lastError = "超时"
			} else {
				lastError = err.Error()
			}
			continue
		}
		lastLatency = time.Since(startTime).Milliseconds()
		record.StatusCode = resp.StatusCode

		// 状态码优先：2xx 视为可用（仅校验显式 error 结构），
		// 4xx 确定性失败立即返回，其余（429/5xx）进入下一轮重试。
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			// 2xx 响应只校验是否携带显式 error 结构（部分上游会返回 200 + {"error": ...}）。
			// 空响应体、SSE、纯文本等一律视为有效，避免误伤兼容端点。
			// 只读前 4KB 判定，不等待完整响应体（生成慢的模型等完整 body 会浪费数秒）。
			sniff, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
			resp.Body.Close()
			cancel()
			if errMsg := healthCheckBodyError(sniff); errMsg != "" {
				lastError = errMsg
				continue
			}
			record.Latency = lastLatency
			if time.Duration(lastLatency)*time.Millisecond <= degradedThreshold {
				record.Status = "operational"
			} else {
				record.Status = "degraded"
			}
			return record
		}

		resp.Body.Close()
		cancel()
		if healthCheckFastFailStatus(resp.StatusCode) {
			record.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
			record.Latency = lastLatency
			return record
		}
		lastError = fmt.Sprintf("HTTP %d", resp.StatusCode)
	}

	record.Error = lastError
	record.Latency = lastLatency
	return record
}

// healthCheckBodyError 在 2xx 响应中探测明确的错误结构（如 {"error": {"message": "..."}}），
// 未发现错误时返回空字符串。兼容 JSON、SSE（data: 行）与纯文本响应。
func healthCheckBodyError(body []byte) string {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return ""
	}

	if strings.HasPrefix(trimmed, "data:") {
		for _, line := range strings.Split(trimmed, "\n") {
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if payload == "" || payload == "[DONE]" {
				continue
			}
			if msg := healthCheckBodyError([]byte(payload)); msg != "" {
				return msg
			}
		}
		return ""
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil {
		return ""
	}
	switch errValue := parsed["error"].(type) {
	case map[string]interface{}:
		if message, ok := errValue["message"].(string); ok && strings.TrimSpace(message) != "" {
			return strings.TrimSpace(message)
		}
	case string:
		if strings.TrimSpace(errValue) != "" {
			return strings.TrimSpace(errValue)
		}
	}
	return ""
}

func (s *Service) runBatchHealthCheck(ctx context.Context, endpointID, baseURL, apiKey string, models []string, timeout time.Duration, concurrency int, pool []string, headers ...[]HeaderItem) HealthSummary {
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

			res := s.healthCheckSingleModel(ctx, endpointID, baseURL, apiKey, m, timeout, pool, headers...)

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

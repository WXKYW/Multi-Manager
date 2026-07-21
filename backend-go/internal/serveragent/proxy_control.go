package serveragent

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/iwvw/api-monitor/backend-go/internal/response"
	"github.com/iwvw/api-monitor/backend-go/internal/secure"
)

type proxyDesiredState struct {
	ServerID        string `json:"server_id"`
	Revision        int64  `json:"revision"`
	Runtime         string `json:"runtime"`
	Config          string `json:"config"`
	Enabled         bool   `json:"enabled"`
	AppliedRevision int64  `json:"applied_revision"`
	ApplyStatus     string `json:"apply_status"`
	LastError       string `json:"last_error,omitempty"`
	AssignedPort    int    `json:"assigned_port"`
	Transport       string `json:"transport"`
	UpdatedAt       string `json:"updated_at"`
}

func (s *Service) getProxyDesiredState(w http.ResponseWriter, r *http.Request, db *sql.DB, serverID string) {
	state, err := loadProxyDesiredState(r, db, serverID)
	if errors.Is(err, sql.ErrNoRows) {
		response.OK(w, nil)
		return
	}
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, state)
}

func (s *Service) putProxyDesiredState(w http.ResponseWriter, r *http.Request, db *sql.DB, serverID string) {
	var input struct {
		Runtime string `json:"runtime"`
		Config  string `json:"config"`
		Enabled bool   `json:"enabled"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&input); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid proxy desired state")
		return
	}
	runtime, ok := normalizeProxyRuntime(input.Runtime)
	if !ok {
		response.Error(w, http.StatusBadRequest, "runtime must be xray or sing-box")
		return
	}
	if !json.Valid([]byte(input.Config)) {
		response.Error(w, http.StatusBadRequest, "proxy config must be valid JSON")
		return
	}
	requestedPort, transport, err := managedProxyBinding(input.Config)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	encrypted, err := secure.SecureEncrypt(input.Config)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	var revision int64
	err = db.QueryRowContext(r.Context(), `INSERT INTO server_proxy_desired_state
		(server_id, revision, runtime, config_encrypted, enabled, assigned_port, transport, apply_status, last_error, updated_at)
		VALUES (?, 1, ?, ?, ?, ?, ?, 'pending', '', datetime('now'))
		ON CONFLICT(server_id) DO UPDATE SET revision = server_proxy_desired_state.revision + 1,
			runtime = excluded.runtime, config_encrypted = excluded.config_encrypted, enabled = excluded.enabled,
			assigned_port = CASE WHEN server_proxy_desired_state.transport = excluded.transport THEN server_proxy_desired_state.assigned_port ELSE excluded.assigned_port END,
			transport = excluded.transport,
			apply_status = 'pending', last_error = '', updated_at = datetime('now')
		RETURNING revision`, serverID, runtime, encrypted, boolToInt(input.Enabled), requestedPort, transport).Scan(&revision)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, map[string]interface{}{"server_id": serverID, "revision": revision, "status": "pending"})
}

func managedProxyBinding(raw string) (int, string, error) {
	var root struct {
		Inbounds []map[string]interface{} `json:"inbounds"`
	}
	if err := json.Unmarshal([]byte(raw), &root); err != nil || len(root.Inbounds) != 1 {
		return 0, "", errors.New("managed proxy config must contain exactly one inbound")
	}
	inbound := root.Inbounds[0]
	protocol := strings.ToLower(strings.TrimSpace(firstProxyString(inbound, "type", "protocol")))
	transport := "tcp"
	if protocol == "hysteria2" || protocol == "hy2" {
		transport = "udp"
	}
	port := 0
	if value, ok := inbound["port"].(float64); ok && value >= 45654 && value <= 55654 {
		port = int(value)
	}
	return port, transport, nil
}

func firstProxyString(values map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		if value, ok := values[key].(string); ok && strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func (s *Service) reconcileProxyDesiredState(w http.ResponseWriter, r *http.Request, db *sql.DB, serverID string) {
	state, err := loadProxyDesiredState(r, db, serverID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			response.Error(w, http.StatusNotFound, "proxy desired state not found")
		} else {
			response.Error(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	payload, _ := json.Marshal(map[string]interface{}{
		"node_id": state.ServerID, "revision": state.Revision, "runtime": state.Runtime, "config": state.Config, "enabled": state.Enabled,
		"requested_port": state.AssignedPort, "port_min": 45654, "port_max": 55654, "transport": state.Transport,
	})
	release, ok := managedProxyRuntime(state.Runtime)
	if !ok {
		response.Error(w, http.StatusInternalServerError, "managed proxy runtime is not pinned")
		return
	}
	var payloadMap map[string]interface{}
	_ = json.Unmarshal(payload, &payloadMap)
	payloadMap["runtime_version"] = release.Version
	payloadMap["asset_url_amd64"] = release.AMD64URL
	payloadMap["asset_sha256_amd64"] = release.AMD64SHA256
	payloadMap["asset_url_arm64"] = release.ARM64URL
	payloadMap["asset_sha256_arm64"] = release.ARM64SHA256
	payload, _ = json.Marshal(payloadMap)
	result, runErr := s.RunProxyRuntimeTaskAndWait(serverID, string(payload))
	status, lastError := "applied", ""
	if runErr != nil {
		status, lastError = "failed", runErr.Error()
	}
	_, _ = db.ExecContext(r.Context(), `UPDATE server_proxy_desired_state SET applied_revision = CASE WHEN ? = 'applied' THEN revision ELSE applied_revision END, apply_status = ?, last_error = ?, updated_at = datetime('now') WHERE server_id = ?`, status, status, lastError, serverID)
	if runErr != nil {
		response.Error(w, http.StatusBadGateway, runErr.Error())
		return
	}
	var applied struct {
		AssignedPort int    `json:"assigned_port"`
		Transport    string `json:"transport"`
		Config       string `json:"config"`
	}
	if json.Unmarshal([]byte(result), &applied) == nil && applied.AssignedPort >= 45654 && applied.AssignedPort <= 55654 {
		if applied.Transport != "udp" {
			applied.Transport = "tcp"
		}
		if applied.Config != "" && json.Valid([]byte(applied.Config)) {
			if encrypted, encryptErr := secure.SecureEncrypt(applied.Config); encryptErr == nil {
				_, _ = db.ExecContext(r.Context(), `UPDATE server_proxy_desired_state SET assigned_port = ?, transport = ?, config_encrypted = ? WHERE server_id = ?`, applied.AssignedPort, applied.Transport, encrypted, serverID)
			}
		} else {
			_, _ = db.ExecContext(r.Context(), `UPDATE server_proxy_desired_state SET assigned_port = ?, transport = ? WHERE server_id = ?`, applied.AssignedPort, applied.Transport, serverID)
		}
	}
	response.OK(w, map[string]interface{}{"server_id": serverID, "revision": state.Revision, "status": status, "result": result})
}

func (s *Service) recordProxyTraffic(w http.ResponseWriter, r *http.Request, db *sql.DB, serverID string) {
	provided := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if err := s.validateAgentKeyForServer(r.Context(), db, serverID, provided); err != nil {
		response.Error(w, http.StatusUnauthorized, "invalid agent credential")
		return
	}
	var input struct {
		BootID        string `json:"boot_id"`
		Sequence      int64  `json:"sequence"`
		NodeID        string `json:"node_id"`
		UploadBytes   int64  `json:"upload_bytes"`
		DownloadBytes int64  `json:"download_bytes"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&input); err != nil || input.BootID == "" || input.Sequence < 0 || input.NodeID == "" || input.UploadBytes < 0 || input.DownloadBytes < 0 {
		response.Error(w, http.StatusBadRequest, "invalid proxy traffic report")
		return
	}
	result, err := db.ExecContext(r.Context(), `INSERT OR IGNORE INTO server_proxy_traffic_reports
		(server_id, boot_id, sequence, node_id, upload_bytes, download_bytes, reported_at)
		VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`, serverID, input.BootID, input.Sequence, input.NodeID, input.UploadBytes, input.DownloadBytes)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	rows, _ := result.RowsAffected()
	response.OK(w, map[string]interface{}{"accepted": rows == 1, "duplicate": rows == 0})
}

func loadProxyDesiredState(r *http.Request, db *sql.DB, serverID string) (proxyDesiredState, error) {
	var state proxyDesiredState
	var encrypted string
	var enabled int
	err := db.QueryRowContext(r.Context(), `SELECT server_id, revision, runtime, config_encrypted, enabled, applied_revision, apply_status, last_error, COALESCE(assigned_port, 0), COALESCE(transport, 'tcp'), updated_at FROM server_proxy_desired_state WHERE server_id = ?`, serverID).
		Scan(&state.ServerID, &state.Revision, &state.Runtime, &encrypted, &enabled, &state.AppliedRevision, &state.ApplyStatus, &state.LastError, &state.AssignedPort, &state.Transport, &state.UpdatedAt)
	state.Enabled = enabled == 1
	state.Config = secure.SecureDecrypt(encrypted)
	return state, err
}

func normalizeProxyRuntime(value string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "xray", "singbox", "sing-box", "":
		return "sing-box", true
	default:
		return "", false
	}
}

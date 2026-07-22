package serveragent

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/iwvw/api-monitor/backend-go/internal/response"
)

type managedProxyRuntimeState struct {
	ServerID        string `json:"server_id"`
	ServerName      string `json:"server_name"`
	Runtime         string `json:"runtime"`
	Version         string `json:"version"`
	DesiredStatus   string `json:"desired_status"`
	ApplyStatus     string `json:"apply_status"`
	LastStage       string `json:"last_stage"`
	LastError       string `json:"last_error"`
	ObservedStatus  string `json:"observed_status"`
	ObservedVersion string `json:"observed_version"`
	ObservedAt      string `json:"observed_at"`
	InstalledAt     string `json:"installed_at"`
	UpdatedAt       string `json:"updated_at"`
}

func (s *Service) handleManagedProxyRuntimeRoutes(w http.ResponseWriter, r *http.Request, db *sql.DB, parts []string) {
	switch {
	case len(parts) == 0 && r.Method == http.MethodGet:
		rows, err := db.QueryContext(r.Context(), `SELECT rt.server_id,COALESCE(a.name,''),rt.runtime,rt.version,rt.desired_status,rt.apply_status,rt.last_stage,rt.last_error,rt.observed_status,rt.observed_version,COALESCE(rt.observed_at,''),COALESCE(rt.installed_at,''),rt.updated_at FROM managed_proxy_runtimes rt LEFT JOIN server_accounts a ON a.id=rt.server_id ORDER BY a.name ASC`)
		if err != nil {
			response.Error(w, 500, err.Error())
			return
		}
		defer rows.Close()
		items := []managedProxyRuntimeState{}
		for rows.Next() {
			var item managedProxyRuntimeState
			if err := rows.Scan(&item.ServerID, &item.ServerName, &item.Runtime, &item.Version, &item.DesiredStatus, &item.ApplyStatus, &item.LastStage, &item.LastError, &item.ObservedStatus, &item.ObservedVersion, &item.ObservedAt, &item.InstalledAt, &item.UpdatedAt); err != nil {
				response.Error(w, 500, err.Error())
				return
			}
			items = append(items, item)
		}
		response.OK(w, items)
	case len(parts) == 2 && parts[1] == "install" && r.Method == http.MethodPost:
		s.startManagedProxyRuntimeTask(w, r, db, parts[0], "install_runtime")
	case len(parts) == 2 && parts[1] == "uninstall" && r.Method == http.MethodPost:
		var count int
		if err := db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM managed_proxy_nodes WHERE server_id=?`, parts[0]).Scan(&count); err != nil {
			response.Error(w, 500, err.Error())
			return
		}
		if count > 0 {
			response.Error(w, http.StatusConflict, "remove managed nodes before uninstalling sing-box")
			return
		}
		s.startManagedProxyRuntimeTask(w, r, db, parts[0], "remove_runtime")
	default:
		response.Error(w, http.StatusNotFound, "managed proxy runtime route not found")
	}
}

func (s *Service) startManagedProxyRuntimeTask(w http.ResponseWriter, r *http.Request, db *sql.DB, serverID, operation string) {
	var serverName string
	if err := db.QueryRowContext(r.Context(), `SELECT name FROM server_accounts WHERE id=?`, serverID).Scan(&serverName); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			response.Error(w, 404, "server not found")
		} else {
			response.Error(w, 500, err.Error())
		}
		return
	}
	if !s.requireAgentCapability(w, serverID, "proxy_runtime_lifecycle_v2") {
		return
	}
	desired := "running"
	if operation == "remove_runtime" {
		desired = "removed"
	}
	task, ok := s.createExclusiveProxyTask(w, serverID, "proxy.runtime."+operation, operation)
	if !ok {
		return
	}
	_, err := db.ExecContext(r.Context(), `INSERT INTO managed_proxy_runtimes(server_id,runtime,desired_status,apply_status,last_stage,last_error,updated_at) VALUES(?,'sing-box',?,'pending','queued','',datetime('now')) ON CONFLICT(server_id) DO UPDATE SET desired_status=excluded.desired_status,apply_status='pending',last_stage='queued',last_error='',updated_at=datetime('now')`, serverID, desired)
	if err != nil {
		s.taskRegistry.Fail(task.ID, err.Error())
		response.Error(w, 500, err.Error())
		return
	}
	response.JSON(w, http.StatusAccepted, map[string]interface{}{"success": true, "data": map[string]interface{}{"task_id": task.ID, "status": task.Status, "server_id": serverID}})
	go s.runManagedProxyRuntimeTask(task.ID, serverID, serverName, operation)
}

func (s *Service) runManagedProxyRuntimeTask(taskID, serverID, serverName, operation string) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	db, err := s.open(ctx)
	if err != nil {
		s.taskRegistry.Fail(taskID, err.Error())
		return
	}
	defer db.Close()
	fail := func(stage string, cause error) {
		_, _ = db.ExecContext(context.Background(), `UPDATE managed_proxy_runtimes SET apply_status='failed',last_stage=?,last_error=?,updated_at=datetime('now') WHERE server_id=?`, stage, cause.Error(), serverID)
		s.taskRegistry.Fail(taskID, cause.Error())
	}
	progress := func(value int, stage, message string) {
		_, _ = db.ExecContext(ctx, `UPDATE managed_proxy_runtimes SET last_stage=?,last_error='',updated_at=datetime('now') WHERE server_id=?`, stage, serverID)
		s.taskRegistry.UpdateProgress(taskID, value, map[string]interface{}{"stage": stage, "message": message, "server_id": serverID, "server_name": serverName})
	}
	release, ok := managedProxyRuntime("sing-box")
	if !ok {
		fail("catalog", errors.New("managed proxy runtime is not pinned"))
		return
	}
	progress(10, "preflight", "正在检查系统架构与 Agent 连接")
	payload, _ := json.Marshal(map[string]interface{}{
		"operation": operation, "node_id": "runtime-" + serverID, "revision": 1,
		"runtime": release.Runtime, "runtime_version": release.Version,
		"asset_url_amd64": release.AMD64URL, "asset_sha256_amd64": release.AMD64SHA256,
		"asset_url_arm64": release.ARM64URL, "asset_sha256_arm64": release.ARM64SHA256,
		"config": `{}`, "enabled": false, "port_min": 45654, "port_max": 55654, "transport": "tcp",
	})
	if operation == "install_runtime" {
		progress(30, "download", "正在下载并校验 sing-box")
	} else {
		progress(30, "remove", "正在卸载 sing-box 运行时")
	}
	if _, err := s.RunProxyRuntimeTaskAndWait(serverID, string(payload)); err != nil {
		fail("agent_apply", err)
		return
	}
	if operation == "remove_runtime" {
		_, _ = db.ExecContext(ctx, `DELETE FROM managed_proxy_runtimes WHERE server_id=?`, serverID)
		progress(95, "removed", "代理程序已卸载")
		s.taskRegistry.Complete(taskID, serverName+" 的 sing-box 已卸载")
		return
	}
	progress(85, "verify", "正在验证 sing-box 版本与可执行状态")
	_, _ = db.ExecContext(ctx, `UPDATE managed_proxy_runtimes SET version=?,desired_status='running',apply_status='running',last_stage='ready',last_error='',observed_status='installed',observed_version=?,observed_at=datetime('now'),installed_at=COALESCE(installed_at,datetime('now')),updated_at=datetime('now') WHERE server_id=?`, release.Version, release.Version, serverID)
	s.taskRegistry.Complete(taskID, serverName+" 的 sing-box "+release.Version+" 已就绪")
}

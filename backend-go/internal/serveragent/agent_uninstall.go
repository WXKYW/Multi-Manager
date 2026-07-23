package serveragent

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/iwvw/api-monitor/backend-go/internal/response"
)

const defaultAgentUninstallVerifyTimeout = 45 * time.Second

// handleAgentUninstall handles POST /api/server/agent/uninstall/{id}
func (s *Service) handleAgentUninstall(w http.ResponseWriter, r *http.Request, db *sql.DB, accountID string) {
	var exists int
	if err := db.QueryRowContext(r.Context(), `SELECT 1 FROM server_accounts WHERE id=?`, accountID).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			response.Error(w, http.StatusNotFound, "主机不存在")
		} else {
			response.Error(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	dependencies, err := loadAccountDeleteDependencies(r.Context(), db, accountID)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if dependencies.Nodes > 0 || dependencies.Runtimes > 0 || dependencies.Tunnels > 0 {
		response.JSON(w, http.StatusConflict, map[string]interface{}{
			"success": false,
			"error":   "该主机仍有托管节点、代理程序或 Tunnel；请使用删除主机的安全级联流程，或先卸载这些代理资源",
			"data": map[string]interface{}{
				"server_id":    accountID,
				"dependencies": dependencies.responseData(),
			},
		})
		return
	}

	forceDetach := r.URL.Query().Get("force") == "1" || strings.EqualFold(r.URL.Query().Get("force"), "true")
	connection, online := s.registry.Get(accountID)
	if !forceDetach {
		if !online {
			response.JSON(w, http.StatusConflict, map[string]interface{}{
				"success": false,
				"error":   "Agent 离线，无法从主机卸载；可仅断开面板关联",
				"data": map[string]interface{}{
					"can_force_detach": true,
					"server_id":        accountID,
				},
			})
			return
		}
		if !connection.GetCapabilities()["self_uninstall_v1"] {
			response.JSON(w, http.StatusConflict, map[string]interface{}{
				"success": false,
				"error":   "Agent 版本过旧，不支持安全自卸载，请先升级 Agent",
				"data": map[string]interface{}{
					"can_force_detach": true,
					"server_id":        accountID,
				},
			})
			return
		}
		if _, err := s.uninstallAgentAndWait(r.Context(), accountID); err != nil {
			response.Error(w, http.StatusBadGateway, "Agent 卸载失败: "+err.Error())
			return
		}
	}

	if err := s.markAgentUninstalled(r.Context(), db, accountID); err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to update server status: "+err.Error())
		return
	}

	message := "Agent 已从主机卸载"
	if forceDetach {
		message = "Agent 面板关联已断开；未确认主机本地程序已清理"
	}
	response.OK(w, map[string]interface{}{
		"success": true,
		"message": message,
	})
}

// uninstallAgentAndWait does not treat the detached uninstall helper's task
// acknowledgement as completion. The Agent connection must disappear before
// callers can remove the host record and its credentials.
func (s *Service) uninstallAgentAndWait(ctx context.Context, accountID string) (string, error) {
	result, err := s.RunAgentSelfUninstallTaskAndWait(accountID)
	if err != nil {
		return "", err
	}
	if err := s.waitForAgentDisconnect(ctx, accountID, agentUninstallVerifyTimeout()); err != nil {
		return "", err
	}
	return result, nil
}

func (s *Service) waitForAgentDisconnect(ctx context.Context, accountID string, timeout time.Duration) error {
	if _, online := s.registry.Get(accountID); !online {
		return nil
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return fmt.Errorf("Agent 已接受卸载任务，但未在 %s 内断开连接", formatBatchDuration(timeout))
		case <-ticker.C:
			if _, online := s.registry.Get(accountID); !online {
				return nil
			}
		}
	}
}

func agentUninstallVerifyTimeout() time.Duration {
	return envDurationMs("API_MONITOR_AGENT_UNINSTALL_VERIFY_TIMEOUT_MS", defaultAgentUninstallVerifyTimeout)
}

func (s *Service) markAgentUninstalled(ctx context.Context, db *sql.DB, accountID string) error {
	if s.presence != nil {
		s.presence.suppress(accountID, 10*time.Minute)
		s.presence.recordDisconnect(accountID, "uninstalled")
	}
	_, err := db.ExecContext(ctx, `UPDATE server_accounts SET status = 'offline', last_check_status = 'uninstalled', updated_at=datetime('now') WHERE id = ?`, accountID)
	if err != nil {
		return err
	}

	if _, exists := s.registry.Get(accountID); exists {
		s.registry.Disconnect(accountID)
		if s.metricsHub != nil {
			s.metricsHub.BroadcastServerStatus(accountID, "offline", false)
		}
	}
	return nil
}

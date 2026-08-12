package serveragent

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/iwvw/api-monitor/backend-go/internal/response"
)

// getAgentInstallCommand returns Agent install commands for the frontend modal.
func (s *Service) getAgentInstallCommand(w http.ResponseWriter, r *http.Request, db *sql.DB, accountID string) {
	var name, host string
	var port int
	err := db.QueryRowContext(r.Context(), "SELECT name, host, port FROM server_accounts WHERE id = ?", accountID).Scan(&name, &host, &port)
	if err == sql.ErrNoRows {
		response.Error(w, http.StatusNotFound, "Account not found")
		return
	}
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	agentKey, err := s.getOrGenerateAgentKeyForServer(r.Context(), db, accountID)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "Failed to get agent key: "+err.Error())
		return
	}

	proto, serverURL := s.resolveInstallOrigin(r.Context(), db, r, "")
	baseURL := fmt.Sprintf("%s://%s", proto, serverURL)
	installScriptURL := appendInstallProtocol(fmt.Sprintf("%s/api/server/agent/install/linux/%s/%s", baseURL, accountID, agentKey), proto)
	winInstallURL := appendInstallProtocol(fmt.Sprintf("%s/api/server/agent/install/win/%s/%s", baseURL, accountID, agentKey), proto)

	installCommand := fmt.Sprintf(`curl -fsSL %s | bash`, installScriptURL)
	winInstallCommand := fmt.Sprintf(`powershell -c "irm %s | iex"`, winInstallURL)
	manualCommand := fmt.Sprintf(`# Download and run Agent
wget %s -O install-agent.sh
chmod +x install-agent.sh
sudo ./install-agent.sh`, installScriptURL)

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"data": map[string]interface{}{
			"serverName":        name,
			"serverHost":        host,
			"serverPort":        port,
			"serverId":          accountID,
			"agentKey":          agentKey,
			"baseUrl":           baseURL,
			"apiUrl":            baseURL,
			"installScriptUrl":  installScriptURL,
			"installCommand":    installCommand,
			"winInstallCommand": winInstallCommand,
			"manualCommand":     manualCommand,
			"curlCommand":       installCommand,
			"timestamp":         time.Now().Format("2006-01-02 15:04:05"),
		},
	})
}

// handleAgentExecCommand POST /api/server/agent/command/{id} 向在线 Agent 下发
// shell 命令并同步等待执行结果。复用 RUN_COMMAND（type=1）任务链路与危险命令检测。
func (s *Service) handleAgentExecCommand(w http.ResponseWriter, r *http.Request, db *sql.DB, serverID string) {
	var req struct {
		Command string `json:"command"`
		Timeout int    `json:"timeout"` // 秒，可选
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body")
		return
	}
	command := strings.TrimSpace(req.Command)
	if command == "" {
		response.Error(w, http.StatusBadRequest, "command required")
		return
	}

	// 危险命令拦截
	danger := DetectDangerousCommand(command)
	if danger.Dangerous {
		response.JSON(w, http.StatusBadRequest, map[string]interface{}{
			"success":       false,
			"error":         "dangerous command rejected: " + strings.Join(danger.Reasons, ", "),
			"dangerous":     true,
			"dangerReasons": danger.Reasons,
		})
		return
	}

	// 超时：默认 30s，上限 300s
	timeout := defaultExecTimeout
	if req.Timeout > 0 {
		timeout = time.Duration(req.Timeout) * time.Second
	}
	if timeout > maxExecTimeout {
		timeout = maxExecTimeout
	}

	conn, online := s.registry.Get(serverID)
	if !online {
		response.Error(w, http.StatusBadGateway, "agent offline: "+serverID)
		return
	}

	task := s.taskRegistry.Create(serverID, "shell", command)
	eventCh := task.Subscribe()

	if err := conn.SendEvent("dashboard:task", map[string]interface{}{
		"id":      task.ID,
		"type":    1, // RUN_COMMAND
		"data":    command,
		"timeout": int(timeout.Seconds()),
	}); err != nil {
		s.taskRegistry.Fail(task.ID, err.Error())
		response.Error(w, http.StatusBadGateway, "failed to send task to agent: "+err.Error())
		return
	}

	output, status, timedOut := waitAgentTaskResult(s.taskRegistry, task, eventCh, timeout)
	if timedOut {
		// 任务已下发且不可取消：超时后 Agent 端命令仍会继续执行到完成，
		// 记录超时历史并提示调用方用 task_id 跟踪后续终态。
		s.recordExecCommandHistory(r.Context(), db, serverID, command, "timeout", "task timeout after "+timeout.String())
		response.JSON(w, http.StatusGatewayTimeout, map[string]interface{}{
			"success": false,
			"error":   "task timeout after " + timeout.String() + "；命令可能仍在 Agent 上执行，可凭 task_id 查询任务终态",
			"task_id": task.ID,
		})
		return
	}

	// 记录命令历史（复用片段历史写入逻辑，executionMode=api）
	s.recordExecCommandHistory(r.Context(), db, serverID, command, status, output)

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"success": status == "success",
		"output":  output,
		"task_id": task.ID,
		"status":  status,
	})
}

// recordExecCommandHistory 将 API 发起的命令执行写入命令历史表
func (s *Service) recordExecCommandHistory(ctx context.Context, db *sql.DB, serverID, command, status, output string) {
	summary := output
	if len(summary) > 500 {
		summary = summary[:500]
	}
	_, _, _ = s.insertSnippetHistory(ctx, db, nil, &serverID, command, command, "api", status, &summary)
}

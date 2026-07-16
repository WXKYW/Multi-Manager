package serveragent

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/iwvw/api-monitor/backend-go/internal/applog"
	"github.com/iwvw/api-monitor/backend-go/internal/response"
)

const (
	remoteDesktopSessionTTL = 30 * time.Minute
	remoteDesktopSignalTTL  = 2 * time.Minute
	remoteDesktopMaxSignals = 256
)

type remoteDesktopSignal struct {
	ID        int64           `json:"id"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt int64           `json:"createdAt"`
}

type remoteDesktopSession struct {
	ID           string
	ServerID     string
	AgentSocket  interface{}
	CreatedAt    time.Time
	ExpiresAt    time.Time
	LastActivity time.Time
	State        string
	Signals      []remoteDesktopSignal
	NextSignalID int64
	Notify       chan struct{}
}

type remoteDesktopManager struct {
	mu       sync.Mutex
	sessions map[string]*remoteDesktopSession
}

func newRemoteDesktopManager() *remoteDesktopManager {
	return &remoteDesktopManager{sessions: make(map[string]*remoteDesktopSession)}
}

func (m *remoteDesktopManager) create(serverID string, agentSocket interface{}) *remoteDesktopSession {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cleanupLocked(time.Now())
	for id, session := range m.sessions {
		if session.ServerID == serverID {
			delete(m.sessions, id)
		}
	}
	now := time.Now()
	session := &remoteDesktopSession{
		ID:           uuid.NewString(),
		ServerID:     serverID,
		AgentSocket:  agentSocket,
		CreatedAt:    now,
		ExpiresAt:    now.Add(remoteDesktopSessionTTL),
		LastActivity: now,
		State:        "connecting",
		Notify:       make(chan struct{}, 1),
	}
	m.sessions[session.ID] = session
	return session
}

func (m *remoteDesktopManager) get(id string) (*remoteDesktopSession, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cleanupLocked(time.Now())
	session, ok := m.sessions[id]
	return session, ok
}

func (m *remoteDesktopManager) appendAgentSignal(id, serverID string, payload json.RawMessage) bool {
	if len(payload) == 0 || len(payload) > 128*1024 {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cleanupLocked(time.Now())
	session, ok := m.sessions[id]
	if !ok || session.ServerID != serverID {
		return false
	}
	session.NextSignalID++
	now := time.Now()
	session.LastActivity = now
	session.Signals = append(session.Signals, remoteDesktopSignal{
		ID:        session.NextSignalID,
		Payload:   append(json.RawMessage(nil), payload...),
		CreatedAt: now.UnixMilli(),
	})
	if len(session.Signals) > remoteDesktopMaxSignals {
		session.Signals = append([]remoteDesktopSignal(nil), session.Signals[len(session.Signals)-remoteDesktopMaxSignals:]...)
	}
	notifyRemoteDesktopSession(session)
	return true
}

func (m *remoteDesktopManager) setState(id, serverID, state string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cleanupLocked(time.Now())
	session, ok := m.sessions[id]
	if !ok || session.ServerID != serverID {
		return false
	}
	state = strings.TrimSpace(state)
	if state != "" {
		session.State = state
	}
	session.LastActivity = time.Now()
	notifyRemoteDesktopSession(session)
	return true
}

func (m *remoteDesktopManager) waitSignals(id string, since int64, wait time.Duration) ([]remoteDesktopSignal, string, bool) {
	signals, state, ok := m.signals(id, since)
	if !ok || len(signals) > 0 || wait <= 0 {
		return signals, state, ok
	}
	m.mu.Lock()
	session, ok := m.sessions[id]
	var notify <-chan struct{}
	if ok {
		notify = session.Notify
	}
	m.mu.Unlock()
	if !ok {
		return nil, "", false
	}
	select {
	case <-notify:
	case <-time.After(wait):
	}
	return m.signals(id, since)
}

func notifyRemoteDesktopSession(session *remoteDesktopSession) {
	if session == nil || session.Notify == nil {
		return
	}
	select {
	case session.Notify <- struct{}{}:
	default:
	}
}

func (m *remoteDesktopManager) signals(id string, since int64) ([]remoteDesktopSignal, string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cleanupLocked(time.Now())
	session, ok := m.sessions[id]
	if !ok {
		return nil, "", false
	}
	session.LastActivity = time.Now()
	out := make([]remoteDesktopSignal, 0)
	for _, signal := range session.Signals {
		if signal.ID > since {
			out = append(out, signal)
		}
	}
	return out, session.State, true
}

func (m *remoteDesktopManager) remove(id string) (*remoteDesktopSession, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	session, ok := m.sessions[id]
	if ok {
		delete(m.sessions, id)
	}
	return session, ok
}

func (m *remoteDesktopManager) cleanupLocked(now time.Time) {
	for id, session := range m.sessions {
		if now.After(session.ExpiresAt) || now.Sub(session.LastActivity) > remoteDesktopSessionTTL {
			delete(m.sessions, id)
			continue
		}
		cutoff := now.Add(-remoteDesktopSignalTTL).UnixMilli()
		first := 0
		for first < len(session.Signals) && session.Signals[first].CreatedAt < cutoff {
			first++
		}
		if first > 0 {
			session.Signals = append([]remoteDesktopSignal(nil), session.Signals[first:]...)
		}
	}
}

type remoteDesktopCreateRequest struct {
	ServerID string          `json:"serverId"`
	Offer    json.RawMessage `json:"offer"`
}

type remoteDesktopBrowserSignalRequest struct {
	Signal json.RawMessage `json:"signal"`
}

func (s *Service) handleRemoteDesktopRoutes(w http.ResponseWriter, r *http.Request, parts []string) {
	if s.remoteDesktop == nil {
		s.remoteDesktop = newRemoteDesktopManager()
	}
	switch {
	case len(parts) == 1 && parts[0] == "sessions" && r.Method == http.MethodPost:
		s.createRemoteDesktopSession(w, r)
	case len(parts) == 2 && parts[0] == "sessions" && r.Method == http.MethodGet:
		s.getRemoteDesktopSession(w, r, parts[1])
	case len(parts) == 2 && parts[0] == "sessions" && r.Method == http.MethodDelete:
		s.closeRemoteDesktopSession(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "sessions" && parts[2] == "signals" && r.Method == http.MethodGet:
		s.getRemoteDesktopSignals(w, r, parts[1])
	case len(parts) == 3 && parts[0] == "sessions" && parts[2] == "signals" && r.Method == http.MethodPost:
		s.postRemoteDesktopSignal(w, r, parts[1])
	default:
		response.Error(w, http.StatusNotFound, "remote desktop route not found")
	}
}

func (s *Service) createRemoteDesktopSession(w http.ResponseWriter, r *http.Request) {
	var req remoteDesktopCreateRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 160*1024))
	if err := decoder.Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid remote desktop request")
		return
	}
	req.ServerID = strings.TrimSpace(req.ServerID)
	if req.ServerID == "" || len(req.Offer) == 0 {
		response.Error(w, http.StatusBadRequest, "serverId and offer are required")
		return
	}
	agentConn, ok := s.registry.Get(req.ServerID)
	if !ok {
		response.Error(w, http.StatusConflict, "Windows Agent is offline")
		return
	}
	metadata := agentConn.GetMetadata()
	platform := strings.ToLower(strings.TrimSpace(fmt.Sprint(metadata["platform"])))
	if !strings.Contains(platform, "windows") && platform != "windows" {
		response.Error(w, http.StatusBadRequest, "remote desktop is only available for Windows Agents")
		return
	}
	if !agentConn.GetCapabilities()["remote_desktop_v1"] {
		response.Error(w, http.StatusConflict, "Agent does not support remote desktop; upgrade it first")
		return
	}
	session := s.remoteDesktop.create(req.ServerID, agentConn.Socket)
	if err := agentConn.SendEvent("dashboard:rd_start", map[string]interface{}{
		"session_id": session.ID,
		"offer":      json.RawMessage(req.Offer),
		"ice_servers": []map[string]interface{}{
			{"urls": []string{"stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"}},
		},
	}); err != nil {
		s.remoteDesktop.remove(session.ID)
		response.Error(w, http.StatusBadGateway, "failed to start remote desktop: "+err.Error())
		return
	}
	applog.Info(r.Context(), "serveragent", "remote desktop session created", "server_id", req.ServerID, "session_id", session.ID, "remote_addr", r.RemoteAddr)
	response.OK(w, map[string]interface{}{
		"sessionId": session.ID,
		"serverId":  session.ServerID,
		"state":     session.State,
		"expiresAt": session.ExpiresAt.UnixMilli(),
	})
}

func (s *Service) getRemoteDesktopSession(w http.ResponseWriter, _ *http.Request, id string) {
	session, ok := s.remoteDesktop.get(id)
	if !ok {
		response.Error(w, http.StatusNotFound, "remote desktop session not found")
		return
	}
	response.OK(w, map[string]interface{}{
		"sessionId": session.ID,
		"serverId":  session.ServerID,
		"state":     session.State,
		"expiresAt": session.ExpiresAt.UnixMilli(),
	})
}

func (s *Service) getRemoteDesktopSignals(w http.ResponseWriter, r *http.Request, id string) {
	since, _ := parseInt64(r.URL.Query().Get("since"))
	waitMillis, _ := parseInt64(r.URL.Query().Get("wait"))
	if waitMillis < 0 {
		waitMillis = 0
	}
	if waitMillis > 20000 {
		waitMillis = 20000
	}
	signals, state, ok := s.remoteDesktop.waitSignals(id, since, time.Duration(waitMillis)*time.Millisecond)
	if !ok {
		response.Error(w, http.StatusNotFound, "remote desktop session not found")
		return
	}
	response.OK(w, map[string]interface{}{"signals": signals, "state": state})
}

func (s *Service) postRemoteDesktopSignal(w http.ResponseWriter, r *http.Request, id string) {
	session, ok := s.remoteDesktop.get(id)
	if !ok {
		response.Error(w, http.StatusNotFound, "remote desktop session not found")
		return
	}
	var req remoteDesktopBrowserSignalRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128*1024))
	if err := decoder.Decode(&req); err != nil || len(req.Signal) == 0 {
		response.Error(w, http.StatusBadRequest, "invalid remote desktop signal")
		return
	}
	agentConn, online := s.registry.Get(session.ServerID)
	if !online || agentConn.Socket != session.AgentSocket {
		response.Error(w, http.StatusConflict, "Agent connection changed or went offline")
		return
	}
	if err := agentConn.SendEvent("dashboard:rd_signal", map[string]interface{}{
		"session_id": id,
		"signal":     json.RawMessage(req.Signal),
	}); err != nil {
		response.Error(w, http.StatusBadGateway, "failed to forward remote desktop signal")
		return
	}
	response.OK(w, map[string]bool{"forwarded": true})
}

func (s *Service) closeRemoteDesktopSession(w http.ResponseWriter, r *http.Request, id string) {
	session, ok := s.remoteDesktop.remove(id)
	if !ok {
		response.OK(w, map[string]bool{"closed": true})
		return
	}
	if agentConn, online := s.registry.Get(session.ServerID); online && agentConn.Socket == session.AgentSocket {
		_ = agentConn.SendEvent("dashboard:rd_stop", map[string]string{"session_id": id})
	}
	applog.Info(r.Context(), "serveragent", "remote desktop session closed", "server_id", session.ServerID, "session_id", id, "remote_addr", r.RemoteAddr)
	response.OK(w, map[string]bool{"closed": true})
}

func (s *Service) handleRemoteDesktopAgentSignal(serverID string, data json.RawMessage) {
	var event struct {
		SessionID string          `json:"session_id"`
		Signal    json.RawMessage `json:"signal"`
		State     string          `json:"state"`
	}
	if err := json.Unmarshal(data, &event); err != nil || event.SessionID == "" {
		return
	}
	if len(event.Signal) > 0 {
		s.remoteDesktop.appendAgentSignal(event.SessionID, serverID, event.Signal)
	}
	if event.State != "" {
		s.remoteDesktop.setState(event.SessionID, serverID, event.State)
	}
}

func parseInt64(raw string) (int64, error) {
	var value int64
	_, err := fmt.Sscan(strings.TrimSpace(raw), &value)
	return value, err
}

package serveragent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRemoteDesktopManagerLongPollReceivesAgentSignal(t *testing.T) {
	manager := newRemoteDesktopManager()
	session := manager.create("windows-1", struct{}{})
	result := make(chan []remoteDesktopSignal, 1)
	go func() {
		signals, _, ok := manager.waitSignals(session.ID, 0, time.Second)
		if !ok {
			result <- nil
			return
		}
		result <- signals
	}()

	time.Sleep(20 * time.Millisecond)
	if !manager.appendAgentSignal(session.ID, "windows-1", json.RawMessage(`{"kind":"answer"}`)) {
		t.Fatal("agent signal should be accepted")
	}
	select {
	case signals := <-result:
		if len(signals) != 1 || signals[0].ID != 1 {
			t.Fatalf("unexpected signals: %#v", signals)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("long poll was not notified")
	}
}

func TestCreateRemoteDesktopSessionRequiresWindowsCapabilityAndForwardsOffer(t *testing.T) {
	registry := NewConnectionRegistry()
	t.Cleanup(registry.Stop)
	engineSession := &EngineIOSession{}
	connection := registry.Register("windows-1", engineSession)
	connection.SetMetadata("platform", "windows")
	connection.UpdateCapabilities(map[string]bool{"remote_desktop_v1": true})
	service := &Service{registry: registry, remoteDesktop: newRemoteDesktopManager()}

	req := httptest.NewRequest(http.MethodPost, "/api/server/remote-desktop/sessions", strings.NewReader(`{
		"serverId":"windows-1",
		"offer":{"type":"offer","sdp":"test-sdp"}
	}`))
	res := httptest.NewRecorder()
	service.createRemoteDesktopSession(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	engineSession.mu.RLock()
	pending := append([]string(nil), engineSession.PendingMessages...)
	engineSession.mu.RUnlock()
	if len(pending) != 1 || !strings.Contains(pending[0], `dashboard:rd_start`) || !strings.Contains(pending[0], `test-sdp`) {
		t.Fatalf("offer was not forwarded to Agent: %#v", pending)
	}

	connection.UpdateCapabilities(map[string]bool{})
	res = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/server/remote-desktop/sessions", strings.NewReader(`{"serverId":"windows-1","offer":{"type":"offer","sdp":"test"}}`))
	service.createRemoteDesktopSession(res, req)
	if res.Code != http.StatusConflict {
		t.Fatalf("Agent without capability status = %d, want %d", res.Code, http.StatusConflict)
	}
}

func TestRemoteDesktopAgentSignalIsScopedToServer(t *testing.T) {
	service := &Service{remoteDesktop: newRemoteDesktopManager()}
	session := service.remoteDesktop.create("windows-1", struct{}{})
	payload := json.RawMessage(`{"session_id":"` + session.ID + `","signal":{"kind":"ice","candidate":{"candidate":"candidate:1"}},"state":"signaling"}`)
	service.handleRemoteDesktopAgentSignal("windows-2", payload)
	signals, _, _ := service.remoteDesktop.signals(session.ID, 0)
	if len(signals) != 0 {
		t.Fatal("signal from another Agent must be rejected")
	}
	service.handleRemoteDesktopAgentSignal("windows-1", payload)
	signals, state, _ := service.remoteDesktop.signals(session.ID, 0)
	if len(signals) != 1 || state != "signaling" {
		t.Fatalf("signal/state = %#v/%q", signals, state)
	}
}

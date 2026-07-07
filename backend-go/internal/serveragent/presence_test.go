package serveragent

import (
	"context"
	"testing"
	"time"
)

func insertPresenceTestServer(t *testing.T, service *Service, serverID, status string) {
	t.Helper()
	db, err := service.open(context.Background())
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	_, err = db.ExecContext(context.Background(), `INSERT OR REPLACE INTO server_accounts
		(id, name, host, port, username, auth_type, status, monitor_mode, created_at, updated_at)
		VALUES (?, ?, ?, 22, 'agent', 'password', ?, 'agent', datetime('now'), datetime('now'))`,
		serverID, serverID, "127.0.0.1", status)
	if err != nil {
		t.Fatalf("insert server: %v", err)
	}
}

func testPresenceManager(t *testing.T, service *Service) *agentPresenceManager {
	t.Helper()
	p := newAgentPresenceManager(service)
	p.startedAt = time.Now().Add(-time.Hour)
	p.cfg.suspectAfter = 75 * time.Second
	p.cfg.offlineAfter = 180 * time.Second
	p.cfg.startupGrace = 0
	p.cfg.recoverySamples = 2
	service.presence = p
	return p
}

func TestPresenceShortDisconnectDoesNotNotifyOffline(t *testing.T) {
	service, _ := testService(t)
	notifier := &recordingNotifier{}
	service.SetNotifier(notifier)
	insertPresenceTestServer(t, service, "presence-short", "online")
	p := testPresenceManager(t, service)

	now := time.Now()
	p.mu.Lock()
	p.records["presence-short"] = &agentPresenceRecord{
		ServerID:         "presence-short",
		Status:           agentPresenceOnline,
		LastHeartbeat:    now.Add(-90 * time.Second),
		LastMetricsSeen:  now.Add(-90 * time.Second),
		RecoverySamples:  p.cfg.recoverySamples,
		ConnectionActive: true,
	}
	p.mu.Unlock()
	p.recordDisconnect("presence-short", "test_disconnect")
	p.check()

	events, _ := notifier.snapshot()
	if len(events) != 0 {
		t.Fatalf("events = %#v, want none", events)
	}
	snapshot := p.snapshot("presence-short")
	if snapshot["presence_status"] != string(agentPresenceSuspect) {
		t.Fatalf("presence_status = %#v, want suspect", snapshot["presence_status"])
	}
}

func TestPresenceOfflineNotificationFiresOnce(t *testing.T) {
	service, _ := testService(t)
	notifier := &recordingNotifier{}
	service.SetNotifier(notifier)
	insertPresenceTestServer(t, service, "presence-offline", "online")
	p := testPresenceManager(t, service)

	p.mu.Lock()
	p.records["presence-offline"] = &agentPresenceRecord{
		ServerID:         "presence-offline",
		Status:           agentPresenceOnline,
		LastHeartbeat:    time.Now().Add(-181 * time.Second),
		LastMetricsSeen:  time.Now().Add(-181 * time.Second),
		RecoverySamples:  p.cfg.recoverySamples,
		ConnectionActive: true,
	}
	p.mu.Unlock()

	p.check()
	p.check()

	events, _ := notifier.snapshot()
	if len(events) != 1 || events[0] != "offline" {
		t.Fatalf("events = %#v, want one offline", events)
	}
}

func TestPresenceRecoveryRequiresTwoSamples(t *testing.T) {
	service, _ := testService(t)
	notifier := &recordingNotifier{}
	service.SetNotifier(notifier)
	insertPresenceTestServer(t, service, "presence-recovery", "offline")
	p := testPresenceManager(t, service)

	p.mu.Lock()
	p.records["presence-recovery"] = &agentPresenceRecord{
		ServerID: "presence-recovery",
		Status:   agentPresenceOffline,
	}
	p.mu.Unlock()

	p.recordHeartbeat("presence-recovery", "heartbeat", 30_000)
	if snapshot := p.snapshot("presence-recovery"); snapshot["presence_status"] != string(agentPresenceOffline) {
		t.Fatalf("first heartbeat status = %#v, want offline", snapshot["presence_status"])
	}
	events, _ := notifier.snapshot()
	if len(events) != 0 {
		t.Fatalf("events after first heartbeat = %#v, want none", events)
	}

	p.recordHeartbeat("presence-recovery", "state", 30_000)
	if snapshot := p.snapshot("presence-recovery"); snapshot["presence_status"] != string(agentPresenceOnline) {
		t.Fatalf("second heartbeat status = %#v, want online", snapshot["presence_status"])
	}
	events, _ = notifier.snapshot()
	if len(events) != 1 || events[0] != "online" {
		t.Fatalf("events = %#v, want one online", events)
	}
}

func TestPresenceSuppressWindowSkipsNotification(t *testing.T) {
	service, _ := testService(t)
	notifier := &recordingNotifier{}
	service.SetNotifier(notifier)
	insertPresenceTestServer(t, service, "presence-suppress", "online")
	p := testPresenceManager(t, service)

	p.mu.Lock()
	p.records["presence-suppress"] = &agentPresenceRecord{
		ServerID:        "presence-suppress",
		Status:          agentPresenceOnline,
		LastHeartbeat:   time.Now().Add(-181 * time.Second),
		LastMetricsSeen: time.Now().Add(-181 * time.Second),
		SuppressUntil:   time.Now().Add(time.Minute),
	}
	p.mu.Unlock()
	p.check()

	events, _ := notifier.snapshot()
	if len(events) != 0 {
		t.Fatalf("events = %#v, want none", events)
	}
}

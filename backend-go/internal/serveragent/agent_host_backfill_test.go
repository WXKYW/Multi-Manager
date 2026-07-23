package serveragent

import (
	"context"
	"net/http/httptest"
	"testing"
)

func TestBackfillAccountHostRequiresMatchingLinuxPublicAndConnectionIP(t *testing.T) {
	service, db := testService(t)
	_ = service
	for _, item := range []struct {
		id   string
		host string
	}{
		{id: "matching-linux", host: "0.0.0.0"},
		{id: "nat-linux", host: "0.0.0.0"},
		{id: "windows-host", host: "0.0.0.0"},
		{id: "manual-host", host: "node.example.com"},
	} {
		if _, err := db.Exec(`INSERT INTO server_accounts(id,name,host,username,auth_type) VALUES(?,?,?,?,?)`, item.id, item.id, item.host, "agent", "password"); err != nil {
			t.Fatal(err)
		}
	}

	matching := map[string]interface{}{
		"platform":      "Debian GNU/Linux",
		"ip":            "203.0.113.20",
		"connection_ip": "203.0.113.20",
	}
	host, changed, err := backfillAccountHostFromAgent(context.Background(), db, "matching-linux", matching)
	if err != nil || !changed || host != "203.0.113.20" {
		t.Fatalf("matching backfill host=%q changed=%v err=%v", host, changed, err)
	}

	for _, item := range []struct {
		id       string
		metadata map[string]interface{}
		wantHost string
	}{
		{
			id: "nat-linux",
			metadata: map[string]interface{}{
				"platform": "Debian GNU/Linux", "ip": "203.0.113.21", "connection_ip": "172.24.110.66",
			},
			wantHost: "0.0.0.0",
		},
		{
			id: "windows-host",
			metadata: map[string]interface{}{
				"platform": "Windows", "ip": "203.0.113.22", "connection_ip": "203.0.113.22",
			},
			wantHost: "0.0.0.0",
		},
		{
			id: "manual-host",
			metadata: map[string]interface{}{
				"platform": "Linux", "ip": "203.0.113.23", "connection_ip": "203.0.113.23",
			},
			wantHost: "node.example.com",
		},
	} {
		_, changed, err := backfillAccountHostFromAgent(context.Background(), db, item.id, item.metadata)
		if err != nil || changed {
			t.Fatalf("%s changed=%v err=%v", item.id, changed, err)
		}
		var actual string
		if err := db.QueryRow(`SELECT host FROM server_accounts WHERE id=?`, item.id).Scan(&actual); err != nil || actual != item.wantHost {
			t.Fatalf("%s host=%q want=%q err=%v", item.id, actual, item.wantHost, err)
		}
	}
}

func TestRequestRemoteIPUsesSocketPeerAndIgnoresForwardingHeaders(t *testing.T) {
	req := httptest.NewRequest("GET", "/socket.io", nil)
	req.RemoteAddr = "[2001:db8::25]:45678"
	req.Header.Set("X-Forwarded-For", "198.51.100.10")
	if got := requestRemoteIP(req); got != "2001:db8::25" {
		t.Fatalf("remote IP=%q", got)
	}

	req.RemoteAddr = "172.24.110.66:45678"
	if got := requestRemoteIP(req); got != "172.24.110.66" {
		t.Fatalf("remote IP=%q", got)
	}
}

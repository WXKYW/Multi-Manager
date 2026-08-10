package serveragent

import (
	"context"
	"sync"
	"testing"

	"github.com/iwvw/api-monitor/backend-go/internal/cloudflare"
)

type fakeManagedTunnelAPI struct {
	mu     sync.Mutex
	count  int
	err    error
	exists map[string]bool
}

func (f *fakeManagedTunnelAPI) PreflightManagedTunnel(context.Context, string, string, string) (cloudflare.ManagedTunnelPreflight, error) {
	return cloudflare.ManagedTunnelPreflight{}, nil
}

func (f *fakeManagedTunnelAPI) CreateManagedTunnel(context.Context, string, string) (cloudflare.ManagedTunnel, error) {
	return cloudflare.ManagedTunnel{}, nil
}

func (f *fakeManagedTunnelAPI) ManagedTunnelExists(_ context.Context, _, tunnelID string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.exists == nil {
		return tunnelID != "", nil
	}
	exists, ok := f.exists[tunnelID]
	return exists || !ok, nil
}

func (f *fakeManagedTunnelAPI) ConfigureManagedTunnel(context.Context, string, string, []cloudflare.ManagedTunnelIngress) error {
	return nil
}

func (f *fakeManagedTunnelAPI) EnsureManagedTunnelDNS(context.Context, string, string, string, string) (cloudflare.ManagedTunnelDNS, error) {
	return cloudflare.ManagedTunnelDNS{}, nil
}

func (f *fakeManagedTunnelAPI) ManagedTunnelToken(context.Context, string, string) (string, error) {
	return "token", nil
}

func (f *fakeManagedTunnelAPI) ManagedTunnelConnections(context.Context, string, string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return 0, f.err
	}
	return f.count, nil
}

func (f *fakeManagedTunnelAPI) DeleteManagedTunnelDNS(context.Context, string, string, string) error {
	return nil
}

func (f *fakeManagedTunnelAPI) DeleteManagedTunnel(context.Context, string, string) error {
	return nil
}

func (f *fakeManagedTunnelAPI) setConnections(count int, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.count, f.err = count, err
}

func TestReconcileManagedTunnelConnectionReflectsRealConnectivity(t *testing.T) {
	service, db := testService(t)
	fake := &fakeManagedTunnelAPI{}
	service.SetCloudflareTunnelManager(fake)
	if _, err := db.Exec(`INSERT INTO server_accounts(id,name,host,username,auth_type) VALUES('tunnel-host','隧道主机','192.0.2.10','root','password')`); err != nil {
		t.Fatal(err)
	}

	insertTunnel := func(status string) {
		t.Helper()
		if _, err := db.Exec(`INSERT INTO managed_proxy_tunnels(server_id,account_id,zone_id,zone_name,tunnel_id,tunnel_name,hostname,desired_status,apply_status,last_stage,last_error) VALUES('tunnel-host','account','zone','example.com','tunnel-id','t','edge.example.com','running',?,?,?) ON CONFLICT(server_id) DO UPDATE SET apply_status=excluded.apply_status,last_stage=excluded.last_stage,last_error=excluded.last_error`, status, "seed", ""); err != nil {
			t.Fatal(err)
		}
	}
	applyStatus := func() string {
		t.Helper()
		var status string
		if err := db.QueryRow(`SELECT apply_status FROM managed_proxy_tunnels WHERE server_id='tunnel-host'`).Scan(&status); err != nil {
			t.Fatal(err)
		}
		return status
	}

	insertTunnel("running")

	fake.setConnections(0, nil)
	service.reconcileManagedTunnelConnection("tunnel-host")
	if got := applyStatus(); got != "disconnected" {
		t.Fatalf("expected disconnected when Cloudflare reports no connectors, got %q", got)
	}

	fake.setConnections(3, nil)
	service.reconcileManagedTunnelConnection("tunnel-host")
	if got := applyStatus(); got != "running" {
		t.Fatalf("expected running when Cloudflare reports active connectors, got %q", got)
	}

	fake.setConnections(0, nil)
	service.reconcileManagedTunnelConnection("tunnel-host")
	if got := applyStatus(); got != "disconnected" {
		t.Fatalf("expected disconnected again after connectors drop, got %q", got)
	}
}

func TestReconcileManagedTunnelConnectionKeepsStatusOnAPIError(t *testing.T) {
	service, db := testService(t)
	fake := &fakeManagedTunnelAPI{}
	service.SetCloudflareTunnelManager(fake)
	if _, err := db.Exec(`INSERT INTO server_accounts(id,name,host,username,auth_type) VALUES('error-host','错误主机','192.0.2.11','root','password')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO managed_proxy_tunnels(server_id,account_id,zone_id,zone_name,tunnel_id,tunnel_name,hostname,desired_status,apply_status,last_stage) VALUES('error-host','account','zone','example.com','tunnel-id','t','edge.example.com','running','running','health_check')`); err != nil {
		t.Fatal(err)
	}
	fake.setConnections(0, context.DeadlineExceeded)
	service.reconcileManagedTunnelConnection("error-host")
	var status string
	if err := db.QueryRow(`SELECT apply_status FROM managed_proxy_tunnels WHERE server_id='error-host'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "running" {
		t.Fatalf("tunnel status must not be flipped on a control-plane API error, got %q", status)
	}
}

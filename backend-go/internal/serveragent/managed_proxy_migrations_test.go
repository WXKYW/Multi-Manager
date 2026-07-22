package serveragent

import (
	"context"
	"testing"
)

func TestRepairLegacyTunnelSubscriberFlowQueuesRunningNodesOnce(t *testing.T) {
	service, db := testService(t)
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `DELETE FROM system_config WHERE key=?`, legacyTunnelSubscriberFlowMigration); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO server_accounts(id,name,host,username,auth_type) VALUES('tunnel-host','Tunnel 主机','192.0.2.10','root','password')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO managed_proxy_nodes(id,server_id,name,protocol,runtime,public_host,assigned_port,transport,config_encrypted,client_uri_encrypted,revision,enabled,publishable,apply_status,access_mode) VALUES('tunnel-node','tunnel-host','Tunnel','vless-reality','sing-box','192.0.2.10',45654,'tcp','{}','',3,1,1,'running','cloudflare_tunnel')`); err != nil {
		t.Fatal(err)
	}
	if err := repairLegacyTunnelSubscriberFlow(ctx, db); err != nil {
		t.Fatal(err)
	}
	var revision int
	var status string
	var publishable int
	if err := db.QueryRowContext(ctx, `SELECT revision,apply_status,publishable FROM managed_proxy_nodes WHERE id='tunnel-node'`).Scan(&revision, &status, &publishable); err != nil {
		t.Fatal(err)
	}
	if revision != 4 || status != "pending" || publishable != 0 {
		t.Fatalf("node state = revision %d, status %q, publishable %d", revision, status, publishable)
	}
	var queuedState string
	if err := db.QueryRowContext(ctx, `SELECT state FROM subscription_runtime_reconcile WHERE node_id='tunnel-node'`).Scan(&queuedState); err != nil {
		t.Fatal(err)
	}
	if queuedState != "pending" {
		t.Fatalf("queue state = %q, want pending", queuedState)
	}
	if err := repairLegacyTunnelSubscriberFlow(ctx, db); err != nil {
		t.Fatal(err)
	}
	var generation int
	if err := db.QueryRowContext(ctx, `SELECT generation FROM subscription_runtime_reconcile WHERE node_id='tunnel-node'`).Scan(&generation); err != nil {
		t.Fatal(err)
	}
	if generation != 1 {
		t.Fatalf("second migration changed queue generation to %d", generation)
	}
	_ = service
}

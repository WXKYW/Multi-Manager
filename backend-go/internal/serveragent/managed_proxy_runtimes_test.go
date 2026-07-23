package serveragent

import (
	"context"
	"net/http"
	"testing"
)

func TestManagedProxyRuntimeInventoryStartsEmpty(t *testing.T) {
	service, _ := testService(t)
	res := perform(service, http.MethodGet, "/api/server/agent/proxy/runtimes", "")
	if res.Code != http.StatusOK {
		t.Fatalf("runtime inventory status=%d body=%s", res.Code, res.Body.String())
	}
	payload := decodePayload(t, res)
	if items, ok := payload["data"].([]interface{}); !ok || len(items) != 0 {
		t.Fatalf("runtime inventory should be empty: %#v", payload)
	}
}

func TestManagedNodeRequiresInstalledRuntime(t *testing.T) {
	service, db := testService(t)
	if _, err := db.ExecContext(context.Background(), `INSERT INTO server_accounts (id,name,host,username,auth_type,status) VALUES ('runtime-required','edge','192.0.2.40','agent','password','online')`); err != nil {
		t.Fatal(err)
	}
	res := perform(service, http.MethodPost, "/api/server/agent/proxy/nodes", `{"server_id":"runtime-required","name":"edge","protocol":"vless-reality","server_name":"www.cloudflare.com"}`)
	if res.Code != http.StatusConflict {
		t.Fatalf("node without runtime status=%d body=%s", res.Code, res.Body.String())
	}
}

func TestManagedProxyPortReservationSkipsPortsOwnedByOtherNodes(t *testing.T) {
	_, db := testService(t)
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `INSERT INTO server_accounts (id,name,host,username,auth_type) VALUES ('port-host','edge','192.0.2.41','agent','password')`); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO managed_proxy_nodes (id,server_id,name,protocol,runtime,public_host,assigned_port,transport,config_encrypted,client_uri_encrypted) VALUES ('port-a','port-host','a','vless-reality','sing-box','192.0.2.41',45654,'tcp','{}','')`,
		`INSERT INTO managed_proxy_nodes (id,server_id,name,protocol,runtime,public_host,assigned_port,transport,config_encrypted,client_uri_encrypted) VALUES ('port-b','port-host','b','hysteria2','sing-box','192.0.2.41',0,'udp','{}','')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	port, excluded, err := reserveManagedProxyPort(ctx, db, "port-host", "port-b", 45654)
	if err != nil {
		t.Fatal(err)
	}
	if port != 45655 || len(excluded) != 1 || excluded[0] != 45654 {
		t.Fatalf("reservation port=%d excluded=%v", port, excluded)
	}
	if _, err := db.ExecContext(ctx, `UPDATE managed_proxy_nodes SET assigned_port=45654 WHERE id='port-b'`); err == nil {
		t.Fatal("duplicate managed port update should be rejected")
	}
}

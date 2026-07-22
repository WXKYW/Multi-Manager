package serveragent

import (
	"context"
	"strings"
	"testing"
)

func TestCloudflaredTaskPayloadUsesPinnedVerifiedAssets(t *testing.T) {
	payload := cloudflaredTaskPayload("install", "scoped-token")
	if payload["version"] != cloudflaredVersion {
		t.Fatalf("unexpected version: %v", payload["version"])
	}
	for _, key := range []string{"asset_url_amd64", "asset_url_arm64"} {
		if !strings.HasPrefix(payload[key].(string), "https://") {
			t.Fatalf("%s must use HTTPS", key)
		}
	}
	for _, key := range []string{"asset_sha256_amd64", "asset_sha256_arm64"} {
		if len(payload[key].(string)) != 64 {
			t.Fatalf("%s must contain a SHA-256 digest", key)
		}
	}
}

func TestResolveManagedNodeClientURIPrecedence(t *testing.T) {
	_, db := testService(t)
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `INSERT INTO managed_proxy_preferences(id,name,address,port,enabled,is_default) VALUES('default','default','saas.sin.fan',443,1,1),('node','node','198.51.100.8',8443,1,0)`); err != nil {
		t.Fatal(err)
	}
	node := managedProxyNode{ClientURI: "vless://id@tunnel.example.com:443?security=tls#node", AccessMode: "cloudflare_tunnel", TunnelHostname: "tunnel.example.com", PreferredAddressID: "node"}
	if got := resolveManagedNodeClientURI(ctx, db, node); !strings.Contains(got, "198.51.100.8:8443") {
		t.Fatalf("node override not applied: %s", got)
	}
	node.PreferredAddressID = ""
	if got := resolveManagedNodeClientURI(ctx, db, node); !strings.Contains(got, "saas.sin.fan:443") {
		t.Fatalf("global default not applied: %s", got)
	}
	node.ConnectAddress, node.ConnectPort = "203.0.113.9", 9443
	if got := resolveManagedNodeClientURI(ctx, db, node); !strings.Contains(got, "203.0.113.9:9443") {
		t.Fatalf("custom node address not applied: %s", got)
	}
}

func TestRewriteTunnelClientURIKeepsPreferredAddressAndMigratesSNI(t *testing.T) {
	raw := "vless://id@saas.sin.fan:443?security=tls&type=ws&sni=old.example.com&host=old.example.com#node"
	got, err := rewriteTunnelClientURI(raw, "old.example.com", "new.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "@saas.sin.fan:443") || !strings.Contains(got, "sni=new.example.com") || !strings.Contains(got, "host=new.example.com") {
		t.Fatalf("unexpected migrated URI: %s", got)
	}
}

func TestBindManagedNodeRuntimePortDoesNotExposeTunnelOriginPort(t *testing.T) {
	tunnel := "vless://id@tunnel.example.com:443?security=tls&type=ws#node"
	if got := bindManagedNodeRuntimePort(tunnel, 45656, "cloudflare_tunnel"); got != tunnel {
		t.Fatalf("Tunnel client endpoint was rewritten to its origin port: %s", got)
	}
	direct := "vless://id@192.0.2.10:0?security=reality#node"
	if got := bindManagedNodeRuntimePort(direct, 45654, "direct"); !strings.Contains(got, "@192.0.2.10:45654") {
		t.Fatalf("direct client endpoint did not receive its runtime port: %s", got)
	}
}

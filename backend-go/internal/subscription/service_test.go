package subscription

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/iwvw/api-monitor/backend-go/internal/config"
	"gopkg.in/yaml.v3"
	_ "modernc.org/sqlite"
)

func TestLoadSubscriptionsDoesNotQueryWhileRowsOpen(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	if err := ensureSchema(ctx, db); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO subscription_subscriptions (id, name, public_token, enabled) VALUES ('sub_test', '测试订阅', 'token_test', 1)`); err != nil {
		t.Fatalf("insert subscription: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO subscription_nodes (id, subscription_id, name, enabled) VALUES ('node_test', 'sub_test', '测试节点', 1)`); err != nil {
		t.Fatalf("insert node: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO subscription_access_logs (subscription_id, public_token, success, status_code) VALUES ('sub_test', 'token_test', 1, 200)`); err != nil {
		t.Fatalf("insert access log: %v", err)
	}

	started := time.Now()
	items, err := loadSubscriptions(ctx, db, "")
	if err != nil {
		t.Fatalf("load subscriptions: %v", err)
	}
	if elapsed := time.Since(started); elapsed > 250*time.Millisecond {
		t.Fatalf("load subscriptions took %s, likely blocked on nested sqlite queries", elapsed)
	}
	if len(items) != 1 {
		t.Fatalf("len(items) = %d, want 1", len(items))
	}
	if items[0].NodeCount != 1 {
		t.Fatalf("NodeCount = %d, want 1", items[0].NodeCount)
	}
	if items[0].AccessCountToday != 1 {
		t.Fatalf("AccessCountToday = %d, want 1", items[0].AccessCountToday)
	}
}

func TestLoadNodesDoesNotQueryQualityWhileRowsOpen(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	if err := ensureSchema(ctx, db); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	if err := insertNode(ctx, tx, Node{ID: "node_bound", SubscriptionID: "profile_one", ProfileID: "profile_one", Name: "绑定主机节点", Enabled: true, TrafficServerID: "server_one"}); err != nil {
		t.Fatalf("insert node: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit tx: %v", err)
	}

	started := time.Now()
	nodes, err := loadNodes(ctx, db, "profile_one", true)
	if err != nil {
		t.Fatalf("load nodes: %v", err)
	}
	if elapsed := time.Since(started); elapsed > 250*time.Millisecond {
		t.Fatalf("load nodes took %s, likely blocked on nested sqlite queries", elapsed)
	}
	if len(nodes) != 1 || nodes[0].TrafficServerID != "server_one" {
		t.Fatalf("nodes = %#v, want bound server id preserved", nodes)
	}
}

func TestParseImportTextDecodesBase64Subscription(t *testing.T) {
	raw := "vmess://example-one#节点一\ntrojan://password@example.com:443#节点二\n"
	encoded := base64.StdEncoding.EncodeToString([]byte(raw))

	nodes := parseImportText(encoded)
	if len(nodes) != 2 {
		t.Fatalf("len(nodes) = %d, want 2", len(nodes))
	}
	if nodes[0].Type != "vmess" || nodes[1].Type != "trojan" {
		t.Fatalf("types = %q, %q", nodes[0].Type, nodes[1].Type)
	}
	if nodes[1].Server != "example.com" || nodes[1].Port != 443 {
		t.Fatalf("trojan endpoint = %s:%d", nodes[1].Server, nodes[1].Port)
	}
}

func TestParseImportTextPreservesURIClientFields(t *testing.T) {
	raw := strings.Join([]string{
		"vless://0119068b-0148-47bf-875b-2145040b8174@saas.sin.fan:443?security=tls&type=ws&fp=chrome&path=/group/live/intro&encryption=none&headerType=none&sni=egtu.pages.dev#JP%20CF%20ET",
		"hysteria2://3Aq8A2om3bNPoY7C@189.1.217.109:1005/?insecure=1&sni=cdn.jsdelivr.net#HK%20香港",
		"trojan://YPMVpLJMZxDHoMChEzY5-nU3xQPALdyV@tjw.rois.eu.org:56501?type=tcp&sni=tjw.rois.eu.orgh3,h2,http/1.1#US%20洛杉矶",
	}, "\n")

	nodes := parseImportText(raw)
	if len(nodes) != 3 {
		t.Fatalf("len(nodes) = %d, want 3", len(nodes))
	}
	if nodes[0].CountryCode != "JP" || nodes[0].Name != "JP CF ET" {
		t.Fatalf("vless name/country not normalized: %#v", nodes[0])
	}
	if nodes[1].CountryCode != "HK" || nodes[1].Name != "HK 香港" {
		t.Fatalf("hysteria2 name/country not normalized: %#v", nodes[1])
	}

	var vless map[string]interface{}
	if err := json.Unmarshal([]byte(nodes[0].ConfigJSON), &vless); err != nil {
		t.Fatalf("vless config json: %v", err)
	}
	if vless["uuid"] != "0119068b-0148-47bf-875b-2145040b8174" || vless["network"] != "ws" || vless["tls"] != true || vless["servername"] != "egtu.pages.dev" || vless["sni"] != "egtu.pages.dev" {
		t.Fatalf("vless config lost fields: %#v", vless)
	}
	wsOpts, ok := vless["ws-opts"].(map[string]interface{})
	if !ok || wsOpts["path"] != "/group/live/intro" {
		t.Fatalf("vless ws opts lost fields: %#v", vless["ws-opts"])
	}
	headers, ok := wsOpts["headers"].(map[string]interface{})
	if !ok || headers["Host"] != "egtu.pages.dev" {
		t.Fatalf("vless ws host header lost fields: %#v", wsOpts["headers"])
	}

	var hy2 map[string]interface{}
	if err := json.Unmarshal([]byte(nodes[1].ConfigJSON), &hy2); err != nil {
		t.Fatalf("hysteria2 config json: %v", err)
	}
	if hy2["password"] != "3Aq8A2om3bNPoY7C" || hy2["sni"] != "cdn.jsdelivr.net" || hy2["skip-cert-verify"] != true {
		t.Fatalf("hysteria2 config lost fields: %#v", hy2)
	}

	var trojan map[string]interface{}
	if err := json.Unmarshal([]byte(nodes[2].ConfigJSON), &trojan); err != nil {
		t.Fatalf("trojan config json: %v", err)
	}
	if trojan["password"] != "YPMVpLJMZxDHoMChEzY5-nU3xQPALdyV" || trojan["sni"] != "tjw.rois.eu.org" || trojan["tls"] != true || trojan["network"] != "tcp" {
		t.Fatalf("trojan config lost fields: %#v", trojan)
	}
	if alpn, ok := trojan["alpn"].([]interface{}); !ok || len(alpn) != 3 {
		t.Fatalf("trojan alpn lost fields: %#v", trojan["alpn"])
	}
}

func TestParseImportTextPreservesUnescapedFragmentNames(t *testing.T) {
	raw := strings.Join([]string{
		"hysteria2://3Aq8A2om3bNPoY7C@189.1.217.109:1005/?insecure=1&sni=cdn.jsdelivr.net#🇭🇰 香港",
		"hysteria2://yNbE8RV2zdIojLVS@45.32.157.55:4534/?insecure=1&sni=cdn.jsdelivr.net#🇩🇪 法兰克福",
		"vless://65f52614-1632-45c6-9809-72c30c4e16bd@saas.sin.fan:443?security=tls&type=ws&fp=chrome&path=/vless-argo?ed=2560&encryption=none&headerType=none#🇯🇵 日本",
	}, "\n")

	nodes := parseImportText(raw)
	if len(nodes) != 3 {
		t.Fatalf("len(nodes) = %d, want 3: %#v", len(nodes), nodes)
	}
	wants := []struct {
		code string
		name string
	}{
		{"HK", "🇭🇰 香港"},
		{"DE", "🇩🇪 法兰克福"},
		{"JP", "🇯🇵 日本"},
	}
	for i, want := range wants {
		if nodes[i].CountryCode != want.code || nodes[i].Name != want.name {
			t.Fatalf("node %d = country %q name %q, want country %q name %q", i, nodes[i].CountryCode, nodes[i].Name, want.code, want.name)
		}
	}
}

func TestParseImportTextReadsClashProxiesOnly(t *testing.T) {
	raw := `
proxies:
  - {"name":"JP CF","type":"vless","server":"saas.example.com","port":443,"uuid":"0119068b-0148-47bf-875b-2145040b8174","network":"ws","ws-opts":{"path":"/group/live/intro","headers":{"Host":"edge.example.com"}}}
  # - {"name":"Disabled","type":"trojan","server":"disabled.example.com","port":443,"password":"secret"}
  - name: London
    type: hysteria2
    server: 185.168.194.90
    port: 5427
    password: secret
rule-providers:
  reject:
    type: http
    url: https://raw.example.com/clash-rules/reject.txt
`

	nodes := parseImportText(raw)
	if len(nodes) != 2 {
		t.Fatalf("len(nodes) = %d, want 2: %#v", len(nodes), nodes)
	}
	if nodes[0].Name != "JP CF" || nodes[0].Type != "vless" || nodes[0].Server != "saas.example.com" || nodes[0].Port != 443 {
		t.Fatalf("first node = %#v", nodes[0])
	}
	if nodes[1].Name != "London" || nodes[1].Type != "hysteria2" || nodes[1].Server != "185.168.194.90" || nodes[1].Port != 5427 {
		t.Fatalf("second node = %#v", nodes[1])
	}
	for _, node := range nodes {
		if strings.Contains(node.Server, "raw.example.com") || strings.Contains(node.Raw, "raw.example.com") {
			t.Fatalf("rule provider URL was parsed as node: %#v", node)
		}
		if node.ConfigJSON == "" {
			t.Fatalf("ConfigJSON is empty for %#v", node)
		}
	}
}

func TestParseClashProxyNodesPreservesEmojiNamesAndClientFields(t *testing.T) {
	raw := `
proxies:
  - {"name":"🇯🇵 CF ET","type":"vless","server":"saas.sin.fan","port":443,"uuid":"0119068b-0148-47bf-875b-2145040b8174","encryption":"none","tls":true,"sni":"egtu.pages.dev","client-fingerprint":"chrome","network":"ws","ws-opts":{"path":"/group/live/intro","headers":{"Host":"egtu.pages.dev"}}}
  - {"name":"🇺🇸 洛杉矶","type":"trojan","server":"tjw.rois.eu.org","port":56501,"network":"tcp","udp":true,"password":"secret","tls":true,"sni":"tjw.rois.eu.org","alpn":["h3","h2","http/1.1"],"client-fingerprint":"chrome"}
`

	nodes := parseImportText(raw)
	if len(nodes) != 2 {
		t.Fatalf("len(nodes) = %d, want 2: %#v", len(nodes), nodes)
	}
	if nodes[0].CountryCode != "JP" || nodes[0].Name != "🇯🇵 CF ET" {
		t.Fatalf("first node country/name = %q/%q", nodes[0].CountryCode, nodes[0].Name)
	}
	if nodes[1].CountryCode != "US" || nodes[1].Name != "🇺🇸 洛杉矶" {
		t.Fatalf("second node country/name = %q/%q", nodes[1].CountryCode, nodes[1].Name)
	}

	body := "proxies:\n" + proxiesYAML(nodes, 2) + "\n"
	var parsed map[string][]map[string]interface{}
	if err := yaml.Unmarshal([]byte(body), &parsed); err != nil {
		t.Fatalf("exported yaml should parse: %v\n%s", err, body)
	}
	proxies := parsed["proxies"]
	if len(proxies) != 2 {
		t.Fatalf("len(proxies) = %d, want 2: %#v", len(proxies), proxies)
	}
	wsOpts, _ := proxies[0]["ws-opts"].(map[string]interface{})
	headers, _ := wsOpts["headers"].(map[string]interface{})
	if proxies[0]["name"] != "🇯🇵 CF ET" || proxies[0]["sni"] != "egtu.pages.dev" || headers["Host"] != "egtu.pages.dev" {
		t.Fatalf("exported vless yaml lost display/client fields: %#v", proxies[0])
	}
	if proxies[1]["name"] != "🇺🇸 洛杉矶" || proxies[1]["tls"] != true || proxies[1]["client-fingerprint"] != "chrome" {
		t.Fatalf("exported trojan yaml lost display/client fields: %#v", proxies[1])
	}
}

func TestStableProxyNamesAlwaysIncludesManualGroup(t *testing.T) {
	nodes := []Node{
		{Name: "🇺🇸 洛杉矶", Enabled: true, Stable: true},
		{Name: "🇯🇵 日本", Enabled: true, Stable: false},
	}

	body := stableProxyNamesYAML(nodes, 0)
	var names []string
	if err := yaml.Unmarshal([]byte(strings.TrimSpace(body)), &names); err != nil {
		t.Fatalf("stable proxy names should parse: %v\n%s", err, body)
	}
	joined := strings.Join(names, "\n")
	if !strings.Contains(joined, "🇺🇸 洛杉矶") {
		t.Fatalf("stable node missing from stable proxy names: %#v", names)
	}
	if !strings.Contains(joined, "🚀 手动") {
		t.Fatalf("manual group missing from stable proxy names: %#v", names)
	}
	if strings.Contains(joined, "🇯🇵 日本") {
		t.Fatalf("non-stable node should not be in stable proxy names:\n%s", body)
	}
}

func TestProxiesYAMLRendersClientCompatibleList(t *testing.T) {
	nodes := parseImportText("vless://0119068b-0148-47bf-875b-2145040b8174@saas.sin.fan:443?security=tls&type=ws&fp=chrome&path=/group/live/intro&encryption=none&sni=egtu.pages.dev#JP%20CF%20ET")
	if len(nodes) != 1 {
		t.Fatalf("len(nodes) = %d, want 1", len(nodes))
	}
	body := "proxies:\n" + proxiesYAML(nodes, 2) + "\n"
	var parsed map[string]interface{}
	if err := yaml.Unmarshal([]byte(body), &parsed); err != nil {
		t.Fatalf("rendered proxies yaml is invalid: %v\n%s", err, body)
	}
	proxies, ok := parsed["proxies"].([]interface{})
	if !ok || len(proxies) != 1 {
		t.Fatalf("proxies = %#v", parsed["proxies"])
	}
	proxy := normalizeStringMap(proxies[0]).(map[string]interface{})
	if proxy["uuid"] != "0119068b-0148-47bf-875b-2145040b8174" || proxy["network"] != "ws" {
		t.Fatalf("rendered proxy lost fields: %#v", proxy)
	}
}

func TestEnsureSchemaMigratesLegacySubscriptionsToProfiles(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()

	legacyStatements := []string{
		`CREATE TABLE subscription_subscriptions (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			remark TEXT,
			enabled INTEGER DEFAULT 1,
			public_token TEXT NOT NULL UNIQUE,
			template_id TEXT DEFAULT 'builtin_mihomo_default',
			traffic_source TEXT DEFAULT 'manual',
			traffic_server_id TEXT,
			upstream_url TEXT,
			upstream_enabled INTEGER DEFAULT 0,
			upstream_refresh_hours INTEGER DEFAULT 24,
			upstream_status TEXT,
			upstream_last_error TEXT,
			upstream_last_refresh_at TEXT,
			upstream_userinfo TEXT,
			total_bytes INTEGER DEFAULT 0,
			manual_upload_bytes INTEGER DEFAULT 0,
			manual_download_bytes INTEGER DEFAULT 0,
			expire_at TEXT,
			cycle_type TEXT DEFAULT 'none',
			cycle_day INTEGER DEFAULT 1,
			cycle_start TEXT,
			cycle_end TEXT,
			baseline_upload_bytes INTEGER DEFAULT 0,
			baseline_download_bytes INTEGER DEFAULT 0,
			rate_limit_enabled INTEGER DEFAULT 1,
			rate_limit_per_minute INTEGER DEFAULT 30,
			created_at TEXT DEFAULT (datetime('now')),
			updated_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE TABLE subscription_nodes (
			id TEXT PRIMARY KEY,
			subscription_id TEXT NOT NULL,
			name TEXT NOT NULL,
			type TEXT,
			server TEXT,
			port INTEGER DEFAULT 0,
			country_code TEXT,
			location TEXT,
			tags TEXT,
			enabled INTEGER DEFAULT 1,
			stable INTEGER DEFAULT 0,
			sort_order INTEGER DEFAULT 0,
			raw_encrypted TEXT,
			config_encrypted TEXT,
			fingerprint TEXT,
			source TEXT DEFAULT 'manual',
			created_at TEXT DEFAULT (datetime('now')),
			updated_at TEXT DEFAULT (datetime('now'))
		)`,
		`INSERT INTO subscription_subscriptions (id, name, public_token, upstream_url, upstream_enabled, upstream_userinfo, total_bytes) VALUES ('sub_legacy', '旧订阅', 'tok_legacy', 'https://example.com/sub', 1, 'upload=1; download=2; total=3; expire=4', 100)`,
		`INSERT INTO subscription_nodes (id, subscription_id, name, enabled) VALUES ('node_legacy', 'sub_legacy', '旧节点', 1)`,
	}
	for _, statement := range legacyStatements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("exec legacy statement: %v", err)
		}
	}

	if err := ensureSchema(ctx, db); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}

	var profileID string
	if err := db.QueryRowContext(ctx, `SELECT profile_id FROM subscription_subscriptions WHERE id = 'sub_legacy'`).Scan(&profileID); err != nil {
		t.Fatalf("load subscription profile id: %v", err)
	}
	if profileID != "sub_legacy" {
		t.Fatalf("profileID = %q, want sub_legacy", profileID)
	}

	var profileName string
	if err := db.QueryRowContext(ctx, `SELECT name FROM subscription_profiles WHERE id = 'sub_legacy'`).Scan(&profileName); err != nil {
		t.Fatalf("load migrated profile: %v", err)
	}
	if profileName != "旧订阅" {
		t.Fatalf("profileName = %q, want 旧订阅", profileName)
	}

	var upstreamURL, userinfo string
	if err := db.QueryRowContext(ctx, `SELECT url, userinfo FROM subscription_upstreams WHERE profile_id = 'sub_legacy'`).Scan(&upstreamURL, &userinfo); err != nil {
		t.Fatalf("load migrated upstream: %v", err)
	}
	if upstreamURL != "https://example.com/sub" || !strings.Contains(userinfo, "total=3") {
		t.Fatalf("upstream = %q userinfo = %q", upstreamURL, userinfo)
	}

	var nodeProfileID string
	if err := db.QueryRowContext(ctx, `SELECT profile_id FROM subscription_nodes WHERE id = 'node_legacy'`).Scan(&nodeProfileID); err != nil {
		t.Fatalf("load node profile id: %v", err)
	}
	if nodeProfileID != "sub_legacy" {
		t.Fatalf("nodeProfileID = %q, want sub_legacy", nodeProfileID)
	}
}

func TestSubscriptionTokenRendersNodesFromProfile(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()

	if err := ensureSchema(ctx, db); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO subscription_subscriptions (id, profile_id, name, public_token, enabled, template_id) VALUES ('link_one', 'profile_one', '公开链接', 'token_one', 1, 'builtin_raw_uri')`); err != nil {
		t.Fatalf("insert subscription: %v", err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	if err := insertNode(ctx, tx, Node{SubscriptionID: "profile_one", ProfileID: "profile_one", Name: "节点一", Type: "trojan", Server: "example.com", Port: 443, Raw: "trojan://password@example.com:443#node-one", Enabled: true}); err != nil {
		t.Fatalf("insert node: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit tx: %v", err)
	}

	subs, err := loadSubscriptionByToken(ctx, db, "token_one")
	if err != nil {
		t.Fatalf("load subscription by token: %v", err)
	}
	if len(subs) != 1 || subs[0].ProfileID != "profile_one" {
		t.Fatalf("loaded subscription = %#v", subs)
	}
	nodes, err := loadNodes(ctx, db, subs[0].ProfileID, true)
	if err != nil {
		t.Fatalf("load profile nodes: %v", err)
	}
	if len(nodes) != 1 {
		t.Fatalf("len(nodes) = %d, want 1", len(nodes))
	}
	body, contentType, err := renderOutput(ctx, db, subs[0], nodes, "raw", false)
	if err != nil {
		t.Fatalf("render output: %v", err)
	}
	if contentType != "text/plain; charset=utf-8" || !strings.Contains(body, "trojan://password@example.com:443#node-one") {
		t.Fatalf("rendered %q as %q", body, contentType)
	}
}

func TestPublicSubscriptionIncludesClientProfileNameHeaders(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	dataDir := t.TempDir()
	svc := New(config.Config{DataDir: dataDir, DBName: "data.db"})
	db, err := svc.open(ctx)
	if err != nil {
		t.Fatalf("open service db: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO subscription_subscriptions (id, profile_id, name, public_token, enabled, template_id) VALUES ('link_one', 'profile_one', '香港 订阅', 'token_one', 1, 'builtin_mihomo_default')`); err != nil {
		t.Fatalf("insert subscription: %v", err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	if err := insertNode(ctx, tx, Node{SubscriptionID: "profile_one", ProfileID: "profile_one", Name: "HK 节点一", Type: "trojan", Server: "example.com", Port: 443, Raw: "trojan://password@example.com:443#node-one", Enabled: true}); err != nil {
		t.Fatalf("insert node: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit tx: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close db: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/sub/token_one", nil)
	rec := httptest.NewRecorder()
	svc.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	wantTitle := "base64:" + base64.StdEncoding.EncodeToString([]byte("香港 订阅"))
	if got := rec.Header().Get("Profile-Title"); got != wantTitle {
		t.Fatalf("Profile-Title = %q, want %q", got, wantTitle)
	}
	contentDisposition := rec.Header().Get("Content-Disposition")
	if !strings.Contains(contentDisposition, "attachment") || !strings.Contains(contentDisposition, "filename*=") {
		t.Fatalf("unexpected Content-Disposition: %q", contentDisposition)
	}
	if strings.Contains(contentDisposition, ".yaml") || strings.Contains(contentDisposition, ".txt") {
		t.Fatalf("Content-Disposition should not include a file extension: %q", contentDisposition)
	}
}

func TestMihomoRenderFallsBackWhenBoundTemplateIsEmpty(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()

	if err := ensureSchema(ctx, db); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO subscription_templates (id, name, format, content) VALUES ('empty_tpl', '空模板', 'clash', '')`); err != nil {
		t.Fatalf("insert template: %v", err)
	}
	sub := Subscription{ID: "link_one", Name: "DSUK", TemplateID: "empty_tpl", Enabled: true}
	nodes := []Node{{Name: "HK 节点一", Type: "trojan", Server: "example.com", Port: 443, Raw: "trojan://password@example.com:443#node-one", Enabled: true}}

	body, contentType, err := renderOutput(ctx, db, sub, nodes, "clash", false)
	if err != nil {
		t.Fatalf("render output: %v", err)
	}
	if contentType != "text/yaml; charset=utf-8" {
		t.Fatalf("contentType = %q", contentType)
	}
	if !strings.Contains(body, "proxies:") || !strings.Contains(body, "HK 节点一") {
		t.Fatalf("rendered body did not fall back to default template:\n%s", body)
	}
}

func TestMihomoRenderUsesEmptyProxyListWhenNoNodes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()

	if err := ensureSchema(ctx, db); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	sub := Subscription{ID: "link_one", Name: "DSUK", TemplateID: defaultTemplateID, Enabled: true}

	body, _, err := renderOutput(ctx, db, sub, nil, "clash", false)
	if err != nil {
		t.Fatalf("render output: %v", err)
	}
	var parsed map[string]interface{}
	if err := yaml.Unmarshal([]byte(body), &parsed); err != nil {
		t.Fatalf("rendered invalid yaml: %v\n%s", err, body)
	}
	proxies, ok := parsed["proxies"].([]interface{})
	if !ok {
		t.Fatalf("proxies = %#v, want empty list", parsed["proxies"])
	}
	if len(proxies) != 0 {
		t.Fatalf("len(proxies) = %d, want 0", len(proxies))
	}
}

func TestLoadProfilesReturnsLibrariesWithCountsAndUpstream(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()

	if err := ensureSchema(ctx, db); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	if err := upsertProfile(ctx, db, "profile_one", Subscription{Name: "DSUK", Enabled: true, UpstreamURL: "https://example.com/sub", UpstreamEnabled: true, RateLimitEnabled: true}, defaultTemplateID, "manual", "none", 1, 30); err != nil {
		t.Fatalf("upsert profile: %v", err)
	}
	if err := upsertDefaultUpstream(ctx, db, "profile_one", Subscription{UpstreamURL: "https://example.com/sub", UpstreamEnabled: true}, 12); err != nil {
		t.Fatalf("upsert upstream: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO subscription_subscriptions (id, profile_id, name, public_token, enabled) VALUES ('link_one', 'profile_one', '公开链接', 'token_one', 1)`); err != nil {
		t.Fatalf("insert subscription link: %v", err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	if err := insertNode(ctx, tx, Node{SubscriptionID: "profile_one", ProfileID: "profile_one", Name: "节点一", Type: "trojan", Server: "example.com", Port: 443, Enabled: true}); err != nil {
		t.Fatalf("insert node: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit tx: %v", err)
	}

	items, err := loadProfiles(ctx, db, "")
	if err != nil {
		t.Fatalf("load profiles: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len(items) = %d, want 1", len(items))
	}
	if items[0].ID != "profile_one" || items[0].Name != "DSUK" {
		t.Fatalf("profile = %#v", items[0])
	}
	if items[0].NodeCount != 1 || items[0].SubscriptionCount != 1 {
		t.Fatalf("counts = nodes %d subscriptions %d, want 1/1", items[0].NodeCount, items[0].SubscriptionCount)
	}
	if items[0].UpstreamURL != "https://example.com/sub" || items[0].UpstreamRefreshHours != 12 || !items[0].UpstreamEnabled {
		t.Fatalf("upstream = %#v", items[0])
	}
}

func TestDeleteProfileBlocksWhenNodesOrLinksExist(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()

	if err := ensureSchema(ctx, db); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	if err := upsertProfile(ctx, db, "profile_busy", Subscription{Name: "繁忙节点库", Enabled: true}, defaultTemplateID, "manual", "none", 1, 30); err != nil {
		t.Fatalf("upsert profile: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO subscription_subscriptions (id, profile_id, name, public_token, enabled) VALUES ('link_busy', 'profile_busy', '公开链接', 'token_busy', 1)`); err != nil {
		t.Fatalf("insert subscription link: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO subscription_nodes (id, subscription_id, profile_id, name, enabled) VALUES ('node_busy', 'link_busy', 'profile_busy', '繁忙节点', 1)`); err != nil {
		t.Fatalf("insert node: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO subscription_access_logs (subscription_id, public_token, success, status_code) VALUES ('link_busy', 'token_busy', 1, 200)`); err != nil {
		t.Fatalf("insert access log: %v", err)
	}

	service := &Service{}
	req := httptest.NewRequest(http.MethodDelete, "/api/subscription/profiles/profile_busy", nil)
	rec := httptest.NewRecorder()
	service.deleteProfile(rec, req, db, "profile_busy")

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d body=%s", rec.Code, http.StatusConflict, rec.Body.String())
	}
	var count int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM subscription_profiles WHERE id = 'profile_busy'`).Scan(&count); err != nil {
		t.Fatalf("count profile: %v", err)
	}
	if count != 1 {
		t.Fatalf("profile count = %d, want 1", count)
	}

	forceReq := httptest.NewRequest(http.MethodDelete, "/api/subscription/profiles/profile_busy?force=1", nil)
	forceRec := httptest.NewRecorder()
	service.deleteProfile(forceRec, forceReq, db, "profile_busy")
	if forceRec.Code != http.StatusOK {
		t.Fatalf("force status = %d, want %d body=%s", forceRec.Code, http.StatusOK, forceRec.Body.String())
	}
	for _, check := range []struct {
		name  string
		query string
	}{
		{"profiles", `SELECT COUNT(*) FROM subscription_profiles WHERE id = 'profile_busy'`},
		{"links", `SELECT COUNT(*) FROM subscription_subscriptions WHERE COALESCE(profile_id, id) = 'profile_busy'`},
		{"nodes", `SELECT COUNT(*) FROM subscription_nodes WHERE COALESCE(profile_id, subscription_id) = 'profile_busy'`},
		{"logs", `SELECT COUNT(*) FROM subscription_access_logs WHERE subscription_id = 'link_busy'`},
	} {
		var remaining int
		if err := db.QueryRowContext(ctx, check.query).Scan(&remaining); err != nil {
			t.Fatalf("count %s: %v", check.name, err)
		}
		if remaining != 0 {
			t.Fatalf("%s remaining = %d, want 0", check.name, remaining)
		}
	}
}

func TestComputeTrafficReadsUpstreamInfoFromProfile(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()

	if err := ensureSchema(ctx, db); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO subscription_upstreams (id, profile_id, name, url, enabled, userinfo) VALUES ('up_profile_one', 'profile_one', '默认上游', 'https://example.com/sub', 1, 'upload=11; download=22; total=100; expire=1234')`); err != nil {
		t.Fatalf("insert upstream: %v", err)
	}

	info := computeTraffic(ctx, db, Subscription{ID: "link_one", ProfileID: "profile_one", TrafficSource: "upstream"})
	if info.Upload != 11 || info.Download != 22 || info.Total != 100 || info.Expire != 1234 {
		t.Fatalf("traffic = %#v", info)
	}
}

func TestComputeTrafficFromNodeBoundServers(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()

	if err := ensureSchema(ctx, db); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE server_accounts (id TEXT PRIMARY KEY, name TEXT, host TEXT, cached_info TEXT, traffic_limit_bytes INTEGER DEFAULT 0)`); err != nil {
		t.Fatalf("create server accounts: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO server_accounts (id, name, host, cached_info, traffic_limit_bytes) VALUES
		('srv_one', 'Server One', 'one.example.com', '{"network":{"rx_total_bytes":1000,"tx_total_bytes":2000}}', 10000),
		('srv_two', 'Server Two', 'two.example.com', '{"net_in_transfer":3000,"net_out_transfer":4000}', 20000)`); err != nil {
		t.Fatalf("insert servers: %v", err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	nodes := []Node{
		{ID: "node_one", SubscriptionID: "profile_one", ProfileID: "profile_one", Name: "节点一", Enabled: true, TrafficServerID: "srv_one"},
		{ID: "node_two", SubscriptionID: "profile_one", ProfileID: "profile_one", Name: "节点二", Enabled: true, TrafficServerID: "srv_two"},
		{ID: "node_three", SubscriptionID: "profile_one", ProfileID: "profile_one", Name: "节点三", Enabled: false, TrafficServerID: "srv_one"},
	}
	for _, node := range nodes {
		if err := insertNode(ctx, tx, node); err != nil {
			t.Fatalf("insert node: %v", err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit tx: %v", err)
	}

	info := computeTraffic(ctx, db, Subscription{ID: "link_one", ProfileID: "profile_one", TrafficSource: "node_servers"})
	if info.Upload != 4000 || info.Download != 6000 || info.Total != 30000 || info.Source != "node_servers" {
		t.Fatalf("traffic = %#v, want upload 4000 download 6000 total 30000", info)
	}

	filtered := computeTraffic(ctx, db, Subscription{ID: "link_one", ProfileID: "profile_one", TrafficSource: "node_servers", NodeFilterIDs: []string{"node_two"}})
	if filtered.Upload != 3000 || filtered.Download != 4000 || filtered.Total != 20000 || filtered.Source != "node_servers" {
		t.Fatalf("filtered traffic = %#v, want upload 3000 download 4000 total 20000", filtered)
	}
}

func TestDeleteSubscriptionKeepsSharedProfile(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()

	if err := ensureSchema(ctx, db); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO subscription_profiles (id, name, enabled) VALUES ('profile_shared', '共享档案', 1)`); err != nil {
		t.Fatalf("insert profile: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO subscription_upstreams (id, profile_id, name, url, enabled) VALUES ('up_profile_shared', 'profile_shared', '默认上游', 'https://example.com/sub', 1)`); err != nil {
		t.Fatalf("insert upstream: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO subscription_subscriptions (id, profile_id, name, public_token, enabled) VALUES ('link_one', 'profile_shared', '链接一', 'token_one', 1), ('link_two', 'profile_shared', '链接二', 'token_two', 1)`); err != nil {
		t.Fatalf("insert links: %v", err)
	}

	profileID := firstNonEmpty(profileIDForSubscription(ctx, db, "link_one"), "link_one")
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	_, _ = tx.ExecContext(ctx, `DELETE FROM subscription_nodes WHERE subscription_id = ?`, "link_one")
	_, _ = tx.ExecContext(ctx, `DELETE FROM subscription_nodes WHERE profile_id = ?`, profileID)
	_, _ = tx.ExecContext(ctx, `DELETE FROM subscription_access_logs WHERE subscription_id = ?`, "link_one")
	if _, err := tx.ExecContext(ctx, `DELETE FROM subscription_subscriptions WHERE id = ?`, "link_one"); err != nil {
		t.Fatalf("delete link: %v", err)
	}
	var remainingLinks int
	_ = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM subscription_subscriptions WHERE COALESCE(profile_id, id) = ?`, profileID).Scan(&remainingLinks)
	if remainingLinks == 0 {
		_, _ = tx.ExecContext(ctx, `DELETE FROM subscription_upstreams WHERE profile_id = ?`, profileID)
		_, _ = tx.ExecContext(ctx, `DELETE FROM subscription_profiles WHERE id = ?`, profileID)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit tx: %v", err)
	}

	var profileCount, upstreamCount int
	_ = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM subscription_profiles WHERE id = 'profile_shared'`).Scan(&profileCount)
	_ = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM subscription_upstreams WHERE profile_id = 'profile_shared'`).Scan(&upstreamCount)
	if profileCount != 1 || upstreamCount != 1 {
		t.Fatalf("profileCount=%d upstreamCount=%d, want both 1", profileCount, upstreamCount)
	}
}

func TestImportCommitReadsSettingsThroughOpenTransaction(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	if err := ensureSchema(ctx, db); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer tx.Rollback()

	var refreshHours int
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(default_refresh_hours, 24) FROM subscription_settings WHERE id = 1`).Scan(&refreshHours); err != nil {
		t.Fatalf("query settings through tx: %v", err)
	}
	if refreshHours != 24 {
		t.Fatalf("refreshHours = %d, want 24", refreshHours)
	}
}

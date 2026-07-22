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
	"github.com/iwvw/api-monitor/backend-go/internal/secure"
	"gopkg.in/yaml.v3"
	_ "modernc.org/sqlite"
)

func TestIsLinuxPlatformRecognizesDistributions(t *testing.T) {
	tests := []struct {
		platform string
		version  string
		want     bool
	}{
		{platform: "Linux", version: "Ubuntu 24.04 LTS", want: true},
		{platform: "Ubuntu", want: true},
		{platform: "Debian GNU/Linux", want: true},
		{platform: "", version: "Alpine Linux v3.20", want: true},
		{platform: "", version: "", want: true},
		{platform: "Windows", version: "11", want: false},
		{platform: "Darwin", version: "15", want: false},
	}
	for _, test := range tests {
		if got := isLinuxPlatform(test.platform, test.version); got != test.want {
			t.Errorf("isLinuxPlatform(%q, %q) = %v, want %v", test.platform, test.version, got, test.want)
		}
	}
}

func TestManagedSubscriptionNodesApplyPreferredAddress(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := ensureSchema(ctx, db); err != nil {
		t.Fatal(err)
	}
	raw := "vless://00000000-0000-4000-8000-000000000001@origin.example.com:443?security=tls&type=ws&sni=origin.example.com&host=origin.example.com&path=%2Fedge#node"
	encrypted, err := secure.SecureEncrypt(raw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO managed_proxy_preferences(id,name,address,port,enabled,is_default) VALUES('pref','优选','saas.sin.fan',443,1,1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO managed_proxy_nodes(id,server_id,name,protocol,public_host,assigned_port,transport,config_encrypted,client_uri_encrypted,enabled,publishable,apply_status,access_mode,tunnel_hostname) VALUES('managed-one','server-one','节点一','vless-reality','origin.example.com',45654,'tcp','',?,1,1,'running','cloudflare_tunnel','origin.example.com')`, encrypted); err != nil {
		t.Fatal(err)
	}
	nodes, err := loadManagedSubscriptionNodes(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 1 || !strings.Contains(nodes[0].Raw, "@saas.sin.fan:443") {
		t.Fatalf("preferred address was not published: %#v", nodes)
	}
	if !strings.Contains(nodes[0].Raw, "sni=origin.example.com") {
		t.Fatalf("Tunnel SNI must remain owned hostname: %s", nodes[0].Raw)
	}
}

func TestPublishedNodeNamesAreUnique(t *testing.T) {
	nodes := ensureUniquePublishedNodeNames([]Node{
		{Name: "🇸🇬 新加坡", Raw: "vless://a@example.com:443#old", ConfigJSON: `{"name":"old","type":"vless"}`},
		{Name: "🇸🇬 新加坡", Raw: "trojan://b@example.net:443#old", ConfigJSON: `{"name":"old","type":"trojan"}`},
	})
	if nodes[0].Name != "🇸🇬 新加坡" || nodes[1].Name != "🇸🇬 新加坡 · 2" {
		t.Fatalf("unexpected published names: %#v", nodes)
	}
	if !strings.Contains(nodes[1].Raw, "%C2%B7%202") || !strings.Contains(nodes[1].ConfigJSON, "新加坡 · 2") {
		t.Fatalf("renamed node was not propagated: %#v", nodes[1])
	}
}

func TestJSONServerMetadataDoesNotTurnMissingValuesIntoNilText(t *testing.T) {
	values := map[string]interface{}{"platform": nil, "os": "Ubuntu"}
	if got := jsonString(values, "platform"); got != "" {
		t.Fatalf("platform = %q, want empty", got)
	}
	if got := firstNonEmpty(jsonString(values, "platform"), jsonString(values, "os")); got != "Ubuntu" {
		t.Fatalf("fallback platform = %q, want Ubuntu", got)
	}
}

func TestListServersIncludesLinuxDistributionsAndPreservesPlatform(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := ensureSchema(ctx, db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE server_accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, username TEXT, auth_type TEXT, cached_info TEXT, resolved_country TEXT, country TEXT, traffic_limit_bytes INTEGER, status TEXT, last_check_time TEXT, order_index INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct{ id, name, cached string }{
		{"ubuntu", "Ubuntu 主机", `{"platform":"Ubuntu","platform_version":"24.04"}`},
		{"debian", "Debian 主机", `{"platform":"Debian GNU/Linux","platform_version":"12"}`},
		{"windows", "Windows 主机", `{"platform":"Windows","platform_version":"11"}`},
	} {
		if _, err := db.ExecContext(ctx, `INSERT INTO server_accounts (id,name,host,username,auth_type,cached_info) VALUES (?,?,?,'root','password',?)`, row.id, row.name, row.id+".example.com", row.cached); err != nil {
			t.Fatal(err)
		}
		var saved string
		if err := db.QueryRowContext(ctx, `SELECT cached_info FROM server_accounts WHERE id=?`, row.id).Scan(&saved); err != nil || saved != row.cached {
			t.Fatalf("cached_info for %s = %q, err=%v", row.id, saved, err)
		}
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/subscription/servers", nil)
	New(config.Config{}).listServers(recorder, request, db)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	if !strings.Contains(body, `"name":"Ubuntu 主机"`) || !strings.Contains(body, `"platform":"Ubuntu"`) || !strings.Contains(body, `"platform_version":"24.04"`) {
		t.Fatalf("Ubuntu host or platform metadata missing: %s", body)
	}
	if !strings.Contains(body, `"name":"Debian 主机"`) {
		t.Fatalf("Debian host missing: %s", body)
	}
	if strings.Contains(body, `"name":"Windows 主机"`) {
		t.Fatalf("Windows host must not be included: %s", body)
	}
}

func TestLoadSubscriptionsDoesNotQueryWhileRowsOpen(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
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
	if _, err := db.ExecContext(ctx, `INSERT INTO subscription_subscriptions (id, name, public_token, enabled, include_internal_nodes, include_external_nodes) VALUES ('sub_test', '测试订阅', 'token_test', 1, 0, 1)`); err != nil {
		t.Fatalf("insert subscription: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO subscription_plans (id, name, total_bytes, cycle_type, cycle_day, rate_limit_enabled, rate_limit_per_minute, include_internal_nodes, include_external_nodes) VALUES ('plan_test', '测试套餐', 4096, 'monthly', 6, 1, 20, 0, 1)`); err != nil {
		t.Fatalf("insert plan: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE subscription_subscriptions SET plan_id = 'plan_test' WHERE id = 'sub_test'`); err != nil {
		t.Fatalf("bind plan: %v", err)
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
	if items[0].TotalBytes != 4096 || items[0].CycleDay != 6 {
		t.Fatalf("plan policy was not applied: %#v", items[0])
	}
}

func TestLoadNodesDoesNotQueryQualityWhileRowsOpen(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
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

func TestImportedNodeDefaultsToExternalUnmanagedTrafficUnavailable(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := ensureSchema(ctx, db); err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := insertNode(ctx, tx, Node{ID: "external", SubscriptionID: "profile", Name: "external", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	nodes, err := loadNodes(ctx, db, "profile", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 1 || nodes[0].Ownership != "external" || nodes[0].Management != "unmanaged" || nodes[0].TrafficReporting != "unavailable" {
		t.Fatalf("unexpected imported node classification: %#v", nodes)
	}
}

func TestLoadQualityUsesDailyAverageLatency(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()

	if _, err := db.ExecContext(ctx, `CREATE TABLE server_network_quality_samples (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		server_id TEXT NOT NULL,
		target_name TEXT NOT NULL,
		success INTEGER DEFAULT 0,
		latency_ms REAL,
		checked_at TEXT DEFAULT (datetime('now'))
	)`); err != nil {
		t.Fatalf("create quality samples: %v", err)
	}
	statements := []string{
		`INSERT INTO server_network_quality_samples (server_id, target_name, success, latency_ms, checked_at) VALUES ('server_one', '联通', 1, 100, datetime('now', '-5 minutes'))`,
		`INSERT INTO server_network_quality_samples (server_id, target_name, success, latency_ms, checked_at) VALUES ('server_one', '联通', 1, 200, datetime('now', '-10 minutes'))`,
		`INSERT INTO server_network_quality_samples (server_id, target_name, success, latency_ms, checked_at) VALUES ('server_one', '联通', 0, 900, datetime('now', '-15 minutes'))`,
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("insert quality sample: %v", err)
		}
	}

	quality := loadQuality(ctx, db, "server_one")
	if len(quality) != 1 {
		t.Fatalf("quality = %#v, want one target", quality)
	}
	if quality[0].LatencyMS != 150 || quality[0].AvgLatencyMS != 150 {
		t.Fatalf("latency = %.1f avg = %.1f, want daily average 150", quality[0].LatencyMS, quality[0].AvgLatencyMS)
	}
	if quality[0].LossRate < 33 || quality[0].LossRate > 34 {
		t.Fatalf("loss rate = %.1f, want about 33.3", quality[0].LossRate)
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
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
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
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
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
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
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
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
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
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
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
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
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
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
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

func TestComputeTrafficDoesNotApplyExternalUpstreamUsageToSubscription(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
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
	if info.Upload != 0 || info.Download != 0 || info.Total != 0 || info.Source != "panel" || info.MeteringStatus != "unavailable" {
		t.Fatalf("traffic = %#v", info)
	}
}

func TestPlanOverridesSubscriptionPolicy(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := ensureSchema(ctx, db); err != nil {
		t.Fatal(err)
	}
	_, err = db.ExecContext(ctx, `INSERT INTO subscription_plans(id,name,total_bytes,cycle_type,cycle_day,rate_limit_enabled,rate_limit_per_minute,node_ids,include_internal_nodes,include_external_nodes) VALUES('plan_one','基础套餐',1000,'monthly',8,1,12,'["internal_one","external_one"]',1,1)`)
	if err != nil {
		t.Fatal(err)
	}
	sub := Subscription{PlanID: "plan_one", TotalBytes: 9, CycleType: "none", NodeFilterIDs: []string{"wrong"}}
	applyPlanToSubscription(ctx, db, &sub)
	if sub.TotalBytes != 1000 || sub.CycleType != "monthly" || sub.CycleDay != 8 || sub.RateLimitPerMinute != 12 || len(sub.NodeFilterIDs) != 2 || !sub.IncludeInternalNodes || !sub.IncludeExternalNodes {
		t.Fatalf("plan policy not applied: %#v", sub)
	}
}

func TestExternalNodeTrafficIsNotPartOfPlanUsage(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := ensureSchema(ctx, db); err != nil {
		t.Fatal(err)
	}
	info := computeTraffic(ctx, db, Subscription{PlanID: "plan_one", TotalBytes: 2048, IncludeExternalNodes: true, TrafficSource: "upstream", ManualUploadBytes: 999})
	if info.Upload != 0 || info.Download != 0 || info.Total != 2048 || info.Source != "panel" {
		t.Fatalf("external usage leaked into plan traffic: %#v", info)
	}
}

func TestRefreshUpstreamPreservesBoundNodeProperties(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	upstreamRaw := "vless://0119068b-0148-47bf-875b-2145040b8174@saas.sin.fan:443?security=tls&type=ws&path=/group/live/intro&encryption=none#%F0%9F%87%AD%F0%9F%87%B0%20%E9%A6%99%E6%B8%AF"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Subscription-Userinfo", "upload=1; download=2; total=3; expire=4")
		_, _ = w.Write([]byte(upstreamRaw))
	}))
	defer server.Close()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "data.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()

	if err := ensureSchema(ctx, db); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO subscription_profiles (id, name, enabled) VALUES ('profile_one', '节点库', 1)`); err != nil {
		t.Fatalf("insert profile: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO subscription_subscriptions (id, profile_id, name, public_token, enabled) VALUES ('link_one', 'profile_one', '公开链接', 'token_one', 1)`); err != nil {
		t.Fatalf("insert subscription: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO subscription_upstreams (id, profile_id, name, url, enabled) VALUES ('up_one', 'profile_one', '默认上游', ?, 1)`, server.URL); err != nil {
		t.Fatalf("insert upstream: %v", err)
	}

	nodes := parseImportText(upstreamRaw)
	if len(nodes) != 1 {
		t.Fatalf("parsed nodes = %d, want 1", len(nodes))
	}
	nodes[0].ID = "node_existing"
	nodes[0].SubscriptionID = "profile_one"
	nodes[0].ProfileID = "profile_one"
	nodes[0].Source = "managed"
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	if err := insertNode(ctx, tx, nodes[0]); err != nil {
		t.Fatalf("insert node: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit tx: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE subscription_nodes SET name = '自定义香港', country_code = 'SG', location = '自定义地区', tags = 'stable,premium', traffic_server_id = 'server_one', enabled = 0, stable = 1, sort_order = 7 WHERE id = 'node_existing'`); err != nil {
		t.Fatalf("customize node: %v", err)
	}

	if err := New(config.Config{}).refreshUpstreamNow(ctx, db, "link_one"); err != nil {
		t.Fatalf("refresh upstream: %v", err)
	}

	loaded, err := loadNodes(ctx, db, "profile_one", true)
	if err != nil {
		t.Fatalf("load nodes: %v", err)
	}
	if len(loaded) != 1 {
		t.Fatalf("len(nodes) = %d, want 1", len(loaded))
	}
	node := loaded[0]
	if node.ID != "node_existing" || node.Name != "自定义香港" || node.TrafficServerID != "server_one" || node.Enabled || !node.Stable || node.SortOrder != 7 {
		t.Fatalf("node local fields not preserved: %#v", node)
	}
	if node.CountryCode != "SG" || node.Location != "自定义地区" || node.Tags != "stable,premium" {
		t.Fatalf("node custom labels not preserved: %#v", node)
	}
	if node.Type != "vless" || node.Server != "saas.sin.fan" || node.Port != 443 || !strings.Contains(node.Raw, "vless://") {
		t.Fatalf("node upstream fields not refreshed: %#v", node)
	}
}

func TestComputeTrafficFromNodeBoundServers(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
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

	info := computeTraffic(ctx, db, Subscription{ID: "link_one", ProfileID: "profile_one", TrafficSource: "node_servers", TotalBytes: 50000})
	if info.Upload != 0 || info.Download != 0 || info.Total != 50000 || info.Source != "panel" || info.MeteringStatus != "unavailable" {
		t.Fatalf("traffic = %#v, host NIC totals must not be treated as subscription usage", info)
	}

	filtered := computeTraffic(ctx, db, Subscription{ID: "link_one", ProfileID: "profile_one", TrafficSource: "node_servers", NodeFilterIDs: []string{"node_two"}, TotalBytes: 50000})
	if filtered.Upload != 0 || filtered.Download != 0 || filtered.Total != 50000 || filtered.Source != "panel" || filtered.MeteringStatus != "unavailable" {
		t.Fatalf("filtered traffic = %#v, node filters must not turn host NIC totals into subscription usage", filtered)
	}
}

func TestDeleteSubscriptionKeepsSharedProfile(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
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
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
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

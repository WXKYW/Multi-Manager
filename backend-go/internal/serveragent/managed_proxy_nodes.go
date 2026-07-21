package serveragent

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/iwvw/api-monitor/backend-go/internal/response"
	"github.com/iwvw/api-monitor/backend-go/internal/secure"
	"golang.org/x/crypto/curve25519"
)

type managedProxyNode struct {
	ID           string `json:"id"`
	ServerID     string `json:"server_id"`
	ServerName   string `json:"server_name"`
	Name         string `json:"name"`
	Protocol     string `json:"protocol"`
	Runtime      string `json:"runtime"`
	PublicHost   string `json:"public_host"`
	AssignedPort int    `json:"assigned_port"`
	Transport    string `json:"transport"`
	ClientURI    string `json:"client_uri"`
	Revision     int64  `json:"revision"`
	Enabled      bool   `json:"enabled"`
	Publishable  bool   `json:"publishable"`
	ApplyStatus  string `json:"apply_status"`
	LastError    string `json:"last_error"`
	CreatedAt    string `json:"created_at"`
	UpdatedAt    string `json:"updated_at"`
}

func (s *Service) handleManagedProxyNodes(w http.ResponseWriter, r *http.Request, db *sql.DB, id string) {
	switch {
	case id == "" && r.Method == http.MethodGet:
		s.listManagedProxyNodes(w, r, db)
	case id == "" && r.Method == http.MethodPost:
		s.createManagedProxyNode(w, r, db)
	case id != "" && r.Method == http.MethodDelete:
		s.deleteManagedProxyNode(w, r, db, id)
	case id != "" && r.Method == http.MethodPut:
		s.updateManagedProxyNodeState(w, r, db, id)
	default:
		response.Error(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Service) updateManagedProxyNodeState(w http.ResponseWriter, r *http.Request, db *sql.DB, id string) {
	var input struct {
		Enabled *bool  `json:"enabled"`
		Name    string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&input); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid internal node update")
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name != "" {
		var clientEncrypted string
		if err := db.QueryRowContext(r.Context(), `SELECT client_uri_encrypted FROM managed_proxy_nodes WHERE id=?`, id).Scan(&clientEncrypted); err != nil {
			if err == sql.ErrNoRows {
				response.Error(w, http.StatusNotFound, "internal node not found")
			} else {
				response.Error(w, http.StatusInternalServerError, err.Error())
			}
			return
		}
		client := secure.SecureDecrypt(clientEncrypted)
		if parsed, err := url.Parse(client); err == nil {
			parsed.Fragment = input.Name
			client = parsed.String()
		}
		updatedClient, err := secure.SecureEncrypt(client)
		if err != nil {
			response.Error(w, http.StatusInternalServerError, err.Error())
			return
		}
		result, err := db.ExecContext(r.Context(), `UPDATE managed_proxy_nodes SET name=?,client_uri_encrypted=?,updated_at=datetime('now') WHERE id=?`, input.Name, updatedClient, id)
		if err != nil {
			if strings.Contains(strings.ToLower(err.Error()), "unique") {
				response.Error(w, http.StatusConflict, "this server already has a node with that name")
			} else {
				response.Error(w, http.StatusInternalServerError, err.Error())
			}
			return
		}
		if affected, _ := result.RowsAffected(); affected == 0 {
			response.Error(w, http.StatusNotFound, "internal node not found")
			return
		}
		response.OK(w, map[string]interface{}{"id": id, "name": input.Name})
		return
	}
	if input.Enabled == nil {
		response.Error(w, http.StatusBadRequest, "name or enabled is required")
		return
	}
	result, err := db.ExecContext(r.Context(), `UPDATE managed_proxy_nodes SET enabled=?,publishable=CASE WHEN ?=1 THEN publishable ELSE 0 END,revision=revision+1,updated_at=datetime('now') WHERE id=?`, boolToInt(*input.Enabled), boolToInt(*input.Enabled), id)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		response.Error(w, http.StatusNotFound, "internal node not found")
		return
	}
	s.reconcileManagedProxyNode(w, r, db, id)
}

func (s *Service) listManagedProxyNodes(w http.ResponseWriter, r *http.Request, db *sql.DB) {
	rows, err := db.QueryContext(r.Context(), `SELECT n.id,n.server_id,COALESCE(a.name,''),n.name,n.protocol,n.runtime,n.public_host,n.assigned_port,n.transport,n.client_uri_encrypted,n.revision,n.enabled,n.publishable,n.apply_status,n.last_error,n.created_at,n.updated_at FROM managed_proxy_nodes n LEFT JOIN server_accounts a ON a.id=n.server_id ORDER BY n.created_at DESC`)
	if err != nil {
		response.Error(w, 500, err.Error())
		return
	}
	defer rows.Close()
	nodes := []managedProxyNode{}
	for rows.Next() {
		var node managedProxyNode
		var client string
		var enabled, publishable int
		if err := rows.Scan(&node.ID, &node.ServerID, &node.ServerName, &node.Name, &node.Protocol, &node.Runtime, &node.PublicHost, &node.AssignedPort, &node.Transport, &client, &node.Revision, &enabled, &publishable, &node.ApplyStatus, &node.LastError, &node.CreatedAt, &node.UpdatedAt); err != nil {
			response.Error(w, 500, err.Error())
			return
		}
		node.Enabled, node.Publishable = enabled == 1, publishable == 1
		node.ClientURI = secure.SecureDecrypt(client)
		nodes = append(nodes, node)
	}
	response.OK(w, nodes)
}

func (s *Service) createManagedProxyNode(w http.ResponseWriter, r *http.Request, db *sql.DB) {
	var input struct {
		ServerID       string `json:"server_id"`
		Name           string `json:"name"`
		Protocol       string `json:"protocol"`
		PublicHost     string `json:"public_host"`
		ServerName     string `json:"server_name"`
		CertificatePEM string `json:"certificate_pem"`
		PrivateKeyPEM  string `json:"private_key_pem"`
		Enabled        *bool  `json:"enabled"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&input); err != nil {
		response.Error(w, 400, "invalid internal node")
		return
	}
	input.ServerID, input.Name, input.Protocol, input.PublicHost = strings.TrimSpace(input.ServerID), strings.TrimSpace(input.Name), strings.ToLower(strings.TrimSpace(input.Protocol)), strings.TrimSpace(input.PublicHost)
	if input.ServerID == "" {
		response.Error(w, 400, "server_id is required")
		return
	}
	if input.Protocol != "vless-reality" && input.Protocol != "hysteria2" {
		response.Error(w, 400, "protocol must be vless-reality or hysteria2")
		return
	}
	var accountHost, accountName, accountCountry, accountResolvedCountry, accountCachedInfo string
	if err := db.QueryRowContext(r.Context(), `SELECT COALESCE(host,''),COALESCE(name,''),COALESCE(country,''),COALESCE(resolved_country,''),COALESCE(cached_info,'{}') FROM server_accounts WHERE id=?`, input.ServerID).Scan(&accountHost, &accountName, &accountCountry, &accountResolvedCountry, &accountCachedInfo); err != nil {
		response.Error(w, 404, "server not found")
		return
	}
	// Connection addressing belongs to the host instance. The caller only
	// chooses the node identity/protocol; changing a host address is done from
	// Host Instances and is picked up by the next deployment.
	input.PublicHost = strings.TrimSpace(accountHost)
	if input.PublicHost == "" || input.PublicHost == "0.0.0.0" {
		response.Error(w, 400, "host instance has no deployable address")
		return
	}
	if input.Name == "" {
		label := "VLESS"
		if input.Protocol == "hysteria2" {
			label = "HY2"
		}
		cached := map[string]interface{}{}
		_ = json.Unmarshal([]byte(accountCachedInfo), &cached)
		countryCode := firstNonEmpty(cleanCountryCode(getString(cached, "country_code")), cleanCountryCode(getString(cached, "country")), cleanCountryCode(accountCountry), cleanCountryCode(accountResolvedCountry))
		flag := countryFlag(countryCode)
		input.Name = strings.TrimSpace(strings.TrimSpace(flag+" ") + accountName + " " + label)
	}
	if input.Protocol == "hysteria2" && (input.CertificatePEM == "" || input.PrivateKeyPEM == "") {
		cert, key, certErr := generateManagedTLSCertificate(input.PublicHost)
		if certErr != nil {
			response.Error(w, 500, "generate managed TLS certificate: "+certErr.Error())
			return
		}
		input.CertificatePEM, input.PrivateKeyPEM = cert, key
	}
	id := "mnode-" + uuid.NewString()
	config, clientURI, transport, err := generateManagedNode(id, input.Name, input.Protocol, input.PublicHost, input.ServerName, input.CertificatePEM, input.PrivateKeyPEM)
	if err != nil {
		response.Error(w, 400, err.Error())
		return
	}
	configEncrypted, err := secure.SecureEncrypt(config)
	if err != nil {
		response.Error(w, 500, err.Error())
		return
	}
	clientEncrypted, err := secure.SecureEncrypt(clientURI)
	if err != nil {
		response.Error(w, 500, err.Error())
		return
	}
	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	_, err = db.ExecContext(r.Context(), `INSERT INTO managed_proxy_nodes(id,server_id,name,protocol,runtime,public_host,assigned_port,transport,config_encrypted,client_uri_encrypted,revision,enabled,publishable,apply_status) VALUES(?,?,?,?,?,?,0,?,?,?,?,?,0,'pending')`, id, input.ServerID, input.Name, input.Protocol, "sing-box", input.PublicHost, transport, configEncrypted, clientEncrypted, 1, boolToInt(enabled))
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			response.Error(w, 409, "this server already has a node with that name")
		} else {
			response.Error(w, 500, err.Error())
		}
		return
	}
	s.reconcileManagedProxyNode(w, r, db, id)
}

func countryFlag(countryCode string) string {
	code := strings.ToUpper(strings.TrimSpace(countryCode))
	if len(code) != 2 || code[0] < 'A' || code[0] > 'Z' || code[1] < 'A' || code[1] > 'Z' {
		return ""
	}
	return string([]rune{rune(0x1F1E6) + rune(code[0]-'A'), rune(0x1F1E6) + rune(code[1]-'A')})
}

func generateManagedNode(id, name, protocol, host, serverName, cert, key string) (string, string, string, error) {
	if protocol == "vless-reality" {
		if serverName == "" {
			serverName = "www.cloudflare.com"
		}
		private := make([]byte, 32)
		if _, err := rand.Read(private); err != nil {
			return "", "", "", err
		}
		private[0] &= 248
		private[31] &= 127
		private[31] |= 64
		public, err := curve25519.X25519(private, curve25519.Basepoint)
		if err != nil {
			return "", "", "", err
		}
		shortBytes := make([]byte, 4)
		_, _ = rand.Read(shortBytes)
		shortID := hex.EncodeToString(shortBytes)
		userID := uuid.NewString()
		privateKey := base64.RawURLEncoding.EncodeToString(private)
		publicKey := base64.RawURLEncoding.EncodeToString(public)
		inbound := map[string]interface{}{
			"type": "vless", "tag": id, "listen": "::", "listen_port": 0,
			"users": []interface{}{map[string]interface{}{"uuid": userID, "flow": "xtls-rprx-vision"}},
			"tls": map[string]interface{}{
				"enabled": true, "server_name": serverName,
				"reality": map[string]interface{}{
					"enabled":     true,
					"handshake":   map[string]interface{}{"server": serverName, "server_port": 443},
					"private_key": privateKey, "short_id": []string{shortID},
				},
			},
		}
		root := map[string]interface{}{"log": map[string]interface{}{"level": "warn"}, "inbounds": []interface{}{inbound}, "outbounds": []interface{}{map[string]interface{}{"type": "direct", "tag": "direct"}}}
		encoded, _ := json.Marshal(root)
		q := url.Values{"encryption": {"none"}, "flow": {"xtls-rprx-vision"}, "security": {"reality"}, "sni": {serverName}, "fp": {"chrome"}, "pbk": {publicKey}, "sid": {shortID}, "type": {"tcp"}}
		return string(encoded), fmt.Sprintf("vless://%s@%s:0?%s#%s", userID, host, q.Encode(), url.QueryEscape(name)), "tcp", nil
	}
	if strings.TrimSpace(serverName) == "" {
		serverName = host
	}
	if !strings.Contains(cert, "BEGIN CERTIFICATE") || !strings.Contains(key, "BEGIN") {
		return "", "", "", errors.New("Hysteria2 TLS certificate generation failed")
	}
	passwordBytes := make([]byte, 24)
	_, _ = rand.Read(passwordBytes)
	password := base64.RawURLEncoding.EncodeToString(passwordBytes)
	inbound := map[string]interface{}{
		"type": "hysteria2", "tag": id, "listen": "::", "listen_port": 0,
		"users": []interface{}{map[string]interface{}{"password": password}},
		"tls":   map[string]interface{}{"enabled": true, "server_name": serverName, "certificate": strings.Split(strings.TrimSpace(cert), "\n"), "key": strings.Split(strings.TrimSpace(key), "\n")},
	}
	root := map[string]interface{}{"log": map[string]interface{}{"level": "warn"}, "inbounds": []interface{}{inbound}, "outbounds": []interface{}{map[string]interface{}{"type": "direct", "tag": "direct"}}}
	encoded, _ := json.Marshal(root)
	q := url.Values{"sni": {serverName}, "insecure": {"1"}}
	return string(encoded), fmt.Sprintf("hysteria2://%s@%s:0?%s#%s", password, host, q.Encode(), url.QueryEscape(name)), "udp", nil
}

func generateManagedTLSCertificate(host string) (string, string, error) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return "", "", err
	}
	serialLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, serialLimit)
	if err != nil {
		return "", "", err
	}
	now := time.Now().UTC()
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: host, Organization: []string{"API Monitor Managed Node"}},
		NotBefore:    now.Add(-5 * time.Minute), NotAfter: now.AddDate(1, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	if ip := net.ParseIP(host); ip != nil {
		template.IPAddresses = []net.IP{ip}
	} else {
		template.DNSNames = []string{host}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &privateKey.PublicKey, privateKey)
	if err != nil {
		return "", "", err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(privateKey)})
	return string(certPEM), string(keyPEM), nil
}

func (s *Service) reconcileManagedProxyNode(w http.ResponseWriter, r *http.Request, db *sql.DB, id string) {
	var serverID, runtime, configEncrypted, transport string
	var revision int64
	var enabled int
	var requestedPort int
	err := db.QueryRowContext(r.Context(), `SELECT server_id,runtime,config_encrypted,revision,enabled,assigned_port,transport FROM managed_proxy_nodes WHERE id=?`, id).Scan(&serverID, &runtime, &configEncrypted, &revision, &enabled, &requestedPort, &transport)
	if err == sql.ErrNoRows {
		response.Error(w, 404, "internal node not found")
		return
	}
	if err != nil {
		response.Error(w, 500, err.Error())
		return
	}
	release, _ := managedProxyRuntime(runtime)
	payload, _ := json.Marshal(map[string]interface{}{"node_id": id, "revision": revision, "runtime": "sing-box", "runtime_version": release.Version, "asset_url_amd64": release.AMD64URL, "asset_sha256_amd64": release.AMD64SHA256, "asset_url_arm64": release.ARM64URL, "asset_sha256_arm64": release.ARM64SHA256, "config": secure.SecureDecrypt(configEncrypted), "enabled": enabled == 1, "requested_port": requestedPort, "port_min": 45654, "port_max": 55654, "transport": transport})
	result, runErr := s.RunProxyRuntimeTaskAndWait(serverID, string(payload))
	if runErr != nil {
		_, _ = db.ExecContext(r.Context(), `UPDATE managed_proxy_nodes SET apply_status='failed',publishable=0,last_error=?,updated_at=datetime('now') WHERE id=?`, runErr.Error(), id)
		response.Error(w, 502, runErr.Error())
		return
	}
	var applied struct {
		AssignedPort int    `json:"assigned_port"`
		Config       string `json:"config"`
		Status       string `json:"status"`
	}
	if err := json.Unmarshal([]byte(result), &applied); err != nil || applied.AssignedPort < 45654 || applied.AssignedPort > 55654 {
		response.Error(w, 502, "Agent returned invalid node binding")
		return
	}
	if err := verifyManagedNodeReachability(statePublicHost(r.Context(), db, id), applied.AssignedPort, transport); err != nil {
		_, _ = db.ExecContext(r.Context(), `UPDATE managed_proxy_nodes SET assigned_port=?,apply_status='unreachable',publishable=0,last_error=?,updated_at=datetime('now') WHERE id=?`, applied.AssignedPort, err.Error(), id)
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	updatedConfig, _ := secure.SecureEncrypt(applied.Config)
	var clientEncrypted string
	_ = db.QueryRowContext(r.Context(), `SELECT client_uri_encrypted FROM managed_proxy_nodes WHERE id=?`, id).Scan(&clientEncrypted)
	client := secure.SecureDecrypt(clientEncrypted)
	client = replaceURIClientPort(client, applied.AssignedPort)
	updatedClient, _ := secure.SecureEncrypt(client)
	_, _ = db.ExecContext(r.Context(), `UPDATE managed_proxy_nodes SET assigned_port=?,config_encrypted=?,client_uri_encrypted=?,apply_status='running',publishable=1,last_error='',updated_at=datetime('now') WHERE id=?`, applied.AssignedPort, updatedConfig, updatedClient, id)
	response.OK(w, map[string]interface{}{"id": id, "server_id": serverID, "assigned_port": applied.AssignedPort, "status": "running", "client_uri": client})
}

func statePublicHost(ctx context.Context, db *sql.DB, id string) string {
	var host string
	_ = db.QueryRowContext(ctx, `SELECT public_host FROM managed_proxy_nodes WHERE id=?`, id).Scan(&host)
	return host
}

func verifyManagedNodeReachability(host string, port int, transport string) error {
	if strings.TrimSpace(host) == "" {
		return errors.New("managed node public host is empty")
	}
	if transport == "udp" {
		return nil
	} // UDP has no transport handshake; runtime active state is the local health signal.
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), 5*time.Second)
	if err != nil {
		return fmt.Errorf("managed node is not externally reachable at %s:%d: %w", host, port, err)
	}
	_ = conn.Close()
	return nil
}

func replaceURIClientPort(raw string, port int) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	parsed.Host = parsed.Hostname() + ":" + strconv.Itoa(port)
	return parsed.String()
}

func loadPublishableManagedNodes(ctx context.Context, db *sql.DB) ([]managedProxyNode, error) {
	rows, err := db.QueryContext(ctx, `SELECT id,server_id,name,protocol,runtime,public_host,assigned_port,transport,client_uri_encrypted,revision,enabled,publishable,apply_status,last_error,created_at,updated_at FROM managed_proxy_nodes WHERE enabled=1 AND publishable=1 AND apply_status='running' ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	nodes := []managedProxyNode{}
	for rows.Next() {
		var node managedProxyNode
		var client string
		var enabled, publishable int
		if err := rows.Scan(&node.ID, &node.ServerID, &node.Name, &node.Protocol, &node.Runtime, &node.PublicHost, &node.AssignedPort, &node.Transport, &client, &node.Revision, &enabled, &publishable, &node.ApplyStatus, &node.LastError, &node.CreatedAt, &node.UpdatedAt); err != nil {
			return nil, err
		}
		node.Enabled, node.Publishable = enabled == 1, publishable == 1
		node.ClientURI = secure.SecureDecrypt(client)
		nodes = append(nodes, node)
	}
	return nodes, rows.Err()
}

func (s *Service) deleteManagedProxyNode(w http.ResponseWriter, r *http.Request, db *sql.DB, id string) {
	var serverID, runtime string
	var revision int64
	if err := db.QueryRowContext(r.Context(), `SELECT server_id,runtime,revision FROM managed_proxy_nodes WHERE id=?`, id).Scan(&serverID, &runtime, &revision); err != nil {
		if err == sql.ErrNoRows {
			response.Error(w, 404, "internal node not found")
		} else {
			response.Error(w, 500, err.Error())
		}
		return
	}
	release, _ := managedProxyRuntime(runtime)
	payload, _ := json.Marshal(map[string]interface{}{"node_id": id, "revision": revision + 1, "runtime": "sing-box", "runtime_version": release.Version, "asset_url_amd64": release.AMD64URL, "asset_sha256_amd64": release.AMD64SHA256, "asset_url_arm64": release.ARM64URL, "asset_sha256_arm64": release.ARM64SHA256, "config": "{}", "remove": true, "port_min": 45654, "port_max": 55654})
	if _, err := s.RunProxyRuntimeTaskAndWait(serverID, string(payload)); err != nil {
		response.Error(w, 502, err.Error())
		return
	}
	_, _ = db.ExecContext(r.Context(), `DELETE FROM managed_proxy_nodes WHERE id=?`, id)
	response.OK(w, map[string]bool{"deleted": true})
}

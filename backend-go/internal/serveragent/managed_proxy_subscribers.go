package serveragent

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/iwvw/api-monitor/backend-go/internal/subscriptionledger"
)

// bindManagedNodeSubscribers replaces the node bootstrap credential with the
// complete, currently entitled subscriber set. Subscription IDs are used as
// sing-box user names so per-user counters can be attributed without exposing
// the public download token.
func bindManagedNodeSubscribers(ctx context.Context, db *sql.DB, nodeID, protocol, raw string) (string, int, error) {
	credentials, err := subscriptionledger.ActiveCredentialsForNode(ctx, db, nodeID, protocol, time.Now().UTC())
	if err != nil {
		return "", 0, err
	}
	var root map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &root); err != nil {
		return "", 0, fmt.Errorf("decode managed node config: %w", err)
	}
	inbounds, ok := root["inbounds"].([]interface{})
	if !ok || len(inbounds) != 1 {
		return "", 0, errors.New("managed node config must contain exactly one inbound")
	}
	inbound, ok := inbounds[0].(map[string]interface{})
	if !ok {
		return "", 0, errors.New("managed node inbound is invalid")
	}
	users := make([]interface{}, 0, len(credentials))
	protocol = strings.ToLower(strings.TrimSpace(protocol))
	for _, credential := range credentials {
		switch protocol {
		case "vless-reality":
			if credential.VLESSUUID != "" {
				users = append(users, map[string]interface{}{"name": credential.SubscriptionID, "uuid": credential.VLESSUUID, "flow": "xtls-rprx-vision"})
			}
		case "vless-ws-tunnel", "vless":
			if credential.VLESSUUID != "" {
				users = append(users, map[string]interface{}{"name": credential.SubscriptionID, "uuid": credential.VLESSUUID})
			}
		case "hysteria2", "hy2":
			if credential.Hysteria2Password != "" {
				users = append(users, map[string]interface{}{"name": credential.SubscriptionID, "password": credential.Hysteria2Password})
			}
		default:
			return "", 0, fmt.Errorf("unsupported managed node protocol %q", protocol)
		}
	}
	inbound["users"] = users
	userNames := make([]interface{}, 0, len(credentials))
	for _, credential := range credentials {
		userNames = append(userNames, credential.SubscriptionID)
	}
	experimental, _ := root["experimental"].(map[string]interface{})
	if experimental == nil {
		experimental = map[string]interface{}{}
		root["experimental"] = experimental
	}
	experimental["v2ray_api"] = map[string]interface{}{
		"listen": "127.0.0.1:0",
		"stats":  map[string]interface{}{"enabled": true, "users": userNames},
	}
	encoded, err := json.Marshal(root)
	if err != nil {
		return "", 0, fmt.Errorf("encode managed node config: %w", err)
	}
	return string(encoded), len(users), nil
}

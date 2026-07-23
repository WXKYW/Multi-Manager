package serveragent

import (
	"context"
	"database/sql"
	"net"
	"strings"
)

// backfillAccountHostFromAgent fills only an unset/unspecified instance
// address. The conditional UPDATE is intentional: a concurrent manual edit
// always wins and established hostnames or IP addresses are never replaced by
// telemetry.
func backfillAccountHostFromAgent(ctx context.Context, db *sql.DB, serverID string, metadata map[string]interface{}) (string, bool, error) {
	host := validatedAgentHost(metadata)
	if host == "" {
		return "", false, nil
	}
	result, err := db.ExecContext(ctx, `UPDATE server_accounts
		SET host=?,updated_at=datetime('now')
		WHERE id=? AND LOWER(TRIM(COALESCE(host,''))) IN ('','0.0.0.0','::','[::]')`, host, serverID)
	if err != nil {
		return "", false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return "", false, err
	}
	return host, affected > 0, nil
}

func validatedAgentHost(metadata map[string]interface{}) string {
	platform := strings.ToLower(strings.TrimSpace(getString(metadata, "platform")))
	if !strings.Contains(platform, "linux") {
		return ""
	}
	publicIP := validAgentIP(firstNonEmpty(getString(metadata, "public_ip"), getString(metadata, "ip")))
	connectionIP := validAgentIP(getString(metadata, "connection_ip"))
	if publicIP == nil || connectionIP == nil || !publicIP.Equal(connectionIP) {
		return ""
	}
	return publicIP.String()
}

func validAgentIP(value string) net.IP {
	parsed := net.ParseIP(strings.Trim(strings.TrimSpace(value), "[]"))
	if parsed == nil || parsed.IsUnspecified() || parsed.IsLoopback() || parsed.IsMulticast() || parsed.IsLinkLocalUnicast() {
		return nil
	}
	return parsed
}

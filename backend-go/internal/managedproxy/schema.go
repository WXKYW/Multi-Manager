package managedproxy

import (
	"context"
	"database/sql"
	"fmt"
)

// NodeTableDDL is shared by the subscription control plane and the Agent
// runtime service. Keeping one canonical definition prevents startup order
// from silently producing different managed-node schemas.
const NodeTableDDL = `CREATE TABLE IF NOT EXISTS managed_proxy_nodes (
	id TEXT PRIMARY KEY,
	server_id TEXT NOT NULL,
	name TEXT NOT NULL,
	protocol TEXT NOT NULL CHECK(protocol IN ('vless-reality', 'hysteria2', 'vless-ws-tunnel')),
	runtime TEXT NOT NULL DEFAULT 'sing-box',
	public_host TEXT NOT NULL,
	assigned_port INTEGER NOT NULL DEFAULT 0,
	stats_port INTEGER NOT NULL DEFAULT 0,
	transport TEXT NOT NULL CHECK(transport IN ('tcp', 'udp')),
	config_encrypted TEXT NOT NULL,
	client_uri_encrypted TEXT NOT NULL,
	revision INTEGER NOT NULL DEFAULT 1,
	enabled INTEGER NOT NULL DEFAULT 1,
	publishable INTEGER NOT NULL DEFAULT 0,
	apply_status TEXT NOT NULL DEFAULT 'pending',
	last_error TEXT NOT NULL DEFAULT '',
	observed_status TEXT NOT NULL DEFAULT 'unknown',
	observed_revision INTEGER NOT NULL DEFAULT 0,
	observed_port INTEGER NOT NULL DEFAULT 0,
	observed_at TEXT,
	health_status TEXT NOT NULL DEFAULT 'unknown',
	access_mode TEXT NOT NULL DEFAULT 'direct',
	tunnel_path TEXT NOT NULL DEFAULT '',
	preferred_address_id TEXT NOT NULL DEFAULT '',
	connect_address TEXT NOT NULL DEFAULT '',
	connect_port INTEGER NOT NULL DEFAULT 0,
	tunnel_hostname TEXT NOT NULL DEFAULT '',
	created_at TEXT DEFAULT (datetime('now')),
	updated_at TEXT DEFAULT (datetime('now')),
	FOREIGN KEY (server_id) REFERENCES server_accounts(id) ON DELETE CASCADE
)`

var nodeColumnMigrations = []struct {
	name string
	sql  string
}{
	{"stats_port", "ALTER TABLE managed_proxy_nodes ADD COLUMN stats_port INTEGER NOT NULL DEFAULT 0"},
	{"access_mode", "ALTER TABLE managed_proxy_nodes ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'direct'"},
	{"tunnel_path", "ALTER TABLE managed_proxy_nodes ADD COLUMN tunnel_path TEXT NOT NULL DEFAULT ''"},
	{"preferred_address_id", "ALTER TABLE managed_proxy_nodes ADD COLUMN preferred_address_id TEXT NOT NULL DEFAULT ''"},
	{"connect_address", "ALTER TABLE managed_proxy_nodes ADD COLUMN connect_address TEXT NOT NULL DEFAULT ''"},
	{"connect_port", "ALTER TABLE managed_proxy_nodes ADD COLUMN connect_port INTEGER NOT NULL DEFAULT 0"},
	{"tunnel_hostname", "ALTER TABLE managed_proxy_nodes ADD COLUMN tunnel_hostname TEXT NOT NULL DEFAULT ''"},
	{"observed_status", "ALTER TABLE managed_proxy_nodes ADD COLUMN observed_status TEXT NOT NULL DEFAULT 'unknown'"},
	{"observed_revision", "ALTER TABLE managed_proxy_nodes ADD COLUMN observed_revision INTEGER NOT NULL DEFAULT 0"},
	{"observed_port", "ALTER TABLE managed_proxy_nodes ADD COLUMN observed_port INTEGER NOT NULL DEFAULT 0"},
	{"observed_at", "ALTER TABLE managed_proxy_nodes ADD COLUMN observed_at TEXT"},
	{"health_status", "ALTER TABLE managed_proxy_nodes ADD COLUMN health_status TEXT NOT NULL DEFAULT 'unknown'"},
}

func EnsureNodeColumns(ctx context.Context, db *sql.DB) error {
	columns, err := tableColumns(ctx, db, "managed_proxy_nodes")
	if err != nil {
		return err
	}
	for _, migration := range nodeColumnMigrations {
		if columns[migration.name] {
			continue
		}
		if _, err := db.ExecContext(ctx, migration.sql); err != nil {
			return fmt.Errorf("migrate managed proxy node %s: %w", migration.name, err)
		}
		columns[migration.name] = true
	}
	return nil
}

func tableColumns(ctx context.Context, db *sql.DB, table string) (map[string]bool, error) {
	rows, err := db.QueryContext(ctx, `PRAGMA table_info(`+table+`)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, kind string
		var notNull, primaryKey int
		var defaultValue interface{}
		if err := rows.Scan(&cid, &name, &kind, &notNull, &defaultValue, &primaryKey); err != nil {
			return nil, err
		}
		columns[name] = true
	}
	return columns, rows.Err()
}

package serveragent

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/iwvw/api-monitor/backend-go/internal/reconcilequeue"
)

const legacyTunnelSubscriberFlowMigration = "managed_proxy_tunnel_vless_ws_flow_v1"

// repairLegacyTunnelSubscriberFlow queues a one-time reapply for Tunnel nodes
// created before Tunnel subscribers were separated from REALITY subscribers.
// The transaction makes the marker and queue entries atomic, so a restart can
// safely retry the migration without leaving a half-repaired node published.
func repairLegacyTunnelSubscriberFlow(ctx context.Context, db *sql.DB) error {
	var marker string
	err := db.QueryRowContext(ctx, `SELECT value FROM system_config WHERE key=?`, legacyTunnelSubscriberFlowMigration).Scan(&marker)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("inspect legacy Tunnel migration: %w", err)
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin legacy Tunnel migration: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	rows, err := tx.QueryContext(ctx, `SELECT id FROM managed_proxy_nodes WHERE access_mode='cloudflare_tunnel' AND enabled=1 AND apply_status='running' ORDER BY id`)
	if err != nil {
		return fmt.Errorf("load legacy Tunnel nodes: %w", err)
	}
	var nodeIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return fmt.Errorf("scan legacy Tunnel node: %w", err)
		}
		nodeIDs = append(nodeIDs, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("iterate legacy Tunnel nodes: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close legacy Tunnel nodes: %w", err)
	}

	if err := reconcilequeue.EnqueueNodes(ctx, tx, nodeIDs, "repair legacy Tunnel VLESS transport"); err != nil {
		return err
	}
	if len(nodeIDs) > 0 {
		if _, err := tx.ExecContext(ctx, `UPDATE managed_proxy_nodes
			SET revision=revision+1,apply_status='pending',publishable=0,last_error='等待 Tunnel 配置自动修复',updated_at=datetime('now')
			WHERE access_mode='cloudflare_tunnel' AND enabled=1 AND apply_status='running'`); err != nil {
			return fmt.Errorf("mark legacy Tunnel nodes for repair: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO system_config(key,value,description,updated_at) VALUES(?,?,?,datetime('now'))`, legacyTunnelSubscriberFlowMigration, "completed", "one-time repair for legacy Tunnel subscriber flow"); err != nil {
		return fmt.Errorf("record legacy Tunnel migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit legacy Tunnel migration: %w", err)
	}
	committed = true
	return nil
}

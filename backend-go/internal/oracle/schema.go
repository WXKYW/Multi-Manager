package oracle

import (
	"context"
	"database/sql"
	"fmt"
)

func ensureSchema(ctx context.Context, db *sql.DB) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS oracle_accounts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			tenancy_ocid TEXT NOT NULL,
			user_ocid TEXT NOT NULL,
			fingerprint TEXT NOT NULL,
			region TEXT NOT NULL,
			private_key_encrypted TEXT NOT NULL,
			passphrase_encrypted TEXT,
			default_compartment_id TEXT,
			description TEXT,
			last_verified_at DATETIME,
			last_verify_status TEXT,
			last_verify_error TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_oracle_accounts_created_at ON oracle_accounts(created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_oracle_accounts_region ON oracle_accounts(region)`,
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("ensure oracle schema: %w", err)
		}
	}
	return nil
}

package drawio

import (
	"context"
	"database/sql"
)

func ensureSchema(ctx context.Context, db *sql.DB) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS drawio_documents (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			title TEXT NOT NULL,
			description TEXT DEFAULT '',
			tags_json TEXT DEFAULT '[]',
			archived INTEGER DEFAULT 0,
			page_count INTEGER DEFAULT 1,
			page_names_json TEXT DEFAULT '[]',
			cover_page_id TEXT DEFAULT '',
			cover_page_name TEXT DEFAULT '',
			current_draft_rev INTEGER DEFAULT 1,
			latest_version_id INTEGER,
			latest_version_no INTEGER DEFAULT 0,
			thumbnail_path TEXT DEFAULT '',
			thumbnail_status TEXT DEFAULT 'missing',
			thumbnail_error TEXT DEFAULT '',
			thumbnail_updated_at TEXT DEFAULT '',
			last_external_asset_scan_at TEXT DEFAULT '',
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_drawio_documents_updated_at ON drawio_documents(updated_at)`,
		`CREATE INDEX IF NOT EXISTS idx_drawio_documents_archived_updated ON drawio_documents(archived, updated_at)`,
		`CREATE INDEX IF NOT EXISTS idx_drawio_documents_title ON drawio_documents(title)`,

		`CREATE TABLE IF NOT EXISTS drawio_drafts (
			document_id INTEGER PRIMARY KEY,
			xml_content TEXT NOT NULL,
			xml_hash TEXT NOT NULL,
			base_version_id INTEGER,
			editor_state_json TEXT DEFAULT '{}',
			external_assets_json TEXT DEFAULT '[]',
			last_active_page_id TEXT DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`,

		`CREATE TABLE IF NOT EXISTS drawio_versions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			document_id INTEGER NOT NULL,
			version_no INTEGER NOT NULL,
			xml_content TEXT NOT NULL,
			xml_hash TEXT NOT NULL,
			summary TEXT DEFAULT '',
			page_count INTEGER DEFAULT 1,
			cover_page_id TEXT DEFAULT '',
			cover_page_name TEXT DEFAULT '',
			thumbnail_path TEXT DEFAULT '',
			thumbnail_status TEXT DEFAULT 'missing',
			thumbnail_error TEXT DEFAULT '',
			thumbnail_updated_at TEXT DEFAULT '',
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_drawio_versions_doc_version ON drawio_versions(document_id, version_no)`,
		`CREATE INDEX IF NOT EXISTS idx_drawio_versions_document_created ON drawio_versions(document_id, created_at)`,

		`CREATE TABLE IF NOT EXISTS drawio_assets (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			document_id INTEGER NOT NULL,
			owner_kind TEXT NOT NULL,
			owner_id INTEGER NOT NULL,
			source_kind TEXT NOT NULL,
			original_url TEXT DEFAULT '',
			local_path TEXT DEFAULT '',
			mime_type TEXT DEFAULT '',
			status TEXT NOT NULL DEFAULT 'active',
			width INTEGER,
			height INTEGER,
			size_bytes INTEGER DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`,

		`CREATE TABLE IF NOT EXISTS drawio_render_jobs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			document_id INTEGER NOT NULL,
			version_id INTEGER,
			source_kind TEXT NOT NULL,
			target_kind TEXT NOT NULL,
			format TEXT NOT NULL,
			trigger_source TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			attempt_count INTEGER DEFAULT 0,
			last_error TEXT DEFAULT '',
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			started_at TEXT DEFAULT '',
			finished_at TEXT DEFAULT ''
		)`,

		`CREATE TABLE IF NOT EXISTS drawio_settings (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			default_export_format TEXT DEFAULT 'drawio',
			default_theme_mode TEXT DEFAULT 'system',
			autosave_enabled INTEGER DEFAULT 1,
			autosave_debounce_ms INTEGER DEFAULT 2000,
			document_size_limit_bytes INTEGER DEFAULT 5242880,
			version_soft_limit INTEGER DEFAULT 100,
			allow_external_assets INTEGER DEFAULT 1,
			block_private_network_assets INTEGER DEFAULT 1,
			thumbnail_format TEXT DEFAULT 'svg',
			thumbnail_max_width INTEGER DEFAULT 480,
			thumbnail_max_height INTEGER DEFAULT 320,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`,

		`INSERT OR IGNORE INTO drawio_settings (id) VALUES (1)`,
	}

	for _, stmt := range statements {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

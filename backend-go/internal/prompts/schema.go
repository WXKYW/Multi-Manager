package prompts

import (
	"context"
	"database/sql"
)

func ensureSchema(ctx context.Context, db *sql.DB) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS prompt_collections (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			parent_id INTEGER,
			name TEXT NOT NULL,
			description TEXT DEFAULT '',
			icon TEXT DEFAULT '',
			color_token TEXT DEFAULT '',
			sort_order INTEGER DEFAULT 0,
			archived INTEGER DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_prompt_collections_parent_sort ON prompt_collections(parent_id, sort_order)`,
		`CREATE INDEX IF NOT EXISTS idx_prompt_collections_archived ON prompt_collections(archived)`,

		`CREATE TABLE IF NOT EXISTS prompt_entries (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			collection_id INTEGER,
			title TEXT NOT NULL,
			internal_slug TEXT NOT NULL,
			public_id TEXT NOT NULL,
			summary TEXT DEFAULT '',
			tags_json TEXT DEFAULT '[]',
			starred INTEGER DEFAULT 0,
			archived INTEGER DEFAULT 0,
			visibility TEXT NOT NULL DEFAULT 'unlisted',
			current_draft_rev INTEGER DEFAULT 1,
			latest_published_version_id INTEGER,
			latest_published_version_no INTEGER DEFAULT 0,
			latest_published_at TEXT DEFAULT '',
			published_char_count INTEGER DEFAULT 0,
			published_word_count INTEGER DEFAULT 0,
			outline_json TEXT DEFAULT '[]',
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_entries_slug ON prompt_entries(internal_slug)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_entries_public_id ON prompt_entries(public_id)`,
		`CREATE INDEX IF NOT EXISTS idx_prompt_entries_collection_updated ON prompt_entries(collection_id, updated_at)`,
		`CREATE INDEX IF NOT EXISTS idx_prompt_entries_visibility ON prompt_entries(visibility)`,
		`CREATE INDEX IF NOT EXISTS idx_prompt_entries_starred ON prompt_entries(starred, updated_at)`,

		`CREATE TABLE IF NOT EXISTS prompt_drafts (
			entry_id INTEGER PRIMARY KEY,
			content_md TEXT NOT NULL,
			content_text TEXT NOT NULL,
			outline_json TEXT DEFAULT '[]',
			variables_json TEXT DEFAULT '[]',
			excerpt_text TEXT DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`,

		`CREATE TABLE IF NOT EXISTS prompt_versions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			entry_id INTEGER NOT NULL,
			version_no INTEGER NOT NULL,
			content_md TEXT NOT NULL,
			content_text TEXT NOT NULL,
			outline_json TEXT DEFAULT '[]',
			variables_json TEXT DEFAULT '[]',
			excerpt_text TEXT DEFAULT '',
			checksum TEXT NOT NULL,
			char_count INTEGER DEFAULT 0,
			word_count INTEGER DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_versions_entry_version ON prompt_versions(entry_id, version_no)`,
		`CREATE INDEX IF NOT EXISTS idx_prompt_versions_entry_created ON prompt_versions(entry_id, created_at)`,

		`CREATE TABLE IF NOT EXISTS prompt_access_logs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			entry_id INTEGER NOT NULL,
			version_id INTEGER,
			route_kind TEXT NOT NULL,
			response_format TEXT NOT NULL,
			ip_hash TEXT DEFAULT '',
			user_agent TEXT DEFAULT '',
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`,

		`CREATE TABLE IF NOT EXISTS prompt_settings (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			default_visibility TEXT DEFAULT 'unlisted',
			default_direct_format TEXT DEFAULT 'text',
			allow_public_pages INTEGER DEFAULT 1,
			allow_direct_links INTEGER DEFAULT 1,
			access_log_retention_days INTEGER DEFAULT 30,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`,
		`INSERT OR IGNORE INTO prompt_settings (id) VALUES (1)`,
	}

	for _, stmt := range statements {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

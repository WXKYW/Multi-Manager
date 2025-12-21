-- OpenList 账号存储
CREATE TABLE IF NOT EXISTS openlist_accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    api_url TEXT NOT NULL,
    api_token TEXT NOT NULL,
    status TEXT DEFAULT 'unknown',
    version TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- OpenList 存储挂载快照（可选，用于缓存状态）
CREATE TABLE IF NOT EXISTS openlist_storage_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    storage_name TEXT NOT NULL,
    driver TEXT,
    mount_path TEXT,
    status TEXT,
    total_size INTEGER,
    used_size INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES openlist_accounts(id) ON DELETE CASCADE
);

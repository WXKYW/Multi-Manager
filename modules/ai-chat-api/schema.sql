-- AI Chat 模块数据库表结构
-- 用于存储 LLM Provider 配置、对话和消息

-- Provider 配置表
CREATE TABLE IF NOT EXISTS ai_chat_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'openai',  -- openai, claude, gemini, ollama
  base_url TEXT NOT NULL DEFAULT 'https://api.openai.com/v1',
  api_key TEXT,
  default_model TEXT DEFAULT 'gpt-3.5-turbo',
  models TEXT,  -- JSON 数组存储可用模型列表
  enabled INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 对话会话表
CREATE TABLE IF NOT EXISTS ai_chat_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '新对话',
  provider_id TEXT,
  model TEXT,
  system_prompt TEXT,
  temperature REAL DEFAULT 0.7,
  max_tokens INTEGER DEFAULT 4096,
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (provider_id) REFERENCES ai_chat_providers(id) ON DELETE SET NULL
);

-- 消息记录表
CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,  -- system, user, assistant
  content TEXT NOT NULL,
  token_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (conversation_id) REFERENCES ai_chat_conversations(id) ON DELETE CASCADE
);

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON ai_chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_provider ON ai_chat_conversations(provider_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON ai_chat_conversations(updated_at DESC);

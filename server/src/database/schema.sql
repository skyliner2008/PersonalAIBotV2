-- ============================================
-- FB AI Agent — SQLite Schema
-- ============================================

-- Conversations (Messenger threads)
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  fb_user_id TEXT NOT NULL,
  fb_user_name TEXT,
  fb_avatar_url TEXT,
  last_message_at DATETIME,
  summary TEXT DEFAULT '',
  summary_msg_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT 1,
  auto_reply BOOLEAN DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- User profiles (Layer 3: Long-term memory)
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  display_name TEXT,
  facts TEXT DEFAULT '[]',
  preferences TEXT DEFAULT '{}',
  tags TEXT DEFAULT '[]',
  total_messages INTEGER DEFAULT 0,
  first_contact DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Messages (per conversation)
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  fb_message_id TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, timestamp);

-- Q&A Database (override AI for specific patterns)
CREATE TABLE IF NOT EXISTS qa_pairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_pattern TEXT NOT NULL,
  answer TEXT NOT NULL,
  match_type TEXT DEFAULT 'contains' CHECK(match_type IN ('exact', 'contains', 'regex')),
  category TEXT,
  priority INTEGER DEFAULT 0,
  use_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- Composite index for Q&A lookup (is_active checked first, then sorted by priority)
CREATE INDEX IF NOT EXISTS idx_qa_active_priority ON qa_pairs(is_active, priority DESC);

-- Persona profiles
CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  system_prompt TEXT NOT NULL,
  personality_traits TEXT,       -- JSON array
  speaking_style TEXT,           -- e.g. "casual-thai", "formal", "funny"
  language TEXT DEFAULT 'th',
  temperature REAL DEFAULT 0.7,
  max_tokens INTEGER DEFAULT 500,
  is_default BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Scheduled posts
CREATE TABLE IF NOT EXISTS scheduled_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT,
  post_type TEXT DEFAULT 'text' CHECK(post_type IN ('text', 'image', 'link')),
  target TEXT DEFAULT 'profile' CHECK(target IN ('profile', 'page', 'group')),
  target_id TEXT,
  target_name TEXT,
  image_path TEXT,
  link_url TEXT,
  scheduled_at DATETIME NOT NULL,
  cron_expression TEXT,
  ai_topic TEXT,
  ai_provider TEXT,
  ai_model TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'generating', 'ready', 'posting', 'posted', 'failed')),
  fb_post_id TEXT,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_posts_status ON scheduled_posts(status, scheduled_at);

-- Comment watch list
CREATE TABLE IF NOT EXISTS comment_watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fb_post_url TEXT NOT NULL,
  fb_post_id TEXT,
  auto_reply BOOLEAN DEFAULT 1,
  reply_style TEXT DEFAULT 'friendly',
  max_replies INTEGER DEFAULT 50,
  replies_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_watches_post_url ON comment_watches(fb_post_url);

-- Replied comments (avoid duplicates)
CREATE TABLE IF NOT EXISTS replied_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER REFERENCES comment_watches(id) ON DELETE CASCADE,
  fb_comment_id TEXT NOT NULL UNIQUE,
  commenter_name TEXT,
  comment_text TEXT,
  reply_text TEXT,
  replied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Activity logs
CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT,
  level TEXT DEFAULT 'info' CHECK(level IN ('info', 'success', 'warning', 'error')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_logs_time ON activity_logs(created_at DESC);

-- Settings (key-value store)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- Unified Memory Tables (Telegram/LINE bots)
-- ============================================

-- Episodic Memory (Layer 2: conversation episodes)
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_episodes_chat ON episodes(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_episodes_time ON episodes(chat_id, timestamp DESC);

-- Semantic Memory (Layer 3: long-term knowledge with embeddings)
CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  fact TEXT NOT NULL,
  embedding BLOB,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_knowledge_chat ON knowledge(chat_id, timestamp);

-- ============================================
-- Processed Messages (dedup persistence)
-- ============================================
CREATE TABLE IF NOT EXISTS processed_messages (
  mid TEXT PRIMARY KEY,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- Unified Memory System (MemGPT-inspired)
-- ============================================

-- Core Memory: persistent user/persona blocks (always in context)
CREATE TABLE IF NOT EXISTS core_memory (
  chat_id TEXT NOT NULL,
  block_label TEXT NOT NULL,
  value TEXT DEFAULT '',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, block_label)
);

-- Archival Memory: long-term facts with embeddings for semantic search
CREATE TABLE IF NOT EXISTS archival_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  fact TEXT NOT NULL,
  embedding BLOB,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_archival_chat ON archival_memory(chat_id, created_at);

-- ============================================
-- API Keys Management
-- ============================================

-- API Keys: encrypted credential storage (source of truth at runtime)
CREATE TABLE IF NOT EXISTS api_keys (
  provider_id TEXT NOT NULL PRIMARY KEY,
  key_type TEXT DEFAULT 'api_key',
  encrypted_value TEXT NOT NULL,
  source TEXT DEFAULT 'dashboard' CHECK(source IN ('dashboard', 'env', 'migration')),
  source_env_var TEXT,
  is_valid BOOLEAN DEFAULT 1,
  last_tested DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider_id, key_type)
);
CREATE INDEX IF NOT EXISTS idx_api_keys_valid ON api_keys(provider_id, is_valid);

-- Provider Configuration: runtime settings per provider
CREATE TABLE IF NOT EXISTS provider_config (
  provider_id TEXT PRIMARY KEY,
  enabled BOOLEAN DEFAULT 1,
  priority INTEGER DEFAULT 0,
  custom_base_url TEXT,
  custom_models TEXT,
  metadata TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- Agentic AI Upgrades: Plan Tracker
-- ============================================

-- Agent Plans: Stateful planning for long-running workflows
CREATE TABLE IF NOT EXISTS agent_plans (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  steps_json TEXT NOT NULL, -- Array of { id, description, status }
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed', 'paused')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_plans_chat ON agent_plans(chat_id, status);

-- ============================================
-- Agentic AI Upgrades: GraphRAG Memory
-- ============================================

-- Knowledge Graph Nodes (Entities)
CREATE TABLE IF NOT EXISTS knowledge_nodes (
  id TEXT PRIMARY KEY,       -- Format: chatId_normalizedLabel
  chat_id TEXT NOT NULL,
  label TEXT NOT NULL,       -- Human readable entity name (e.g. "ผู้ใช้", "โปรเจคระบบ AI")
  node_type TEXT DEFAULT 'entity',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_knodes_chat ON knowledge_nodes(chat_id);

-- Knowledge Graph Edges (Relationships)
CREATE TABLE IF NOT EXISTS knowledge_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL, -- The predicate (e.g. "เป็นเจ้าของ", "ชอบ")
  weight REAL DEFAULT 1.0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(chat_id, source_id, target_id, relationship)
);
CREATE INDEX IF NOT EXISTS idx_kedges_source ON knowledge_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_kedges_target ON knowledge_edges(target_id);

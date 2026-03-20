// ============================================================
// Test Utilities — Shared helpers for all tests
// ============================================================

import Database, { type Database as SqliteDatabase } from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Create an in-memory SQLite database for testing
 * with the same schema as production
 */
export function createTestDb(): SqliteDatabase {
  const db = new Database(':memory:');

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Create schema (must match src/database/schema.ts)
  const schema = `
    -- Core Memory (Layer 1)
    CREATE TABLE IF NOT EXISTS core_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      block_label TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chat_id, block_label)
    );

    -- Messages (Recall Memory - Layer 3)
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Archival Memory (Layer 4)
    CREATE TABLE IF NOT EXISTS archival_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      fact TEXT NOT NULL,
      embedding TEXT,
      source TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Vector Store metadata
    CREATE TABLE IF NOT EXISTS vector_docs (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      metadata TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Personas
    CREATE TABLE IF NOT EXISTS personas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      system_prompt TEXT NOT NULL,
      personality_traits TEXT,
      speaking_style TEXT,
      language TEXT DEFAULT 'en',
      temperature REAL DEFAULT 0.7,
      max_tokens INTEGER DEFAULT 2048,
      is_default INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Conversations
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      fb_user_id TEXT,
      fb_user_name TEXT,
      fb_avatar_url TEXT,
      last_message_at DATETIME,
      summary TEXT,
      summary_msg_count INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      auto_reply INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Activity logs
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      level TEXT CHECK(level IN ('info', 'success', 'warning', 'error')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_core_memory_chat_id ON core_memory(chat_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_archival_facts_chat_id ON archival_facts(chat_id);
    CREATE INDEX IF NOT EXISTS idx_vector_docs_created ON vector_docs(created_at);
  `;

  db.exec(schema);
  return db;
}

/**
 * Cleanup test database
 */
export function cleanupTestDb(db: SqliteDatabase): void {
  try {
    db.close();
  } catch (err) {
    // Already closed
  }
}

/**
 * Create mock BotContext for testing
 */
export interface MockBotContext {
  botId: string;
  chatId: string;
  userId: string;
  persona?: {
    name: string;
    systemPrompt: string;
  };
}

export function createMockContext(overrides?: Partial<MockBotContext>): MockBotContext {
  return {
    botId: 'test-bot-001',
    chatId: 'test-chat-001',
    userId: 'test-user-001',
    persona: {
      name: 'TestBot',
      systemPrompt: 'You are a helpful test assistant.',
    },
    ...overrides,
  };
}

/**
 * Wait helper for async tests
 */
export async function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create sample messages for testing
 */
export function createSampleMessages(count: number = 5) {
  const messages = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Sample message ${i + 1}`,
    });
  }
  return messages;
}

/**
 * Helper to insert test data into database
 */
export function insertTestMessage(
  db: SqliteDatabase,
  chatId: string,
  role: 'user' | 'assistant' | 'system',
  content: string
): void {
  db.prepare(
    'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)'
  ).run(chatId, role, content);
}

export function insertTestCoreMemory(
  db: SqliteDatabase,
  chatId: string,
  label: string,
  value: string
): void {
  db.prepare(
    'INSERT OR REPLACE INTO core_memory (chat_id, block_label, value) VALUES (?, ?, ?)'
  ).run(chatId, label, value);
}

/**
 * Helper to retrieve test data
 */
export function getTestMessages(db: SqliteDatabase, chatId: string): Array<any> {
  return db.prepare(
    'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id ASC'
  ).all(chatId) as any[];
}

export function getTestCoreMemory(db: SqliteDatabase, chatId: string): Array<any> {
  return db.prepare(
    'SELECT block_label, value FROM core_memory WHERE chat_id = ?'
  ).all(chatId) as any[];
}

/**
 * Create temporary test file
 */
export function createTempFile(content: string, ext: string = '.tmp'): string {
  const fileName = `/tmp/test_${Date.now()}${ext}`;
  fs.writeFileSync(fileName, content);
  return fileName;
}

/**
 * Cleanup temporary file
 */
export function deleteTempFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    // File already deleted or doesn't exist
  }
}

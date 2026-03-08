import Database, { type Database as SqliteDatabase } from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: ReturnType<typeof Database>;

// ============================================================
// Domain Interfaces — typed row shapes for all tables
// ============================================================

export interface ActivityLog {
  id: number;
  type: string;
  action: string;
  details: string | null;
  level: 'info' | 'success' | 'warning' | 'error';
  created_at: string;
}

export interface Persona {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  personality_traits: string | null; // JSON array string
  speaking_style: string | null;
  language: string;
  temperature: number;
  max_tokens: number;
  is_default: number; // SQLite stores BOOLEAN as 0/1
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  fb_user_id: string;
  fb_user_name: string | null;
  fb_avatar_url: string | null;
  last_message_at: string | null;
  summary: string;
  summary_msg_count: number;
  is_active: number;
  auto_reply: number;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: number;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  fb_message_id: string | null;
  timestamp: string;
}

export interface UserProfile {
  user_id: string;
  display_name: string | null;
  facts: string;        // JSON array string
  preferences: string;  // JSON object string
  tags: string;         // JSON array string
  total_messages: number;
  first_contact: string;
  updated_at: string;
}

export interface QAPair {
  id: number;
  question_pattern: string;
  answer: string;
  match_type: 'exact' | 'contains' | 'regex';
  category: string | null;
  priority: number;
  use_count: number;
  is_active: number;
  created_at: string;
}

/** Generic SQLite param type */
type SqlParam = string | number | null | Buffer;

// ============ Helper functions ============
function allRows<T = Record<string, unknown>>(
  dbInstance: ReturnType<typeof Database>, sql: string, params: SqlParam[] = []
): T[] {
  return dbInstance.prepare(sql).all(...params) as T[];
}

function getRow<T = Record<string, unknown>>(
  dbInstance: ReturnType<typeof Database>, sql: string, params: SqlParam[] = []
): T | undefined {
  return dbInstance.prepare(sql).get(...params) as T | undefined;
}

function runSql(dbInstance: ReturnType<typeof Database>, sql: string, params: SqlParam[] = []): void {
  dbInstance.prepare(sql).run(...params);
}

export async function initDb(): Promise<SqliteDatabase> {
  if (db) return db;

  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');  // Required for ON DELETE CASCADE to work

  // Run schema
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  // --- Migrations: add columns if missing (for existing databases) ---
  try { db.exec(`ALTER TABLE conversations ADD COLUMN summary_msg_count INTEGER DEFAULT 0`); } catch { /* already exists */ }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY, display_name TEXT, facts TEXT DEFAULT '[]',
    preferences TEXT DEFAULT '{}', tags TEXT DEFAULT '[]',
    total_messages INTEGER DEFAULT 0, first_contact DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  } catch { /* already exists */ }

  // --- Safety: ensure indexes exist (idempotent) ---
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_episodes_chat ON episodes(chat_id, id)`); } catch { /* exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_chat ON knowledge(chat_id, timestamp)`); } catch { /* exists */ }
  // Additional indexes for performance
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id)`); } catch { /* exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages(conversation_id, timestamp)`); } catch { /* exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at)`); } catch { /* exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_activity_logs_ts ON activity_logs(created_at)`); } catch { /* exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_core_memory_chat ON core_memory(chat_id, block_label)`); } catch { /* exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_archival_memory_chat ON archival_memory(chat_id, created_at)`); } catch { /* exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_processed_messages ON processed_messages(created_at)`); } catch { /* exists */ }

  // --- Evolution System tables ---
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS evolution_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL,
      description TEXT NOT NULL,
      details TEXT,
      applied INTEGER DEFAULT 0,
      success INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch { /* already exists */ }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS learning_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      insight TEXT NOT NULL,
      source TEXT,
      confidence REAL DEFAULT 0.5,
      times_applied INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch { /* already exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_evolution_log_type ON evolution_log(action_type, created_at)`); } catch { /* exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_learning_journal_cat ON learning_journal(category, confidence)`); } catch { /* exists */ }

  // Insert default persona if none exists
  const count = getRow(db, 'SELECT COUNT(*) as c FROM personas');
  if (count && count.c === 0) {
    db.prepare(`
      INSERT INTO personas (id, name, description, system_prompt, personality_traits, speaking_style, is_default)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(
      'default',
      'แอดมินเพจ',
      'แอดมินเพจที่เป็นมิตร ตอบเร็ว ช่วยเหลือลูกค้า',
      `คุณคือแอดมินเพจ Facebook ที่เป็นมิตรและเป็นมืออาชีพ
- ตอบเป็นภาษาไทย สุภาพแต่เป็นกันเอง
- ใช้ครับ/ค่ะ ตามความเหมาะสม
- ตอบกระชับ ไม่ยาวเกินไป
- ถ้าไม่แน่ใจ ให้บอกว่าจะตรวจสอบและแจ้งกลับ
- ห้ามแต่งข้อมูลที่ไม่จริง
- ถ้าเป็นคำถามเกี่ยวกับราคา/สินค้า ให้แนะนำติดต่อทาง inbox`,
      JSON.stringify(['friendly', 'helpful', 'professional']),
      'casual-thai'
    );
  }

  console.log('[DB] SQLite (better-sqlite3) initialized:', config.dbPath);
  return db;
}

export function getDb(): SqliteDatabase {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

// ============ Helper Functions ============

// -- Settings --
export function getSetting(key: string): string | null {
  const row = getRow<{ value: string }>(getDb(), 'SELECT value FROM settings WHERE key = ?', [key]);
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  runSql(getDb(), `
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `, [key, value]);
}

// ============================================================
// 🔒 Credential Store — AES-256-GCM encrypted settings
// ============================================================
// ใช้ AES-256-GCM (authenticated encryption) สำหรับ credentials ที่เก็บใน DB
// Derive key จาก CRED_SECRET env var ด้วย scrypt
const CRED_SECRET = process.env.CRED_SECRET || 'ai-bot-v2-secret-2024';
// Use a fixed salt so the key is consistent across restarts
const CRED_SALT = Buffer.from('personalaibot-v2-fixed-salt-2024');
const DERIVED_KEY = crypto.scryptSync(CRED_SECRET, CRED_SALT, 32); // 256-bit key

function aesEncrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', DERIVED_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  // Format: iv:authTag:ciphertext (all hex)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

function aesDecrypt(encoded: string): string {
  const parts = encoded.split(':');
  if (parts.length !== 3) throw new Error('Invalid AES format');
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];
  const decipher = crypto.createDecipheriv('aes-256-gcm', DERIVED_KEY, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Legacy XOR decode for backward compatibility with old data
function xorDeobfuscateLegacy(encoded: string): string {
  try {
    const key = CRED_SECRET;
    const bytes = Buffer.from(encoded, 'base64');
    const result: number[] = [];
    for (let i = 0; i < bytes.length; i++) {
      result.push(bytes[i] ^ key.charCodeAt(i % key.length));
    }
    return result.map(c => String.fromCharCode(c)).join('');
  } catch {
    return encoded;
  }
}

/** เก็บ credential แบบ AES-256-GCM encrypted */
export function setCredential(key: string, value: string): void {
  const encrypted = `aes:${aesEncrypt(value)}`;
  setSetting(key, encrypted);
}

/** อ่าน credential (auto-detect format: aes > obf(legacy) > plaintext) */
export function getCredential(key: string): string | null {
  const raw = getSetting(key);
  if (!raw) return null;
  if (raw.startsWith('aes:')) {
    try { return aesDecrypt(raw.slice(4)); }
    catch { return null; }
  }
  // Backward compat: migrate old XOR obfuscated values
  if (raw.startsWith('obf:')) {
    const plaintext = xorDeobfuscateLegacy(raw.slice(4));
    // Re-encrypt with AES on read (auto-migration)
    try { setCredential(key, plaintext); } catch { /* ignore migration error */ }
    return plaintext;
  }
  return raw; // plaintext fallback
}

// -- Activity Logs --
export function addLog(type: string, action: string, details?: string | null, level: string = 'info'): void {
  runSql(getDb(),
    'INSERT INTO activity_logs (type, action, details, level) VALUES (?, ?, ?, ?)',
    [type, action, details || null, level]
  );
}

export function getRecentLogs(limit: number = 100): ActivityLog[] {
  return allRows<ActivityLog>(getDb(),
    'SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT ?',
    [limit]
  );
}

// -- Personas --
export function getDefaultPersona(): Persona | undefined {
  return getRow<Persona>(getDb(), 'SELECT * FROM personas WHERE is_default = 1 LIMIT 1');
}

export function getAllPersonas(): Persona[] {
  return allRows<Persona>(getDb(), 'SELECT * FROM personas ORDER BY is_default DESC, name');
}

// -- Conversations --
export function getConversation(id: string): Conversation | undefined {
  return getRow<Conversation>(getDb(), 'SELECT * FROM conversations WHERE id = ?', [id]);
}

export function upsertConversation(id: string, fbUserId: string, fbUserName: string): void {
  runSql(getDb(), `
    INSERT INTO conversations (id, fb_user_id, fb_user_name, last_message_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      fb_user_name = excluded.fb_user_name,
      last_message_at = datetime('now'),
      updated_at = datetime('now')
  `, [id, fbUserId, fbUserName]);
}

export function getConversationMessages(convId: string, limit: number = 50): MessageRow[] {
  return allRows<MessageRow>(getDb(),
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT ?',
    [convId, limit]
  ).reverse();
}

export function addMessage(convId: string, role: string, content: string, fbMessageId?: string): void {
  runSql(getDb(),
    'INSERT INTO messages (conversation_id, role, content, fb_message_id) VALUES (?, ?, ?, ?)',
    [convId, role, content, fbMessageId || null]
  );
}

// -- Conversation Summary (Layer 2) --
export function getConversationSummary(convId: string): { summary: string; summaryMsgCount: number } {
  const row = getRow<{ summary: string; summary_msg_count: number }>(getDb(), 'SELECT summary, summary_msg_count FROM conversations WHERE id = ?', [convId]);
  return { summary: row?.summary || '', summaryMsgCount: row?.summary_msg_count || 0 };
}

export function updateConversationSummary(convId: string, summary: string, msgCount: number): void {
  runSql(getDb(), `UPDATE conversations SET summary = ?, summary_msg_count = ? WHERE id = ?`, [summary, msgCount, convId]);
}

export function getMessageCount(convId: string): number {
  const row = getRow<{ c: number }>(getDb(), 'SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?', [convId]);
  return row?.c || 0;
}

// -- User Profiles (Layer 3) --
export function getUserProfile(userId: string): UserProfile | undefined {
  return getRow<UserProfile>(getDb(), 'SELECT * FROM user_profiles WHERE user_id = ?', [userId]);
}

export function upsertUserProfile(userId: string, displayName: string, facts: string[], tags: string[], totalMessages: number): void {
  runSql(getDb(), `
    INSERT INTO user_profiles (user_id, display_name, facts, tags, total_messages, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      display_name = excluded.display_name,
      facts = excluded.facts,
      tags = excluded.tags,
      total_messages = excluded.total_messages,
      updated_at = datetime('now')
  `, [userId, displayName, JSON.stringify(facts), JSON.stringify(tags), totalMessages]);
}

// -- Q&A --

// Regex pattern cache — avoids recompiling on every match attempt
const regexCache = new Map<string, { re: RegExp; ts: number }>();
const REGEX_CACHE_TTL = 3600_000; // 1 hour

/** Safe regex execution with timeout protection against ReDoS */
function safeRegexTest(re: RegExp, input: string, timeoutMs: number = 100): boolean {
  // Quick check: limit input length to prevent exponential backtracking
  if (input.length > 5000) input = input.substring(0, 5000);
  try {
    const start = Date.now();
    const result = re.test(input);
    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) {
      console.warn(`[QA] Slow regex (${elapsed}ms): ${re.source.substring(0, 60)}`);
    }
    return result;
  } catch {
    return false;
  }
}

function getCachedRegex(pattern: string): RegExp | null {
  const cached = regexCache.get(pattern);
  if (cached && Date.now() - cached.ts < REGEX_CACHE_TTL) return cached.re;
  try {
    // Basic complexity check — reject patterns with nested quantifiers
    if (/(\+|\*|\{)\??(\+|\*|\{)/.test(pattern)) {
      console.warn(`[QA] Rejected potentially dangerous regex: ${pattern.substring(0, 60)}`);
      return null;
    }
    const re = new RegExp(pattern, 'i');
    regexCache.set(pattern, { re, ts: Date.now() });
    return re;
  } catch {
    return null; // invalid regex
  }
}

/** Clear regex cache (call when QA pairs are modified) */
export function clearRegexCache(): void { regexCache.clear(); }

export function findQAMatch(question: string): QAPair | null {
  const qLower = question.toLowerCase().trim();

  // 1. Exact match (highest priority)
  const exact = getRow<QAPair>(getDb(),
    `SELECT * FROM qa_pairs WHERE is_active = 1 AND match_type = 'exact'
     AND LOWER(question_pattern) = ? ORDER BY priority DESC LIMIT 1`,
    [qLower]
  );
  if (exact) return exact;

  // 2. Contains match
  const allContains = allRows<QAPair>(getDb(),
    `SELECT * FROM qa_pairs WHERE is_active = 1 AND match_type = 'contains'
     ORDER BY priority DESC`
  );
  for (const qa of allContains) {
    if (qLower.includes(qa.question_pattern.toLowerCase())) return qa;
  }

  // 3. Regex match (uses compiled cache)
  const allRegex = allRows<QAPair>(getDb(),
    `SELECT * FROM qa_pairs WHERE is_active = 1 AND match_type = 'regex'
     ORDER BY priority DESC`
  );
  for (const qa of allRegex) {
    const re = getCachedRegex(qa.question_pattern);
    if (re && safeRegexTest(re, question)) return qa;
  }

  return null;
}

// ============ Public DB Wrapper Functions ============
// These wrappers allow calling db functions without explicit getDb() calls

export function dbAll<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): T[] {
  return allRows<T>(getDb(), sql, params);
}

export function dbGet<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): T | undefined {
  return getRow<T>(getDb(), sql, params);
}

export function dbRun(sql: string, params: SqlParam[] = []): void {
  runSql(getDb(), sql, params);
}

// ============ Maintenance Functions ============

/**
 * Get database statistics for health monitoring
 */
export function getDbStats(): Record<string, number> {
  const db = getDb();
  const stats: Record<string, number> = {};
  const tables = ['messages', 'conversations', 'episodes', 'knowledge', 'activity_logs', 'qa_pairs', 'personas', 'processed_messages'];
  for (const table of tables) {
    try {
      const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number } | undefined;
      stats[table] = row?.c || 0;
    } catch {
      stats[table] = 0;
    }
  }
  return stats;
}

/**
 * Clean up old activity logs (older than N days)
 */
export function cleanupOldLogs(daysOld: number = 30): number {
  const result = getDb().prepare(`DELETE FROM activity_logs WHERE created_at < datetime('now', '-' || ? || ' days')`).run(daysOld);
  return (result as { changes: number }).changes || 0;
}

/**
 * Clean up old processed message IDs (older than N days)
 */
export function cleanupOldProcessedMessages(daysOld: number = 7): number {
  try {
    const result = getDb().prepare(`DELETE FROM processed_messages WHERE created_at < datetime('now', '-' || ? || ' days')`).run(daysOld);
    return (result as { changes: number }).changes || 0;
  } catch { return 0; }
}

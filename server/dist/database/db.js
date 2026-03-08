import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let db;
// ============ Helper functions ============
function allRows(dbInstance, sql, params = []) {
    return dbInstance.prepare(sql).all(...params);
}
function getRow(dbInstance, sql, params = []) {
    return dbInstance.prepare(sql).get(...params);
}
function runSql(dbInstance, sql, params = []) {
    dbInstance.prepare(sql).run(...params);
}
export async function initDb() {
    if (db)
        return db;
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    // Run schema
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    db.exec(schema);
    // --- Migrations: add columns if missing (for existing databases) ---
    try {
        db.exec(`ALTER TABLE conversations ADD COLUMN summary_msg_count INTEGER DEFAULT 0`);
    }
    catch { /* already exists */ }
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY, display_name TEXT, facts TEXT DEFAULT '[]',
    preferences TEXT DEFAULT '{}', tags TEXT DEFAULT '[]',
    total_messages INTEGER DEFAULT 0, first_contact DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
    }
    catch { /* already exists */ }
    // --- Safety: ensure indexes exist (idempotent) ---
    try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_episodes_chat ON episodes(chat_id, id)`);
    }
    catch { /* exists */ }
    try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_chat ON knowledge(chat_id, timestamp)`);
    }
    catch { /* exists */ }
    // Insert default persona if none exists
    const count = getRow(db, 'SELECT COUNT(*) as c FROM personas');
    if (count && count.c === 0) {
        db.prepare(`
      INSERT INTO personas (id, name, description, system_prompt, personality_traits, speaking_style, is_default)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run('default', 'แอดมินเพจ', 'แอดมินเพจที่เป็นมิตร ตอบเร็ว ช่วยเหลือลูกค้า', `คุณคือแอดมินเพจ Facebook ที่เป็นมิตรและเป็นมืออาชีพ
- ตอบเป็นภาษาไทย สุภาพแต่เป็นกันเอง
- ใช้ครับ/ค่ะ ตามความเหมาะสม
- ตอบกระชับ ไม่ยาวเกินไป
- ถ้าไม่แน่ใจ ให้บอกว่าจะตรวจสอบและแจ้งกลับ
- ห้ามแต่งข้อมูลที่ไม่จริง
- ถ้าเป็นคำถามเกี่ยวกับราคา/สินค้า ให้แนะนำติดต่อทาง inbox`, JSON.stringify(['friendly', 'helpful', 'professional']), 'casual-thai');
    }
    console.log('[DB] SQLite (better-sqlite3) initialized:', config.dbPath);
    return db;
}
export function getDb() {
    if (!db)
        throw new Error('Database not initialized. Call initDb() first.');
    return db;
}
// ============ Helper Functions ============
// -- Settings --
export function getSetting(key) {
    const row = getRow(getDb(), 'SELECT value FROM settings WHERE key = ?', [key]);
    return row?.value ?? null;
}
export function setSetting(key, value) {
    runSql(getDb(), `
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `, [key, value]);
}
// -- Activity Logs --
export function addLog(type, action, details, level = 'info') {
    runSql(getDb(), 'INSERT INTO activity_logs (type, action, details, level) VALUES (?, ?, ?, ?)', [type, action, details || null, level]);
}
export function getRecentLogs(limit = 100) {
    return allRows(getDb(), 'SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT ?', [limit]);
}
// -- Personas --
export function getDefaultPersona() {
    return getRow(getDb(), 'SELECT * FROM personas WHERE is_default = 1 LIMIT 1');
}
export function getAllPersonas() {
    return allRows(getDb(), 'SELECT * FROM personas ORDER BY is_default DESC, name');
}
// -- Conversations --
export function getConversation(id) {
    return getRow(getDb(), 'SELECT * FROM conversations WHERE id = ?', [id]);
}
export function upsertConversation(id, fbUserId, fbUserName) {
    runSql(getDb(), `
    INSERT INTO conversations (id, fb_user_id, fb_user_name, last_message_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      fb_user_name = excluded.fb_user_name,
      last_message_at = datetime('now'),
      updated_at = datetime('now')
  `, [id, fbUserId, fbUserName]);
}
export function getConversationMessages(convId, limit = 50) {
    return allRows(getDb(), 'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT ?', [convId, limit]).reverse();
}
export function addMessage(convId, role, content, fbMessageId) {
    runSql(getDb(), 'INSERT INTO messages (conversation_id, role, content, fb_message_id) VALUES (?, ?, ?, ?)', [convId, role, content, fbMessageId || null]);
}
// -- Conversation Summary (Layer 2) --
export function getConversationSummary(convId) {
    const row = getRow(getDb(), 'SELECT summary, summary_msg_count FROM conversations WHERE id = ?', [convId]);
    return { summary: row?.summary || '', summaryMsgCount: row?.summary_msg_count || 0 };
}
export function updateConversationSummary(convId, summary, msgCount) {
    runSql(getDb(), `UPDATE conversations SET summary = ?, summary_msg_count = ? WHERE id = ?`, [summary, msgCount, convId]);
}
export function getMessageCount(convId) {
    const row = getRow(getDb(), 'SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?', [convId]);
    return row?.c || 0;
}
// -- User Profiles (Layer 3) --
export function getUserProfile(userId) {
    return getRow(getDb(), 'SELECT * FROM user_profiles WHERE user_id = ?', [userId]);
}
export function upsertUserProfile(userId, displayName, facts, tags, totalMessages) {
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
export function findQAMatch(question) {
    const qLower = question.toLowerCase().trim();
    // 1. Exact match (highest priority)
    const exact = getRow(getDb(), `SELECT * FROM qa_pairs WHERE is_active = 1 AND match_type = 'exact'
     AND LOWER(question_pattern) = ? ORDER BY priority DESC LIMIT 1`, [qLower]);
    if (exact)
        return exact;
    // 2. Contains match
    const allContains = allRows(getDb(), `SELECT * FROM qa_pairs WHERE is_active = 1 AND match_type = 'contains'
     ORDER BY priority DESC`);
    for (const qa of allContains) {
        if (qLower.includes(qa.question_pattern.toLowerCase()))
            return qa;
    }
    // 3. Regex match
    const allRegex = allRows(getDb(), `SELECT * FROM qa_pairs WHERE is_active = 1 AND match_type = 'regex'
     ORDER BY priority DESC`);
    for (const qa of allRegex) {
        try {
            if (new RegExp(qa.question_pattern, 'i').test(question))
                return qa;
        }
        catch { /* skip invalid regex */ }
    }
    return null;
}
// ============ Public DB Wrapper Functions ============
// These wrappers allow calling db functions without explicit getDb() calls
export function dbAll(sql, params = []) {
    return allRows(getDb(), sql, params);
}
export function dbGet(sql, params = []) {
    return getRow(getDb(), sql, params);
}
export function dbRun(sql, params = []) {
    runSql(getDb(), sql, params);
}
// ============ Maintenance Functions ============
/**
 * Get database statistics for health monitoring
 */
export function getDbStats() {
    const db = getDb();
    const stats = {};
    const tables = ['messages', 'conversations', 'episodes', 'knowledge', 'activity_logs', 'qa_pairs', 'personas', 'processed_messages'];
    for (const table of tables) {
        try {
            const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get();
            stats[table] = row?.c || 0;
        }
        catch {
            stats[table] = 0;
        }
    }
    return stats;
}
/**
 * Clean up old activity logs (older than N days)
 */
export function cleanupOldLogs(daysOld = 30) {
    const result = getDb().prepare(`DELETE FROM activity_logs WHERE created_at < datetime('now', '-' || ? || ' days')`).run(daysOld);
    return result.changes || 0;
}
/**
 * Clean up old processed message IDs (older than N days)
 */
export function cleanupOldProcessedMessages(daysOld = 7) {
    try {
        const result = getDb().prepare(`DELETE FROM processed_messages WHERE created_at < datetime('now', '-' || ? || ' days')`).run(daysOld);
        return result.changes || 0;
    }
    catch {
        return 0;
    }
}
//# sourceMappingURL=db.js.map
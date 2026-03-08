import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

const DB_PATH = path.join(process.cwd(), 'memory.db');

// สร้าง Database
const db = new Database(DB_PATH);

// ==========================================
// 1. ตาราง Episodes (Episodic Memory - ประวัติเหตุการณ์)
// ==========================================
db.exec(`
  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ==========================================
// 2. ตาราง Knowledge (Semantic Memory - ความรู้/ความจำระยะยาว)
// ==========================================
db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    fact TEXT NOT NULL,
    embedding BLOB, -- เก็บ Vector Embedding (Float32Array)
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Performance indexes
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_episodes_chat_id ON episodes(chat_id, id)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_chat_id ON knowledge(chat_id, id)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_knowledge_chat_ts ON knowledge(chat_id, timestamp)`); } catch {}

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('cache_size = -20000'); // 20MB cache

export default db;

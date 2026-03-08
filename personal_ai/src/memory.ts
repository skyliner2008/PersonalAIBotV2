import { Content } from '@google/genai';
import db from './db';

// ==========================================
// 3-Layer Memory Manager (improved)
// ==========================================
const MAX_SHORT_TERM   = 40;         // เพิ่มจาก 30 → จำบริบทได้มากขึ้น
const HISTORY_LOAD     = 30;         // เพิ่มจาก 20 → โหลดข้อความมากขึ้น
const SESSION_TTL_MS   = 60 * 60_000; // เพิ่มเป็น 60 นาที

interface SessionEntry {
  messages: Content[];
  lastActive: number;
}

export class MemoryManager {
  private sessions: Map<string, SessionEntry> = new Map();

  constructor() {
    // ล้าง session ที่ไม่ active ทุก 10 นาที
    setInterval(() => this.cleanupStale(), 10 * 60_000);
  }

  private cleanupStale() {
    const now = Date.now();
    let cleaned = 0;
    for (const [chatId, entry] of this.sessions.entries()) {
      if (now - entry.lastActive > SESSION_TTL_MS) {
        this.sessions.delete(chatId);
        cleaned++;
      }
    }
    if (cleaned > 0) console.log(`[Memory] Cleaned ${cleaned} stale sessions from RAM`);
  }

  /**
   * ดึงประวัติการคุยจาก RAM
   * ถ้ายังไม่มีให้โหลดจาก SQLite (Episodic Memory)
   */
  public getSessionMemory(chatId: string): Content[] {
    if (!this.sessions.has(chatId)) {
      const episodes = db.prepare(
        'SELECT role, content FROM episodes WHERE chat_id = ? ORDER BY id DESC LIMIT ?'
      ).all(chatId, HISTORY_LOAD) as any[];

      const messages: Content[] = episodes
        .reverse()
        .map(e => ({
          role: (e.role === 'user' ? 'user' : 'model') as 'user' | 'model',
          parts: [{ text: e.content as string }]
        }));

      this.sessions.set(chatId, { messages, lastActive: Date.now() });
    }

    const entry = this.sessions.get(chatId)!;
    entry.lastActive = Date.now();
    return entry.messages;
  }

  /**
   * เพิ่มข้อความใหม่ (RAM + SQLite)
   */
  public addMessage(chatId: string, role: string, text: string) {
    const memory = this.getSessionMemory(chatId);

    // Map role: Gemini รองรับแค่ 'user' | 'model'
    const geminiRole: 'user' | 'model' = role === 'user' ? 'user' : 'model';
    const prefix = role === 'system' ? '[System]: ' : '';

    memory.push({ role: geminiRole, parts: [{ text: prefix + text }] });

    // ตัด memory เก่าออกถ้าเกิน limit
    if (memory.length > MAX_SHORT_TERM) {
      this.sessions.get(chatId)!.messages = memory.slice(memory.length - MAX_SHORT_TERM);
    }

    // บันทึก SQLite (เก็บ role จริงเพื่อดูย้อนหลัง)
    db.prepare(
      'INSERT INTO episodes (chat_id, role, content) VALUES (?, ?, ?)'
    ).run(chatId, role, text);
  }

  /** ล้าง Working Memory (RAM) — ไม่ลบ Episodic Memory ถาวร */
  public clearMemory(chatId: string) {
    this.sessions.delete(chatId);
  }
}

export const memoryManager = new MemoryManager();

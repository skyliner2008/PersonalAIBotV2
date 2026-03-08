import { getDb } from "../database/db.js";
// ==========================================
// 3-Layer Memory Manager
// ==========================================
export class MemoryManager {
    // Layer 1: RAM Memory (Working Memory)
    sessions = {};
    MAX_SHORT_TERM = 30;
    /**
     * ดึงประวัติการคุยจาก RAM (ถ้าไม่มีให้โหลดจาก SQLite)
     */
    getSessionMemory(chatId) {
        if (!this.sessions[chatId]) {
            // โหลด 10 ข้อความล่าสุดจาก Episodic Memory (Layer 2) เข้า RAM
            const episodes = getDb().prepare('SELECT role, content FROM episodes WHERE chat_id = ? ORDER BY id DESC LIMIT 10').all(chatId);
            this.sessions[chatId] = episodes
                .reverse()
                .map(e => ({ role: e.role, parts: [{ text: e.content }] }));
        }
        return this.sessions[chatId];
    }
    /**
     * เพิ่มข้อความใหม่ (Layer 1 + Layer 2)
     */
    addMessage(chatId, role, text) {
        // 1. เพิ่มลง RAM (Short-term)
        const memory = this.getSessionMemory(chatId);
        // แปลง role สำหรับ Gemini (Gemini รองรับแค่ user กับ model)
        // ถ้าเป็น system ให้ถือว่าเป็นข้อมูลที่ model ได้รับรู้ (เหมือนเป็นส่วนหนึ่งของ user context)
        const geminiRole = role === "user" ? "user" : "model";
        const prefix = role === "system" ? "[System Observation]: " : "";
        memory.push({ role: geminiRole, parts: [{ text: prefix + text }] });
        if (memory.length > this.MAX_SHORT_TERM) {
            this.sessions[chatId] = memory.slice(memory.length - this.MAX_SHORT_TERM);
        }
        // 2. บันทึกลง SQLite (Episodic - Layer 2) - เก็บ role จริงไว้ดูย้อนหลัง
        const stmt = getDb().prepare('INSERT INTO episodes (chat_id, role, content) VALUES (?, ?, ?)');
        stmt.run(chatId, role, text);
    }
    clearMemory(chatId) {
        this.sessions[chatId] = [];
        // หมายเหตุ: ไม่ลบ Episodic Memory ถาวรเพื่อใช้เป็นคลังเหตุการณ์
    }
}
export const memoryManager = new MemoryManager();
//# sourceMappingURL=memory.js.map
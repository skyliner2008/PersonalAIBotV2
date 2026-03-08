import { Content } from "@google/genai";
export declare class MemoryManager {
    private sessions;
    private MAX_SHORT_TERM;
    /**
     * ดึงประวัติการคุยจาก RAM (ถ้าไม่มีให้โหลดจาก SQLite)
     */
    getSessionMemory(chatId: string): Content[];
    /**
     * เพิ่มข้อความใหม่ (Layer 1 + Layer 2)
     */
    addMessage(chatId: string, role: string, text: string): void;
    clearMemory(chatId: string): void;
}
export declare const memoryManager: MemoryManager;

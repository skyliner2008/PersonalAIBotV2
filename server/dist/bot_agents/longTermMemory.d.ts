export declare class LongTermMemory {
    private ai;
    constructor(apiKey: string);
    /**
     * สร้าง Embedding Vector จากข้อความ
     */
    getEmbedding(text: string): Promise<number[]>;
    /**
     * บันทึกความจำใหม่ลงใน Semantic Memory
     */
    saveKnowledge(chatId: string, fact: string): Promise<void>;
    /**
     * ค้นหาความจำที่เกี่ยวข้อง (Semantic Search)
     */
    retrieveRelevantKnowledge(chatId: string, query: string, limit?: number): Promise<string[]>;
    private cosineSimilarity;
}

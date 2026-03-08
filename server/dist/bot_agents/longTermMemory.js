import { GoogleGenAI } from '@google/genai';
import { getDb } from '../database/db.js';
export class LongTermMemory {
    ai;
    constructor(apiKey) {
        this.ai = new GoogleGenAI({ apiKey });
    }
    /**
     * สร้าง Embedding Vector จากข้อความ
     */
    async getEmbedding(text) {
        const result = await this.ai.models.embedContent({
            model: "gemini-embedding-001",
            contents: [{ role: "user", parts: [{ text }] }]
        });
        if (!result.embeddings || result.embeddings.length === 0 || !result.embeddings[0].values) {
            throw new Error("No embeddings returned");
        }
        return result.embeddings[0].values;
    }
    /**
     * บันทึกความจำใหม่ลงใน Semantic Memory
     */
    async saveKnowledge(chatId, fact) {
        try {
            const embedding = await this.getEmbedding(fact);
            // แปลง Embedding เป็น Buffer เพื่อเก็บลง SQLite BLOB
            const buffer = Buffer.from(new Float32Array(embedding).buffer);
            const stmt = getDb().prepare('INSERT INTO knowledge (chat_id, fact, embedding) VALUES (?, ?, ?)');
            stmt.run(chatId, fact, buffer);
            console.log(`[Semantic Memory] Saved fact: ${fact}`);
        }
        catch (err) {
            console.error("[Semantic Memory Error]:", err);
        }
    }
    /**
     * ค้นหาความจำที่เกี่ยวข้อง (Semantic Search)
     */
    async retrieveRelevantKnowledge(chatId, query, limit = 3) {
        try {
            const queryEmbedding = await this.getEmbedding(query);
            const queryVec = new Float32Array(queryEmbedding);
            // ดึงความจำทั้งหมดจาก DB (สำหรับโปรเจกต์ขนาดเล็กใช้ Cosine Similarity ในโค้ด)
            const allKnowledge = getDb().prepare('SELECT fact, embedding FROM knowledge WHERE chat_id = ?').all(chatId);
            const results = allKnowledge.map(k => {
                const kVec = new Float32Array(k.embedding.buffer, k.embedding.byteOffset, k.embedding.byteLength / 4);
                const score = this.cosineSimilarity(queryVec, kVec);
                return { fact: k.fact, score };
            });
            // เรียงตามความเหมือน และส่งคืนเฉพาะที่คะแนนสูงกว่าเกณฑ์
            return results
                .sort((a, b) => b.score - a.score)
                .filter(r => r.score > 0.7) // Threshold ความเหมือน
                .slice(0, limit)
                .map(r => r.fact);
        }
        catch (err) {
            console.error("[Semantic Retrieval Error]:", err);
            return [];
        }
    }
    cosineSimilarity(vecA, vecB) {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
}
//# sourceMappingURL=longTermMemory.js.map
import { GoogleGenAI } from '@google/genai';
import db from './db';

const SIMILARITY_THRESHOLD  = 0.65;  // ลด threshold ลงนิดเพื่อจับ context กว้างขึ้น
const MAX_ARCHIVAL_PER_USER = 200;    // จำกัดจำนวน facts ต่อ user

export class LongTermMemory {
  private ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  /**
   * สร้าง Embedding Vector จากข้อความ
   */
  public async getEmbedding(text: string): Promise<number[]> {
    const result = await this.ai.models.embedContent({
      model: 'gemini-embedding-001',
      contents: [{ role: 'user', parts: [{ text }] }]
    });
    if (!result.embeddings?.[0]?.values) {
      throw new Error('No embeddings returned');
    }
    return result.embeddings[0].values;
  }

  /**
   * บันทึก fact ใหม่ลงใน Semantic Memory
   * มีการจำกัดจำนวน facts ต่อ user เพื่อไม่ให้ DB บวม
   */
  public async saveKnowledge(chatId: string, fact: string) {
    try {
      // ตรวจสอบว่ามี fact ที่คล้ายกันอยู่แล้วไหม (dedup)
      const existing = db.prepare(
        'SELECT id, fact FROM knowledge WHERE chat_id = ? ORDER BY id DESC LIMIT 50'
      ).all(chatId) as any[];

      const isDuplicate = existing.some(k =>
        k.fact.toLowerCase().trim() === fact.toLowerCase().trim()
      );
      if (isDuplicate) return;

      const embedding = await this.getEmbedding(fact);
      const buffer = Buffer.from(new Float32Array(embedding).buffer);

      // บันทึก fact ใหม่
      db.prepare(
        'INSERT INTO knowledge (chat_id, fact, embedding) VALUES (?, ?, ?)'
      ).run(chatId, fact, buffer);

      // จำกัดจำนวน — ลบ fact เก่าสุดถ้าเกิน limit
      const totalCount = (db.prepare(
        'SELECT COUNT(*) as cnt FROM knowledge WHERE chat_id = ?'
      ).get(chatId) as any)?.cnt ?? 0;

      if (totalCount > MAX_ARCHIVAL_PER_USER) {
        db.prepare(
          'DELETE FROM knowledge WHERE chat_id = ? AND id IN (SELECT id FROM knowledge WHERE chat_id = ? ORDER BY id ASC LIMIT ?)'
        ).run(chatId, chatId, totalCount - MAX_ARCHIVAL_PER_USER);
      }

      console.log(`[LTM] Saved: "${fact}" for ${chatId}`);
    } catch (err) {
      console.error('[LTM Save Error]:', err);
    }
  }

  /**
   * ค้นหา facts ที่เกี่ยวข้องด้วย Cosine Similarity
   */
  public async retrieveRelevantKnowledge(
    chatId: string,
    query: string,
    limit = 4
  ): Promise<string[]> {
    try {
      // ถ้าไม่มี knowledge เลยให้ return เร็ว
      const count = (db.prepare(
        'SELECT COUNT(*) as cnt FROM knowledge WHERE chat_id = ?'
      ).get(chatId) as any)?.cnt ?? 0;
      if (count === 0) return [];

      const queryEmbedding = await this.getEmbedding(query);
      const queryVec = new Float32Array(queryEmbedding);

      // โหลดแค่ recent facts เพื่อประหยัด memory
      const facts = db.prepare(
        'SELECT fact, embedding FROM knowledge WHERE chat_id = ? ORDER BY id DESC LIMIT 150'
      ).all(chatId) as any[];

      const scored = facts.map(k => {
        const kVec = new Float32Array(
          k.embedding.buffer,
          k.embedding.byteOffset,
          k.embedding.byteLength / 4
        );
        return { fact: k.fact as string, score: this.cosineSimilarity(queryVec, kVec) };
      });

      return scored
        .sort((a, b) => b.score - a.score)
        .filter(r => r.score > SIMILARITY_THRESHOLD)
        .slice(0, limit)
        .map(r => r.fact);
    } catch (err) {
      console.error('[LTM Retrieve Error]:', err);
      return [];
    }
  }

  private cosineSimilarity(vecA: Float32Array, vecB: Float32Array): number {
    const len = Math.min(vecA.length, vecB.length);
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < len; i++) {
      dot   += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}

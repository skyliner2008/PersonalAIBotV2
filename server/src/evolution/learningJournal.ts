// ============================================================
// Learning Journal — Persistent knowledge base that grows from interactions
// ============================================================
// The AI records insights from conversations, errors, and self-reflection
// into categories. These learnings can be retrieved to improve future responses.
// Learnings are also indexed in VectorStore for semantic search.

import { getDb } from '../database/db.js';
import { createLogger } from '../utils/logger.js';
import { getVectorStore, type VectorDocument } from '../memory/vectorStore.js';
import { embedText } from '../memory/embeddingProvider.js';

const log = createLogger('LearningJournal');

export type LearningCategory =
    | 'user_patterns'       // วิธีที่ users พูด, สิ่งที่ถามบ่อย
    | 'tool_usage'          // tool ไหนดี/ไม่ดีในสถานการณ์ไหน
    | 'error_solutions'     // error ที่เจอและวิธีแก้
    | 'prompt_improvements' // ปรับปรุง prompt/persona ที่ได้ผล
    | 'performance'         // insights เกี่ยวกับ performance
    | 'general';            // ความรู้ทั่วไป

export interface Learning {
    id: number;
    category: LearningCategory;
    insight: string;
    source: string;
    confidence: number;
    times_applied: number;
    created_at: string;
}

/**
 * Record a new learning insight
 */
export function addLearning(
    category: LearningCategory,
    insight: string,
    source: string = 'self_reflection',
    confidence: number = 0.5
): void {
    try {
        const db = getDb();
        // Dedup: skip if very similar insight already exists
        const existing = db.prepare(
            `SELECT id FROM learning_journal WHERE category = ? AND insight = ? LIMIT 1`
        ).get(category, insight);
        if (existing) return;

        const result = db.prepare(
            `INSERT INTO learning_journal (category, insight, source, confidence) VALUES (?, ?, ?, ?)`
        ).run(category, insight, source, confidence);

        const newId = (result as any).lastInsertRowid || Date.now();
        log.info('New learning recorded', { category, insight: insight.substring(0, 80) });

        // Index in vector store asynchronously (non-blocking)
        setImmediate(() => {
            indexLearningInVectorStore(newId, insight).catch(err => {
                log.warn('Async learning indexing failed', { error: String(err) });
            });
        });
    } catch (err: any) {
        log.error('Failed to add learning', { error: err.message });
    }
}

/**
 * Get learnings by category, sorted by confidence
 */
export function getLearnings(category?: LearningCategory, limit: number = 10): Learning[] {
    try {
        const db = getDb();
        if (category) {
            return db.prepare(
                `SELECT * FROM learning_journal WHERE category = ? ORDER BY confidence DESC, times_applied DESC LIMIT ?`
            ).all(category, limit) as Learning[];
        }
        return db.prepare(
            `SELECT * FROM learning_journal ORDER BY confidence DESC, created_at DESC LIMIT ?`
        ).all(limit) as Learning[];
    } catch (err) {
        log.warn('Failed to retrieve learning journal', { error: String(err) });
        return [];
    }
}

/**
 * Increment times_applied and boost confidence when a learning is used
 */
export function applyLearning(id: number): void {
    try {
        getDb().prepare(
            `UPDATE learning_journal SET times_applied = times_applied + 1, confidence = MIN(confidence + 0.05, 1.0) WHERE id = ?`
        ).run(id);
    } catch (err) { log.debug('Failed to apply learning', { id, error: String(err) }); }
}

/**
 * Log an evolution action (self-edit, auto-tune, self-heal, etc.)
 */
export function logEvolution(
    actionType: string,
    description: string,
    details?: Record<string, unknown>,
    success: boolean = true
): void {
    try {
        getDb().prepare(
            `INSERT INTO evolution_log (action_type, description, details, applied, success) VALUES (?, ?, ?, 1, ?)`
        ).run(actionType, description, details ? JSON.stringify(details) : null, success ? 1 : 0);
        log.info(`Evolution: ${actionType}`, { description });
    } catch (err: any) {
        log.error('Failed to log evolution', { error: err.message });
    }
}

/**
 * Get recent evolution log entries
 */
export function getEvolutionLog(limit: number = 20): any[] {
    try {
        return getDb().prepare(
            `SELECT * FROM evolution_log ORDER BY created_at DESC LIMIT ?`
        ).all(limit);
    } catch (err) {
        log.warn('Failed to retrieve evolution log', { error: String(err) });
        return [];
    }
}

/**
 * Build a learnings context string for injection into system prompt
 */
export function buildLearningsContext(): string {
    const topLearnings = getLearnings(undefined, 5);
    if (topLearnings.length === 0) return '';
    const items = topLearnings.map(l => `• [${l.category}] ${l.insight}`).join('\n');
    return `\n[Self-Learnings — สิ่งที่เรียนรู้จากประสบการณ์]:\n${items}`;
}

/**
 * Search learnings by semantic similarity
 */
export async function searchLearnings(query: string, topK: number = 5): Promise<Learning[]> {
    try {
        // Try vector store search first
        try {
            const vs = await getVectorStore();
            const embedding = await embedText(query);
            if (embedding && embedding.length > 0) {
                const results = await vs.search(embedding, topK, { type: 'learning' });
                if (results.length > 0) {
                    const learnings = getLearnings(undefined, 100);
                    return results
                        .map(r => {
                            const id = parseInt(r.id.replace('learning_', ''));
                            return learnings.find(l => l.id === id);
                        })
                        .filter((l): l is Learning => l !== undefined);
                }
            }
        } catch (err) {
            log.warn('Vector store search for learnings failed, falling back', { error: String(err) });
        }

        // Fallback: keyword search in all learnings
        const allLearnings = getLearnings(undefined, 100);
        const queryLower = query.toLowerCase();
        return allLearnings
            .filter(l =>
                l.insight.toLowerCase().includes(queryLower) ||
                l.source.toLowerCase().includes(queryLower) ||
                l.category.toLowerCase().includes(queryLower)
            )
            .slice(0, topK);
    } catch (err) {
        log.error('Learning search failed', { error: String(err) });
        return [];
    }
}

/**
 * Index a learning in VectorStore for semantic search (async)
 */
async function indexLearningInVectorStore(id: number, insight: string): Promise<void> {
    try {
        const embedding = await embedText(insight);
        if (!embedding || embedding.length === 0) return;

        const vs = await getVectorStore();
        const doc: VectorDocument = {
            id: `learning_${id}`,
            text: insight,
            embedding,
            metadata: {
                chatId: 'system',
                type: 'learning',
                createdAt: new Date().toISOString(),
            },
        };
        await vs.upsert(doc);
    } catch (err) {
        log.warn('Failed to index learning in vector store', { error: String(err) });
    }
}

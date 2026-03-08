// ============================================================
// Learning Journal — Persistent knowledge base that grows from interactions
// ============================================================
// The AI records insights from conversations, errors, and self-reflection
// into categories. These learnings can be retrieved to improve future responses.

import { getDb } from '../database/db.js';
import { createLogger } from '../utils/logger.js';

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

        db.prepare(
            `INSERT INTO learning_journal (category, insight, source, confidence) VALUES (?, ?, ?, ?)`
        ).run(category, insight, source, confidence);
        log.info('New learning recorded', { category, insight: insight.substring(0, 80) });
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
    } catch {
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
    } catch { /* silent */ }
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
    } catch {
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

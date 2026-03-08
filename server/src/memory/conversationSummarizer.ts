// ============================================================
// Conversation Auto-Summarizer
// ============================================================
// Periodically summarizes long conversations to reduce token usage.
// Called from buildContext() in unifiedMemory.ts.

import { getDb } from '../database/db.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Summarizer');

// Threshold: summarize when new messages exceed this count since last summary
const SUMMARY_THRESHOLD = 20;

// Provider set externally (to avoid circular dependency with agent)
let summarizeProvider: ((messages: string) => Promise<string>) | null = null;

/**
 * Set the LLM provider function for summarization.
 * Should be called once at startup from agent.ts.
 */
export function setSummarizeProvider(fn: (messages: string) => Promise<string>): void {
    summarizeProvider = fn;
}

/**
 * Check if a conversation needs summarization based on message count delta.
 */
export function needsSummary(chatId: string): boolean {
    try {
        const db = getDb();
        const conv = db.prepare('SELECT summary_msg_count FROM conversations WHERE id = ?').get(chatId) as { summary_msg_count: number } | undefined;
        const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?').get(chatId) as { c: number } | undefined;
        if (!conv || !msgCount) return false;
        return (msgCount.c - (conv.summary_msg_count || 0)) >= SUMMARY_THRESHOLD;
    } catch {
        return false;
    }
}

/**
 * Get existing conversation summary from DB.
 */
export function getSummary(chatId: string): string {
    try {
        const db = getDb();
        const row = db.prepare('SELECT summary FROM conversations WHERE id = ?').get(chatId) as { summary: string } | undefined;
        return row?.summary || '';
    } catch {
        return '';
    }
}

/**
 * Summarize conversation and persist to DB.
 * This is designed to run asynchronously (non-blocking).
 */
export async function maybeSummarize(chatId: string): Promise<void> {
    if (!summarizeProvider) return;
    if (!needsSummary(chatId)) return;

    try {
        const db = getDb();
        // Fetch recent unsummarized messages
        const conv = db.prepare('SELECT summary, summary_msg_count FROM conversations WHERE id = ?').get(chatId) as { summary: string; summary_msg_count: number } | undefined;
        if (!conv) return;

        const msgs = db.prepare(
            'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 30'
        ).all(chatId) as { role: string; content: string }[];

        if (msgs.length < 5) return;

        const existing = conv.summary || '';
        const recentText = msgs.reverse()
            .map(m => `${m.role}: ${m.content.substring(0, 200)}`)
            .join('\n');

        const prompt = existing
            ? `สรุปเดิม:\n${existing}\n\nข้อความใหม่:\n${recentText}\n\nอัพเดทสรุปให้กระชับ (ไม่เกิน 3 บรรทัด) รวมข้อมูลสำคัญทั้งเก่าและใหม่:`
            : `สรุปบทสนทนานี้ให้กระชับ (ไม่เกิน 3 บรรทัด):\n${recentText}`;

        const summary = await summarizeProvider(prompt);
        if (summary && summary.length > 5) {
            const totalMsgs = db.prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?').get(chatId) as { c: number };
            db.prepare('UPDATE conversations SET summary = ?, summary_msg_count = ? WHERE id = ?')
                .run(summary, totalMsgs.c, chatId);
            log.info('Summarized conversation', { chatId, length: summary.length });
        }
    } catch (err: any) {
        log.error('Summarization failed', { chatId, error: err.message });
    }
}

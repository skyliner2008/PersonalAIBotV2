// ============================================================
// Unified Memory Service (MemGPT-inspired 4-Layer Architecture)
// ============================================================
// Layer 1: Core Memory    — User profile/facts, always in system prompt
// Layer 2: Working Memory — Last N messages cached in RAM
// Layer 3: Recall Memory  — Full searchable chat history in SQLite
// Layer 4: Archival Memory — Semantic embeddings for long-term facts
// ============================================================

import { getDb } from '../database/db.js';
import type {
    CoreMemoryBlock,
    MemoryMessage,
    ArchivalFact,
    MemoryContext,
    BuildContextOptions,
} from './types.js';
import { getSummary, maybeSummarize } from './conversationSummarizer.js';

// ---- Config — ปรับค่าให้รองรับ context ที่ใหญ่ขึ้น ----
const WORKING_MEMORY_LIMIT = 25;
const SESSION_TTL_MS = 60 * 60_000;  // 60 นาที
const ARCHIVAL_LIMIT = 200;
const CORE_EXTRACT_INTERVAL = 15;
const ARCHIVAL_EXTRACT_INTERVAL = 5;
const MAX_CACHE_ENTRIES = 500;       // จำกัด RAM cache ป้องกัน memory leak

// ============================================================
// RAM Cache for Working Memory (LRU-based eviction)
// ============================================================
const ramCache: Record<string, {
    messages: MemoryMessage[];
    lastActive: number;
    messageCount: number;
}> = {};

/** LRU eviction: ลบ session ที่เก่าที่สุดเมื่อ cache เต็ม */
function evictLRU(): void {
    const keys = Object.keys(ramCache);
    if (keys.length <= MAX_CACHE_ENTRIES) return;
    const sorted = keys
        .map(k => ({ key: k, ts: ramCache[k].lastActive }))
        .sort((a, b) => a.ts - b.ts);
    const toEvict = sorted.slice(0, keys.length - MAX_CACHE_ENTRIES);
    for (const e of toEvict) delete ramCache[e.key];
    if (toEvict.length > 0) console.log(`[Memory] LRU evicted ${toEvict.length} sessions`);
}

// Periodic cleanup — TTL + LRU (ทุก 5 นาที)
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const chatId of Object.keys(ramCache)) {
        if (now - ramCache[chatId].lastActive > SESSION_TTL_MS) {
            delete ramCache[chatId];
            cleaned++;
        }
    }
    evictLRU();
    if (cleaned > 0) console.log(`[Memory] TTL-cleaned ${cleaned} inactive sessions`);
}, 5 * 60_000);

// ============================================================
// CORE MEMORY (Layer 1) — always in system prompt
// ============================================================

export function getCoreMemory(chatId: string): CoreMemoryBlock[] {
    const rows = getDb()
        .prepare('SELECT block_label, value, updated_at FROM core_memory WHERE chat_id = ?')
        .all(chatId) as any[];
    return rows.map(r => ({
        label: r.block_label,
        value: r.value,
        updatedAt: r.updated_at,
    }));
}

export function setCoreMemory(chatId: string, label: string, value: string): void {
    getDb().prepare(`
    INSERT INTO core_memory (chat_id, block_label, value, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(chat_id, block_label) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
  `).run(chatId, label, value, value);
}

export function formatCoreMemory(blocks: CoreMemoryBlock[]): string {
    if (blocks.length === 0) return '';
    const parts: string[] = [];
    for (const b of blocks) {
        if (b.value.trim()) {
            parts.push(`<${b.label}>\n${b.value}\n</${b.label}>`);
        }
    }
    return parts.length > 0 ? `[Core Memory]\n${parts.join('\n')}` : '';
}

// ============================================================
// WORKING MEMORY (Layer 2) — RAM-cached recent messages
// ============================================================

export function addMessage(chatId: string, role: string, content: string): void {
    // 1. Save to DB (recall memory)
    getDb().prepare(
        'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)'
    ).run(chatId, role, content);

    // 2. Update RAM cache (with LRU check)
    if (!ramCache[chatId]) {
        evictLRU(); // ป้องกัน cache โตไม่มีขีดจำกัด
        ramCache[chatId] = { messages: [], lastActive: Date.now(), messageCount: 0 };
        // Load recent from DB to prime cache
        const rows = getDb()
            .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
            .all(chatId, WORKING_MEMORY_LIMIT) as any[];
        ramCache[chatId].messages = rows.reverse().map(r => ({
            chatId,
            role: r.role,
            content: r.content,
        }));
    } else {
        ramCache[chatId].messages.push({ chatId, role: role as any, content });
        // Trim to limit
        if (ramCache[chatId].messages.length > WORKING_MEMORY_LIMIT) {
            ramCache[chatId].messages = ramCache[chatId].messages.slice(-WORKING_MEMORY_LIMIT);
        }
    }
    ramCache[chatId].lastActive = Date.now();
    ramCache[chatId].messageCount++;
}

export function getWorkingMemory(chatId: string): MemoryMessage[] {
    if (!ramCache[chatId]) {
        // Load from DB
        const rows = getDb()
            .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
            .all(chatId, WORKING_MEMORY_LIMIT) as any[];
        ramCache[chatId] = {
            messages: rows.reverse().map(r => ({ chatId, role: r.role, content: r.content })),
            lastActive: Date.now(),
            messageCount: 0,
        };
    }
    ramCache[chatId].lastActive = Date.now();
    return ramCache[chatId].messages;
}

// Also save to episodes table for backward compatibility with Telegram/LINE
export function addEpisode(chatId: string, role: string, content: string): void {
    getDb().prepare('INSERT INTO episodes (chat_id, role, content) VALUES (?, ?, ?)').run(chatId, role, content);
}

// ============================================================
// RECALL MEMORY (Layer 3) — searchable chat history
// ============================================================

/** Escape LIKE wildcards (% and _) to prevent unintended wildcard matching */
function escapeLikePattern(s: string): string {
    return s.replace(/[%_\\]/g, '\\$&');
}

export function searchRecall(chatId: string, query: string, limit: number = 10): MemoryMessage[] {
    // Search from 'episodes' table (used by Telegram/LINE bots)
    // The 'messages' table is for Facebook Messenger (uses conversation_id, not chat_id)
    try {
        const safeQuery = escapeLikePattern(query.substring(0, 100));
        const rows = getDb().prepare(`
      SELECT role, content, timestamp FROM episodes
      WHERE chat_id = ? AND content LIKE ? ESCAPE '\\'
      ORDER BY id DESC LIMIT ?
    `).all(chatId, `%${safeQuery}%`, limit) as any[];

        return rows.reverse().map(r => ({
            chatId,
            role: r.role,
            content: r.content,
            createdAt: r.timestamp,
        }));
    } catch (err) {
        console.error('[Recall] searchRecall error:', err);
        return [];
    }
}

export function getRecallCount(chatId: string): number {
    // Count from 'episodes' (Telegram/LINE) — not 'messages' (Facebook)
    const row = getDb().prepare('SELECT COUNT(*) as c FROM episodes WHERE chat_id = ?').get(chatId) as any;
    return row?.c || 0;
}

// ============================================================
// ARCHIVAL MEMORY (Layer 4) — semantic facts with embeddings
// ============================================================

let embeddingProvider: ((text: string) => Promise<number[]>) | null = null;

export function setEmbeddingProvider(fn: (text: string) => Promise<number[]>): void {
    embeddingProvider = fn;
}

export async function saveArchivalFact(chatId: string, fact: string): Promise<void> {
    let embedding: Buffer | null = null;

    if (embeddingProvider) {
        try {
            const vec = await embeddingProvider(fact);
            embedding = Buffer.from(new Float32Array(vec).buffer);
        } catch (e) {
            console.error('[Memory] Embedding failed, saving without:', e);
        }
    }

    // Dedup: check if very similar fact already exists
    if (embedding) {
        const existing = getArchivalFacts(chatId);
        for (const ex of existing) {
            if (ex.embedding) {
                const sim = cosineSimilarity(
                    new Float32Array(embedding.buffer, embedding.byteOffset, embedding.byteLength / 4),
                    ex.embedding
                );
                if (sim > 0.9) {
                    // Update existing instead of inserting duplicate
                    getDb().prepare('UPDATE archival_memory SET fact = ?, embedding = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?')
                        .run(fact, embedding, ex.id);
                    return;
                }
            }
        }
    }

    getDb().prepare('INSERT INTO archival_memory (chat_id, fact, embedding) VALUES (?, ?, ?)')
        .run(chatId, fact, embedding);

    // 🧠 Smart Pruning — ถ้าเกิน ARCHIVAL_LIMIT ให้ลบ facts ที่สั้นและเก่าที่สุดออก
    // (ไม่ลบแบบ FIFO ล้วนๆ — facts สั้นมักมีคุณค่าน้อยกว่า)
    const count = getDb().prepare('SELECT COUNT(*) as c FROM archival_memory WHERE chat_id = ?').get(chatId) as any;
    if (count?.c > ARCHIVAL_LIMIT) {
        const excess = count.c - ARCHIVAL_LIMIT;
        // ลบ facts ที่สั้นที่สุดก่อน (priority: short = low-value), หากสั้นเท่ากันให้ลบเก่าก่อน
        getDb().prepare(`
            DELETE FROM archival_memory WHERE id IN (
                SELECT id FROM archival_memory
                WHERE chat_id = ?
                ORDER BY LENGTH(fact) ASC, created_at ASC
                LIMIT ?
            )
        `).run(chatId, excess);
    }
}

export async function searchArchival(chatId: string, query: string, limit: number = 3, threshold: number = 0.65): Promise<string[]> {
    if (!embeddingProvider) {
        // Fallback: text search (escape LIKE wildcards to prevent injection)
        const safeQ = escapeLikePattern(query.substring(0, 50));
        const rows = getDb().prepare("SELECT fact FROM archival_memory WHERE chat_id = ? AND fact LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?")
            .all(chatId, `%${safeQ}%`, limit) as any[];
        return rows.map(r => r.fact);
    }

    try {
        const queryVec = new Float32Array(await embeddingProvider(query));
        const facts = getArchivalFacts(chatId);
        if (facts.length === 0) return [];

        const now = Date.now();
        const scored = facts
            .filter(f => f.embedding)
            .map(f => {
                const semanticScore = cosineSimilarity(queryVec, f.embedding!);
                // 🎯 Importance = semantic similarity (70%) + recency (20%) + length bonus (10%)
                // recency: decay หลัง 30 วัน → score ลดลงเป็น 0.5
                const ageMs = now - new Date(f.createdAt || 0).getTime();
                const recencyScore = Math.exp(-ageMs / (30 * 24 * 60 * 60 * 1000)) * 0.5 + 0.5;
                const lengthBonus = Math.min(f.fact.length / 200, 1) * 0.1;
                const importanceScore = (semanticScore * 0.7) + (recencyScore * 0.2) + lengthBonus;
                return { fact: f.fact, score: importanceScore, semantic: semanticScore };
            })
            .filter(r => r.semantic > threshold) // semantic ต้องผ่าน threshold ก่อน
            .sort((a, b) => b.score - a.score)   // sort โดย composite score
            .slice(0, limit);

        return scored.map(s => s.fact);
    } catch (e) {
        console.error('[Memory] Archival search error:', e);
        return [];
    }
}

function getArchivalFacts(chatId: string): { id: number; chatId: string; fact: string; embedding: Float32Array | null; createdAt: string }[] {
    const rows = getDb().prepare('SELECT id, fact, embedding, created_at FROM archival_memory WHERE chat_id = ? ORDER BY created_at DESC LIMIT 150')
        .all(chatId) as any[];
    return rows.map(r => ({
        id: r.id,
        chatId,
        fact: r.fact,
        createdAt: r.created_at,
        embedding: r.embedding ?
            new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4) : null,
    }));
}

// ============================================================
// BUILD CONTEXT — combines all 4 layers
// ============================================================

export async function buildContext(
    chatId: string,
    userMessage: string,
    options: BuildContextOptions = {}
): Promise<MemoryContext> {
    const maxRecent = options.maxRecent ?? WORKING_MEMORY_LIMIT;
    const maxArchival = options.maxArchival ?? 5;
    const threshold = options.archivalThreshold ?? 0.55;

    // Layer 1: Core Memory
    const coreBlocks = getCoreMemory(chatId);
    const coreMemoryText = formatCoreMemory(coreBlocks);

    // Layer 2: Working Memory — ใช้ smart trimming
    const allWorking = getWorkingMemory(chatId);
    let workingMessages = allWorking.slice(-maxRecent);

    // Smart token budget: ถ้า context ใหญ่เกินไป ให้ตัดข้อความเก่าที่ยาว
    const MAX_CONTEXT_CHARS = 30_000;
    let totalChars = workingMessages.reduce((sum, m) => sum + m.content.length, 0);
    while (totalChars > MAX_CONTEXT_CHARS && workingMessages.length > 4) {
        const removed = workingMessages.shift()!;
        totalChars -= removed.content.length;
    }

    // Layer 3: Recall Memory — ค้นหาบริบทเก่าที่เกี่ยวข้อง (text search)
    let recallContext: string[] = [];
    if (userMessage.length > 15 && !options.skipArchival) {
        const keywords = userMessage.split(/\s+/).filter(w => w.length > 3).slice(0, 3);
        for (const kw of keywords) {
            const found = searchRecall(chatId, kw, 3);
            for (const msg of found) {
                if (msg?.content && !recallContext.includes(msg.content) && msg.content.length > 20) {
                    recallContext.push(`[${msg.role}]: ${msg.content.substring(0, 200)}`);
                }
            }
            if (recallContext.length >= 5) break;
        }
    }

    // Layer 4: Archival Memory (semantic search)
    let archivalFacts: string[] = [];
    if (!options.skipArchival && userMessage) {
        archivalFacts = await searchArchival(chatId, userMessage, maxArchival, threshold);
    }

    // Merge recall context into archival facts (deduplicated)
    if (recallContext.length > 0) {
        const existingSet = new Set(archivalFacts);
        for (const rc of recallContext) {
            if (!existingSet.has(rc)) archivalFacts.push(rc);
        }
    }

    // Conversation Summary (auto-generated)
    const conversationSummary = getSummary(chatId);

    // Token estimate
    let chars = coreMemoryText.length + conversationSummary.length;
    for (const m of workingMessages) chars += m.content.length;
    for (const f of archivalFacts) chars += f.length;
    chars += 800; // system prompt overhead (เพิ่มจาก 400 เพราะ prompt ใหญ่ขึ้น)
    const tokenEstimate = Math.round(chars / 2.5);

    // Trigger async summarization if needed (non-blocking)
    setImmediate(() => maybeSummarize(chatId).catch(() => { }));

    return {
        coreMemoryText,
        workingMessages,
        archivalFacts,
        conversationSummary,
        tokenEstimate,
        stats: {
            coreBlocks: coreBlocks.length,
            workingMessages: workingMessages.length,
            archivalFacts: archivalFacts.length,
        },
    };
}

// ============================================================
// AUTO-EXTRACTION — extracts facts from conversation
// ============================================================

export function shouldExtractCore(chatId: string): boolean {
    return (ramCache[chatId]?.messageCount || 0) > 0 &&
        ramCache[chatId].messageCount % CORE_EXTRACT_INTERVAL === 0;
}

export function shouldExtractArchival(chatId: string): boolean {
    return (ramCache[chatId]?.messageCount || 0) > 0 &&
        ramCache[chatId].messageCount % ARCHIVAL_EXTRACT_INTERVAL === 0;
}

// ============================================================
// UTILITIES
// ============================================================

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    // Guard: mismatched dimensions → return 0 (no similarity)
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

export function clearMemory(chatId: string): void {
    delete ramCache[chatId];
    getDb().prepare('DELETE FROM core_memory WHERE chat_id = ?').run(chatId);
    getDb().prepare('DELETE FROM archival_memory WHERE chat_id = ?').run(chatId);
    getDb().prepare('DELETE FROM messages WHERE conversation_id = ?').run(chatId);
}

export function getMemoryStats(chatId: string): {
    coreBlocks: number;
    workingMessages: number;
    recallMessages: number;
    archivalFacts: number;
} {
    const coreBlocks = (getDb().prepare('SELECT COUNT(*) as c FROM core_memory WHERE chat_id = ?').get(chatId) as any)?.c || 0;
    const recallMessages = getRecallCount(chatId);
    const archivalFacts = (getDb().prepare('SELECT COUNT(*) as c FROM archival_memory WHERE chat_id = ?').get(chatId) as any)?.c || 0;
    const workingMessages = getWorkingMemory(chatId).length;
    return { coreBlocks, workingMessages, recallMessages, archivalFacts };
}

// ============================================================
// Unified Memory Service (MemGPT-inspired 4-Layer Architecture)
// ============================================================
// Layer 1: Core Memory    — User profile/facts, always in system prompt
// Layer 2: Working Memory — Last N messages cached in RAM
// Layer 3: Recall Memory  — Full searchable chat history in SQLite
// Layer 4: Archival Memory — Semantic embeddings for long-term facts
// ============================================================

import { getDb, upsertConversation } from '../database/db.js';
import type {
    CoreMemoryBlock,
    MemoryMessage,
    ArchivalFact,
    MemoryContext,
    BuildContextOptions,
} from './types.js';
import { getSummary, maybeSummarize } from './conversationSummarizer.js';
import { getVectorStore, initVectorStore, type VectorDocument } from './vectorStore.js';
import { embedText } from './embeddingProvider.js';
import { memoryMutex } from '../utils/mutex.js';
import { searchCache } from '../utils/cache.js';
import { createLogger } from '../utils/logger.js';
import { queryGraph } from './graphMemory.js';
import { pingActivity } from '../scheduler/subconscious.js';
import { getMaxMemoryMessages } from '../config/runtimeSettings.js';

const log = createLogger('Memory');

// ---- Config — ปรับค่าให้รองรับ context ที่ใหญ่ขึ้น ----
const SESSION_TTL_MS = 60 * 60_000;  // 60 นาที
const ARCHIVAL_LIMIT = 200;
const CORE_EXTRACT_INTERVAL = 15;
const ARCHIVAL_EXTRACT_INTERVAL = 5;
const MAX_CACHE_ENTRIES = 500;       // จำกัด RAM cache ป้องกัน memory leak

// Token Budget — สำหรับ Gemini 2.0 Flash (1M context, แต่เราจำกัดไว้ให้ประหยัด)
const TOKEN_BUDGET = {
    systemPrompt: 2_000,     // System instruction + persona + bot identity
    coreMemory: 1_500,       // Core memory blocks
    summary: 500,            // Conversation summary
    archival: 2_000,         // Archival facts
    history: 8_000,          // Working memory messages (main budget)
    userMessage: 2_000,      // Current user message + attachments
    total: 16_000,           // Max tokens per request (~40K chars)
};

/** Estimate tokens from text (Thai/English: ~2.5 chars per token) */
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 2.5);
}

/** Trim messages from oldest first until within budget, keep at least minKeep */
function trimToTokenBudget(messages: MemoryMessage[], budgetTokens: number, minKeep: number = 4): MemoryMessage[] {
    let totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    if (totalTokens <= budgetTokens) return messages;

    // Try truncating long messages first (keep first 300 chars)
    const truncated = messages.map((m, i) => {
        if (i < messages.length - minKeep && m.content.length > 600) {
            return { ...m, content: m.content.substring(0, 300) + '...(ย่อ)' };
        }
        return m;
    });

    // Remove oldest messages until within budget
    let startIdx = 0;
    while (totalTokens > budgetTokens && startIdx < truncated.length - minKeep) {
        totalTokens -= estimateTokens(truncated[startIdx].content);
        startIdx++;
    }

    return truncated.slice(startIdx);
}

// ============================================================
// RAM Cache for Working Memory (LRU-based eviction)
// ============================================================
const ramCache: Record<string, {
    messages: MemoryMessage[];
    lastActive: number;
    messageCount: number;
}> = {};

// Synchronization flag to prevent concurrent cache operations
let cacheOperationInProgress = false;

/** LRU eviction: ลบ session ที่เก่าที่สุดเมื่อ cache เต็ม */
function evictLRU(): void {
    const keys = Object.keys(ramCache);
    if (keys.length <= MAX_CACHE_ENTRIES) return;
    try {
        const sorted = keys
            .map(k => {
                const entry = ramCache[k];
                if (!entry) return null;
                return { key: k, ts: entry.lastActive };
            })
            .filter((item): item is { key: string; ts: number } => item !== null)
            .sort((a, b) => a.ts - b.ts);
        const toEvict = sorted.slice(0, Math.max(0, keys.length - MAX_CACHE_ENTRIES));
        for (const e of toEvict) delete ramCache[e.key];
        if (toEvict.length > 0) log.info(`LRU evicted ${toEvict.length} sessions`);
    } catch (err) {
        log.warn('Error during LRU cache eviction', { error: String(err) });
    }
}

// Periodic cleanup — TTL + LRU (ทุก 5 นาที) + Vector index flush
const cleanupInterval = setInterval(() => {
    // Prevent concurrent eviction/cleanup operations
    if (cacheOperationInProgress) return;
    cacheOperationInProgress = true;
    try {
        const now = Date.now();
        let cleaned = 0;
        for (const chatId of Object.keys(ramCache)) {
            const entry = ramCache[chatId];
            // Null check: cache entry might be evicted elsewhere
            if (entry && now - entry.lastActive > SESSION_TTL_MS) {
                delete ramCache[chatId];
                cleaned++;
            }
        }
        evictLRU();
        if (cleaned > 0) log.info(`TTL-cleaned ${cleaned} inactive sessions`);
    } finally {
        cacheOperationInProgress = false;
    }
}, 5 * 60_000);

// Prevent the interval from keeping the Node.js process alive
if (typeof cleanupInterval.unref === 'function') {
    cleanupInterval.unref();
}

export function stopMemoryCleanup(): void {
    clearInterval(cleanupInterval);
}

// Initialize Vector Store on startup
let vectorStoreReady = false;
let vectorStoreInitPromise: Promise<void> | null = null;

export async function initUnifiedMemory(): Promise<void> {
    if (vectorStoreInitPromise) {
        await vectorStoreInitPromise;
        return;
    }
    vectorStoreInitPromise = (async () => {
        try {
            await initVectorStore();
            vectorStoreReady = true;
            log.info('Vector Store initialized');
            const vs = await getVectorStore();
            const stats = await vs.getStats();
            if (stats.totalDocuments === 0) {
                log.info('Building initial vector index from SQLite...');
                const result = await vs.rebuildFromSQLite();
                log.info(`Vector index migration: ${result.migrated} docs, ${result.errors} errors`);
            }
        } catch (err) {
            log.warn('Failed to initialize Vector Store:', { error: String(err) });
        }
    })();
    await vectorStoreInitPromise;
}

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
    const workingMemoryLimit = getMaxMemoryMessages();
    // 0. Aggressive token saving: strip <think>, Base64 images, and overly long lines
    let cleanContent = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    cleanContent = cleanContent.replace(/data:image\/[^;]+;base64,[a-zA-Z0-9+/=]+/gi, '[Base64 Image Truncated]');
    const lines = cleanContent.split('\n');
    cleanContent = lines.map(l => l.length > 2500 ? l.substring(0, 2500) + '...[Truncated]' : l).join('\n');
    if (!cleanContent) return; // Do not save entirely empty messages

    // Ping subconscious that the user is active
    if (role === 'user') {
        pingActivity();
    }

    // 0.5 Ensure parent conversation exists before writing recall messages.
    // This prevents FOREIGN KEY failures for ad-hoc chat IDs (e.g. admin_web_session).
    const displayName = chatId.startsWith('admin_')
        ? 'Jarvis Terminal Admin'
        : 'Unified Memory Session';
    upsertConversation(chatId, chatId, displayName);

    // 1. Save to DB (recall memory)
    getDb().prepare(
        'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)'
    ).run(chatId, role, cleanContent);

    // 2. Update RAM cache (with LRU check)
    if (!ramCache[chatId]) {
        evictLRU(); // ป้องกัน cache โตไม่มีขีดจำกัด
        ramCache[chatId] = { messages: [], lastActive: Date.now(), messageCount: 0 };
        // Load recent from DB to prime cache
        const rows = getDb()
            .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
            .all(chatId, workingMemoryLimit) as any[];
        ramCache[chatId].messages = rows.reverse().map(r => ({
            chatId,
            role: r.role,
            content: r.content,
        }));
        // Initialize messageCount from DB to keep extraction triggers aligned
        const countRow = getDb().prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?').get(chatId) as any;
        ramCache[chatId].messageCount = countRow?.c || 0;
    } else {
        ramCache[chatId].messages.push({ chatId, role: role as any, content: cleanContent });
        // Trim to limit
        if (ramCache[chatId].messages.length > workingMemoryLimit) {
            ramCache[chatId].messages = ramCache[chatId].messages.slice(-workingMemoryLimit);
        }
    }
    ramCache[chatId].lastActive = Date.now();
    ramCache[chatId].messageCount++;
}

export function getWorkingMemory(chatId: string): MemoryMessage[] {
    const workingMemoryLimit = getMaxMemoryMessages();
    if (!ramCache[chatId]) {
        // Load from DB
        const rows = getDb()
            .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
            .all(chatId, workingMemoryLimit) as any[];
        ramCache[chatId] = {
            messages: rows.reverse().map(r => ({ chatId, role: r.role, content: r.content })),
            lastActive: Date.now(),
            messageCount: 0,
        };
    }
    if (ramCache[chatId].messages.length > workingMemoryLimit) {
        ramCache[chatId].messages = ramCache[chatId].messages.slice(-workingMemoryLimit);
    }
    ramCache[chatId].lastActive = Date.now();
    return ramCache[chatId].messages;
}

// Also save to episodes table for backward compatibility with Telegram/LINE
export function addEpisode(chatId: string, role: string, content: string): void {
    let cleanContent = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    cleanContent = cleanContent.replace(/data:image\/[^;]+;base64,[a-zA-Z0-9+/=]+/gi, '[Base64 Image Truncated]');
    const lines = cleanContent.split('\n');
    cleanContent = lines.map(l => l.length > 2500 ? l.substring(0, 2500) + '...[Truncated]' : l).join('\n');
    if (!cleanContent) return;
    getDb().prepare('INSERT INTO episodes (chat_id, role, content) VALUES (?, ?, ?)').run(chatId, role, cleanContent);
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

/** Get embedding for a fact if provider is available */
async function _getFactEmbedding(fact: string): Promise<{ embedding: Buffer | null, vector: number[] }> {
    if (!embeddingProvider) return { embedding: null, vector: [] };
    try {
        const vec = await embeddingProvider(fact);
        return {
            embedding: Buffer.from(new Float32Array(vec).buffer),
            vector: vec
        };
    } catch (e) {
        console.error('[Memory] Embedding failed, saving without:', e);
        return { embedding: null, vector: [] };
    }
}

/** Check if a similar fact already exists (similarity > 0.9) */
function _findDuplicateFact(chatId: string, embedding: Buffer): { id: number } | null {
    const existing = getArchivalFacts(chatId);
    const embFloat = new Float32Array(embedding.buffer, embedding.byteOffset, embedding.byteLength / 4);
    for (const ex of existing) {
        if (ex.embedding) {
            const sim = cosineSimilarity(embFloat, ex.embedding);
            if (sim > 0.9) return { id: ex.id };
        }
    }
    return null;
}

/** Sync archival fact to vector store */
async function _syncFactToVectorStore(id: string | number, fact: string, vector: number[], chatId: string) {
    if (!vectorStoreReady || vector.length === 0) return;
    try {
        const vs = await getVectorStore();
        await vs.upsert({
            id: `archival_${id}`,
            text: fact,
            embedding: vector,
            metadata: {
                chatId,
                type: 'archival',
                createdAt: new Date().toISOString(),
            },
        });
    } catch (err) {
        log.warn('Failed to update vector store:', { error: String(err) });
    }
}

/** Prune archival memory if limit exceeded (short and old facts first) */
async function _pruneArchivalMemory(chatId: string) {
    const count = (getDb().prepare('SELECT COUNT(*) as c FROM archival_memory WHERE chat_id = ?').get(chatId) as any)?.c || 0;
    if (count <= ARCHIVAL_LIMIT) return;

    const excess = count - ARCHIVAL_LIMIT;
    const toDelete = getDb().prepare(`
        SELECT id FROM archival_memory WHERE chat_id = ?
        ORDER BY LENGTH(fact) ASC, created_at ASC LIMIT ?
    `).all(chatId, excess) as any[];

    if (toDelete.length === 0) return;

    const placeholders = toDelete.map(() => '?').join(',');
    getDb().prepare(`DELETE FROM archival_memory WHERE id IN (${placeholders})`)
        .run(...toDelete.map(r => r.id));

    if (vectorStoreReady) {
        try {
            const vs = await getVectorStore();
            for (const row of toDelete) await vs.delete(`archival_${row.id}`);
        } catch (err) {
            console.warn('[Memory] Vector store pruning failed:', err);
        }
    }
}

export async function saveArchivalFact(chatId: string, fact: string): Promise<void> {
    // Use per-chatId mutex to prevent concurrent duplicate checks
    return memoryMutex.withLock(`archival:${chatId}`, async () => {
        const { embedding, vector } = await _getFactEmbedding(fact);

        // Dedup: check if very similar fact already exists
        if (embedding) {
            const dup = _findDuplicateFact(chatId, embedding);
            if (dup) {
                getDb().prepare('UPDATE archival_memory SET fact = ?, embedding = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?')
                    .run(fact, embedding, dup.id);
                await _syncFactToVectorStore(dup.id, fact, vector, chatId);
                return;
            }
        }

        // Insert new fact
        const result = getDb().prepare('INSERT INTO archival_memory (chat_id, fact, embedding) VALUES (?, ?, ?)')
            .run(chatId, fact, embedding);
        const newId = (result as any).lastInsertRowid || Date.now();

        await _syncFactToVectorStore(newId, fact, vector, chatId);
        await _pruneArchivalMemory(chatId);
    }); // end memoryMutex.withLock
}

export async function searchArchival(chatId: string, query: string, limit: number = 3, threshold: number = 0.65): Promise<string[]> {
    // Cache: same chatId + query → same results (1 hour TTL)
    const cacheKey = `arch:${chatId}:${query.substring(0, 100)}:${limit}`;
    const cached = searchCache.get(cacheKey);
    if (cached) return cached as string[];

    const results = await _searchArchivalCore(chatId, query, limit, threshold);
    if (results.length > 0) {
        searchCache.set(cacheKey, results);
    }
    return results;
}

async function _searchArchivalCore(chatId: string, query: string, limit: number, threshold: number): Promise<string[]> {
    const textFallbackSearch = (): string[] => {
        const safeQ = escapeLikePattern(query.substring(0, 50));
        const rows = getDb().prepare("SELECT fact FROM archival_memory WHERE chat_id = ? AND fact LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?")
            .all(chatId, `%${safeQ}%`, limit) as any[];
        return rows.map(r => r.fact);
    };

    if (!embeddingProvider) {
        return textFallbackSearch();
    }

    try {
        const queryVec = await embedText(query);
        if (!queryVec || queryVec.length === 0) {
            return textFallbackSearch();
        }

        // Try Vector Store search first
        if (vectorStoreReady) {
            try {
                const vs = await getVectorStore();
                const results = await vs.search(queryVec, Math.max(limit * 2, 10), { chatId, type: 'archival' });

                if (results.length > 0) {
                    // Apply recency and length bonuses on top of vector similarity
                    const now = Date.now();
                    const scored = results.map(r => {
                        const ageMs = now - new Date(r.metadata.createdAt).getTime();
                        const recencyScore = Math.exp(-ageMs / (30 * 24 * 60 * 60 * 1000)) * 0.5 + 0.5;
                        const lengthBonus = Math.min(r.text.length / 200, 1) * 0.1;
                        const importanceScore = (r.score * 0.7) + (recencyScore * 0.2) + lengthBonus;
                        return { fact: r.text, score: importanceScore, semantic: r.score };
                    })
                        .filter(r => r.semantic > threshold)
                        .sort((a, b) => b.score - a.score)
                        .slice(0, limit);

                    if (scored.length > 0) {
                        return scored.map(s => s.fact);
                    }
                }
            } catch (err) {
                console.warn('[Memory] Vector store search failed, falling back to SQLite:', err);
            }
        }

        // Fallback: SQLite cosine similarity (slower but always works)
        const queryVecTyped = new Float32Array(queryVec);
        const facts = getArchivalFacts(chatId);
        if (facts.length === 0) return [];

        const now = Date.now();
        const scored = facts
            .filter(f => f.embedding)
            .map(f => {
                const semanticScore = cosineSimilarity(queryVecTyped, f.embedding!);
                // 🎯 Importance = semantic similarity (70%) + recency (20%) + length bonus (10%)
                const ageMs = now - new Date(f.createdAt || 0).getTime();
                const recencyScore = Math.exp(-ageMs / (30 * 24 * 60 * 60 * 1000)) * 0.5 + 0.5;
                const lengthBonus = Math.min(f.fact.length / 200, 1) * 0.1;
                const importanceScore = (semanticScore * 0.7) + (recencyScore * 0.2) + lengthBonus;
                return { fact: f.fact, score: importanceScore, semantic: semanticScore };
            })
            .filter(r => r.semantic > threshold)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

        if (scored.length > 0) {
            return scored.map(s => s.fact);
        }
        return textFallbackSearch();
    } catch (e) {
        console.error('[Memory] Archival search error:', e);
        return textFallbackSearch();
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

/** Calculate dynamic token budget based on model context window */
function getDynamicTokenBudget(modelContextWindow?: number) {
    const budget = { ...TOKEN_BUDGET };
    if (modelContextWindow) {
        if (modelContextWindow >= 1_000_000) {
            budget.history = 12_000;
            budget.archival = 3_000;
            budget.total = 22_000;
        } else if (modelContextWindow >= 128_000) {
            budget.history = 10_000;
            budget.archival = 2_500;
            budget.total = 18_000;
        }
    }
    return budget;
}

/** Retrieve context from multiple layers in parallel */
async function retrieveContextLayers(
    chatId: string,
    userMessage: string,
    options: { skipSearch: boolean; maxArchival: number; threshold: number }
) {
    const { skipSearch, maxArchival, threshold } = options;

    return Promise.all([
        // Layer 3: Recall Memory — text search
        (async (): Promise<string[]> => {
            if (skipSearch || userMessage.length <= 15) return [];
            try {
                const context: string[] = [];
                const keywords = userMessage.split(/\s+/).filter(w => w.length > 3).slice(0, 3);
                for (const kw of keywords) {
                    const found = searchRecall(chatId, kw, 3);
                    for (const msg of found) {
                        if (msg?.content && !context.includes(msg.content) && msg.content.length > 20) {
                            context.push(`[${msg.role}]: ${msg.content.substring(0, 200)}`);
                        }
                    }
                }
                return context;
            } catch (err) { log.warn('Recall memory context failed', { error: String(err) }); return []; }
        })(),

        // Layer 4: Archival Memory — vector search
        (async (): Promise<string[]> => {
            if (skipSearch) return [];
            try {
                return await searchArchival(chatId, userMessage, maxArchival, threshold);
            } catch (err) { log.warn('Archival search failed', { error: String(err) }); return []; }
        })(),

        // Layer 5: GraphRAG — relational knowledge
        (async (): Promise<string> => {
            if (skipSearch || userMessage.length <= 10) return '';
            try {
                const graphKeywords = userMessage
                    .split(/[\s,;.!?\u0E00-\u0E7F]+/)
                    .filter(w => w.length > 2)
                    .slice(0, 5);
                if (graphKeywords.length > 0) {
                    return queryGraph(chatId, graphKeywords, 8);
                }
            } catch (err) { log.debug('Graph query failed', { error: String(err) }); }
            return '';
        })(),

        // Layer 6: Conversation Summary
        (async (): Promise<string> => {
            try {
                const { getConversationSummary } = await import('../database/db.js');
                const { summary } = getConversationSummary(chatId);
                return summary || '';
            } catch { return ''; }
        })()
    ]);
}

/** Enhance graph context by doing a multi-hop search from archival facts */
function enhanceGraphWithArchival(chatId: string, archivalContext: string[], graphContext: string): string {
    try {
        const entityKeywords = archivalContext
            .flatMap(f => f.split(/[\s,;.!?]+/).filter(w => w.length > 3))
            .slice(0, 5);
        if (entityKeywords.length > 0) {
            const hopResult = queryGraph(chatId, entityKeywords, 4);
            if (hopResult && hopResult !== graphContext) {
                return graphContext ? `${graphContext}\n${hopResult}` : hopResult;
            }
        }
    } catch (err) { log.debug('Multi-hop graph retrieval failed', { error: String(err) }); }
    return graphContext;
}

export async function buildContext(
    chatId: string,
    userMessage: string,
    options: BuildContextOptions = {}
): Promise<MemoryContext> {
    const maxRecent = options.maxRecent ?? getMaxMemoryMessages();
    const maxArchival = options.maxArchival ?? 5;
    const threshold = options.archivalThreshold ?? 0.55;

    // Layer 1: Core Memory (sync)
    const coreBlocks = getCoreMemory(chatId);
    const coreMemoryText = formatCoreMemory(coreBlocks);

    // Layer 2: Working Memory
    const allWorking = getWorkingMemory(chatId);
    const recentMessages = allWorking.slice(-maxRecent);

    // Token Budget Management
    const dynamicBudget = getDynamicTokenBudget(options.modelContextWindow);
    const coreTokens = estimateTokens(coreMemoryText);
    const usedBudget = Math.min(coreTokens, dynamicBudget.coreMemory) + dynamicBudget.systemPrompt + dynamicBudget.summary;
    const historyBudget = dynamicBudget.total - usedBudget - dynamicBudget.archival - dynamicBudget.userMessage;
    const workingMessages = trimToTokenBudget(recentMessages, Math.max(historyBudget, dynamicBudget.history));

    // Parallel Retrieval: Layer 3, 4, 5, 6
    const skipSearch = !!options.skipArchival;
    const [_, archivalContext, graphContext, summaryContext] = await retrieveContextLayers(
        chatId,
        userMessage,
        { skipSearch, maxArchival, threshold }
    );

    // Multi-hop Retrieval
    const enhancedGraphContext = !skipSearch && archivalContext.length > 0
        ? enhanceGraphWithArchival(chatId, archivalContext, graphContext)
        : graphContext;

    const stats = getMemoryStats(chatId);

    return {
        coreMemoryText,
        workingMessages,
        archivalFacts: archivalContext,
        tokenEstimate: 0,
        conversationSummary: summaryContext,
        graphContext: enhancedGraphContext || undefined,
        stats: {
            coreBlocks: stats.coreBlocks,
            workingMessages: stats.workingMessages,
            archivalFacts: stats.archivalFacts,
        }
    };
}

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

export async function clearMemory(chatId: string): Promise<void> {
    delete ramCache[chatId];
    getDb().prepare('DELETE FROM core_memory WHERE chat_id = ?').run(chatId);
    getDb().prepare('DELETE FROM archival_memory WHERE chat_id = ?').run(chatId);
    getDb().prepare('DELETE FROM messages WHERE conversation_id = ?').run(chatId);

    // Also clear from vector store
    if (vectorStoreReady) {
        try {
            const vs = await getVectorStore();
            await vs.deleteByFilter({ chatId });
        } catch (err) {
            log.warn('Failed to clear vector store:', { error: String(err) });
        }
    }
}

export function getMemoryStats(chatId: string): {
    coreBlocks: number;
    workingMessages: number;
    recallMessages: number;
    archivalFacts: number;
} {
    // Combine multiple queries into fewer database calls
    const coreBlocks = (getDb().prepare('SELECT COUNT(*) as c FROM core_memory WHERE chat_id = ?').get(chatId) as any)?.c || 0;
    const recallMessages = getRecallCount(chatId);
    const archivalFacts = (getDb().prepare('SELECT COUNT(*) as c FROM archival_memory WHERE chat_id = ?').get(chatId) as any)?.c || 0;

    // Use ramCache length directly instead of calling getWorkingMemory which loads full messages
    const workingMessages = ramCache[chatId]?.messages.length || 0;

    return { coreBlocks, workingMessages, recallMessages, archivalFacts };
}



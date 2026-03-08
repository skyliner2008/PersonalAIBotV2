// ============================================================
// Unified Memory Service (MemGPT-inspired 4-Layer Architecture)
// ============================================================
// Layer 1: Core Memory    — User profile/facts, always in system prompt
// Layer 2: Working Memory — Last N messages cached in RAM
// Layer 3: Recall Memory  — Full searchable chat history in SQLite
// Layer 4: Archival Memory — Semantic embeddings for long-term facts
// ============================================================
import { getDb } from '../database/db.js';
// ---- Config ----
const WORKING_MEMORY_LIMIT = 15; // Max messages in working memory
const SESSION_TTL_MS = 30 * 60_000; // 30 min RAM cache TTL
const ARCHIVAL_LIMIT = 100; // Max archival facts per chat
const CORE_EXTRACT_INTERVAL = 20; // Update core memory every N messages
const ARCHIVAL_EXTRACT_INTERVAL = 8; // Extract facts every N messages
// ============================================================
// RAM Cache for Working Memory
// ============================================================
const ramCache = {};
// Periodic cleanup
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const chatId of Object.keys(ramCache)) {
        if (now - ramCache[chatId].lastActive > SESSION_TTL_MS) {
            delete ramCache[chatId];
            cleaned++;
        }
    }
    if (cleaned > 0)
        console.log(`[Memory] Cleaned ${cleaned} inactive sessions`);
}, 10 * 60_000);
// ============================================================
// CORE MEMORY (Layer 1) — always in system prompt
// ============================================================
export function getCoreMemory(chatId) {
    const rows = getDb()
        .prepare('SELECT block_label, value, updated_at FROM core_memory WHERE chat_id = ?')
        .all(chatId);
    return rows.map(r => ({
        label: r.block_label,
        value: r.value,
        updatedAt: r.updated_at,
    }));
}
export function setCoreMemory(chatId, label, value) {
    getDb().prepare(`
    INSERT INTO core_memory (chat_id, block_label, value, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(chat_id, block_label) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
  `).run(chatId, label, value, value);
}
export function formatCoreMemory(blocks) {
    if (blocks.length === 0)
        return '';
    const parts = [];
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
export function addMessage(chatId, role, content) {
    // 1. Save to DB (recall memory)
    getDb().prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(chatId, role, content);
    // 2. Update RAM cache
    if (!ramCache[chatId]) {
        ramCache[chatId] = { messages: [], lastActive: Date.now(), messageCount: 0 };
        // Load recent from DB to prime cache
        const rows = getDb()
            .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
            .all(chatId, WORKING_MEMORY_LIMIT);
        ramCache[chatId].messages = rows.reverse().map(r => ({
            chatId,
            role: r.role,
            content: r.content,
        }));
    }
    else {
        ramCache[chatId].messages.push({ chatId, role: role, content });
        // Trim to limit
        if (ramCache[chatId].messages.length > WORKING_MEMORY_LIMIT) {
            ramCache[chatId].messages = ramCache[chatId].messages.slice(-WORKING_MEMORY_LIMIT);
        }
    }
    ramCache[chatId].lastActive = Date.now();
    ramCache[chatId].messageCount++;
}
export function getWorkingMemory(chatId) {
    if (!ramCache[chatId]) {
        // Load from DB
        const rows = getDb()
            .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
            .all(chatId, WORKING_MEMORY_LIMIT);
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
export function addEpisode(chatId, role, content) {
    getDb().prepare('INSERT INTO episodes (chat_id, role, content) VALUES (?, ?, ?)').run(chatId, role, content);
}
// ============================================================
// RECALL MEMORY (Layer 3) — searchable chat history
// ============================================================
export function searchRecall(chatId, query, limit = 10) {
    // Simple text search using LIKE (no embeddings needed)
    const rows = getDb().prepare(`
    SELECT role, content, created_at FROM messages
    WHERE conversation_id = ? AND content LIKE ?
    ORDER BY id DESC LIMIT ?
  `).all(chatId, `%${query}%`, limit);
    return rows.reverse().map(r => ({
        chatId,
        role: r.role,
        content: r.content,
        createdAt: r.created_at,
    }));
}
export function getRecallCount(chatId) {
    const row = getDb().prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?').get(chatId);
    return row?.c || 0;
}
// ============================================================
// ARCHIVAL MEMORY (Layer 4) — semantic facts with embeddings
// ============================================================
let embeddingProvider = null;
export function setEmbeddingProvider(fn) {
    embeddingProvider = fn;
}
export async function saveArchivalFact(chatId, fact) {
    let embedding = null;
    if (embeddingProvider) {
        try {
            const vec = await embeddingProvider(fact);
            embedding = Buffer.from(new Float32Array(vec).buffer);
        }
        catch (e) {
            console.error('[Memory] Embedding failed, saving without:', e);
        }
    }
    // Dedup: check if very similar fact already exists
    if (embedding) {
        const existing = getArchivalFacts(chatId);
        for (const ex of existing) {
            if (ex.embedding) {
                const sim = cosineSimilarity(new Float32Array(embedding.buffer, embedding.byteOffset, embedding.byteLength / 4), ex.embedding);
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
    // Auto-limit
    const count = getDb().prepare('SELECT COUNT(*) as c FROM archival_memory WHERE chat_id = ?').get(chatId);
    if (count?.c > ARCHIVAL_LIMIT) {
        getDb().prepare('DELETE FROM archival_memory WHERE id IN (SELECT id FROM archival_memory WHERE chat_id = ? ORDER BY created_at ASC LIMIT ?)')
            .run(chatId, count.c - ARCHIVAL_LIMIT);
    }
}
export async function searchArchival(chatId, query, limit = 3, threshold = 0.65) {
    if (!embeddingProvider) {
        // Fallback: text search
        const rows = getDb().prepare('SELECT fact FROM archival_memory WHERE chat_id = ? AND fact LIKE ? ORDER BY created_at DESC LIMIT ?')
            .all(chatId, `%${query.substring(0, 20)}%`, limit);
        return rows.map(r => r.fact);
    }
    try {
        const queryVec = new Float32Array(await embeddingProvider(query));
        const facts = getArchivalFacts(chatId);
        if (facts.length === 0)
            return [];
        const scored = facts
            .filter(f => f.embedding)
            .map(f => ({ fact: f.fact, score: cosineSimilarity(queryVec, f.embedding) }))
            .sort((a, b) => b.score - a.score)
            .filter(r => r.score > threshold)
            .slice(0, limit);
        return scored.map(s => s.fact);
    }
    catch (e) {
        console.error('[Memory] Archival search error:', e);
        return [];
    }
}
function getArchivalFacts(chatId) {
    const rows = getDb().prepare('SELECT id, fact, embedding FROM archival_memory WHERE chat_id = ? ORDER BY created_at DESC LIMIT 100')
        .all(chatId);
    return rows.map(r => ({
        id: r.id,
        chatId,
        fact: r.fact,
        embedding: r.embedding ?
            new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4) : null,
    }));
}
// ============================================================
// BUILD CONTEXT — combines all 4 layers
// ============================================================
export async function buildContext(chatId, userMessage, options = {}) {
    const maxRecent = options.maxRecent ?? WORKING_MEMORY_LIMIT;
    const maxArchival = options.maxArchival ?? 3;
    const threshold = options.archivalThreshold ?? 0.65;
    // Layer 1: Core Memory
    const coreBlocks = getCoreMemory(chatId);
    const coreMemoryText = formatCoreMemory(coreBlocks);
    // Layer 2: Working Memory
    const allWorking = getWorkingMemory(chatId);
    const workingMessages = allWorking.slice(-maxRecent);
    // Layer 4: Archival Memory (semantic search)
    let archivalFacts = [];
    if (!options.skipArchival && userMessage) {
        archivalFacts = await searchArchival(chatId, userMessage, maxArchival, threshold);
    }
    // Token estimate
    let chars = coreMemoryText.length;
    for (const m of workingMessages)
        chars += m.content.length;
    for (const f of archivalFacts)
        chars += f.length;
    chars += 400; // system prompt overhead
    const tokenEstimate = Math.round(chars / 2.5);
    return {
        coreMemoryText,
        workingMessages,
        archivalFacts,
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
export function shouldExtractCore(chatId) {
    return (ramCache[chatId]?.messageCount || 0) > 0 &&
        ramCache[chatId].messageCount % CORE_EXTRACT_INTERVAL === 0;
}
export function shouldExtractArchival(chatId) {
    return (ramCache[chatId]?.messageCount || 0) > 0 &&
        ramCache[chatId].messageCount % ARCHIVAL_EXTRACT_INTERVAL === 0;
}
// ============================================================
// UTILITIES
// ============================================================
function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}
export function clearMemory(chatId) {
    delete ramCache[chatId];
    getDb().prepare('DELETE FROM core_memory WHERE chat_id = ?').run(chatId);
    getDb().prepare('DELETE FROM archival_memory WHERE chat_id = ?').run(chatId);
    getDb().prepare('DELETE FROM messages WHERE conversation_id = ?').run(chatId);
}
export function getMemoryStats(chatId) {
    const coreBlocks = getDb().prepare('SELECT COUNT(*) as c FROM core_memory WHERE chat_id = ?').get(chatId)?.c || 0;
    const recallMessages = getRecallCount(chatId);
    const archivalFacts = getDb().prepare('SELECT COUNT(*) as c FROM archival_memory WHERE chat_id = ?').get(chatId)?.c || 0;
    const workingMessages = getWorkingMemory(chatId).length;
    return { coreBlocks, workingMessages, recallMessages, archivalFacts };
}
//# sourceMappingURL=unifiedMemory.js.map
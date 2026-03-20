import { getDb } from '../database/db.js';
import { createLogger } from '../utils/logger.js';
import { createAgentRuntimeProvider, getAgentCompatibleProviders } from '../providers/agentRuntime.js';
import { z } from 'zod';

const log = createLogger('GraphMemory');

/** Zod schema for LLM-extracted knowledge graph triples */
const TripleSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
});
const TriplesArraySchema = z.array(TripleSchema);

export interface GraphNode {
  id: string;
  chatId: string;
  label: string;
  nodeType: string;
}

export interface GraphEdge {
  id: number;
  chatId: string;
  sourceId: string;
  targetId: string;
  relationship: string;
  weight: number;
}

export interface Triple {
  subject: string;
  predicate: string;
  object: string;
}

/**
 * Normalizes a label for use as an ID to prevent duplicates (e.g., "John Doe" -> "john_doe")
 */
function normalizeLabel(label: string): string {
    return label.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_ก-ฮ]/g, '');
}

/**
 * Add or update a node in the graph
 */
export function addNode(chatId: string, label: string, type: string = 'entity'): string {
    const db = getDb();
    const normalized = normalizeLabel(label);
    const nodeId = `${chatId}_${normalized}`;

    db.prepare(`
        INSERT INTO knowledge_nodes (id, chat_id, label, node_type)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
    `).run(nodeId, chatId, label.trim(), type);

    return nodeId;
}

/**
 * Add a relationship (edge) between two nodes
 */
export function addEdge(chatId: string, sourceLabel: string, targetLabel: string, relationship: string): void {
    const db = getDb();

    // Ensure nodes exist
    const sourceId = addNode(chatId, sourceLabel);
    const targetId = addNode(chatId, targetLabel);

    try {
        db.prepare(`
            INSERT INTO knowledge_edges (chat_id, source_id, target_id, relationship)
            VALUES (?, ?, ?, ?)
        `).run(chatId, sourceId, targetId, relationship.trim().toLowerCase());
        log.debug(`Added Graph Edge: [${sourceLabel}] -(${relationship})-> [${targetLabel}]`);
    } catch (err: any) {
        // Ignore UNIQUE constraint failures
        if (!err.message.includes('UNIQUE constraint failed')) {
            throw err;
        }
    }
}

/**
 * Adds multiple triples to the graph
 */
export function addTriples(chatId: string, triples: Triple[]): void {
    const db = getDb();
    const insertNode = db.prepare(`
        INSERT INTO knowledge_nodes (id, chat_id, label, node_type)
        VALUES (?, ?, ?, 'entity')
        ON CONFLICT(id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
    `);
    const insertEdge = db.prepare(`
        INSERT INTO knowledge_edges (chat_id, source_id, target_id, relationship)
        VALUES (?, ?, ?, ?)
    `);

    db.transaction(() => {
        for (const t of triples) {
            const srcId = `${chatId}_${normalizeLabel(t.subject)}`;
            const tgtId = `${chatId}_${normalizeLabel(t.object)}`;

            insertNode.run(srcId, chatId, t.subject.trim());
            insertNode.run(tgtId, chatId, t.object.trim());

            try {
                insertEdge.run(chatId, srcId, tgtId, t.predicate.trim().toLowerCase());
                log.debug(`Added Graph Edge: [${t.subject}] -(${t.predicate})-> [${t.object}]`);
            } catch (err: any) {
                if (!err.message.includes('UNIQUE constraint failed')) {
                    log.error('Failed to insert edge', { error: err.message, triple: t });
                }
            }
        }
    })();
}

/**
 * Queries the graph for relationships around specific keywords
 */
export function queryGraph(chatId: string, keywords: string[], limit: number = 10): string {
    if (!keywords || keywords.length === 0) return '';

    const db = getDb();
    const normalizedKeywords = keywords.map(k => normalizeLabel(k)).filter(k => k.length > 0);
    if(normalizedKeywords.length === 0) return '';

    const likeParams = normalizedKeywords.flatMap(k => [`%${k}%`, `%${k}%`]);
    const conditions = normalizedKeywords.map(() => `n1.label LIKE ? OR n2.label LIKE ?`).join(' OR ');

    const rows = db.prepare(`
        SELECT DISTINCT n1.label as subject, e.relationship, n2.label as object
        FROM knowledge_edges e
        JOIN knowledge_nodes n1 ON e.source_id = n1.id
        JOIN knowledge_nodes n2 ON e.target_id = n2.id
        WHERE e.chat_id = ? AND (${conditions})
        ORDER BY e.created_at DESC
        LIMIT ?
    `).all(chatId, ...likeParams, limit) as any[];

    if (rows.length === 0) return '';

    return rows.map(r => `[${r.subject}] -> (${r.relationship}) -> [${r.object}]`).join('\n');
}

/**
 * Selects an available LLM provider for GraphRAG extraction
 */
function selectGraphRAGProvider() {
    const compatibleProviders = getAgentCompatibleProviders({ enabledOnly: true });

    for (const p of compatibleProviders) {
        try {
            const runtimeProvider = createAgentRuntimeProvider(p.id);
            if (runtimeProvider) {
                const model = p.id === 'gemini' ? 'gemini-2.0-flash-lite' : (p.defaultModel || 'gpt-4o-mini');
                return { provider: runtimeProvider, model, providerId: p.id };
            }
        } catch (err: any) {
            log.debug(`Provider ${p.id} not available for GraphRAG: ${err.message}`);
        }
    }
    return null;
}

/**
 * Parses and validates triples from LLM response text
 */
function parseTriplesFromText(text: string, chatId: string): Triple[] {
    const jsonMatch = text.match(/\[.*\]/s);
    if (!jsonMatch) return [];

    try {
        const parsed = JSON.parse(jsonMatch[0]);
        const result = TriplesArraySchema.safeParse(parsed);
        if (result.success) {
            return result.data;
        } else {
            log.debug('Graph triple validation failed', { error: result.error.message, chatId });
        }
    } catch (err) {
        log.debug(`GraphRAG JSON parse failed for ${chatId}`);
    }
    return [];
}

/**
 * Use LLM to extract triples from conversation text
 */
export async function extractGraphKnowledge(chatId: string, text: string): Promise<void> {
    if (!text || text.length < 15) {
        log.debug(`Skipping GraphRAG for ${chatId}: text too short (${text?.length || 0} chars)`);
        return;
    }

    try {
        const providerConfig = selectGraphRAGProvider();
        if (!providerConfig) {
            log.warn(`No enabled LLM providers available for GraphRAG extraction (chatId: ${chatId})`);
            return;
        }

        const { provider, model, providerId } = providerConfig;
        log.debug(`Using provider "${providerId}" (model: ${model}) for GraphRAG extraction`);

        const prompt = `ดึงความสัมพันธ์เป็นกราฟความรู้ (Knowledge Graph) จากข้อความต่อไปนี้
ให้ดึงเฉพาะข้อเท็จจริงที่สำคัญเกี่ยวกับผู้ใช้ ประสบการณ์ของเขา หรือสิ่งที่เขาพูดถึง
ถ้าไม่มีความสัมพันธ์ที่ชัดเจน ให้คืนค่าอาร์เรย์ว่าง []

ตอบเป็น JSON array ของวัตถุที่มีรูปแบบดังนี้:
[
  { "subject": "ประธาน", "predicate": "ความสัมพันธ์", "object": "กรรม" }
]
* ห้ามตอบอะไรนอกเหนือจาก JSON
* ใช้ภาษาไทย (หรือภาษาเดียวกันกับต้นฉบับ) กระชับที่สุด

ข้อความ: "${text.substring(0, 2000)}"`;

        // Timeout protection (30s)
        const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 30000));
        const responsePromise = provider.generateResponse(
            model,
            'คุณเป็นผู้เชี่ยวชาญด้าน Knowledge Graph Extraction ให้ทำงานตามสั่งและตอบเป็น JSON เท่านั้น',
            [{ role: 'user', parts: [{ text: prompt }] }]
        );

        const res = await Promise.race([responsePromise, timeoutPromise]);

        if (!res) {
            log.warn(`GraphRAG extraction timed out for ${chatId} (provider: ${providerId})`);
            return;
        }

        if (res.text) {
            const triples = parseTriplesFromText(res.text, chatId);
            if (triples.length > 0) {
                addTriples(chatId, triples);
                log.info(`Extracted ${triples.length} triples for ${chatId} (provider: ${providerId})`);
            }
        }
    } catch (err) {
        log.error('Graph extraction failed', { error: String(err), chatId });
        throw err;
    }
}

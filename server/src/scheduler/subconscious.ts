// ============================================================
// Subconscious Sleep Mode — Memory Consolidation ระหว่าง Idle
// ============================================================
// เมื่อระบบ idle 2 ชม. จะเริ่ม:
// Phase 1: Summarize conversations ที่มีข้อความใหม่เยอะ
// Phase 1.5: Extract GraphRAG knowledge จาก summaries
// Phase 2: Prune old working memory ที่ summarize แล้ว

import { getDb } from '../database/db.js';
import { createLogger } from '../utils/logger.js';
import { maybeSummarize } from '../memory/conversationSummarizer.js';
import { addLog } from '../database/db.js';
import { extractGraphKnowledge } from '../memory/graphMemory.js';

const log = createLogger('Subconscious');

// ── Configuration ──
const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000;  // 2 hours
const CHECK_INTERVAL_MS = 30 * 60 * 1000;       // 30 minutes
const PRUNE_AGE_DAYS = 7;
const PRUNE_KEEP_RECENT = 50;                    // ข้อความล่าสุดที่เก็บไว้ต่อ conversation
const API_DELAY_MS = 5000;                        // delay ระหว่าง API calls

// ── State ──
let lastActivityTime = Date.now();
let isSleeping = false;
let sleepInterval: NodeJS.Timeout | null = null;

// Phase tracking for resume after interruption
interface SleepState {
  phase: 'idle' | 'summarizing' | 'graphrag' | 'pruning' | 'done';
  summarizedIds: Set<string>;
  graphExtractedIds: Set<string>;
  startedAt: number;
  prunedCount: number;
}
let _sleepState: SleepState = {
  phase: 'idle',
  summarizedIds: new Set(),
  graphExtractedIds: new Set(),
  startedAt: 0,
  prunedCount: 0,
};

/**
 * Call from anywhere to reset idle timer (user activity detected)
 */
export function pingActivity(): void {
  lastActivityTime = Date.now();
  if (isSleeping) {
    log.info('System activity detected — waking up from Subconscious Sleep.');
    isSleeping = false;
  }
}

/** Check if sleep cycle is active */
export function getIsSleeping(): boolean {
  return isSleeping;
}

/** Get detailed sleep status */
export function getSleepStatus(): {
  isSleeping: boolean;
  phase: string;
  idleMinutes: number;
  summarized: number;
  graphExtracted: number;
  pruned: number;
} {
  const idleMs = Date.now() - lastActivityTime;
  return {
    isSleeping,
    phase: _sleepState.phase,
    idleMinutes: Math.round(idleMs / 60000),
    summarized: _sleepState.summarizedIds.size,
    graphExtracted: _sleepState.graphExtractedIds.size,
    pruned: _sleepState.prunedCount,
  };
}

/**
 * Initialize the background sleep job
 */
export function startSubconsciousSleepJob(): void {
  if (sleepInterval) clearInterval(sleepInterval);

  log.info(`Subconscious Sleep Job initialized. Idle threshold: ${IDLE_THRESHOLD_MS / 1000 / 60 / 60} hours.`);

  sleepInterval = setInterval(async () => {
    const timeSinceLastActivity = Date.now() - lastActivityTime;

    if (timeSinceLastActivity >= IDLE_THRESHOLD_MS && !isSleeping) {
      log.info(`System idle for > ${IDLE_THRESHOLD_MS / 1000 / 60 / 60} hours. Entering Subconscious Sleep Mode.`);
      isSleeping = true;
      _sleepState = {
        phase: 'idle',
        summarizedIds: new Set(),
        graphExtractedIds: new Set(),
        startedAt: Date.now(),
        prunedCount: 0,
      };
      await enterSleepCycle();
    }
  }, CHECK_INTERVAL_MS);
}

// ── Core Sleep Cycle ──

async function enterSleepCycle(): Promise<void> {
  try {
    addLog('system', 'Subconscious Sleep Started', 'Memory consolidation cycle เริ่มทำงาน', 'info');

    // Phase 1: Summarize conversations
    _sleepState.phase = 'summarizing';
    const summarized = await consolidateWorkingMemories();

    if (!isSleeping) {
      addLog('system', 'Subconscious Sleep Interrupted', `Phase 1 ถูกขัดจังหวะ (summarized: ${summarized})`, 'info');
      _sleepState.phase = 'idle';
      return;
    }

    // Phase 1.5: Extract GraphRAG
    _sleepState.phase = 'graphrag';
    const extracted = await consolidateGraphRAG();

    if (!isSleeping) {
      addLog('system', 'Subconscious Sleep Interrupted', `Phase 1.5 ถูกขัดจังหวะ (graphrag: ${extracted})`, 'info');
      _sleepState.phase = 'idle';
      return;
    }

    // Phase 2: Prune old messages
    _sleepState.phase = 'pruning';
    const pruned = pruneWorkingMemory();
    _sleepState.prunedCount = pruned;

    _sleepState.phase = 'done';
    const elapsed = Math.round((Date.now() - _sleepState.startedAt) / 1000);
    log.info(`Subconscious Sleep completed in ${elapsed}s: ${summarized} summarized, ${extracted} graphrag, ${pruned} pruned`);
    addLog('system', 'Subconscious Sleep Completed',
      `Summarized: ${summarized}, GraphRAG: ${extracted}, Pruned: ${pruned} (${elapsed}s)`, 'success');
  } catch (err) {
    log.error('Error during Subconscious Sleep cycle:', err);
    addLog('system', 'Subconscious Sleep Error', String(err), 'error');
  } finally {
    _sleepState.phase = 'idle';
  }
}

// ── Phase 1: Summarize Conversations ──

async function consolidateWorkingMemories(): Promise<number> {
  log.info('Phase 1: Consolidating Working Memories...');
  let summarized = 0;

  try {
    const db = getDb();

    // ✅ FIX: ใช้ threshold เดียวกับ conversationSummarizer (SUMMARY_THRESHOLD = 20)
    // แทนที่จะ hardcode 10 ซึ่งไม่ตรงกัน
    const unsummarizedConvs = db.prepare(`
      SELECT c.id,
             COUNT(m.id) as total_msgs,
             COALESCE(c.summary_msg_count, 0) as summary_count,
             (COUNT(m.id) - COALESCE(c.summary_msg_count, 0)) as unsummarized
      FROM conversations c
      JOIN messages m ON c.id = m.conversation_id
      GROUP BY c.id
      HAVING unsummarized >= 20
    `).all() as { id: string; total_msgs: number; summary_count: number; unsummarized: number }[];

    if (unsummarizedConvs.length === 0) {
      log.info('No pending conversations need summarization.');
      return 0;
    }

    log.info(`Found ${unsummarizedConvs.length} conversations to summarize.`);

    for (const conv of unsummarizedConvs) {
      if (!isSleeping) {
        log.info('Sleep interrupted by user activity. Aborting summarization.');
        break;
      }

      // Skip if already summarized in this cycle
      if (_sleepState.summarizedIds.has(conv.id)) continue;

      try {
        log.info(`Summarizing conversation: ${conv.id} (${conv.unsummarized} unsummarized msgs)`);
        await maybeSummarize(conv.id);
        _sleepState.summarizedIds.add(conv.id);
        summarized++;
      } catch (err: any) {
        // ✅ FIX: ไม่ให้ error ตัวเดียวหยุดทั้ง loop
        log.error(`Failed to summarize ${conv.id}`, { error: err.message });
      }

      // API rate limiting delay
      await new Promise(res => setTimeout(res, API_DELAY_MS));
    }
  } catch (err) {
    log.error('Failed to consolidate working memories:', err);
  }

  return summarized;
}

// ── Phase 1.5: GraphRAG Extraction ──

async function consolidateGraphRAG(): Promise<number> {
  log.info('Phase 1.5: Consolidating GraphRAG Knowledge...');
  let extracted = 0;

  try {
    const db = getDb();

    // ✅ FIX: ขยาย window จาก 24h → 3 days เพื่อครอบคลุมมากขึ้น
    const recentConvs = db.prepare(`
      SELECT id, summary FROM conversations
      WHERE summary IS NOT NULL AND summary != ''
      AND updated_at >= datetime('now', '-3 days')
      ORDER BY updated_at DESC
      LIMIT 20
    `).all() as { id: string; summary: string }[];

    if (recentConvs.length === 0) {
      log.info('No recent summaries to consolidate into GraphRAG.');
      return 0;
    }

    log.info(`Found ${recentConvs.length} conversations for GraphRAG consolidation.`);

    for (const conv of recentConvs) {
      if (!isSleeping) {
        log.info('Sleep interrupted. Aborting GraphRAG consolidation.');
        break;
      }

      // Skip if already extracted in this cycle
      if (_sleepState.graphExtractedIds.has(conv.id)) continue;

      try {
        log.info(`Extracting GraphRAG for: ${conv.id}`);
        await extractGraphKnowledge(conv.id, conv.summary);
        _sleepState.graphExtractedIds.add(conv.id);
        extracted++;
      } catch (err: any) {
        // ✅ FIX: ไม่ให้ error ตัวเดียวหยุดทั้ง loop
        log.error(`GraphRAG extraction failed for ${conv.id}`, { error: err.message });
      }

      await new Promise(res => setTimeout(res, API_DELAY_MS));
    }
  } catch (err) {
    log.error('Failed to consolidate GraphRAG:', err);
  }

  return extracted;
}

// ── Phase 2: Prune Old Working Memory ──

function pruneWorkingMemory(): number {
  log.info('Phase 2: Pruning old Working Memory...');
  try {
    const db = getDb();

    // ✅ FIX: Rewrite SQL ให้ปลอดภัยกว่า — 2-step approach แทน correlated subquery
    // Step 1: หา conversation IDs ทั้งหมดที่มี messages เก่า
    const oldConvs = db.prepare(`
      SELECT DISTINCT conversation_id
      FROM messages
      WHERE timestamp < datetime('now', '-${PRUNE_AGE_DAYS} days')
    `).all() as { conversation_id: string }[];

    if (oldConvs.length === 0) {
      log.info('No old messages to prune.');
      return 0;
    }

    let totalPruned = 0;

    // Step 2: สำหรับแต่ละ conversation, ลบ messages เก่าที่ไม่ใช่ 50 ล่าสุด
    // ✅ FIX: ใช้ per-conversation approach ที่ debug ง่ายและถูกต้อง
    const deleteStmt = db.prepare(`
      DELETE FROM messages
      WHERE conversation_id = ?
      AND timestamp < datetime('now', '-${PRUNE_AGE_DAYS} days')
      AND id NOT IN (
        SELECT id FROM messages
        WHERE conversation_id = ?
        ORDER BY id DESC
        LIMIT ${PRUNE_KEEP_RECENT}
      )
    `);

    // ✅ FIX: Only prune conversations that HAVE summaries (data is already consolidated)
    const convHasSummary = db.prepare(
      "SELECT id FROM conversations WHERE id = ? AND summary IS NOT NULL AND summary != ''"
    );

    for (const { conversation_id } of oldConvs) {
      // Safety check: only prune if conversation has a summary
      const hasSummary = convHasSummary.get(conversation_id);
      if (!hasSummary) {
        log.debug(`Skipping prune for ${conversation_id} — no summary yet`);
        continue;
      }

      try {
        const result = deleteStmt.run(conversation_id, conversation_id);
        const pruned = (result as any).changes || 0;
        if (pruned > 0) {
          totalPruned += pruned;
          log.debug(`Pruned ${pruned} messages from conversation ${conversation_id}`);
        }
      } catch (err: any) {
        log.error(`Failed to prune conversation ${conversation_id}`, { error: err.message });
      }
    }

    if (totalPruned > 0) {
      log.info(`Pruned ${totalPruned} obsolete messages from ${oldConvs.length} conversations.`);
      addLog('system', 'Memory Pruned', `Cleaned up ${totalPruned} old messages from Working Memory layer`, 'info');
    } else {
      log.info('No messages qualified for pruning.');
    }

    return totalPruned;
  } catch (err) {
    log.error('Failed to prune working memory:', err);
    return 0;
  }
}

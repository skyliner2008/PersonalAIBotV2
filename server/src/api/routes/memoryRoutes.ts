import { Router } from 'express';
import { asyncHandler } from '../../utils/errorHandler.js';
import { addLog, dbAll, dbGet, dbRun, getDb } from '../../database/db.js';
import { formatCoreMemory, getCoreMemory, getMemoryStats, getWorkingMemory } from '../../memory/unifiedMemory.js';
import { parseIntParam } from './shared.js';
import { requireReadWriteAuth } from '../../utils/auth.js';

const memoryRoutes = Router();
memoryRoutes.use(requireReadWriteAuth('viewer'));

// FB conversation memory info
memoryRoutes.get('/memory/fb/:convId', asyncHandler(async (req, res) => {
  const convId = String(req.params.convId);
  const conv = await dbGet<{ fb_user_name: string | null; summary: string; summary_msg_count: number }>(
    'SELECT * FROM conversations WHERE id = ?',
    [convId],
  );
  if (!conv) return res.status(404).json({ success: false, error: 'Conversation not found' });

  const profile = await dbGet<{ facts: string; tags: string; total_messages: number; first_contact: string }>(
    'SELECT * FROM user_profiles WHERE user_id = ?',
    [convId],
  );
  const msgCount = await dbGet<{ c: number }>('SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?', [convId]);

  let facts = [];
  let tags = [];
  if (profile) {
    try { facts = JSON.parse(profile.facts); } catch { facts = []; }
    try { tags = JSON.parse(profile.tags); } catch { tags = []; }
  }

  res.json({
    conversationId: convId,
    userName: conv.fb_user_name,
    messageCount: msgCount?.c || 0,
    summary: conv.summary || '',
    summaryMsgCount: conv.summary_msg_count || 0,
    profile: profile ? {
      facts,
      tags,
      totalMessages: profile.total_messages,
      firstContact: profile.first_contact,
    } : null,
  });
}));

// Clear all legacy FB memory
memoryRoutes.delete('/memory/all', asyncHandler(async (_req, res) => {
  await dbRun('DELETE FROM messages');
  await dbRun('DELETE FROM user_profiles');
  await dbRun('DELETE FROM conversations');
  addLog('system', 'Wiped AI Memory', 'Cleared all conversations, messages, and profiles', 'warning');
  res.json({ success: true });
}));

// Clear one legacy FB conversation
memoryRoutes.delete('/memory/fb/:convId', asyncHandler(async (req, res) => {
  const convId = String(req.params.convId);
  await dbRun('DELETE FROM messages WHERE conversation_id = ?', [convId]);
  await dbRun('DELETE FROM user_profiles WHERE user_id = ?', [convId]);
  await dbRun('DELETE FROM conversations WHERE id = ?', [convId]);
  addLog('system', 'Cleared User Memory', `Cleared memory for ID: ${convId}`, 'info');
  res.json({ success: true });
}));

// Conversations (with pagination)
memoryRoutes.get('/conversations', asyncHandler(async (req, res) => {
  const limit = parseIntParam(req.query.limit, 50, 1, 200);
  const offset = parseIntParam(req.query.offset, 0, 0, 100000);
  const rows = await dbAll(`
    SELECT c.*, COUNT(m.id) as message_count
    FROM conversations c
    LEFT JOIN messages m ON m.conversation_id = c.id
    GROUP BY c.id
    ORDER BY c.last_message_at DESC LIMIT ? OFFSET ?
  `, [limit, offset]);
  const total = await dbGet<{ c: number }>('SELECT COUNT(*) as c FROM conversations');
  res.json({ items: rows, total: total?.c ?? 0, limit, offset });
}));

memoryRoutes.get('/conversations/:id/messages', asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const limit = parseIntParam(req.query.limit, 50, 1, 500);
  const rows = await dbAll(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC LIMIT ?',
    [id, limit],
  );
  res.json(rows);
}));

// Memory viewer (with pagination)
memoryRoutes.get('/memory/chats', (req, res) => {
  const db = getDb();
  const limit = parseIntParam(req.query.limit, 50, 1, 200);
  const offset = parseIntParam(req.query.offset, 0, 0, 100000);
  try {
    const chats = db.prepare(`
      SELECT e.chat_id,
             COUNT(e.id) as episodeCount,
             MAX(e.timestamp) as lastSeen
      FROM episodes e
      GROUP BY e.chat_id
      ORDER BY lastSeen DESC
      LIMIT ? OFFSET ?
    `).all([limit, offset]);
    const total = db.prepare('SELECT COUNT(DISTINCT chat_id) as c FROM episodes').get() as { c: number } | undefined;
    res.json({ items: chats, total: total?.c ?? 0, limit, offset });
  } catch {
    res.json({ items: [], total: 0, limit, offset });
  }
});

// Keep static memory routes before /memory/:chatId to avoid route shadowing.
memoryRoutes.get('/memory/vector-stats', async (_req, res) => {
  try {
    const { getVectorStore } = await import('../../memory/vectorStore.js');
    const { getEmbeddingStats } = await import('../../memory/embeddingProvider.js');
    const vs = await getVectorStore();
    const vectorStats = await vs.getStats();
    const embeddingStats = getEmbeddingStats();

    res.json({
      success: true,
      vectorStore: {
        totalDocuments: vectorStats.totalDocuments,
        indexSizeBytes: vectorStats.indexSize,
      },
      embeddingProvider: embeddingStats,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

memoryRoutes.post('/memory/rebuild-index', async (_req, res) => {
  try {
    const { getVectorStore } = await import('../../memory/vectorStore.js');
    const vs = await getVectorStore();
    const result = await vs.rebuildFromSQLite();

    addLog('system', 'Vector index rebuilt', `migrated=${result.migrated}, errors=${result.errors}`, 'info');

    res.json({
      success: true,
      migrated: result.migrated,
      errors: result.errors,
      message: `Rebuilt vector index: ${result.migrated} documents indexed, ${result.errors} errors`,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

memoryRoutes.get('/memory/:chatId', (req, res) => {
  const { chatId } = req.params;
  const db = getDb();
  const archivalLimit = parseIntParam(req.query.archivalLimit, 30, 1, 200);
  const archivalOffset = parseIntParam(req.query.archivalOffset, 0, 0, 100000);
  try {
    const stats = getMemoryStats(chatId);
    const coreBlocks = getCoreMemory(chatId);
    const coreText = formatCoreMemory(coreBlocks);
    const workingMessages = getWorkingMemory(chatId);
    const archival = db.prepare(
      'SELECT id, fact, created_at FROM archival_memory WHERE chat_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all([chatId, archivalLimit, archivalOffset]) as any[];
    const archivalTotal = (db.prepare('SELECT COUNT(*) as c FROM archival_memory WHERE chat_id = ?').get([chatId]) as any)?.c ?? 0;
    const episodeCount = (db.prepare('SELECT COUNT(*) as c FROM episodes WHERE chat_id = ?').get([chatId]) as any)?.c ?? 0;

    res.json({
      chatId,
      stats,
      core: { text: coreText, blocks: coreBlocks },
      working: workingMessages,
      archival: { items: archival, total: archivalTotal, limit: archivalLimit, offset: archivalOffset },
      episodeCount,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

memoryRoutes.delete('/memory/:chatId', asyncHandler(async (req, res) => {
  const chatId = String(req.params.chatId);
  const db = getDb();

  await db.prepare('DELETE FROM archival_memory WHERE chat_id = ?').run([chatId]);
  await db.prepare('DELETE FROM core_memory WHERE chat_id = ?').run([chatId]);
  await db.prepare('DELETE FROM episodes WHERE chat_id = ?').run([chatId]);

  try {
    const { getVectorStore } = await import('../../memory/vectorStore.js');
    const vs = await getVectorStore();
    await vs.deleteByFilter({ chatId });
  } catch {
    // Vector store may not be ready.
  }

  addLog('system', 'Memory cleared', chatId, 'info');
  res.json({ success: true });
}));

export default memoryRoutes;

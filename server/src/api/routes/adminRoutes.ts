import { Router } from 'express';
import { z } from 'zod';
import { isRunning } from '../../automation/browser.js';
import { isChatMonitorActive } from '../../automation/chatBot.js';
import { isCommentMonitorActive } from '../../automation/commentBot.js';
import { addLog, dbAll, dbGet, dbRun, getDb } from '../../database/db.js';
import {
  clearAgentRunHistory,
  getAgentActiveRuns,
  getAgentRunHistory,
  getAgentStats,
} from '../../bot_agents/agentTelemetry.js';
import { getAllCacheStats } from '../../utils/cache.js';
import { getEmbeddingStats } from '../../memory/embeddingProvider.js';
import { cleanupUsageRecords, getHourlyUsage, getUsageSummary } from '../../utils/usageTracker.js';
import {
  createBackup,
  exportConversation,
  exportDataAsJSON,
  getBackupStorageInfo,
  listBackups,
} from '../../utils/backup.js';
import {
  addSubGoal,
  createGoal,
  deleteGoal,
  getGoalStats,
  getGoals,
  type SubGoal,
  updateGoalProgress,
  updateSubGoal,
} from '../../memory/goalTracker.js';
import { asyncHandler } from '../../utils/errorHandler.js';
import { validateBody } from '../../utils/validation.js';
import { requireAuth } from '../../utils/auth.js';
import { parseIntParam } from './shared.js';

const backupCreateSchema = z.object({
  label: z.string().max(50).regex(/^[a-zA-Z0-9_-]*$/).optional(),
});

const goalCreateSchema = z.object({
  chatId: z.string().min(1),
  title: z.string().min(1).max(500),
  description: z.string().max(2000).optional().default(''),
  priority: z.coerce.number().int().min(1).max(5).optional().default(3),
  subGoals: z.array(z.object({
    id: z.string().optional(),
    title: z.string().min(1),
    status: z.enum(['pending', 'in_progress', 'completed', 'skipped']).optional().default('pending'),
    order: z.coerce.number().int().optional(),
  })).optional().default([]),
});

const adminRoutes = Router();
adminRoutes.use(requireAuth('admin'));

// Keep backup endpoints protected.
adminRoutes.use('/backup', requireAuth('admin'));

adminRoutes.get('/health/detailed', (_req, res) => {
  const memUsage = process.memoryUsage();
  const dbSize = (() => {
    try {
      const row = dbGet<{ size: number }>(
        `SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()`,
      );
      return row?.size || 0;
    } catch {
      return 0;
    }
  })();

  const messageCount = dbGet<{ c: number }>('SELECT COUNT(*) as c FROM messages');
  const conversationCount = dbGet<{ c: number }>('SELECT COUNT(*) as c FROM conversations');
  const episodeCount = dbGet<{ c: number }>('SELECT COUNT(*) as c FROM episodes');
  const knowledgeCount = dbGet<{ c: number }>('SELECT COUNT(*) as c FROM knowledge');
  const logCount = dbGet<{ c: number }>('SELECT COUNT(*) as c FROM activity_logs');

  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
      rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
    },
    database: {
      sizeBytes: dbSize,
      sizeMB: Math.round(dbSize / 1024 / 1024 * 100) / 100,
      messages: messageCount?.c || 0,
      conversations: conversationCount?.c || 0,
      episodes: episodeCount?.c || 0,
      knowledge: knowledgeCount?.c || 0,
      logs: logCount?.c || 0,
    },
    bots: {
      browser: isRunning(),
      chatBot: isChatMonitorActive(),
      commentBot: isCommentMonitorActive(),
    },
    timestamp: new Date().toISOString(),
  });
});

adminRoutes.post('/maintenance/cleanup-logs', (_req, res) => {
  const cutoffDays = 30;
  const result = getDb()
    .prepare(`DELETE FROM activity_logs WHERE created_at < datetime('now', '-' || ? || ' days')`)
    .run(cutoffDays);
  const cleaned = (result as any).changes || 0;
  addLog('system', 'Log cleanup', `Removed ${cleaned} logs older than ${cutoffDays} days`, 'info');
  res.json({ success: true, cleaned });
});

adminRoutes.post('/maintenance/cleanup-episodes', (_req, res) => {
  const chatIds = dbAll<{ chat_id: string }>('SELECT DISTINCT chat_id FROM episodes');
  let totalCleaned = 0;
  for (const { chat_id } of chatIds) {
    const countRow = dbGet<{ c: number }>('SELECT COUNT(*) as c FROM episodes WHERE chat_id = ?', [chat_id]);
    if (countRow && countRow.c > 500) {
      const excess = countRow.c - 500;
      dbRun(
        'DELETE FROM episodes WHERE id IN (SELECT id FROM episodes WHERE chat_id = ? ORDER BY id ASC LIMIT ?)',
        [chat_id, excess],
      );
      totalCleaned += excess;
    }
  }
  addLog('system', 'Episode cleanup', `Removed ${totalCleaned} old episodes`, 'info');
  res.json({ success: true, cleaned: totalCleaned });
});

adminRoutes.get('/agent/runs', (req, res) => {
  const limit = parseIntParam(req.query.limit, 500, 1, 5000);
  res.json(getAgentRunHistory().slice(0, limit));
});

adminRoutes.delete('/agent/runs', (_req, res) => {
  clearAgentRunHistory();
  res.json({ success: true, message: 'Agent runs cleared' });
});

adminRoutes.get('/agent/active', (_req, res) => {
  res.json(getAgentActiveRuns());
});

adminRoutes.get('/agent/stats', (_req, res) => {
  const stats = getAgentStats();
  const mem = process.memoryUsage();
  res.json({
    ...stats,
    uptime: Math.round(process.uptime()),
    memoryMB: Math.round(mem.rss / 1024 / 1024),
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    embedding: getEmbeddingStats(),
    cache: getAllCacheStats(),
  });
});

adminRoutes.get('/usage/summary', (req, res) => {
  const hours = parseIntParam(req.query.hours, 24, 1, 720);
  res.json(getUsageSummary(hours));
});

adminRoutes.get('/usage/hourly', (req, res) => {
  const hours = parseIntParam(req.query.hours, 24, 1, 168);
  res.json(getHourlyUsage(hours));
});

adminRoutes.post('/usage/cleanup', (req, res) => {
  const keepDays = parseIntParam(req.body.keepDays, 90, 7, 365);
  const cleaned = cleanupUsageRecords(keepDays);
  addLog('system', 'Usage cleanup', `Removed ${cleaned} records older than ${keepDays} days`, 'info');
  res.json({ success: true, cleaned });
});

adminRoutes.post('/backup/create', validateBody(backupCreateSchema), asyncHandler(async (req, res) => {
  const label = req.body.label || undefined;
  const result = createBackup(label);
  addLog('system', 'Backup created', `${result.filename} (${result.sizeKB}KB)`, 'success');
  res.json({ success: true, ...result });
}));

adminRoutes.get('/backup/list', (_req, res) => {
  res.json({ backups: listBackups(), storage: getBackupStorageInfo() });
});

adminRoutes.post('/backup/export-json', asyncHandler(async (req, res) => {
  const options = req.body || {};
  const result = exportDataAsJSON(options);
  addLog('system', 'JSON export', result.filename, 'success');
  res.json({ success: true, filename: result.filename, tables: Object.keys(result.data) });
}));

adminRoutes.get('/backup/conversation/:chatId', (req, res) => {
  const { chatId } = req.params;
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  const data = exportConversation(chatId);
  res.json(data);
});

adminRoutes.get('/goals', (req, res) => {
  const chatId = String(req.query.chatId || '');
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  const status = req.query.status ? String(req.query.status) : undefined;
  res.json({ goals: getGoals(chatId, status), stats: getGoalStats(chatId) });
});

adminRoutes.post('/goals', validateBody(goalCreateSchema), (req, res) => {
  const { chatId, title, description, priority, subGoals } = req.body;
  const enrichedSubGoals = (subGoals as SubGoal[]).map((sg, i) => ({
    ...sg,
    id: sg.id || `sg_${Date.now()}_${i}`,
    order: sg.order ?? i + 1,
  }));
  const goal = createGoal(chatId, title, description, priority, enrichedSubGoals);
  res.json({ success: true, goal });
});

adminRoutes.patch('/goals/:id/progress', (req, res) => {
  const { progress, status } = req.body;
  const goal = updateGoalProgress(req.params.id, progress ?? 0, status);
  if (!goal) return res.status(404).json({ error: 'Goal not found' });
  res.json({ success: true, goal });
});

adminRoutes.patch('/goals/:goalId/subgoals/:subGoalId', (req, res) => {
  const goal = updateSubGoal(req.params.goalId, req.params.subGoalId, req.body);
  if (!goal) return res.status(404).json({ error: 'Goal or sub-goal not found' });
  res.json({ success: true, goal });
});

adminRoutes.post('/goals/:id/subgoals', (req, res) => {
  const { title, order } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const goal = addSubGoal(req.params.id, title, order);
  if (!goal) return res.status(404).json({ error: 'Goal not found' });
  res.json({ success: true, goal });
});

adminRoutes.delete('/goals/:id', (req, res) => {
  const deleted = deleteGoal(req.params.id);
  res.json({ success: deleted });
});

export default adminRoutes;

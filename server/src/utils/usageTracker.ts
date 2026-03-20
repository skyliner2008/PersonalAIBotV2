/**
 * Token Usage Tracker — Per-provider, per-task cost & usage monitoring
 *
 * Tracks:
 * - Token counts (prompt/completion/total) per provider
 * - Request counts and error rates per provider
 * - Per-task breakdown (chat, content, comment, summary, agent)
 * - Rolling 24h stats + all-time totals
 * - Approximate cost estimation based on provider pricing
 */

import { dbRun, dbGet, dbAll, getDb } from '../database/db.js';
import { createLogger } from './logger.js';

const log = createLogger('UsageTracker');
console.log('Test match 2');

// ============ Types ============

export interface UsageRecord {
  provider: string;
  model: string;
  task: string;         // 'chat' | 'content' | 'agent' | 'embedding' | etc.
  platform: string;     // 'facebook' | 'telegram' | 'line' | 'dashboard' | 'api'
  chatId?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
}

export interface ProviderStats {
  provider: string;
  totalRequests: number;
  totalErrors: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  avgDurationMs: number;
  estimatedCostUSD: number;
  lastUsed: string;
}

export interface UsageSummary {
  period: string;
  providers: (ProviderStats & { avgTokensPerRequest: number; isCalculationValid: boolean })[];
  taskBreakdown: Record<string, { requests: number; tokens: number }>;
  totalRequests: number;
  totalTokens: number;
  totalErrors: number;
  estimatedCostUSD: number;
  avgTokensPerRequest: number;
  isCalculationValid: boolean;
}

// ============ Pricing (per 1M tokens) ============
// Approximate pricing — update as needed
const PRICING: Record<string, { input: number; output: number }> = {
  'gemini-2.0-flash':       { input: 0.10, output: 0.40 },
  'gemini-2.0-flash-lite':  { input: 0.025, output: 0.10 },
  'gemini-2.5-flash':       { input: 0.15, output: 0.60 },
  'gemini-2.5-pro':         { input: 1.25, output: 10.0 },
  'gemini-embedding-001':   { input: 0.00, output: 0.00 }, // Free in Pro plan
  'gemini-embedding-002':   { input: 0.00, output: 0.00 }, // Configure if pricing changes
  'text-embedding-004':     { input: 0.00, output: 0.00 }, // Legacy Gemini embedding fallback
  'gpt-4o':                 { input: 2.50, output: 10.0 },
  'gpt-4o-mini':            { input: 0.15, output: 0.60 },
  'gpt-3.5-turbo':          { input: 0.50, output: 1.50 },
  'deepseek-chat':          { input: 0.14, output: 0.28 },
  'default':                { input: 0.50, output: 1.50 }, // fallback
};

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = PRICING[model] || PRICING['default'];
  return (promptTokens * pricing.input + completionTokens * pricing.output) / 1_000_000;
}

// ============ DB Schema (ensure table exists) ============

export function ensureUsageTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'unknown',
      task TEXT NOT NULL DEFAULT 'chat',
      platform TEXT NOT NULL DEFAULT 'api',
      chat_id TEXT,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      success BOOLEAN DEFAULT 1,
      error_message TEXT,
      estimated_cost_usd REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_tracking(provider, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_task ON usage_tracking(task, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_tracking(created_at DESC);
  `);
}

// ============ Record Usage ============

export function trackUsage(record: UsageRecord): void {
  try {
    const cost = estimateCost(record.model, record.promptTokens, record.completionTokens);
    dbRun(
      `INSERT INTO usage_tracking
        (provider, model, task, platform, chat_id, prompt_tokens, completion_tokens, total_tokens, duration_ms, success, error_message, estimated_cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.provider,
        record.model || 'unknown',
        record.task,
        record.platform,
        record.chatId || null,
        record.promptTokens,
        record.completionTokens,
        record.totalTokens,
        record.durationMs,
        record.success ? 1 : 0,
        record.errorMessage || null,
        cost,
      ]
    );
  } catch (err) {
    log.error('Failed to track usage', { error: String(err) });
  }
}

// ============ Query Stats ============

/** Get per-provider summary for the last N hours (default 24h) */
export function getUsageSummary(hours: number = 24): UsageSummary {
  try {
    const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();

    // Per-provider stats
    const providerRows = dbAll<{
      provider: string;
      totalRequests: number;
      totalErrors: number;
      totalPromptTokens: number;
      totalCompletionTokens: number;
      totalTokens: number;
      avgDurationMs: number;
      estimatedCostUSD: number;
      lastUsed: string;
    }>(`
      SELECT
        provider,
        COUNT(*) as totalRequests,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as totalErrors,
        SUM(prompt_tokens) as totalPromptTokens,
        SUM(completion_tokens) as totalCompletionTokens,
        SUM(total_tokens) as totalTokens,
        ROUND(AVG(duration_ms)) as avgDurationMs,
        ROUND(SUM(estimated_cost_usd), 6) as estimatedCostUSD,
        MAX(created_at) as lastUsed
      FROM usage_tracking
      WHERE created_at >= ?
      GROUP BY provider
      ORDER BY totalTokens DESC
    `, [cutoff]);

    // Per-task breakdown
    const taskRows = dbAll<{ task: string; requests: number; tokens: number }>(`
      SELECT task, COUNT(*) as requests, SUM(total_tokens) as tokens
      FROM usage_tracking
      WHERE created_at >= ?
      GROUP BY task
    `, [cutoff]);

    const taskBreakdown: Record<string, { requests: number; tokens: number }> = {};
    for (const row of taskRows) {
      taskBreakdown[row.task] = { requests: row.requests, tokens: row.tokens };
    }

    // Totals
    const totals = dbGet<{ totalRequests: number; totalTokens: number; totalErrors: number; totalCost: number }>(`
      SELECT
        COUNT(*) as totalRequests,
        SUM(total_tokens) as totalTokens,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as totalErrors,
        ROUND(SUM(estimated_cost_usd), 6) as totalCost
      FROM usage_tracking
      WHERE created_at >= ?
    `, [cutoff]);

    const providersWithMetrics = providerRows.map(p => ({
      ...p,
      avgTokensPerRequest: p.totalRequests > 0 ? Math.round(p.totalTokens / p.totalRequests) : 0,
      isCalculationValid: (p.totalPromptTokens + p.totalCompletionTokens) === p.totalTokens // Basic token math validation
    }));

    const totalAvgTokens = totals?.totalRequests ? Math.round((totals.totalTokens || 0) / totals.totalRequests) : 0;
    const isTotalValid = providersWithMetrics.every(p => p.isCalculationValid);

    return {
      period: `${hours}h`,
      providers: providersWithMetrics,
      taskBreakdown,
      totalRequests: totals?.totalRequests || 0,
      totalTokens: totals?.totalTokens || 0,
      totalErrors: totals?.totalErrors || 0,
      estimatedCostUSD: totals?.totalCost || 0,
      avgTokensPerRequest: totalAvgTokens,
      isCalculationValid: isTotalValid,
    };
  } catch (err) {
    log.error('Failed to get usage summary', { error: String(err) });
    return {
      period: `${hours}h`,
      providers: [],
      taskBreakdown: {},
      totalRequests: 0,
      totalTokens: 0,
      totalErrors: 0,
      estimatedCostUSD: 0,
      avgTokensPerRequest: 0,
      isCalculationValid: true,
    };
  }
}

/** Get hourly token usage for the last N hours (for charts) */
export function getHourlyUsage(hours: number = 24): { hour: string; tokens: number; requests: number; cost: number }[] {
  try {
    const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
    return dbAll<{ hour: string; tokens: number; requests: number; cost: number }>(`
      SELECT
        strftime('%Y-%m-%d %H:00', created_at) as hour,
        SUM(total_tokens) as tokens,
        COUNT(*) as requests,
        ROUND(SUM(estimated_cost_usd), 6) as cost
      FROM usage_tracking
      WHERE created_at >= ?
      GROUP BY hour
      ORDER BY hour ASC
    `, [cutoff]);
  } catch {
    return [];
  }
}

/** Cleanup old usage records (keep last N days) */
export function cleanupUsageRecords(keepDays: number = 90): number {
  try {
    const result = getDb().prepare(
      `DELETE FROM usage_tracking WHERE created_at < datetime('now', '-' || ? || ' days')`
    ).run(keepDays);
    return (result as any).changes || 0;
  } catch {
    return 0;
  }
}

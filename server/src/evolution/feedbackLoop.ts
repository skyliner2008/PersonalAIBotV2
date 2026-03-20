/**
 * Agent Performance Feedback Loop System
 *
 * Tracks and analyzes agent/specialist performance metrics:
 * - Task outcomes (success/failure/partial)
 * - Performance scoring (success rate, latency, token efficiency)
 * - Auto-tuning recommendations (upgrade/downgrade models)
 * - Historical leaderboard and trends
 */

import { getDb } from '../database/db.js';
import { createLogger } from '../utils/logger.js';
import { addLearning, logEvolution } from './learningJournal.js';

const log = createLogger('FeedbackLoop');

export type TaskOutcome = 'success' | 'failure' | 'partial';

export interface OutcomeRecord {
  id?: number;
  agentId: string;
  taskType: string;
  outcome: TaskOutcome;
  latencyMs: number;
  tokensUsed: number;
  timestamp: string;
}

export interface PerformanceScore {
  agentId: string;
  successRate: number;
  avgLatencyMs: number;
  tokenEfficiency: number;
  overallScore: number;
  sampleSize: number;
  lastUpdated: string;
}

export interface PerformanceMetrics {
  totalTasks: number;
  successes: number;
  failures: number;
  partials: number;
  totalLatencyMs: number;
  totalTokens: number;
}

/**
 * Agent Performance Feedback Loop
 * In-memory tracking with periodic DB persistence
 */
export class AgentFeedbackLoop {
  private outcomes: Map<string, OutcomeRecord[]> = new Map();
  private scoreCache: Map<string, PerformanceScore> = new Map();
  private readonly dbCheckInterval = 5 * 60 * 1000; // 5 minutes
  private lastDbSync = Date.now();

  constructor() {
    this.ensureTables();
    this.loadFromDb();
  }

  /**
   * Create feedback metrics table if it doesn't exist
   */
  private ensureTables(): void {
    try {
      const db = getDb();
      db.exec(`
        CREATE TABLE IF NOT EXISTS feedback_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL,
          task_type TEXT NOT NULL,
          outcome TEXT NOT NULL,
          latency_ms INTEGER NOT NULL,
          tokens_used INTEGER NOT NULL,
          timestamp TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_feedback_agent_id ON feedback_metrics(agent_id);
        CREATE INDEX IF NOT EXISTS idx_feedback_timestamp ON feedback_metrics(timestamp);
      `);
      log.info('Feedback metrics tables ready');
    } catch (err: any) {
      log.error('Failed to create feedback tables', { error: err.message });
    }
  }

  /**
   * Load historical outcomes from database
   */
  private loadFromDb(): void {
    try {
      const db = getDb();
      const rows = db.prepare(`
        SELECT agent_id, task_type, outcome, latency_ms, tokens_used, timestamp
        FROM feedback_metrics
        WHERE timestamp > datetime('now', '-7 days')
        ORDER BY timestamp DESC
      `).all() as any[];

      for (const row of rows) {
        const agentId = row.agent_id;
        if (!this.outcomes.has(agentId)) {
          this.outcomes.set(agentId, []);
        }
        this.outcomes.get(agentId)!.push({
          agentId,
          taskType: row.task_type,
          outcome: row.outcome,
          latencyMs: row.latency_ms,
          tokensUsed: row.tokens_used,
          timestamp: row.timestamp,
        });
      }
      log.debug('Loaded feedback metrics from DB', { agentCount: this.outcomes.size });
    } catch (err: any) {
      log.warn('Failed to load feedback from DB', { error: err.message });
    }
  }

  /**
   * Record task outcome for an agent
   */
  recordOutcome(
    agentId: string,
    taskType: string,
    outcome: TaskOutcome,
    latencyMs: number = 0,
    tokensUsed: number = 0
  ): void {
    if (!this.outcomes.has(agentId)) {
      this.outcomes.set(agentId, []);
    }

    const record: OutcomeRecord = {
      agentId,
      taskType,
      outcome,
      latencyMs,
      tokensUsed,
      timestamp: new Date().toISOString(),
    };

    this.outcomes.get(agentId)!.push(record);
    this.scoreCache.delete(agentId); // Invalidate cache

    // Persist to DB if interval elapsed
    if (Date.now() - this.lastDbSync > this.dbCheckInterval) {
      this.syncToDb();
    }

    log.debug('Outcome recorded', { agentId, taskType, outcome, latencyMs });
  }

  /**
   * Sync in-memory outcomes to database
   */
  private syncToDb(): void {
    try {
      const db = getDb();
      for (const [agentId, records] of this.outcomes) {
        for (const record of records) {
          db.prepare(`
            INSERT OR IGNORE INTO feedback_metrics
            (agent_id, task_type, outcome, latency_ms, tokens_used, timestamp)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            record.agentId,
            record.taskType,
            record.outcome,
            record.latencyMs,
            record.tokensUsed,
            record.timestamp
          );
        }
      }
      this.lastDbSync = Date.now();
      log.debug('Feedback metrics synced to DB');
    } catch (err: any) {
      log.warn('Failed to sync feedback to DB', { error: err.message });
    }
  }

  /**
   * Compute performance score for an agent
   */
  getPerformanceScore(agentId: string): PerformanceScore {
    if (this.scoreCache.has(agentId)) {
      return this.scoreCache.get(agentId)!;
    }

    const records = this.outcomes.get(agentId) || [];
    const metrics = this.computeMetrics(records);

    const successRate = metrics.totalTasks > 0
      ? metrics.successes / metrics.totalTasks
      : 0;

    const avgLatencyMs = metrics.totalTasks > 0
      ? metrics.totalLatencyMs / metrics.totalTasks
      : 0;

    const tokenEfficiency = metrics.totalTasks > 0
      ? metrics.totalTokens / metrics.totalTasks
      : 0;

    // Overall score: 40% success, 30% latency (lower is better), 30% token efficiency (lower is better)
    const latencyScore = Math.max(0, 1 - (avgLatencyMs / 5000)); // Max 5s latency
    const tokenScore = Math.max(0, 1 - (tokenEfficiency / 10000)); // Max 10k tokens
    const overallScore = successRate * 0.4 + latencyScore * 0.3 + tokenScore * 0.3;

    const score: PerformanceScore = {
      agentId,
      successRate,
      avgLatencyMs,
      tokenEfficiency,
      overallScore,
      sampleSize: metrics.totalTasks,
      lastUpdated: new Date().toISOString(),
    };

    this.scoreCache.set(agentId, score);
    return score;
  }

  /**
   * Compute metrics from outcome records
   */
  private computeMetrics(records: OutcomeRecord[]): PerformanceMetrics {
    let successes = 0;
    let failures = 0;
    let partials = 0;
    let totalLatency = 0;
    let totalTokens = 0;

    for (const record of records) {
      if (record.outcome === 'success') successes++;
      else if (record.outcome === 'failure') failures++;
      else if (record.outcome === 'partial') partials++;

      totalLatency += record.latencyMs;
      totalTokens += record.tokensUsed;
    }

    return {
      totalTasks: records.length,
      successes,
      failures,
      partials,
      totalLatencyMs: totalLatency,
      totalTokens,
    };
  }

  /**
   * Suggest improvements based on performance patterns
   */
  suggestImprovements(agentId: string): string[] {
    const score = this.getPerformanceScore(agentId);
    const suggestions: string[] = [];

    if (score.successRate < 0.6) {
      suggestions.push('High failure rate detected. Consider retraining or task specialization.');
    }

    if (score.avgLatencyMs > 3000) {
      suggestions.push('Latency is high. May benefit from optimized model or caching strategy.');
    }

    if (score.tokenEfficiency > 8000) {
      suggestions.push('Token usage is excessive. Try prompt compression or summarization.');
    }

    if (score.sampleSize < 10) {
      suggestions.push('Insufficient data for reliable recommendations. Continue collecting metrics.');
    }

    const records = this.outcomes.get(agentId) || [];
    const taskTypes = new Set(records.map(r => r.taskType));
    if (taskTypes.size > 3) {
      suggestions.push('High task diversity. Consider specialization to fewer task types.');
    }

    return suggestions;
  }

  /**
   * Check if agent should be downgraded to a smaller model
   */
  shouldDowngrade(agentId: string): boolean {
    const score = this.getPerformanceScore(agentId);
    // Downgrade if success rate > 95% AND sample size is sufficient
    return score.successRate > 0.95 && score.sampleSize > 20;
  }

  /**
   * Check if agent should be upgraded to a larger model
   */
  shouldUpgrade(agentId: string): boolean {
    const score = this.getPerformanceScore(agentId);
    // Upgrade if success rate < 70% AND we have enough data
    return score.successRate < 0.7 && score.sampleSize > 15;
  }

  /**
   * Get ranked leaderboard of agents by performance
   */
  getLeaderboard(limit: number = 10): Array<{ rank: number; agent: string; score: PerformanceScore }> {
    const scores = Array.from(this.outcomes.keys())
      .map(agentId => this.getPerformanceScore(agentId))
      .sort((a, b) => b.overallScore - a.overallScore)
      .slice(0, limit);

    return scores.map((score, index) => ({
      rank: index + 1,
      agent: score.agentId,
      score,
    }));
  }

  /**
   * Apply learnings from feedback loop to learning journal
   */
  applyFeedback(): void {
    const leaderboard = this.getLeaderboard(5);

    for (const { agent, score } of leaderboard) {
      const improvements = this.suggestImprovements(agent);

      if (improvements.length > 0) {
        const insight = `Agent ${agent} scored ${(score.overallScore * 100).toFixed(1)}%. ${improvements[0]}`;
        addLearning('performance', insight, 'feedback_loop', score.overallScore);

        logEvolution(
          'feedback_analysis',
          `Performance feedback for ${agent}`,
          { agentId: agent, score: score.overallScore, suggestions: improvements },
          true
        );
      }

      if (this.shouldUpgrade(agent)) {
        addLearning(
          'performance',
          `Agent ${agent} should be upgraded to a larger model (success rate ${(score.successRate * 100).toFixed(1)}%)`,
          'feedback_loop',
          0.8
        );
      }

      if (this.shouldDowngrade(agent)) {
        addLearning(
          'performance',
          `Agent ${agent} can be downgraded to a smaller model (high success rate: ${(score.successRate * 100).toFixed(1)}%)`,
          'feedback_loop',
          0.8
        );
      }
    }

    log.info('Feedback applied and learnings recorded', { agentCount: leaderboard.length });
  }

  /**
   * Force persistence to DB
   */
  flushToDB(): void {
    this.syncToDb();
  }
}

// Singleton instance
let instance: AgentFeedbackLoop | null = null;

export function getFeedbackLoop(): AgentFeedbackLoop {
  if (!instance) {
    instance = new AgentFeedbackLoop();
  }
  return instance;
}

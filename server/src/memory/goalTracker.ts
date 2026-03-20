/**
 * Goal Tracker — Multi-Session Goal Persistence
 *
 * Enables the agent to:
 * - Remember long-term goals across conversations
 * - Decompose goals into sub-goals
 * - Track progress and milestones
 * - Resume incomplete goals in new sessions
 *
 * Storage: SQLite for persistence across server restarts
 */

import { getDb } from '../database/db.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('GoalTracker');

// ── Types ─────────────────────────────────────────────────
export interface Goal {
  id: string;
  chatId: string;
  title: string;
  description: string;
  status: 'active' | 'paused' | 'completed' | 'failed';
  priority: number;        // 1-5 (5 = highest)
  progress: number;        // 0-100 percent
  subGoals: SubGoal[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SubGoal {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  order: number;
  notes?: string;
}

// ── Database Setup ────────────────────────────────────────
export function ensureGoalTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 3,
      progress INTEGER DEFAULT 0,
      sub_goals TEXT DEFAULT '[]',
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_goals_chat_id ON goals(chat_id);
    CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
  `);
  log.info('Goal tables ready');
}

// ── CRUD Operations ───────────────────────────────────────

let goalCounter = 0;

export function createGoal(chatId: string, title: string, description: string = '', priority: number = 3, subGoals: SubGoal[] = []): Goal {
  const db = getDb();
  const id = `goal_${Date.now()}_${++goalCounter}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO goals (id, chat_id, title, description, status, priority, progress, sub_goals, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, 0, ?, ?, ?)
  `).run(id, chatId, title, description, priority, JSON.stringify(subGoals), now, now);

  log.info(`Goal created: "${title}" for ${chatId}`, { id, priority });

  return {
    id, chatId, title, description,
    status: 'active', priority, progress: 0,
    subGoals, createdAt: now, updatedAt: now,
  };
}

export function getGoals(chatId: string, status?: string): Goal[] {
  const db = getDb();
  let sql = 'SELECT * FROM goals WHERE chat_id = ?';
  const params: (string | number)[] = [chatId];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY priority DESC, created_at DESC';

  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(rowToGoal);
}

export function getGoalById(goalId: string): Goal | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId) as any;
  return row ? rowToGoal(row) : null;
}

export function updateGoalProgress(goalId: string, progress: number, status?: Goal['status']): Goal | null {
  const db = getDb();
  const now = new Date().toISOString();
  const completedAt = status === 'completed' ? now : null;

  if (status) {
    db.prepare(`UPDATE goals SET progress = ?, status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?`)
      .run(progress, status, now, completedAt, goalId);
  } else {
    db.prepare(`UPDATE goals SET progress = ?, updated_at = ? WHERE id = ?`)
      .run(progress, now, goalId);
  }

  return getGoalById(goalId);
}

export function updateSubGoal(goalId: string, subGoalId: string, updates: Partial<SubGoal>): Goal | null {
  const goal = getGoalById(goalId);
  if (!goal) return null;

  const subGoals = goal.subGoals.map(sg => {
    if (sg.id === subGoalId) return { ...sg, ...updates };
    return sg;
  });

  // Recalculate progress from sub-goals
  const completedCount = subGoals.filter(sg => sg.status === 'completed').length;
  const totalCount = subGoals.filter(sg => sg.status !== 'skipped').length;
  const progress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const allDone = totalCount > 0 && completedCount === totalCount;

  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`UPDATE goals SET sub_goals = ?, progress = ?, status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?`)
    .run(JSON.stringify(subGoals), progress, allDone ? 'completed' : 'active', now, allDone ? now : null, goalId);

  return getGoalById(goalId);
}

export function addSubGoal(goalId: string, title: string, order?: number): Goal | null {
  const goal = getGoalById(goalId);
  if (!goal) return null;

  const newSubGoal: SubGoal = {
    id: `sg_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    title,
    status: 'pending',
    order: order ?? goal.subGoals.length + 1,
  };

  const subGoals = [...goal.subGoals, newSubGoal];
  const db = getDb();
  db.prepare(`UPDATE goals SET sub_goals = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(subGoals), goalId);

  return getGoalById(goalId);
}

export function deleteGoal(goalId: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM goals WHERE id = ?').run(goalId);
  return result.changes > 0;
}

// ── Context Builder (for system prompt injection) ────────
/**
 * Build a context string of active goals for injection into agent system prompt.
 * This allows the agent to be aware of user's ongoing goals.
 */
export function buildGoalContext(chatId: string): string {
  const activeGoals = getGoals(chatId, 'active');
  if (activeGoals.length === 0) return '';

  const lines = activeGoals.map(g => {
    const subInfo = g.subGoals.length > 0
      ? ` (${g.subGoals.filter(s => s.status === 'completed').length}/${g.subGoals.length} tasks done)`
      : '';
    return `- [${g.progress}%] ${g.title}${subInfo}`;
  });

  return `\n[Active Goals ของผู้ใช้]:\n${lines.join('\n')}`;
}

/**
 * Get summary stats for all goals of a user
 */
export function getGoalStats(chatId: string): {
  active: number; completed: number; total: number; avgProgress: number;
} {
  const db = getDb();
  const rows = db.prepare('SELECT status, progress FROM goals WHERE chat_id = ?').all(chatId) as any[];
  const active = rows.filter(r => r.status === 'active').length;
  const completed = rows.filter(r => r.status === 'completed').length;
  const avgProgress = rows.length > 0
    ? Math.round(rows.reduce((s, r) => s + (r.progress || 0), 0) / rows.length)
    : 0;
  return { active, completed, total: rows.length, avgProgress };
}

// ── Helper ────────────────────────────────────────────────
function rowToGoal(row: any): Goal {
  return {
    id: row.id,
    chatId: row.chat_id,
    title: row.title,
    description: row.description || '',
    status: row.status,
    priority: row.priority || 3,
    progress: row.progress || 0,
    subGoals: safeParseJSON(row.sub_goals, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || undefined,
    metadata: safeParseJSON(row.metadata, {}),
  };
}

function safeParseJSON<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

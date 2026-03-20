// ============================================================
// Database Migration Runner - Lightweight SQLite migrations
// ============================================================

import { getDb } from './db.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('migrationRunner');

// ============================================================
// Types
// ============================================================

export interface Migration {
  version: number;
  name: string;
  up: (db: any) => void;
  down: (db: any) => void;
}

interface AppliedMigration {
  version: number;
  name: string;
  applied_at: string;
}

export interface MigrationStatus {
  currentVersion: number;
  pendingCount: number;
  appliedMigrations: AppliedMigration[];
}

// ============================================================
// Migration Runner Class
// ============================================================

export class MigrationRunner {
  private migrations: Migration[] = [];

  constructor() {
    this.initializeMigrationsTable();
  }

  /**
   * Create the _migrations table if it doesn't exist
   */
  private initializeMigrationsTable(): void {
    try {
      const db = getDb();
      db.prepare(`
        CREATE TABLE IF NOT EXISTS _migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          applied_at TEXT NOT NULL
        )
      `).run();
      logger.info('Migrations table initialized');
    } catch (err) {
      logger.error('Failed to initialize migrations table', { error: String(err) });
      throw err;
    }
  }

  /**
   * Register a migration
   */
  register(migration: Migration): void {
    this.migrations.push(migration);
    this.migrations.sort((a, b) => a.version - b.version);
  }

  /**
   * Get list of applied migration versions
   */
  getAppliedVersions(): number[] {
    try {
      const db = getDb();
      const rows = db.prepare('SELECT version FROM _migrations ORDER BY version ASC').all() as AppliedMigration[];
      return rows.map(r => r.version);
    } catch (err) {
      logger.error('Failed to get applied versions', { error: String(err) });
      return [];
    }
  }

  /**
   * Get pending migrations (not yet applied)
   */
  getPendingMigrations(): Migration[] {
    const appliedVersions = new Set(this.getAppliedVersions());
    return this.migrations.filter(m => !appliedVersions.has(m.version));
  }

  /**
   * Run all pending migrations in order
   */
  runPending(): { success: boolean; applied: number; error?: string } {
    try {
      const pending = this.getPendingMigrations();

      if (pending.length === 0) {
        logger.info('No pending migrations');
        return { success: true, applied: 0 };
      }

      const db = getDb();

      for (const migration of pending) {
        try {
          logger.info(`Running migration: v${migration.version} ${migration.name}`);

          // Start transaction
          const runMigration = db.transaction(() => {
            migration.up(db);
            db.prepare(
              'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)'
            ).run(migration.version, migration.name, new Date().toISOString());
          });

          runMigration();
          logger.info(`Successfully applied migration: v${migration.version} ${migration.name}`);
        } catch (err) {
          logger.error(`Migration failed: v${migration.version} ${migration.name}`, { error: String(err) });
          throw err;
        }
      }

      logger.info(`Applied ${pending.length} migration(s)`);
      return { success: true, applied: pending.length };
    } catch (err) {
      const errorMsg = String(err);
      logger.error('Migration run failed', { error: errorMsg });
      return { success: false, applied: 0, error: errorMsg };
    }
  }

  /**
   * Rollback to a specific version or the previous migration
   */
  rollback(targetVersion?: number): { success: boolean; rolledBack: number; error?: string } {
    try {
      const applied = this.getAppliedVersions();

      if (applied.length === 0) {
        logger.info('No migrations to rollback');
        return { success: true, rolledBack: 0 };
      }

      const db = getDb();
      const migrationsByVersion = new Map(this.migrations.map(m => [m.version, m]));
      let rolledBackCount = 0;

      // Determine which migrations to rollback
      const toRollback = targetVersion
        ? applied.filter(v => v > targetVersion).reverse()
        : [applied[applied.length - 1]];

      for (const version of toRollback) {
        const migration = migrationsByVersion.get(version);
        if (!migration) {
          logger.warn(`Migration not found for rollback: v${version}`);
          continue;
        }

        try {
          logger.info(`Rolling back migration: v${version} ${migration.name}`);

          const performRollback = db.transaction(() => {
            migration.down(db);
            db.prepare('DELETE FROM _migrations WHERE version = ?').run(version);
          });

          performRollback();
          logger.info(`Successfully rolled back migration: v${version} ${migration.name}`);
          rolledBackCount++;
        } catch (err) {
          logger.error(`Rollback failed: v${version} ${migration.name}`, { error: String(err) });
          throw err;
        }
      }

      return { success: true, rolledBack: rolledBackCount };
    } catch (err) {
      const errorMsg = String(err);
      logger.error('Rollback failed', { error: errorMsg });
      return { success: false, rolledBack: 0, error: errorMsg };
    }
  }

  /**
   * Get migration status
   */
  getStatus(): MigrationStatus {
    try {
      const db = getDb();
      const applied = db.prepare(
        'SELECT version, name, applied_at FROM _migrations ORDER BY version ASC'
      ).all() as AppliedMigration[];

      const currentVersion = applied.length > 0 ? applied[applied.length - 1].version : 0;
      const pending = this.getPendingMigrations();

      return {
        currentVersion,
        pendingCount: pending.length,
        appliedMigrations: applied,
      };
    } catch (err) {
      logger.error('Failed to get migration status', { error: String(err) });
      return {
        currentVersion: 0,
        pendingCount: 0,
        appliedMigrations: [],
      };
    }
  }
}

// ============================================================
// Example Migrations
// ============================================================

export const exampleMigrations: Migration[] = [
  {
    version: 1,
    name: 'add_feedback_metrics_table',
    up: (db) => {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS feedback_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL,
          task_type TEXT,
          outcome TEXT,
          latency_ms INTEGER,
          tokens_used INTEGER,
          created_at TEXT NOT NULL
        )
      `).run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_feedback_agent_id ON feedback_metrics(agent_id)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback_metrics(created_at)').run();
    },
    down: (db) => {
      db.prepare('DROP INDEX IF EXISTS idx_feedback_created_at').run();
      db.prepare('DROP INDEX IF EXISTS idx_feedback_agent_id').run();
      db.prepare('DROP TABLE IF EXISTS feedback_metrics').run();
    },
  },
  {
    version: 2,
    name: 'add_collaboration_sessions_table',
    up: (db) => {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS collaboration_sessions (
          id TEXT PRIMARY KEY,
          participants TEXT NOT NULL,
          objective TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          completed_at TEXT
        )
      `).run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_collab_status ON collaboration_sessions(status)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_collab_created_at ON collaboration_sessions(created_at)').run();
    },
    down: (db) => {
      db.prepare('DROP INDEX IF EXISTS idx_collab_created_at').run();
      db.prepare('DROP INDEX IF EXISTS idx_collab_status').run();
      db.prepare('DROP TABLE IF EXISTS collaboration_sessions').run();
    },
  },
  {
    version: 3,
    name: 'add_tool_usage_analytics_table',
    up: (db) => {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS tool_usage_analytics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tool_name TEXT NOT NULL,
          task_type TEXT,
          success INTEGER NOT NULL,
          context TEXT,
          created_at TEXT NOT NULL
        )
      `).run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_usage_analytics(tool_name)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_tool_created_at ON tool_usage_analytics(created_at)').run();
    },
    down: (db) => {
      db.prepare('DROP INDEX IF EXISTS idx_tool_created_at').run();
      db.prepare('DROP INDEX IF EXISTS idx_tool_name').run();
      db.prepare('DROP TABLE IF EXISTS tool_usage_analytics').run();
    },
  },
];

// ============================================================
// Singleton Instance
// ============================================================

export const migrationRunner = new MigrationRunner();

// Register example migrations
exampleMigrations.forEach(m => migrationRunner.register(m));

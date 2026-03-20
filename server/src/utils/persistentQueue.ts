/**
 * SQLite-Backed Persistent Message Queue
 *
 * Survives server restarts — queued messages are persisted to SQLite.
 * On startup, any unprocessed or in-progress items are recovered.
 *
 * Features:
 * - Persistent storage (SQLite WAL mode via better-sqlite3)
 * - Configurable concurrency
 * - Auto-retry with exponential backoff
 * - Dead-letter queue for permanently failed items
 * - Recovery of in-progress items on restart
 * - Statistics and monitoring
 */

import { getDb, dbRun, dbAll, dbGet } from '../database/db.js';
import { createLogger } from './logger.js';

const log = createLogger('PersistentQueue');

// ── Types ──

export type QueueItemStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'dead';

export interface PersistentQueueItem {
  id: number;
  queue_name: string;
  payload: string;
  status: QueueItemStatus;
  retries: number;
  max_retries: number;
  error?: string;
  created_at: string;
  updated_at: string;
  process_after?: string;
  completed_at?: string;
  processing_duration_ms?: number;
}

export interface PersistentQueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  dead: number;
  total: number;
  avgProcessingMs: number;
}

// ── Table Setup ──

export function ensureQueueTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS persistent_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_name TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      retries INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      process_after TEXT,
      completed_at TEXT,
      processing_duration_ms INTEGER
    );
  `);
  // Create indexes separately (CREATE INDEX IF NOT EXISTS in separate statements)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pq_status ON persistent_queue(queue_name, status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pq_process_after ON persistent_queue(process_after);`);
  log.info('Persistent queue table ensured');
}

// ── Queue Class ──

export class PersistentQueue<T = any> {
  private queueName: string;
  private concurrency: number;
  private maxRetries: number;
  private activeCount = 0;
  private handler: ((payload: T) => Promise<void>) | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private pollMs: number;

  constructor(
    queueName: string,
    options: {
      concurrency?: number;
      maxRetries?: number;
      pollMs?: number;
    } = {}
  ) {
    this.queueName = queueName;
    this.concurrency = options.concurrency || 2;
    this.maxRetries = options.maxRetries || 3;
    this.pollMs = options.pollMs || 1000;
  }

  /**
   * Register a handler function that processes each queue item
   */
  onProcess(handler: (payload: T) => Promise<void>): void {
    this.handler = handler;
  }

  /**
   * Add an item to the queue (persisted immediately)
   */
  enqueue(payload: T, options?: { maxRetries?: number; delayMs?: number }): number {
    const maxR = options?.maxRetries ?? this.maxRetries;
    const processAfter = options?.delayMs
      ? new Date(Date.now() + options.delayMs).toISOString()
      : null;

    dbRun(
      `INSERT INTO persistent_queue (queue_name, payload, max_retries, process_after)
       VALUES (?, ?, ?, ?)`,
      [this.queueName, JSON.stringify(payload), maxR, processAfter]
    );

    // Get the last inserted ID
    const row = dbGet<{ id: number }>(`SELECT last_insert_rowid() as id`);
    const id = row?.id || 0;

    log.debug(`Enqueued item ${id} to ${this.queueName}`);
    this.processNext();

    return id;
  }

  /**
   * Start processing loop
   */
  start(): void {
    if (this.pollInterval) return;

    // Recover any items stuck in 'processing' state (from previous crash)
    this.recoverStuckItems();

    this.pollInterval = setInterval(() => {
      this.processNext();
    }, this.pollMs);

    log.info(`PersistentQueue "${this.queueName}" started (concurrency: ${this.concurrency})`);
  }

  /**
   * Stop processing loop
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    log.info(`PersistentQueue "${this.queueName}" stopped`);
  }

  /**
   * Recover items stuck in 'processing' state (from previous crash)
   */
  private recoverStuckItems(): void {
    dbRun(
      `UPDATE persistent_queue SET status = 'pending', updated_at = datetime('now')
       WHERE queue_name = ? AND status = 'processing'`,
      [this.queueName]
    );
    // We can't easily get change count from dbRun (void), so just log
    log.info(`Recovered stuck items in "${this.queueName}" (if any)`);
  }

  /**
   * Process next available items up to concurrency limit
   */
  private processNext(): void {
    if (!this.handler) return;
    if (this.activeCount >= this.concurrency) return;

    const slotsAvailable = this.concurrency - this.activeCount;

    const items = dbAll<PersistentQueueItem>(
      `SELECT * FROM persistent_queue
       WHERE queue_name = ? AND status = 'pending'
         AND (process_after IS NULL OR process_after <= datetime('now'))
       ORDER BY id ASC
       LIMIT ?`,
      [this.queueName, slotsAvailable]
    );

    for (const item of items) {
      this.activeCount++;

      // Mark as processing
      dbRun(
        `UPDATE persistent_queue SET status = 'processing', updated_at = datetime('now') WHERE id = ?`,
        [item.id]
      );

      // Process in background (async)
      this.processItem(item).catch(err => {
        log.error(`Unexpected error processing item ${item.id}:`, err);
      });
    }
  }

  /**
   * Process a single item
   */
  private async processItem(item: PersistentQueueItem): Promise<void> {
    const startTime = Date.now();

    try {
      const payload = JSON.parse(item.payload) as T;
      await this.handler!(payload);

      // Success
      const duration = Date.now() - startTime;
      dbRun(
        `UPDATE persistent_queue
         SET status = 'completed', completed_at = datetime('now'),
             processing_duration_ms = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [duration, item.id]
      );

      log.debug(`Item ${item.id} completed in ${duration}ms`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const retries = item.retries + 1;

      if (retries >= item.max_retries) {
        // Move to dead-letter queue
        dbRun(
          `UPDATE persistent_queue
           SET status = 'dead', error = ?, retries = ?, updated_at = datetime('now')
           WHERE id = ?`,
          [errorMsg, retries, item.id]
        );
        log.error(`Item ${item.id} moved to dead-letter queue after ${retries} retries: ${errorMsg}`);
      } else {
        // Schedule retry with exponential backoff
        const backoffMs = Math.min(5000 * Math.pow(2, retries - 1), 300000);
        const processAfter = new Date(Date.now() + backoffMs).toISOString();

        dbRun(
          `UPDATE persistent_queue
           SET status = 'pending', error = ?, retries = ?,
               process_after = ?, updated_at = datetime('now')
           WHERE id = ?`,
          [errorMsg, retries, processAfter, item.id]
        );
        log.warn(`Item ${item.id} retry ${retries}/${item.max_retries} in ${backoffMs}ms`);
      }
    } finally {
      this.activeCount--;
      this.processNext();
    }
  }

  /**
   * Get queue statistics
   */
  getStats(): PersistentQueueStats {
    const counts = dbAll<{ status: string; count: number }>(
      `SELECT status, COUNT(*) as count FROM persistent_queue
       WHERE queue_name = ? GROUP BY status`,
      [this.queueName]
    );

    const avgResult = dbGet<{ avg_ms: number | null }>(
      `SELECT AVG(processing_duration_ms) as avg_ms FROM persistent_queue
       WHERE queue_name = ? AND status = 'completed' AND processing_duration_ms IS NOT NULL`,
      [this.queueName]
    );

    const stats: PersistentQueueStats = {
      pending: 0, processing: 0, completed: 0, failed: 0, dead: 0, total: 0,
      avgProcessingMs: avgResult?.avg_ms || 0,
    };

    for (const row of counts) {
      if (row.status in stats) (stats as any)[row.status] = row.count;
      stats.total += row.count;
    }

    return stats;
  }

  /**
   * Get dead-letter items for manual review
   */
  getDeadLetterItems(limit = 50): PersistentQueueItem[] {
    return dbAll<PersistentQueueItem>(
      `SELECT * FROM persistent_queue
       WHERE queue_name = ? AND status = 'dead'
       ORDER BY updated_at DESC LIMIT ?`,
      [this.queueName, limit]
    );
  }

  /**
   * Retry a dead-letter item
   */
  retryDeadItem(itemId: number): void {
    dbRun(
      `UPDATE persistent_queue
       SET status = 'pending', retries = 0, error = NULL,
           process_after = NULL, updated_at = datetime('now')
       WHERE id = ? AND queue_name = ? AND status = 'dead'`,
      [itemId, this.queueName]
    );
  }

  /**
   * Cleanup completed items older than specified hours
   */
  cleanup(olderThanHours = 24): void {
    dbRun(
      `DELETE FROM persistent_queue
       WHERE queue_name = ? AND status = 'completed'
         AND completed_at < datetime('now', '-' || ? || ' hours')`,
      [this.queueName, olderThanHours]
    );
    log.info(`Cleaned up old completed items from "${this.queueName}"`);
  }
}

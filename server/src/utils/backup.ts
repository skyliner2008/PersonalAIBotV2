/**
 * Backup & Export Utility
 *
 * Provides automated SQLite backup, JSON export, and restore functionality.
 * - Full database backup (file copy)
 * - Selective JSON export (conversations, personas, memory, settings)
 * - Backup rotation (keep last N backups)
 */

import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { getDb, dbAll } from '../database/db.js';
import { createLogger } from './logger.js';

const log = createLogger('Backup');
const BACKUP_DIR = path.join(config.dataDir, 'backups');
const MAX_BACKUPS = 10; // Keep last 10 backups

// Ensure backup directory exists
function ensureBackupDir(): void {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

/**
 * Create a full SQLite database backup
 */
export function createBackup(label?: string): { filename: string; path: string; sizeKB: number } {
  ensureBackupDir();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substring(0, 19);
  const suffix = label ? `_${label.replace(/[^a-zA-Z0-9_-]/g, '')}` : '';
  const filename = `backup_${timestamp}${suffix}.db`;
  const backupPath = path.join(BACKUP_DIR, filename);

  try {
    const db = getDb();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // flush WAL to main DB
    db.backup(backupPath);

    const stat = fs.statSync(backupPath);
    const sizeKB = Math.round(stat.size / 1024);
    log.info(`Backup created: ${filename} (${sizeKB}KB)`);

    // Rotate old backups
    rotateBackups();

    return { filename, path: backupPath, sizeKB };
  } catch (err: any) {
    log.error(`Backup failed: ${err.message}`);
    throw err;
  }
}

/**
 * Export selected data as JSON
 */
export function exportDataAsJSON(options: {
  conversations?: boolean;
  personas?: boolean;
  settings?: boolean;
  qaDatabase?: boolean;
  activityLogs?: boolean;
} = {}): { data: Record<string, unknown>; filename: string; path: string } {
  ensureBackupDir();

  const exportData: Record<string, unknown> = {
    exportedAt: new Date().toISOString(),
    version: '2.0',
  };

  if (options.conversations !== false) {
    exportData.conversations = dbAll('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 1000');
    exportData.messages = dbAll('SELECT * FROM messages ORDER BY created_at DESC LIMIT 10000');
  }

  if (options.personas !== false) {
    exportData.personas = dbAll('SELECT * FROM personas');
  }

  if (options.settings !== false) {
    exportData.settings = dbAll('SELECT * FROM settings');
  }

  if (options.qaDatabase !== false) {
    try {
      exportData.qaDatabase = dbAll('SELECT * FROM qa_database');
    } catch (err) { log.debug('qa_database table not found during export', { error: String(err) }); }
  }

  if (options.activityLogs !== false) {
    exportData.activityLogs = dbAll('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 5000');
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const filename = `export_${timestamp}.json`;
  const exportPath = path.join(BACKUP_DIR, filename);

  fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2));
  log.info(`JSON export created: ${filename}`);

  return { data: exportData, filename, path: exportPath };
}

/**
 * Export a single conversation with all messages
 */
export function exportConversation(chatId: string): {
  conversation: unknown;
  messages: unknown[];
  memoryFacts: unknown[];
} {
  const conversation = dbAll('SELECT * FROM conversations WHERE chat_id = ?', [chatId]);
  const messages = dbAll('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC', [chatId]);

  let memoryFacts: unknown[] = [];
  try {
    memoryFacts = dbAll('SELECT * FROM archival_memory WHERE chat_id = ?', [chatId]);
  } catch (err) { log.debug('archival_memory table not found during export', { chatId, error: String(err) }); }

  return { conversation: conversation[0] || null, messages, memoryFacts };
}

/**
 * List available backups
 */
export function listBackups(): Array<{
  filename: string;
  sizeKB: number;
  createdAt: string;
  type: 'db' | 'json';
}> {
  ensureBackupDir();

  const files = fs.readdirSync(BACKUP_DIR);
  return files
    .filter(f => f.startsWith('backup_') || f.startsWith('export_'))
    .map(filename => {
      const filePath = path.join(BACKUP_DIR, filename);
      const stat = fs.statSync(filePath);
      return {
        filename,
        sizeKB: Math.round(stat.size / 1024),
        createdAt: stat.mtime.toISOString(),
        type: filename.endsWith('.db') ? 'db' as const : 'json' as const,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Delete old backups, keep last MAX_BACKUPS
 */
function rotateBackups(): void {
  try {
    const backups = listBackups().filter(b => b.type === 'db');
    if (backups.length > MAX_BACKUPS) {
      const toDelete = backups.slice(MAX_BACKUPS);
      for (const b of toDelete) {
        fs.unlinkSync(path.join(BACKUP_DIR, b.filename));
        log.debug(`Rotated old backup: ${b.filename}`);
      }
    }
  } catch (err: any) {
    log.warn(`Backup rotation error: ${err.message}`);
  }
}

/**
 * Get total backup storage usage
 */
export function getBackupStorageInfo(): { totalSizeKB: number; count: number; dir: string } {
  const backups = listBackups();
  const totalSizeKB = backups.reduce((sum, b) => sum + b.sizeKB, 0);
  return { totalSizeKB, count: backups.length, dir: BACKUP_DIR };
}

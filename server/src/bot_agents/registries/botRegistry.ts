// ============================================================
// Bot Registry — CRUD for dynamic bot instances (DB-backed)
// ============================================================

import { getDb } from '../../database/db.js';
import { getDefaultToolNames } from './toolRegistry.js';

export type BotPlatform = 'telegram' | 'line' | 'facebook' | 'discord' | 'custom';
export type BotStatus = 'active' | 'stopped' | 'error';

export interface BotInstance {
  id: string;
  name: string;
  platform: BotPlatform;
  /** Platform-specific credentials (JSON) — stored encrypted in DB */
  credentials: Record<string, string>;
  /** Persona ID to use for this bot */
  persona_id: string | null;
  /** Tool names enabled for this bot (JSON array) */
  enabled_tools: string[];
  /** Bot-specific config overrides (JSON) */
  config: Record<string, unknown>;
  status: BotStatus;
  /** Error message if status = 'error' */
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Row shape from SQLite (JSON stored as strings) */
interface BotRow {
  id: string;
  name: string;
  platform: string;
  credentials: string;
  persona_id: string | null;
  enabled_tools: string;
  config: string;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToBot(row: BotRow): BotInstance {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform as BotPlatform,
    credentials: safeJsonParse(row.credentials, {}),
    persona_id: row.persona_id,
    enabled_tools: safeJsonParse(row.enabled_tools, []),
    config: safeJsonParse(row.config, {}),
    status: row.status as BotStatus,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function safeJsonParse<T>(str: string, fallback: T): T {
  try { return JSON.parse(str); }
  catch { return fallback; }
}

// ── Ensure table exists ──────────────────────────────

export function ensureBotTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL CHECK(platform IN ('telegram', 'line', 'facebook', 'discord', 'custom')),
      credentials TEXT DEFAULT '{}',
      persona_id TEXT,
      enabled_tools TEXT DEFAULT '[]',
      config TEXT DEFAULT '{}',
      status TEXT DEFAULT 'stopped' CHECK(status IN ('active', 'stopped', 'error')),
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_bot_instances_platform ON bot_instances(platform);
    CREATE INDEX IF NOT EXISTS idx_bot_instances_status ON bot_instances(status);

    CREATE TABLE IF NOT EXISTS tool_assignments (
      bot_id TEXT NOT NULL REFERENCES bot_instances(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      PRIMARY KEY (bot_id, tool_name)
    );
  `);
}

// ── CRUD Operations ──────────────────────────────────

/** List all bot instances (optionally filter by platform) */
export function listBots(platform?: BotPlatform): BotInstance[] {
  const db = getDb();
  let rows: BotRow[];
  if (platform) {
    rows = db.prepare('SELECT * FROM bot_instances WHERE platform = ? ORDER BY created_at DESC').all(platform) as BotRow[];
  } else {
    rows = db.prepare('SELECT * FROM bot_instances ORDER BY created_at DESC').all() as BotRow[];
  }
  return rows.map(rowToBot);
}

/** Get a single bot by ID */
export function getBot(id: string): BotInstance | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM bot_instances WHERE id = ?').get(id) as BotRow | undefined;
  return row ? rowToBot(row) : null;
}

/** Create a new bot instance */
export function createBot(data: {
  id: string;
  name: string;
  platform: BotPlatform;
  credentials?: Record<string, string>;
  persona_id?: string;
  enabled_tools?: string[];
  config?: Record<string, unknown>;
}): BotInstance {
  const db = getDb();
  const enabledTools = data.enabled_tools ?? getDefaultToolNames();

  db.prepare(`
    INSERT INTO bot_instances (id, name, platform, credentials, persona_id, enabled_tools, config)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.id,
    data.name,
    data.platform,
    JSON.stringify(data.credentials ?? {}),
    data.persona_id ?? null,
    JSON.stringify(enabledTools),
    JSON.stringify(data.config ?? {}),
  );

  return getBot(data.id)!;
}

/** Update a bot instance (partial update) */
export function updateBot(id: string, updates: Partial<{
  name: string;
  platform: BotPlatform;
  credentials: Record<string, string>;
  persona_id: string | null;
  enabled_tools: string[];
  config: Record<string, unknown>;
  status: BotStatus;
  last_error: string | null;
}>): BotInstance | null {
  const db = getDb();
  const existing = getBot(id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.platform !== undefined) { fields.push('platform = ?'); values.push(updates.platform); }
  if (updates.credentials !== undefined) { fields.push('credentials = ?'); values.push(JSON.stringify(updates.credentials)); }
  if (updates.persona_id !== undefined) { fields.push('persona_id = ?'); values.push(updates.persona_id); }
  if (updates.enabled_tools !== undefined) { fields.push('enabled_tools = ?'); values.push(JSON.stringify(updates.enabled_tools)); }
  if (updates.config !== undefined) { fields.push('config = ?'); values.push(JSON.stringify(updates.config)); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (updates.last_error !== undefined) { fields.push('last_error = ?'); values.push(updates.last_error); }

  if (fields.length === 0) return existing;

  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);

  db.prepare(`UPDATE bot_instances SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getBot(id);
}

/** Delete a bot instance */
export function deleteBot(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM bot_instances WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Toggle bot status (active <-> stopped) */
export function toggleBot(id: string): BotInstance | null {
  const bot = getBot(id);
  if (!bot) return null;
  const newStatus: BotStatus = bot.status === 'active' ? 'stopped' : 'active';
  return updateBot(id, { status: newStatus, last_error: null });
}

// ── Tool Assignment Helpers ──────────────────────────

/** Get enabled tool names for a bot */
export function getBotToolNames(botId: string): string[] {
  const bot = getBot(botId);
  return bot?.enabled_tools ?? [];
}

/** Set enabled tools for a bot */
export function setBotTools(botId: string, toolNames: string[]): void {
  updateBot(botId, { enabled_tools: toolNames });
}

/** Get platform credential fields required */
export function getPlatformCredentialFields(platform: BotPlatform): { key: string; label: string; secret: boolean }[] {
  switch (platform) {
    case 'telegram':
      return [
        { key: 'bot_token', label: 'Bot Token', secret: true },
      ];
    case 'line':
      return [
        { key: 'channel_access_token', label: 'Channel Access Token', secret: true },
        { key: 'channel_secret', label: 'Channel Secret', secret: true },
      ];
    case 'facebook':
      return [
        { key: 'page_access_token', label: 'Page Access Token', secret: true },
        { key: 'verify_token', label: 'Verify Token', secret: true },
        { key: 'app_secret', label: 'App Secret', secret: true },
      ];
    case 'discord':
      return [
        { key: 'bot_token', label: 'Bot Token', secret: true },
        { key: 'application_id', label: 'Application ID', secret: false },
      ];
    case 'custom':
      return [];
    default:
      return [];
  }
}

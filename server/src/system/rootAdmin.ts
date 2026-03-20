import { getSetting, isDbInitialized } from '../database/db.js';

const DEFAULT_ROOT_ADMIN_BOT_ID = process.env.JARVIS_ROOT_BOT_ID || 'jarvis-root-admin';
const DEFAULT_ROOT_ADMIN_BOT_NAME = process.env.JARVIS_ROOT_BOT_NAME || 'Jarvis Root Admin';
const DEFAULT_ROOT_ADMIN_PERSONA_PLATFORM = process.env.JARVIS_ROOT_PERSONA_PLATFORM || 'system';
const DEFAULT_ROOT_ADMIN_SPECIALIST = process.env.JARVIS_ROOT_SPECIALIST || 'jarvis-root-admin';

const DEFAULT_SUPERVISOR_BOT_IDS = Array.from(
  new Set([
    DEFAULT_ROOT_ADMIN_BOT_ID,
    'jarvis-root-admin',
    'jarvis-admin',
    'specialist_jarvis-root-admin',
    'system',
  ]),
);

function readSettingSafe(key: string): string | null {
  if (!isDbInitialized()) return null;
  try {
    return getSetting(key);
  } catch {
    return null;
  }
}

function normalizeId(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function normalizeName(value: string): string {
  return String(value || '').trim();
}

function parseSupervisorIds(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((item) => normalizeId(item))
    .filter(Boolean);
}

export function getRootAdminBotId(): string {
  const fromDb = normalizeId(readSettingSafe('jarvis_root_bot_id') || '');
  if (fromDb) return fromDb;
  return normalizeId(DEFAULT_ROOT_ADMIN_BOT_ID);
}

export function getRootAdminBotName(): string {
  const fromDb = normalizeName(readSettingSafe('jarvis_root_bot_name') || '');
  if (fromDb) return fromDb;
  return DEFAULT_ROOT_ADMIN_BOT_NAME;
}

export function getRootAdminPersonaPlatform(): string {
  const fromDb = normalizeName(readSettingSafe('jarvis_root_persona_platform') || '');
  if (fromDb) return fromDb;
  return DEFAULT_ROOT_ADMIN_PERSONA_PLATFORM;
}

export function getRootAdminSpecialistName(): string {
  const fromDb = normalizeId(readSettingSafe('jarvis_root_specialist_name') || '');
  if (fromDb) return fromDb;
  return normalizeId(DEFAULT_ROOT_ADMIN_SPECIALIST);
}

export function getRootAdminSupervisorBotIds(): string[] {
  const configuredRaw = readSettingSafe('jarvis_supervisor_bot_ids');
  const configured = configuredRaw ? parseSupervisorIds(configuredRaw) : [];
  const merged = Array.from(
    new Set([
      getRootAdminBotId(),
      ...configured,
      ...DEFAULT_SUPERVISOR_BOT_IDS,
    ]),
  );
  return merged.filter(Boolean);
}

export function isRootAdminBotId(botId?: string): boolean {
  if (!botId) return false;
  const normalized = normalizeId(botId);
  if (!normalized) return false;
  return getRootAdminSupervisorBotIds().includes(normalized);
}

export function getRootAdminIdentity() {
  return {
    botId: getRootAdminBotId(),
    botName: getRootAdminBotName(),
    personaPlatform: getRootAdminPersonaPlatform(),
    specialistName: getRootAdminSpecialistName(),
    supervisorBotIds: getRootAdminSupervisorBotIds(),
  };
}

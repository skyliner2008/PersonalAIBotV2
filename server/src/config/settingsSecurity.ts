import {
  deleteSetting,
  getCredential,
  getSetting,
  isDbInitialized,
  setCredential,
  setSetting,
} from '../database/db.js';
import { getProvider } from '../providers/registry.js';

export const MASKED_SECRET_VALUE = '********';

type SettingRow = {
  key: string;
  value: string;
  updated_at?: string;
};

const SECRET_KEY_EXCEPTIONS = new Set([
  'admin_telegram_ids',
  'admin_line_ids',
  'fb_app_id',
  'fb_page_id',
  'fb_page_name',
  'fb_api_version',
  'fb_email',
]);

const SECRET_KEY_EXACT = new Set([
  'fb_app_secret',
  'fb_page_access_token',
  'fb_verify_token',
  'fb_password',
  'admin_password',
  'viewer_password',
]);

const SECRET_KEY_PATTERNS = [
  /^provider_key_/i,
  /^ai_[a-z0-9._-]+_key$/i,
  /(?:^|_)(?:api_key|secret|password|token)$/i,
  /(?:^|_)(?:access_token|verify_token)$/i,
];

export function isInternalOnlySettingKey(key: string): boolean {
  return key.startsWith('provider_key_');
}

export function isSecretSettingKey(key: string): boolean {
  if (SECRET_KEY_EXCEPTIONS.has(key)) return false;
  if (SECRET_KEY_EXACT.has(key)) return true;
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function isMaskedSecretValue(value: unknown): boolean {
  return typeof value === 'string' && value === MASKED_SECRET_VALUE;
}

export function getCanonicalSettingKey(key: string): string {
  const providerId = getLegacyAiProviderId(key);
  return providerId ? `provider_key_${providerId}` : key;
}

export function sanitizeSettingsRows(rows: SettingRow[]): SettingRow[] {
  return rows
    .filter((row) => !isInternalOnlySettingKey(row.key))
    .map((row) => ({
      ...row,
      value: isSecretSettingKey(row.key) && row.value ? MASKED_SECRET_VALUE : row.value,
    }));
}

export function getManagedSetting(key: string): string | null {
  if (!isDbInitialized()) {
    return null;
  }

  if (!isSecretSettingKey(key)) {
    return getSetting(key);
  }

  const canonicalKey = getCanonicalSettingKey(key);
  const lookupOrder = canonicalKey === key ? [canonicalKey] : [canonicalKey, key];

  for (const candidate of lookupOrder) {
    const raw = getSetting(candidate);
    if (!raw) continue;

    const value = getCredential(candidate);
    if (!value) continue;

    if (candidate !== canonicalKey || !isEncryptedSettingValue(raw)) {
      setCredential(canonicalKey, value);
      if (candidate !== canonicalKey) {
        deleteSetting(candidate);
      }
    }

    return value;
  }

  return null;
}

export function setManagedSetting(key: string, value: string): void {
  const normalizedValue = String(value ?? '');

  if (!isSecretSettingKey(key)) {
    setSetting(key, normalizedValue);
    return;
  }

  if (isMaskedSecretValue(normalizedValue)) {
    return;
  }

  const canonicalKey = getCanonicalSettingKey(key);
  if (!normalizedValue) {
    deleteSetting(canonicalKey);
    if (canonicalKey !== key) {
      deleteSetting(key);
    }
    return;
  }

  setCredential(canonicalKey, normalizedValue);
  if (canonicalKey !== key) {
    deleteSetting(key);
  }
}

export function getProviderApiKey(providerId: string): string | null {
  return resolveProviderApiKey(providerId).key;
}

export type ProviderApiKeyResolution = {
  key: string | null;
  source: 'db' | 'env' | 'none';
  envVar?: string;
};

export function resolveProviderApiKey(providerId: string): ProviderApiKeyResolution {
  const managedKey = getManagedSetting(`ai_${providerId}_key`);
  if (managedKey) {
    return { key: managedKey, source: 'db' };
  }

  const provider = getProvider(providerId);
  if (!provider?.apiKeyEnvVar) {
    return { key: null, source: 'none' };
  }

  const envValue = process.env[provider.apiKeyEnvVar];
  const key = envValue?.trim() ? envValue : null;
  if (!key) {
    return { key: null, source: 'none', envVar: provider.apiKeyEnvVar };
  }
  return { key, source: 'env', envVar: provider.apiKeyEnvVar };
}

function getLegacyAiProviderId(key: string): string | null {
  const match = key.match(/^ai_([a-z0-9._-]+)_key$/i);
  return match?.[1] || null;
}

function isEncryptedSettingValue(value: string): boolean {
  return value.startsWith('aes:') || value.startsWith('obf:');
}

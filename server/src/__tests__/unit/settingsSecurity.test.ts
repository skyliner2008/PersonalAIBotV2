import { beforeEach, describe, expect, it, vi } from 'vitest';

const settingsStore = new Map<string, string>();

vi.mock('../../database/db.js', () => ({
  isDbInitialized: vi.fn(() => true),
  getSetting: vi.fn((key: string) => settingsStore.get(key) ?? null),
  setSetting: vi.fn((key: string, value: string) => {
    settingsStore.set(key, value);
  }),
  deleteSetting: vi.fn((key: string) => {
    settingsStore.delete(key);
  }),
  getCredential: vi.fn((key: string) => {
    const raw = settingsStore.get(key);
    if (!raw) return null;
    return raw.startsWith('aes:') ? raw.slice(4) : raw;
  }),
  setCredential: vi.fn((key: string, value: string) => {
    settingsStore.set(key, `aes:${value}`);
  }),
}));

vi.mock('../../providers/registry.js', () => ({
  getProvider: vi.fn((providerId: string) => {
    const providers: Record<string, { id: string; apiKeyEnvVar: string }> = {
      openai: { id: 'openai', apiKeyEnvVar: 'OPENAI_API_KEY' },
      gemini: { id: 'gemini', apiKeyEnvVar: 'GEMINI_API_KEY' },
    };
    return providers[providerId];
  }),
}));

import * as dbModule from '../../database/db.js';
import {
  MASKED_SECRET_VALUE,
  getManagedSetting,
  getProviderApiKey,
  sanitizeSettingsRows,
  setManagedSetting,
} from '../../config/settingsSecurity.js';

describe('settingsSecurity', () => {
  beforeEach(() => {
    settingsStore.clear();
    delete process.env.OPENAI_API_KEY;
    vi.mocked(dbModule.isDbInitialized).mockReturnValue(true);
  });

  it('masks secret rows and hides internal credential keys', () => {
    const rows = sanitizeSettingsRows([
      { key: 'fb_app_id', value: '123' },
      { key: 'fb_app_secret', value: 'aes:secret' },
      { key: 'provider_key_openai', value: 'aes:abc' },
    ]);

    expect(rows).toEqual([
      { key: 'fb_app_id', value: '123' },
      { key: 'fb_app_secret', value: MASKED_SECRET_VALUE },
    ]);
  });

  it('auto-migrates legacy AI keys into encrypted provider storage', () => {
    settingsStore.set('ai_openai_key', 'legacy-openai-key');

    const value = getManagedSetting('ai_openai_key');

    expect(value).toBe('legacy-openai-key');
    expect(settingsStore.get('provider_key_openai')).toBe('aes:legacy-openai-key');
    expect(settingsStore.has('ai_openai_key')).toBe(false);
  });

  it('re-encrypts secret keys stored in plaintext under their canonical key', () => {
    settingsStore.set('fb_app_secret', 'legacy-secret');

    const value = getManagedSetting('fb_app_secret');

    expect(value).toBe('legacy-secret');
    expect(settingsStore.get('fb_app_secret')).toBe('aes:legacy-secret');
  });

  it('writes secret keys to encrypted storage and ignores masked placeholders', () => {
    setManagedSetting('ai_openai_key', 'new-secret');
    setManagedSetting('ai_openai_key', MASKED_SECRET_VALUE);

    expect(settingsStore.get('provider_key_openai')).toBe('aes:new-secret');
    expect(settingsStore.has('ai_openai_key')).toBe(false);
  });

  it('keeps non-secret settings plain and falls back to env for provider keys', () => {
    setManagedSetting('admin_line_ids', 'u1,u2');
    process.env.OPENAI_API_KEY = 'env-openai-key';

    expect(settingsStore.get('admin_line_ids')).toBe('u1,u2');
    expect(getProviderApiKey('openai')).toBe('env-openai-key');
  });

  it('returns env provider key when DB is not initialized yet', async () => {
    process.env.OPENAI_API_KEY = 'env-openai-key';
    vi.mocked(dbModule.isDbInitialized).mockReturnValue(false);

    expect(getManagedSetting('ai_openai_key')).toBeNull();
    expect(getProviderApiKey('openai')).toBe('env-openai-key');
  });
});

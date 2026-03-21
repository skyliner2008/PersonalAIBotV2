/**
 * Unified API Key Manager
 * Uses better-sqlite3 via db.ts helpers + AES-256-GCM encryption
 */

import { createLogger } from '../utils/logger.js';
import { getProvider, getRegistry } from './registry.js';
import { dbAll, dbGet, dbRun, setCredential, getCredential } from '../database/db.js';

const log = createLogger('KeyManager');

export class KeyManager {
  private static envKeyCache: Map<string, string> = new Map();

  /**
   * Import API keys from .env into database (idempotent)
   */
  static async importEnvKeys(): Promise<void> {
    try {
      const registry = getRegistry();
      let imported = 0;

      for (const provider of Object.values(registry.providers)) {
        if (!provider.apiKeyEnvVar) continue;
        const envValue = process.env[provider.apiKeyEnvVar];
        if (!envValue) continue;

        // Check if already in DB
        const existing = this.getKeyFromDb(provider.id);
        if (existing) continue;

        // Store encrypted in DB
        this.setKeyInDb(provider.id, envValue, 'env');
        imported++;
      }

      if (imported > 0) {
        log.info('✓ Imported env keys to DB', { count: imported });
      }
    } catch (error) {
      log.error('Failed to import env keys', { error: String(error) });
    }
  }

  /**
   * Get API key for a provider (DB → .env fallback)
   */
  static async getKey(providerId: string): Promise<string | null> {
    try {
      const provider = getProvider(providerId);
      if (!provider) return null;

      // 1. Try encrypted DB first
      const dbKey = this.getKeyFromDb(providerId);
      if (dbKey) return dbKey;

      // No .env fallback - force Database ONLY as single source of truth
      return null;
    } catch (error) {
      log.error('Failed to get key', { providerId, error: String(error) });
      return null;
    }
  }

  /**
   * Set/update API key (encrypted via AES-256-GCM)
   */
  static async setKey(
    providerId: string,
    value: string,
    source: 'dashboard' | 'env' = 'dashboard'
  ): Promise<boolean> {
    try {
      if (!value || value.trim().length === 0) return false;
      const provider = getProvider(providerId);
      if (!provider) return false;

      this.setKeyInDb(providerId, value, source);
      log.info('✓ Key saved (encrypted)', { providerId, source });
      return true;
    } catch (error) {
      log.error('Failed to set key', { providerId, error: String(error) });
      return false;
    }
  }

  /**
   * Delete API key from database
   */
  static async deleteKey(providerId: string): Promise<boolean> {
    try {
      dbRun('DELETE FROM api_keys WHERE provider_id = ?', [providerId]);
      // Also remove from credential store - use SQL concatenation to prevent injection
      dbRun("DELETE FROM settings WHERE key = 'provider_key_' || ?", [providerId]);
      log.info('✓ Key deleted', { providerId });
      return true;
    } catch (error) {
      log.error('Failed to delete key', { providerId, error: String(error) });
      return false;
    }
  }

  /**
   * List configured providers (those with keys in DB or .env)
   */
  static async listConfigured(): Promise<string[]> {
    try {
      // Ensure the provider has an entry in api_keys and the actual key exists in settings
      const rows = dbAll<{ provider_id: string }>(
        "SELECT DISTINCT provider_id FROM api_keys WHERE encrypted_value IS NOT NULL AND EXISTS (SELECT 1 FROM settings WHERE key = 'provider_key_' || provider_id)"
      );
      return rows.map(r => r.provider_id);
    } catch (error) {
      log.error('Failed to list', { error: String(error) });
      return [];
    }
  }

  // ============================================================
  // Private helpers
  // ============================================================

  private static getKeyFromDb(providerId: string): string | null {
    try {
      // Use AES-encrypted credential store from db.ts
      const credKey = `provider_key_${providerId}`;
      const decrypted = getCredential(credKey);
      if (decrypted) return decrypted;

      // Fallback: check api_keys table directly (for env-imported keys)
      const row = dbGet<{ encrypted_value: string }>(
        'SELECT encrypted_value FROM api_keys WHERE provider_id = ? AND key_type = ?',
        [providerId, 'api_key']
      );
      
      const val = row?.encrypted_value || null;
      // Prevent returning the internal reference string if it couldn't be decrypted
      if (val && val.startsWith('ref:')) {
        return null;
      }
      return val;
    } catch {
      return null;
    }
  }

  private static setKeyInDb(providerId: string, value: string, source: string): void {
    // 1. Store encrypted via AES-256-GCM credential store
    const credKey = `provider_key_${providerId}`;
    setCredential(credKey, value);

    // 2. Also store reference in api_keys table (encrypted value stored separately)
    dbRun(
      `INSERT OR REPLACE INTO api_keys (provider_id, key_type, encrypted_value, source, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [providerId, 'api_key', `ref:${credKey}`, source]
    );
  }
}

export default KeyManager;

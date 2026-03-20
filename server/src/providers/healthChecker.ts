/**
 * Provider Health Checker
 *
 * Periodically checks health of enabled providers:
 * - Runs testConnection() on each enabled provider
 * - Tracks consecutive failures
 * - Auto-disables providers after N consecutive failures
 * - Auto-re-enables after cooldown period
 * - Emits health events via Socket.IO
 */

import { createLogger } from '../utils/logger.js';
import { broadcast } from '../utils/socketBroadcast.js';
import { getEnabledProviders, toggleProvider, type ProviderDefinition } from './registry.js';
import { KeyManager } from './keyManager.js';
import { addLog } from '../database/db.js';

const log = createLogger('HealthChecker'); // Refactored

// ============ Configuration ============
const CHECK_INTERVAL_MS = 5 * 60 * 1000;   // Check every 5 minutes
const MAX_CONSECUTIVE_FAILURES = 3;          // Auto-disable after 3 failures
const COOLDOWN_MS = 30 * 60 * 1000;          // Re-check disabled providers after 30 min

// ============ State ============
interface ProviderHealth {
  providerId: string;
  status: 'healthy' | 'degraded' | 'down' | 'disabled';
  consecutiveFailures: number;
  lastCheck: number;
  lastSuccess: number;
  lastError?: string;
  responseTimeMs?: number;
  disabledAt?: number;     // When auto-disabled
}

const healthMap = new Map<string, ProviderHealth>();
let intervalId: ReturnType<typeof setInterval> | null = null;

// ============ Public API ============

/** Get health status for all tracked providers */
export function getProviderHealthMap(): Record<string, ProviderHealth> {
  const result: Record<string, ProviderHealth> = {};
  for (const [id, health] of healthMap) {
    result[id] = { ...health };
  }
  return result;
}

/** Get health status for a specific provider */
export function getProviderHealth(providerId: string): ProviderHealth | undefined {
  return healthMap.get(providerId);
}

/** Check a single provider's health */
export async function checkProviderHealth(provider: ProviderDefinition): Promise<ProviderHealth> {
  const existing = healthMap.get(provider.id) || {
    providerId: provider.id,
    status: 'healthy' as const,
    consecutiveFailures: 0,
    lastCheck: 0,
    lastSuccess: 0,
  };

  // Need API key to test
  const apiKey = await KeyManager.getKey(provider.id);
  if (!apiKey) {
    const health: ProviderHealth = {
      ...existing,
      status: 'disabled',
      lastCheck: Date.now(),
      lastError: 'No API key configured',
    };
    healthMap.set(provider.id, health);
    return health;
  }

  // Dynamic import to avoid circular dependencies
  const startMs = Date.now();
  try {
    let connected = false;

    if (provider.type === 'gemini') {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey });
      // Quick model list call as health check
      const models = await ai.models.list();
      connected = true;
    } else if (provider.type === 'openai-compatible' && provider.baseUrl) {
      const response = await fetch(`${provider.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      connected = response.ok;
    } else if (provider.type === 'platform') {
      // Platform providers (Telegram, LINE, FB) — skip health check
      connected = true;
    } else {
      connected = true; // Unknown type — assume healthy
    }

    const responseTimeMs = Date.now() - startMs;
    const health: ProviderHealth = {
      ...existing,
      status: responseTimeMs > 5000 ? 'degraded' : 'healthy',
      consecutiveFailures: 0,
      lastCheck: Date.now(),
      lastSuccess: Date.now(),
      responseTimeMs,
      lastError: undefined,
      disabledAt: undefined,
    };
    healthMap.set(provider.id, health);

    // Broadcast healthy event
    broadcast('provider:health', { providerId: provider.id, status: health.status, responseTimeMs });

    return health;
  } catch (err: any) {
    const responseTimeMs = Date.now() - startMs;
    const failures = existing.consecutiveFailures + 1;
    const shouldDisable = failures >= MAX_CONSECUTIVE_FAILURES;

    const health: ProviderHealth = {
      ...existing,
      status: shouldDisable ? 'down' : 'degraded',
      consecutiveFailures: failures,
      lastCheck: Date.now(),
      lastError: err.message || String(err),
      responseTimeMs,
      disabledAt: shouldDisable ? Date.now() : existing.disabledAt,
    };
    healthMap.set(provider.id, health);

    // Auto-disable after consecutive failures
    if (shouldDisable && provider.enabled) {
      log.warn(`Auto-disabling provider after ${failures} failures`, { providerId: provider.id, error: err.message });
      toggleProvider(provider.id, false);
      addLog('system', 'Provider auto-disabled', `${provider.name}: ${failures} consecutive failures — ${err.message}`, 'warning');
      broadcast('provider:disabled', { providerId: provider.id, reason: err.message, failures });
    }

    broadcast('provider:health', { providerId: provider.id, status: health.status, error: err.message });

    return health;
  }
}

/** Run health check on all enabled providers */
export async function checkAllProviders(): Promise<Record<string, ProviderHealth>> {
  const providers = getEnabledProviders();
  const results: Record<string, ProviderHealth> = {};

  // Also check recently disabled providers (cooldown expired)
  const allProviders = [...providers];
  for (const [id, health] of healthMap) {
    if (health.status === 'down' && health.disabledAt) {
      const elapsed = Date.now() - health.disabledAt;
      if (elapsed >= COOLDOWN_MS) {
        // Cooldown expired — re-check
        const { getProvider } = await import('./registry.js');
        const provDef = getProvider(id);
        if (provDef && !allProviders.find(p => p.id === id)) {
          allProviders.push(provDef);
        }
      }
    }
  }

  for (const provider of allProviders) {
    if (provider.category === 'platform') continue; // Skip platform providers
    results[provider.id] = await checkProviderHealth(provider);
  }

  return results;
}

/** Start periodic health checks */
export function startHealthChecker(): void {
  if (intervalId) return; // Already running

  log.debug('Starting provider health checker', { intervalMs: CHECK_INTERVAL_MS });

  // Run first check after 30s delay (let server finish startup)
  setTimeout(async () => {
    try {
      await checkAllProviders();
      log.debug('Initial health check complete', { providers: healthMap.size });
    } catch (err) {
      log.error('Initial health check failed', { error: String(err) });
    }
  }, 30_000);

  intervalId = setInterval(async () => {
    try {
      await checkAllProviders();
    } catch (err) {
      log.error('Health check cycle failed', { error: String(err) });
    }
  }, CHECK_INTERVAL_MS);
}

/** Stop health checker */
export function stopHealthChecker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.debug('Health checker stopped');
  }
}

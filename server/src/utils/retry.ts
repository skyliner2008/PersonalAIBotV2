/**
 * Retry Utility with Exponential Backoff
 *
 * Shared retry logic for all providers: Gemini, OpenAI-compatible, Anthropic.
 * - Exponential backoff with jitter
 * - Non-retryable error detection
 * - Configurable max retries & base delay
 */

import { createLogger } from './logger.js';
const log = createLogger('Retry');

/** Errors that should NOT be retried */
const NON_RETRYABLE_PATTERNS = [
  'api key', 'api_key', 'invalid_api_key',
  'permission', 'unauthorized', '401',
  'invalid argument', 'invalid_argument', '400',
  'safety', 'blocked', 'content_filter',
  'model_not_found', 'not found', '404',
  'billing', 'quota exceeded',
];

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  context?: string;  // for logging: "GeminiProvider", "OpenAI", etc.
}

/**
 * Execute an async function with exponential backoff retry
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 15000,
    context = 'Provider',
  } = opts;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

      // Don't retry non-retryable errors
      if (NON_RETRYABLE_PATTERNS.some(p => msg.includes(p))) {
        throw err;
      }

      if (attempt < maxRetries) {
        // Exponential backoff with jitter
        const delay = Math.min(
          baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500,
          maxDelayMs
        );
        log.warn(`[${context}] Attempt ${attempt}/${maxRetries} failed, retrying in ${Math.round(delay)}ms`, {
          error: msg.substring(0, 100),
          attempt,
        });
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}

/**
 * Execute with timeout + retry
 */
export async function withTimeoutRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  retryOpts: RetryOptions = {}
): Promise<T> {
  return withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }, retryOpts);
}

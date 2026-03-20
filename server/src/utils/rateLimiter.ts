/**
 * Per-User & Per-Endpoint Rate Limiting
 *
 * Enhanced rate limiting beyond express-rate-limit's IP-based approach.
 * Tracks by chatId/userId to prevent single user from hogging resources.
 */

import { createLogger } from './logger.js';
const log = createLogger('RateLimiter');

// ── Per-user message rate tracking ──────────────────────────
interface UserRateEntry {
  count: number;
  windowStart: number;
  blocked: number;       // times blocked in this window
}

const userRates = new Map<string, UserRateEntry>();

const USER_WINDOW_MS = 60_000;     // 1 minute window
const USER_MAX_MESSAGES = 20;       // max 20 messages per user per minute
const USER_MAX_AI_CALLS = 10;       // max 10 AI calls per user per minute
const CLEANUP_INTERVAL = 5 * 60_000; // cleanup stale entries every 5 min

/**
 * Check if user is within rate limit. Returns true if allowed.
 */
export function checkUserRate(userId: string, limit: number = USER_MAX_MESSAGES): boolean {
  const now = Date.now();
  const entry = userRates.get(userId);

  if (!entry || now - entry.windowStart > USER_WINDOW_MS) {
    // New window
    userRates.set(userId, { count: 1, windowStart: now, blocked: 0 });
    return true;
  }

  if (entry.count >= limit) {
    entry.blocked++;
    if (entry.blocked === 1) {
      log.warn(`User rate limit hit`, { userId: userId.substring(0, 20), count: entry.count, limit });
    }
    return false;
  }

  entry.count++;
  return true;
}

/**
 * Check AI-specific rate limit (stricter)
 */
export function checkUserAIRate(userId: string): boolean {
  return checkUserRate(`ai:${userId}`, USER_MAX_AI_CALLS);
}

/**
 * Get rate limit info for a user (for headers)
 */
export function getUserRateInfo(userId: string, limit: number = USER_MAX_MESSAGES) {
  const entry = userRates.get(userId);
  if (!entry) {
    return { limit, remaining: limit, resetMs: 0 };
  }
  const elapsed = Date.now() - entry.windowStart;
  if (elapsed > USER_WINDOW_MS) {
    return { limit, remaining: limit, resetMs: 0 };
  }
  return {
    limit,
    remaining: Math.max(0, limit - entry.count),
    resetMs: USER_WINDOW_MS - elapsed,
  };
}

/**
 * Get rate limit stats for monitoring
 */
export function getRateLimitStats() {
  const now = Date.now();
  let activeUsers = 0;
  let blockedUsers = 0;
  let totalBlocks = 0;

  for (const [, entry] of userRates) {
    if (now - entry.windowStart <= USER_WINDOW_MS) {
      activeUsers++;
      if (entry.blocked > 0) {
        blockedUsers++;
        totalBlocks += entry.blocked;
      }
    }
  }
  return { activeUsers, blockedUsers, totalBlocks, trackedUsers: userRates.size };
}

// ── Periodic cleanup of stale entries ─────────────────────
function cleanupStaleEntries() {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of userRates) {
    if (now - entry.windowStart > USER_WINDOW_MS * 2) {
      userRates.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    log.debug(`Cleaned ${cleaned} stale rate limit entries`);
  }
}

let cleanupTimer: any = setInterval(cleanupStaleEntries, CLEANUP_INTERVAL);

export function stopRateLimiterCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
cleanupTimer.unref(); // Don't prevent process exit

// ── Express Middleware ─────────────────────────────────────
import { Request, Response, NextFunction } from 'express';

/**
 * Express middleware: per-user rate limit based on chatId from body or query
 */
export function userRateLimitMiddleware(limit: number = USER_MAX_MESSAGES) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Extract user identifier from various sources
    const userId = extractUserId(req);
    if (!userId) {
      // No user ID — fall through to IP-based rate limiting
      return next();
    }

    if (!checkUserRate(userId, limit)) {
      const info = getUserRateInfo(userId, limit);
      res.set('X-RateLimit-Limit', String(limit));
      res.set('X-RateLimit-Remaining', '0');
      res.set('X-RateLimit-Reset', String(Math.ceil(info.resetMs / 1000)));
      return res.status(429).json({
        error: 'User rate limit exceeded',
        retryAfterMs: info.resetMs,
      });
    }

    // Add rate limit headers
    const info = getUserRateInfo(userId, limit);
    res.set('X-RateLimit-Limit', String(limit));
    res.set('X-RateLimit-Remaining', String(info.remaining));
    next();
  };
}

/**
 * Extract user identifier from request
 */
function extractUserId(req: Request): string | null {
  // From body (POST requests with chatId)
  if (req.body?.chatId) return String(req.body.chatId);
  if (req.body?.userId) return String(req.body.userId);
  // From query params
  if (req.query?.chatId) return String(req.query.chatId);
  // From URL params
  if (req.params?.chatId) return String(req.params.chatId);
  return null;
}

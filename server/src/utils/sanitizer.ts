/**
 * Input Sanitizer — XSS, SQL Injection, and Path Traversal Protection
 *
 * Provides sanitization functions and Express middleware to clean
 * all incoming request data (body, query, params) before processing.
 *
 * Zero external dependencies — pure TypeScript implementation.
 */

import type { Request, Response, NextFunction } from 'express';
import { createLogger } from './logger.js';

const log = createLogger('Sanitizer');

// ── XSS Protection ──────────────────────────────────────

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
  '`': '&#96;',
};

/**
 * Escape HTML special characters to prevent XSS
 */
export function escapeHtml(str: string): string {
  return str.replace(/[&<>"'`/]/g, char => HTML_ENTITIES[char] || char);
}

/**
 * Strip common XSS attack vectors from a string
 * More aggressive than escapeHtml — removes script tags, event handlers, etc.
 */
export function stripXSS(input: string): string {
  let cleaned = input;

  // Remove script tags and content
  cleaned = cleaned.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

  // Remove on* event handlers (onclick, onerror, onload, etc.)
  cleaned = cleaned.replace(/\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');

  // Remove javascript: protocol
  cleaned = cleaned.replace(/javascript\s*:/gi, '');

  // Remove data: protocol (commonly used in XSS)
  cleaned = cleaned.replace(/data\s*:[^,]*,/gi, '');

  // Remove vbscript: protocol
  cleaned = cleaned.replace(/vbscript\s*:/gi, '');

  // Remove expression() CSS
  cleaned = cleaned.replace(/expression\s*\(/gi, '');

  // Remove eval() calls
  cleaned = cleaned.replace(/eval\s*\(/gi, '');

  // Remove <iframe>, <object>, <embed>, <form>
  cleaned = cleaned.replace(/<(iframe|object|embed|form)\b[^>]*>/gi, '');

  return cleaned;
}

// ── SQL Injection Protection ──────────────────────────────

// Common SQL injection patterns
const SQL_INJECTION_PATTERNS = [
  /(\b(UNION|SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|EXEC|EXECUTE)\b\s+)/i,
  /(['";]\s*OR\s+['"]?\d+['"]?\s*=\s*['"]?\d+)/i,     // ' OR 1=1
  /(--\s|#\s|\/\*)/,                                      // SQL comments
  /(\bWAITFOR\b\s+\bDELAY\b)/i,                          // time-based injection
  /(\bSLEEP\s*\()/i,                                      // MySQL sleep
  /(\bBENCHMARK\s*\()/i,                                  // MySQL benchmark
  /(;\s*(DROP|DELETE|UPDATE|INSERT)\b)/i,                   // stacked queries
];

/**
 * Check if a string contains SQL injection patterns
 * Returns the matched pattern name or null if clean
 */
export function detectSQLInjection(input: string): string | null {
  for (const pattern of SQL_INJECTION_PATTERNS) {
    if (pattern.test(input)) {
      return pattern.source.substring(0, 40);
    }
  }
  return null;
}

// ── Path Traversal Protection ──────────────────────────────

/**
 * Sanitize a file path to prevent directory traversal attacks
 */
export function sanitizePath(input: string): string {
  return input
    .replace(/\.\.\//g, '')          // Remove ../
    .replace(/\.\.\\/g, '')          // Remove ..\
    .replace(/~\//g, '')             // Remove ~/
    .replace(/\/\//g, '/')           // Collapse //
    .replace(/\0/g, '');             // Remove null bytes
}

// ── Deep Object Sanitizer ──────────────────────────────────

/**
 * Recursively sanitize all string values in an object/array
 */
export function sanitizeDeep(obj: unknown, options: { stripXSS?: boolean; logInjection?: boolean } = {}): unknown {
  const { stripXSS: doStripXSS = true, logInjection = true } = options;

  if (typeof obj === 'string') {
    let result = obj.trim();

    // Check for SQL injection
    if (logInjection) {
      const sqlPattern = detectSQLInjection(result);
      if (sqlPattern) {
        log.warn(`Potential SQL injection detected: pattern="${sqlPattern}" input="${result.substring(0, 100)}"`);
      }
    }

    // Strip XSS vectors
    if (doStripXSS) {
      result = stripXSS(result);
    }

    // Remove null bytes
    result = result.replace(/\0/g, '');

    return result;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeDeep(item, options));
  }

  if (obj !== null && typeof obj === 'object') {
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      // Also sanitize keys (prevent prototype pollution)
      const safeKey = key.replace(/[^a-zA-Z0-9_.-]/g, '');
      if (safeKey === '__proto__' || safeKey === 'constructor' || safeKey === 'prototype') {
        log.warn(`Blocked prototype pollution attempt via key: "${key}"`);
        continue;
      }
      sanitized[safeKey] = sanitizeDeep(value, options);
    }
    return sanitized;
  }

  return obj;
}

// ── Express Middleware ──────────────────────────────────────

/**
 * Express middleware that sanitizes req.body, req.query, and req.params
 */
export function sanitizeMiddleware(
  options: {
    stripXSS?: boolean;
    logInjection?: boolean;
    excludePaths?: string[];
  } = {}
): (req: Request, res: Response, next: NextFunction) => void {
  const { stripXSS: doStripXSS = true, logInjection = true, excludePaths = [] } = options;

  return (req: Request, _res: Response, next: NextFunction) => {
    // Skip excluded paths (e.g., webhook paths that need raw body)
    if (excludePaths.some(p => req.path.startsWith(p))) {
      return next();
    }

    const sanitizeOpts = { stripXSS: doStripXSS, logInjection };

    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeDeep(req.body, sanitizeOpts);
    }

    if (req.query && typeof req.query === 'object') {
      req.query = sanitizeDeep(req.query, sanitizeOpts) as any;
    }

    if (req.params && typeof req.params === 'object') {
      req.params = sanitizeDeep(req.params, sanitizeOpts) as any;
    }

    next();
  };
}

/**
 * Validate and sanitize a single user input string
 * Returns { clean, warnings } where warnings are any detected issues
 */
export function sanitizeUserInput(input: string): { clean: string; warnings: string[] } {
  const warnings: string[] = [];

  let clean = input.trim();

  // Check for SQL injection
  const sqlPattern = detectSQLInjection(clean);
  if (sqlPattern) {
    warnings.push(`Potential SQL injection pattern detected`);
  }

  // Strip XSS
  const beforeXSS = clean;
  clean = stripXSS(clean);
  if (clean !== beforeXSS) {
    warnings.push('XSS content was stripped');
  }

  // Remove null bytes
  clean = clean.replace(/\0/g, '');

  // Limit length (prevent DoS via extremely long strings)
  if (clean.length > 50000) {
    clean = clean.substring(0, 50000);
    warnings.push('Input truncated to 50000 characters');
  }

  return { clean, warnings };
}

// ============================================================
// Request Tracing Middleware - Request ID tracking and logging
// ============================================================

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { createLogger } from './logger.js';

const logger = createLogger('requestTracer');

// ============================================================
// Express Request Extension
// ============================================================

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

// ============================================================
// Request ID Storage & Generation
// ============================================================

export const requestStore = new AsyncLocalStorage<string>();

/**
 * Generate a short unique request ID (8 characters hex)
 */
export function generateRequestId(): string {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Get the current request ID from AsyncLocalStorage
 * Returns 'no-request' if not in a request context
 */
export function getRequestId(): string {
  return requestStore.getStore() ?? 'no-request';
}

// ============================================================
// Request Tracing Middleware
// ============================================================

/**
 * Express middleware for request ID tracking
 * - Generates or reads request ID from x-request-id header
 * - Attaches to req.requestId
 * - Sets response header
 * - Stores in AsyncLocalStorage for access anywhere in request chain
 */
export function requestTracingMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Get existing request ID or generate new one
  const requestIdHeader = req.get('x-request-id');
  const requestId = requestIdHeader || generateRequestId();

  // Attach to request object
  req.requestId = requestId;

  // Set response header
  res.setHeader('x-request-id', requestId);

  // Store in AsyncLocalStorage for this request chain
  requestStore.run(requestId, () => {
    next();
  });
}

// ============================================================
// Traced Logger Factory
// ============================================================

/**
 * Create a logger child that automatically includes the current request ID
 */
export function tracedLogger(context: string): ReturnType<typeof createLogger> {
  return createLogger({
    context,
    requestId: getRequestId(),
  });
}

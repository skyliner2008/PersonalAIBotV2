/**
 * JWT Authentication - Lightweight implementation using Node.js crypto
 *
 * No external dependencies. Uses HMAC-SHA256 for signing.
 * Provides login, token generation, and middleware for protected routes.
 */

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { createLogger } from './logger.js';

const log = createLogger('Auth');
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_DEV = NODE_ENV === 'development';
const AUTH_DISABLED = process.env.AUTH_DISABLED === 'true';
const STARTUP_COMPACT = process.env.STARTUP_COMPACT === '1';
const DEFAULT_DEV_ADMIN_USER = 'admin';
const DEFAULT_DEV_ADMIN_PASSWORD = 'admin';
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_EXPIRY_HOURS = 24;

if (!process.env.JWT_SECRET) {
  if (!STARTUP_COMPACT) {
    log.warn('JWT_SECRET not set - using auto-generated key (tokens invalidated on restart)');
  }
}

if (!process.env.ADMIN_PASSWORD) {
  if (IS_DEV) {
    if (!STARTUP_COMPACT) {
      log.warn('ADMIN_PASSWORD not set - using development fallback credentials (admin/admin)');
    }
  } else {
    log.error('ADMIN_PASSWORD not set outside development - admin login is disabled until configured');
  }
}

if (AUTH_DISABLED) {
  if (IS_DEV) {
    log.warn('AUTH_DISABLED=true is active (development only)');
  } else {
    log.error('AUTH_DISABLED=true is ignored outside development');
  }
}

interface User {
  username: string;
  role: 'admin' | 'viewer';
}

function validateCredentials(username: string, password: string): User | null {
  const adminUser = process.env.ADMIN_USER || DEFAULT_DEV_ADMIN_USER;
  const configuredAdminPass = process.env.ADMIN_PASSWORD;
  const adminPass = configuredAdminPass || (IS_DEV ? DEFAULT_DEV_ADMIN_PASSWORD : '');

  if (adminPass && username === adminUser && password === adminPass) {
    return { username: adminUser, role: 'admin' };
  }

  const viewerUser = process.env.VIEWER_USER;
  const viewerPass = process.env.VIEWER_PASSWORD;
  if (viewerUser && viewerPass && username === viewerUser && password === viewerPass) {
    return { username: viewerUser, role: 'viewer' };
  }

  return null;
}

function base64url(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return buf.toString('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function createJWT(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = base64url(JSON.stringify({
    ...payload,
    iat: now,
    exp: now + TOKEN_EXPIRY_HOURS * 3600,
  }));

  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');

  return `${header}.${body}.${signature}`;
}

function verifyJWT(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, body, signature] = parts;
    const expectedSig = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${header}.${body}`)
      .digest('base64url');

    if (!safeEqual(signature, expectedSig)) return null;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    } catch {
      return null; // malformed base64/JSON in token body
    }

    if (typeof payload !== 'object' || payload === null) return null;

    if (payload.exp && (payload.exp as number) < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Login and get JWT token
 */
export function login(username: string, password: string): { token: string; user: User; expiresIn: string } | null {
  const user = validateCredentials(username, password);
  if (!user) {
    log.warn('Login failed', { username });
    return null;
  }

  const token = createJWT({ username: user.username, role: user.role });
  log.info('Login successful', { username: user.username, role: user.role });
  return { token, user, expiresIn: `${TOKEN_EXPIRY_HOURS}h` };
}

/**
 * Express middleware: require valid JWT for protected routes.
 * Skips auth only when AUTH_DISABLED=true in development.
 */
export function requireAuth(requiredRole?: 'admin' | 'viewer') {
  return (req: Request, res: Response, next: NextFunction) => {
    if (AUTH_DISABLED && IS_DEV) {
      (req as any).user = { username: 'dev', role: 'admin' };
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required', hint: 'POST /api/auth/login to get a token' });
    }

    const token = authHeader.substring(7);
    const payload = verifyJWT(token);
    if (!payload) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    if (requiredRole === 'admin' && payload.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    (req as any).user = { username: payload.username, role: payload.role };
    next();
  };
}

/**
 * Policy helper:
 * - Read-only methods (GET/HEAD/OPTIONS): require authenticated viewer/admin.
 * - Mutating methods (POST/PUT/PATCH/DELETE): require admin.
 */
export function requireReadWriteAuth(readRole: 'viewer' | 'admin' = 'viewer') {
  const readGuard = requireAuth(readRole);
  const writeGuard = requireAuth('admin');

  return (req: Request, res: Response, next: NextFunction) => {
    const method = (req.method || 'GET').toUpperCase();
    if (READ_ONLY_METHODS.has(method)) {
      return readGuard(req, res, next);
    }
    return writeGuard(req, res, next);
  };
}

/**
 * Optional auth - doesn't block, just attaches user if token present.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const payload = verifyJWT(authHeader.substring(7));
    if (payload) {
      (req as any).user = { username: payload.username, role: payload.role };
    }
  }
  next();
}

/**
 * Verify a token (for Socket.IO auth).
 */
export function verifyToken(token: string): { username: string; role: string } | null {
  const payload = verifyJWT(token);
  if (!payload) return null;
  return { username: payload.username as string, role: payload.role as string };
}

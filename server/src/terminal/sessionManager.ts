/**
 * Terminal Session Manager
 *
 * Manages multiple terminal sessions (PTY processes or Agent mode).
 * Each session has a unique ID, type, process handle, and output buffer.
 * Auto-cleans idle sessions after a configurable timeout.
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('TerminalSession');

export type SessionType = 'shell' | 'agent' | `${string}-cli`;

export interface TerminalSession {
  id: string;
  type: SessionType;
  process: import('child_process').ChildProcess | null;
  buffer: string[];          // last N lines of output (ring buffer)
  createdAt: Date;
  lastActivity: Date;
  cols: number;
  rows: number;
  cwd: string;
  label: string;             // user-visible session name
  platform?: string;         // 'web' | 'telegram' | 'line' (source of this session)
  userId?: string;           // user identifier (optional, from session context)
}

const MAX_BUFFER_LINES = 1000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

export class SessionManager {
  private sessions: Map<string, TerminalSession> = new Map();
  private maxSessions: number;
  private idleTimeoutMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { maxSessions?: number; idleTimeoutMs?: number } = {}) {
    this.maxSessions = opts.maxSessions ?? 10;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 3_600_000; // 1 hour

    // Start periodic idle cleanup every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanupIdle(), 300_000);
  }

  /** Generate a short unique session ID */
  private generateId(): string {
    return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  /** Create a new terminal session */
  createSession(opts: {
    type?: SessionType;
    cols?: number;
    rows?: number;
    cwd?: string;
    label?: string;
    platform?: string;
    userId?: string;
  } = {}): TerminalSession {
    if (this.sessions.size >= this.maxSessions) {
      // Try to clean up idle sessions first
      this.cleanupIdle();
      if (this.sessions.size >= this.maxSessions) {
        throw new Error(`Maximum terminal sessions (${this.maxSessions}) reached`);
      }
    }

    const session: TerminalSession = {
      id: this.generateId(),
      type: opts.type ?? 'shell',
      process: null,
      buffer: [],
      createdAt: new Date(),
      lastActivity: new Date(),
      cols: opts.cols ?? DEFAULT_COLS,
      rows: opts.rows ?? DEFAULT_ROWS,
      cwd: opts.cwd ?? process.cwd(),
      label: opts.label ?? `Terminal ${this.sessions.size + 1}`,
      platform: opts.platform ?? 'web',
      userId: opts.userId,
    };

    this.sessions.set(session.id, session);
    log.info(`Session created: ${session.id} (${session.type}) from ${session.platform}`);
    return session;
  }

  /** Get a session by ID */
  getSession(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  /** Touch session activity timestamp */
  touchSession(id: string): void {
    const s = this.sessions.get(id);
    if (s) s.lastActivity = new Date();
  }

  /** Append output data to session buffer */
  appendOutput(id: string, data: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.lastActivity = new Date();

    // Split into lines and add to ring buffer
    const lines = data.split('\n');
    for (const line of lines) {
      s.buffer.push(line);
    }
    // Trim buffer to max size
    if (s.buffer.length > MAX_BUFFER_LINES) {
      s.buffer.splice(0, s.buffer.length - MAX_BUFFER_LINES);
    }
  }

  /** Close and clean up a specific session */
  closeSession(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;

    if (s.process && !s.process.killed) {
      try {
        s.process.kill('SIGTERM');
        // Force kill after 3 seconds
        setTimeout(() => {
          if (s.process && !s.process.killed) {
            s.process.kill('SIGKILL');
          }
        }, 3000);
      } catch (err) {
        log.warn(`Error killing process for session ${id}: ${err}`);
      }
    }

    this.sessions.delete(id);
    log.info(`Session closed: ${id}`);
    return true;
  }

  /** List all active sessions */
  listSessions(): Array<{
    id: string;
    type: SessionType;
    label: string;
    platform: string;
    createdAt: string;
    lastActivity: string;
    alive: boolean;
  }> {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      type: s.type,
      label: s.label,
      platform: s.platform || 'web',
      createdAt: s.createdAt.toISOString(),
      lastActivity: s.lastActivity.toISOString(),
      alive: s.process ? !s.process.killed : s.type === 'agent',
    }));
  }

  /** Clean up sessions that have been idle for too long */
  cleanupIdle(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, s] of this.sessions) {
      if (now - s.lastActivity.getTime() > this.idleTimeoutMs) {
        this.closeSession(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      log.info(`Cleaned up ${cleaned} idle terminal sessions`);
    }
    return cleaned;
  }

  /** Shut down all sessions (for graceful shutdown) */
  shutdownAll(): void {
    for (const id of this.sessions.keys()) {
      this.closeSession(id);
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    log.info('All terminal sessions shut down');
  }

  /** Get session count */
  get count(): number {
    return this.sessions.size;
  }
}



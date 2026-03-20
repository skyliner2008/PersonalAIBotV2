/**
 * Winston Logger Configuration
 *
 * Structured logging with file rotation for production use.
 * - Console: shows info/warn/error + filtered HTTP (important only)
 * - File: full JSON logs for all levels including every HTTP request
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Request, Response, NextFunction } from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logsDir = path.resolve(__dirname, '../../logs');

const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

type LogLevelName = keyof typeof logLevels;
type HttpConsoleMode = 'errors' | 'important' | 'all';

const configuredLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
const loggerLevel: LogLevelName = configuredLevel in logLevels
  ? (configuredLevel as LogLevelName)
  : 'info';
const httpConsoleMode = ((process.env.HTTP_CONSOLE_MODE || 'errors').toLowerCase() as HttpConsoleMode);

// Filter: block 'http' level from console (httpLogger handles console output itself)
const skipHttpOnConsole = winston.format((info) => {
  return info[Symbol.for('level') as unknown as string] === 'http' ? false : info;
})();

const logger = winston.createLogger({
  levels: logLevels,
  level: loggerLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  defaultMeta: { service: 'personal-ai-bot' },
  transports: [
    // Console: info/warn/error/debug only (http is handled separately)
    new winston.transports.Console({
      format: winston.format.combine(
        skipHttpOnConsole,
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const msg = typeof message === 'object' ? JSON.stringify(message) : message;
          const filteredMeta = Object.fromEntries(
            Object.entries(meta).filter(([k]) => k !== 'service'),
          );
          const metaStr = Object.keys(filteredMeta).length > 0
            ? ` ${JSON.stringify(filteredMeta)}`
            : '';
          return `${timestamp} [${level}]: ${msg}${metaStr}`;
        }),
      ),
    }),

    // Error log file
    new DailyRotateFile({
      filename: path.join(logsDir, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '20m',
      maxFiles: '14d',
      format: winston.format.json(),
    }),

    // Combined log file (all levels)
    new DailyRotateFile({
      filename: path.join(logsDir, 'combined-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '7d',
      format: winston.format.json(),
    }),

    // HTTP request log file (http level only)
    new DailyRotateFile({
      filename: path.join(logsDir, 'http-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'http',
      maxSize: '10m',
      maxFiles: '7d',
      format: winston.format.json(),
    }),
  ],
});

// Create a child logger with additional context
export const createLogger = (context: string | Record<string, unknown> = {}) => {
  const ctx = typeof context === 'string' ? { module: context } : context;
  return logger.child(ctx);
};

// HTTP Request Logger Middleware
// Console output is fully controlled here (Winston console skips http level)
const SLOW_REQUEST_MS = 3000;

// Dashboard/internal routes - suppress from console (still logged to file)
const QUIET_PATTERNS = [
  /^\/$/,                      // SPA index
  /^\/assets\//,               // Static assets
  /\.(ico|png|jpg|svg|woff2?|js|css|map)(\?|$)/,
  /^\/logs(\?|$)/,             // Dashboard polling
  /^\/agent\//,                // Agent stats/runs
  /^\/topology(\?|$)/,         // Legacy topology polling
  /^\/system\/topology(\?|$)/,
  /^\/status$/,                // Health check
  /^\/settings$/,              // Settings
  /^\/platforms$/,
  /^\/personas$/,
  /^\/bot-personas$/,
  /^\/categories$/,
  /^\/conversations$/,
  /^\/memory\//,
  /^\/posts$/,
  /^\/qa$/,
  /\/models$/,                 // Provider model lists
  /^\/usage\//,                // Usage tracking polling
  /^\/providers\/health/,      // Health check polling
  /^\/swarm\//,                // Multi-agent polling routes
  /^\/api\/swarm\//,           // Full API-prefixed swarm routes
  /^\/batches(\?|$)/,          // Legacy/mounted swarm polling
  /^\/tasks(\?|$)/,
  /^\/specialists(\?|$)/,
  /\/health/,                  // Any health endpoint (/health, /health/all, etc.)
];

export const httpLogger = {
  log: (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - start;
      const statusCode = res.statusCode;
      const url = req.url;
      const method = req.method;

      // Always write to file transports via Winston (console is blocked by skipHttpOnConsole)
      logger.http(`${method} ${url} ${statusCode} ${duration}ms`, {
        method,
        url,
        status: statusCode,
        duration: `${duration}ms`,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });

      // Console output mode:
      // - errors (default): show only HTTP errors + slow requests
      // - important: previous behavior (non-quiet + errors + slow)
      // - all: everything except expected unauthorized bootstrap noise
      const isQuiet = QUIET_PATTERNS.some((pattern) => pattern.test(url));
      const isError = statusCode >= 400;
      const isSlow = duration >= SLOW_REQUEST_MS;
      const isExpectedUnauthorized = statusCode === 401 && isQuiet;
      const isSuccessful = statusCode < 400;
      const isNonQuiet = !isQuiet;

      // Expected dashboard polling 401s are noisy during auth bootstrap.
      // Keep them in file logs but suppress from console.
      let shouldPrint = false;
      if (httpConsoleMode === 'all') {
        shouldPrint = !isExpectedUnauthorized;
      } else if (httpConsoleMode === 'important') {
        shouldPrint = isSlow || (isError && !isExpectedUnauthorized) || isNonQuiet;
      } else {
        shouldPrint = isSlow || (isError && !isExpectedUnauthorized);
      }

      if (isSuccessful && statusCode === 304 && httpConsoleMode !== 'all') {
        shouldPrint = false;
      }

      if (shouldPrint) {
        const icon =
          statusCode >= 500
            ? '[ERR]'
            : statusCode >= 400
              ? '[WARN]'
              : statusCode >= 300
                ? '[REDIR]'
                : '[OK]';
        const slowTag = isSlow ? ' [SLOW]' : '';
        const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
        console.log(`${ts} [http]: ${icon} ${method} ${url} ${statusCode} ${duration}ms${slowTag}`);
      }
    });

    next();
  },
};

export default logger;

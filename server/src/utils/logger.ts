// ============================================================
// Structured Logger — Lightweight JSON logging (no external deps)
// ============================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

interface LogEntry {
    timestamp: string;
    level: LogLevel;
    component: string;
    message: string;
    meta?: Record<string, unknown>;
}

function shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatEntry(entry: LogEntry): string {
    if (process.env.LOG_FORMAT === 'json') {
        return JSON.stringify(entry);
    }
    // Human-readable format for development
    const ts = entry.timestamp.split('T')[1]?.replace('Z', '') ?? entry.timestamp;
    const metaStr = entry.meta ? ` ${JSON.stringify(entry.meta)}` : '';
    const levelIcon = { debug: '🔍', info: 'ℹ️', warn: '⚠️', error: '❌' }[entry.level];
    return `${ts} ${levelIcon} [${entry.component}] ${entry.message}${metaStr}`;
}

function log(level: LogLevel, component: string, message: string, meta?: Record<string, unknown>) {
    if (!shouldLog(level)) return;
    const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level,
        component,
        message,
        ...(meta && { meta }),
    };
    const output = formatEntry(entry);
    if (level === 'error') {
        console.error(output);
    } else if (level === 'warn') {
        console.warn(output);
    } else {
        console.log(output);
    }
}

/**
 * Create a logger scoped to a specific component.
 * Usage:
 *   const log = createLogger('Agent');
 *   log.info('Processing message', { chatId, taskType });
 *   log.error('Failed', { error: err.message });
 */
export function createLogger(component: string) {
    return {
        debug: (message: string, meta?: Record<string, unknown>) => log('debug', component, message, meta),
        info: (message: string, meta?: Record<string, unknown>) => log('info', component, message, meta),
        warn: (message: string, meta?: Record<string, unknown>) => log('warn', component, message, meta),
        error: (message: string, meta?: Record<string, unknown>) => log('error', component, message, meta),
    };
}

import type { AgentStats, ToolTelemetry, CircuitState } from './types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('CircuitBreaker');

// ============================================================
// Circuit Breaker — ป้องกัน tool ที่ fail ซ้ำๆ (Exponential Backoff)
// ============================================================
const toolCircuits: Map<string, CircuitState> = new Map();
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_BASE_MS = 10_000;
const CIRCUIT_MAX_MS = 120_000;

export function isCircuitOpen(toolName: string): boolean {
  const c = toolCircuits.get(toolName);
  if (!c) return false;
  if (c.openUntil > Date.now()) return true;
  if (c.openUntil <= 0) return false;
  c.failures = Math.floor(c.failures / 2);
  c.openUntil = 0;
  if (c.failures === 0) toolCircuits.delete(toolName);
  else toolCircuits.set(toolName, c);
  return false;
}

export function recordToolResult(toolName: string, success: boolean): void {
  if (success) {
    const c = toolCircuits.get(toolName);
    if (c) {
      c.recoveries = (c.recoveries ?? 0) + 1;
      c.failures = Math.max(0, c.failures - 1);
      if (c.failures === 0) {
        if ((c.totalOpens ?? 0) > 0) {
          log.info(`${toolName} fully recovered after ${c.recoveries} successful calls (was opened ${c.totalOpens} times)`);
        }
        toolCircuits.delete(toolName);
      } else {
        toolCircuits.set(toolName, c);
      }
    }
    return;
  }
  const c = toolCircuits.get(toolName) ?? { failures: 0, openUntil: 0, recoveries: 0, totalOpens: 0 };
  c.failures++;
  if (c.failures >= CIRCUIT_THRESHOLD) {
    const backoffMs = Math.min(CIRCUIT_BASE_MS * Math.pow(2, c.failures - CIRCUIT_THRESHOLD), CIRCUIT_MAX_MS);
    c.openUntil = Date.now() + backoffMs;
    c.totalOpens = (c.totalOpens ?? 0) + 1;
    c.lastOpenedAt = Date.now();
    log.warn(`${toolName} OPEN for ${backoffMs / 1000}s after ${c.failures} failures (opened ${c.totalOpens} times)`);
  }
  toolCircuits.set(toolName, c);
}

/** Get circuit breaker stats for monitoring dashboard */
export function getCircuitBreakerStats(): Array<{
  toolName: string; failures: number; isOpen: boolean;
  totalOpens: number; recoveries: number; lastOpenedAt?: number;
}> {
  const now = Date.now();
  return Array.from(toolCircuits.entries()).map(([name, c]) => ({
    toolName: name,
    failures: c.failures,
    isOpen: c.openUntil > now,
    totalOpens: c.totalOpens ?? 0,
    recoveries: c.recoveries ?? 0,
    lastOpenedAt: c.lastOpenedAt,
  }));
}

// ============================================================
// Per-user processing queue (ป้องกัน race condition)
// ============================================================
const processingQueues: Map<string, Promise<string>> = new Map();

export function enqueueForUser(chatId: string, task: () => Promise<string>): Promise<string> {
  const prev = processingQueues.get(chatId) ?? Promise.resolve('');
  const next = prev.catch(() => { }).then(task);
  processingQueues.set(chatId, next);
  next.finally(() => {
    if (processingQueues.get(chatId) === next) processingQueues.delete(chatId);
  });
  return next;
}

// ============================================================
// Global Agent Run History
// ============================================================
export interface AgentRun {
  id: string;
  chatId: string;
  message: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  turns: number;
  toolCalls: ToolTelemetry[];
  totalTokens: number;
  reply?: string;
  error?: string;
  taskType?: string;
}

const _runHistory: AgentRun[] = [];
const MAX_RUN_HISTORY = 5000;
let _runCounter = 0;

export function newStats(): AgentStats {
  return { turns: 0, toolCalls: [] as ToolTelemetry[], totalTokens: 0, startTime: Date.now() };
}

export function startRun(chatId: string, message: string, taskType: string): AgentRun {
  const run: AgentRun = {
    id: `run_${++_runCounter}_${Date.now()}`,
    chatId,
    message: message.substring(0, 200),
    startTime: Date.now(),
    turns: 0,
    toolCalls: [],
    totalTokens: 0,
    taskType,
  };
  _runHistory.push(run);
  if (_runHistory.length > MAX_RUN_HISTORY) _runHistory.shift();
  return run;
}

export function finishRun(run: AgentRun, stats: AgentStats, reply?: string, error?: string) {
  run.endTime = Date.now();
  run.durationMs = run.endTime - run.startTime;
  run.turns = stats.turns;
  run.toolCalls = stats.toolCalls;
  run.totalTokens = stats.totalTokens;
  run.reply = reply?.substring(0, 300);
  run.error = error;
}

export function getAgentRunHistory(): AgentRun[] {
  return [..._runHistory].reverse();
}

export function clearAgentRunHistory(): void {
  _runHistory.length = 0;
}

export function getAgentActiveRuns(): AgentRun[] {
  return _runHistory.filter(r => !r.endTime);
}

export function getAgentStats(): { totalRuns: number; activeRuns: number; avgDurationMs: number; avgTokens: number; totalToolCalls: number } {
  const finished = _runHistory.filter(r => r.endTime);
  const avgDuration = finished.length > 0
    ? Math.round(finished.reduce((s, r) => s + (r.durationMs || 0), 0) / finished.length)
    : 0;
  const avgTokens = finished.length > 0
    ? Math.round(finished.reduce((s, r) => s + r.totalTokens, 0) / finished.length)
    : 0;
  return {
    totalRuns: _runCounter,  // Use monotonic counter instead of capped buffer length
    activeRuns: _runHistory.filter(r => !r.endTime).length,
    avgDurationMs: avgDuration,
    avgTokens,
    totalToolCalls: _runHistory.reduce((s, r) => s + r.toolCalls.length, 0),
  };
}

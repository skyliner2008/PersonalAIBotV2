import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SpecialistDispatcher } from '../../swarm/specialistDispatcher.js';
import type { SpecialistRuntimeHealth } from '../../swarm/swarmTypes.js';

// Mock external dependencies
vi.mock('../../swarm/specialists.js', () => ({
  getAvailableSpecialists: () => [
    { name: 'gemini-cli-agent', capabilities: ['general', 'code'] },
    { name: 'codex-cli-agent', capabilities: ['code', 'refactor'] },
    { name: 'claude-cli-agent', capabilities: ['general', 'analysis'] },
    { name: 'jarvis', capabilities: ['planning'] },
  ],
  getSpecialistByName: (name: string) =>
    ({ name, capabilities: name === 'gemini-cli-agent' ? ['general', 'code'] : ['general'] }),
}));

vi.mock('../../system/rootAdmin.js', () => ({
  getRootAdminSpecialistName: () => 'jarvis',
}));

function createHealth(overrides: Partial<SpecialistRuntimeHealth> = {}): SpecialistRuntimeHealth {
  return {
    specialist: 'test-agent',
    state: 'idle',
    totalTasks: 0,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
    timeouts: 0,
    reroutes: 0,
    ...overrides,
  };
}

describe('SpecialistDispatcher', () => {
  let dispatcher: SpecialistDispatcher;

  beforeEach(() => {
    dispatcher = new SpecialistDispatcher();
  });

  // ── Runtime State ──

  it('recomputeRuntimeState: idle when no tasks', () => {
    const h = createHealth({ totalTasks: 0 });
    dispatcher.recomputeRuntimeState(h);
    expect(h.state).toBe('idle');
  });

  it('recomputeRuntimeState: healthy after success', () => {
    const h = createHealth({ totalTasks: 5, successes: 5, consecutiveFailures: 0 });
    dispatcher.recomputeRuntimeState(h);
    expect(h.state).toBe('healthy');
  });

  it('recomputeRuntimeState: degraded after 1 failure', () => {
    const h = createHealth({ totalTasks: 3, successes: 2, consecutiveFailures: 1 });
    dispatcher.recomputeRuntimeState(h);
    expect(h.state).toBe('degraded');
  });

  it('recomputeRuntimeState: unavailable after 3 consecutive failures', () => {
    const h = createHealth({ totalTasks: 3, failures: 3, consecutiveFailures: 3 });
    dispatcher.recomputeRuntimeState(h);
    expect(h.state).toBe('unavailable');
  });

  it('recomputeRuntimeState: unavailable on rate limit with 2 failures', () => {
    const h = createHealth({
      totalTasks: 2,
      failures: 2,
      consecutiveFailures: 2,
      lastError: '429 rate limit exceeded',
    });
    dispatcher.recomputeRuntimeState(h);
    expect(h.state).toBe('unavailable');
  });

  // ── Record Success / Failure ──

  it('recordSpecialistSuccess: updates counters and resets consecutiveFailures', () => {
    const h = createHealth({ totalTasks: 1, failures: 1, consecutiveFailures: 1 });
    dispatcher.recordSpecialistSuccess(h, 500);
    expect(h.totalTasks).toBe(2);
    expect(h.successes).toBe(1);
    expect(h.consecutiveFailures).toBe(0);
    expect(h.averageLatencyMs).toBe(500);
  });

  it('recordSpecialistSuccess: computes running average latency', () => {
    const h = createHealth({ totalTasks: 1, successes: 1, averageLatencyMs: 1000 });
    dispatcher.recordSpecialistSuccess(h, 500);
    // (1000 * 1 + 500) / 2 = 750
    expect(h.averageLatencyMs).toBe(750);
  });

  it('recordSpecialistFailure: increments failure counters', () => {
    const h = createHealth();
    dispatcher.recordSpecialistFailure(h, 'Connection refused');
    expect(h.totalTasks).toBe(1);
    expect(h.failures).toBe(1);
    expect(h.consecutiveFailures).toBe(1);
    expect(h.lastError).toBe('Connection refused');
  });

  it('recordSpecialistFailure: increments timeouts on timeout error', () => {
    const h = createHealth();
    dispatcher.recordSpecialistFailure(h, 'Request timeout after 30s');
    expect(h.timeouts).toBe(1);
  });

  // ── Recoverable failure detection ──

  it('isRecoverableSpecialistFailure: recognizes timeout', () => {
    expect(dispatcher.isRecoverableSpecialistFailure('Request timed out')).toBe(true);
  });

  it('isRecoverableSpecialistFailure: recognizes rate limit', () => {
    expect(dispatcher.isRecoverableSpecialistFailure('429 rate limit exceeded')).toBe(true);
  });

  it('isRecoverableSpecialistFailure: rejects unknown error', () => {
    expect(dispatcher.isRecoverableSpecialistFailure('Syntax error in code')).toBe(false);
  });

  // ── CLI specialist check ──

  it('isCliSpecialist: returns true for known CLI agents', () => {
    expect(dispatcher.isCliSpecialist('gemini-cli-agent')).toBe(true);
    expect(dispatcher.isCliSpecialist('codex-cli-agent')).toBe(true);
    expect(dispatcher.isCliSpecialist('claude-cli-agent')).toBe(true);
  });

  it('isCliSpecialist: returns false for non-CLI agents', () => {
    expect(dispatcher.isCliSpecialist('jarvis')).toBe(false);
    expect(dispatcher.isCliSpecialist('unknown')).toBe(false);
  });

  // ── Fallback selection ──

  it('chooseFallbackSpecialist: picks available specialist', () => {
    const mockTask = { taskType: 'general' } as any;
    const healthGetter = (name: string) => createHealth({ specialist: name, state: 'healthy' });

    const result = dispatcher.chooseFallbackSpecialist(mockTask, 'gemini-cli-agent', healthGetter);
    expect(result).not.toBeNull();
    expect(result).not.toBe('gemini-cli-agent');
    expect(result).not.toBe('jarvis'); // jarvis is root admin, should be excluded
  });

  it('chooseFallbackSpecialist: returns null when all unavailable', () => {
    const mockTask = { taskType: 'general' } as any;
    const healthGetter = () => createHealth({ state: 'unavailable' });

    const result = dispatcher.chooseFallbackSpecialist(mockTask, 'gemini-cli-agent', healthGetter);
    expect(result).toBeNull();
  });
});

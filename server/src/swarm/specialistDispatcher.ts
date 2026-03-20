/**
 * Specialist Dispatcher
 * Handles routing tasks to specialist lanes, health checking, and lane availability
 */

import type { SwarmTask, SwarmBatch, SpecialistRuntimeHealth } from './swarmTypes.js';
import { getAvailableSpecialists, getSpecialistByName } from './specialists.js';
import { getRootAdminSpecialistName } from '../system/rootAdmin.js';

export class SpecialistDispatcher {
  /**
   * Compute runtime state based on failure/success metrics
   */
  recomputeRuntimeState(health: SpecialistRuntimeHealth): void {
    if (health.totalTasks === 0) {
      health.state = 'idle';
      return;
    }
    if (
      health.consecutiveFailures >= 2 &&
      /(429|no capacity|rate limit|quota)/i.test(health.lastError || '')
    ) {
      health.state = 'unavailable';
      return;
    }
    if (health.consecutiveFailures >= 3 || health.timeouts >= 3) {
      health.state = 'unavailable';
      return;
    }
    if (health.consecutiveFailures >= 1) {
      health.state = 'degraded';
      return;
    }
    health.state = 'healthy';
  }

  /**
   * Record a successful task execution
   */
  recordSpecialistSuccess(health: SpecialistRuntimeHealth, latencyMs?: number): void {
    health.totalTasks += 1;
    health.successes += 1;
    health.consecutiveFailures = 0;
    health.lastError = undefined;
    health.lastSuccessAt = new Date().toISOString();

    if (Number.isFinite(latencyMs) && latencyMs! >= 0) {
      const priorSamples = Math.max(0, health.successes - 1);
      const priorTotal = (health.averageLatencyMs || 0) * priorSamples;
      health.averageLatencyMs = Math.round((priorTotal + latencyMs!) / Math.max(1, health.successes));
    }
    this.recomputeRuntimeState(health);
  }

  /**
   * Record a failed task execution
   */
  recordSpecialistFailure(health: SpecialistRuntimeHealth, errorMsg: string, latencyMs?: number): void {
    health.totalTasks += 1;
    health.failures += 1;
    health.consecutiveFailures += 1;
    health.lastError = errorMsg;
    health.lastFailureAt = new Date().toISOString();
    if (/timeout/i.test(errorMsg)) {
      health.timeouts += 1;
    }
    if (Number.isFinite(latencyMs) && latencyMs! >= 0 && !health.averageLatencyMs) {
      health.averageLatencyMs = Math.round(latencyMs!);
    }
    this.recomputeRuntimeState(health);
  }

  /**
   * Mark a reroute occurred for a specialist
   */
  markReroute(health: SpecialistRuntimeHealth): void {
    health.reroutes += 1;
    this.recomputeRuntimeState(health);
  }

  /**
   * Check if a failure is recoverable (worth retrying)
   */
  isRecoverableSpecialistFailure(errorMsg: string): boolean {
    const normalized = String(errorMsg || '').toLowerCase();
    return [
      'timeout',
      'timed out',
      'usage limit',
      'rate limit',
      'temporarily unavailable',
      'econn',
      'network',
      'no response',
      'service unavailable',
      '503',
      '429',
      'connection',
      'quota',
    ].some((token) => normalized.includes(token));
  }

  /**
   * Choose a fallback specialist if primary fails
   */
  chooseFallbackSpecialist(
    task: SwarmTask,
    failedSpecialist: string,
    runtimeHealthGetter: (name: string) => SpecialistRuntimeHealth,
  ): string | null {
    const candidates = getAvailableSpecialists()
      .filter((specialist) => specialist.name !== failedSpecialist && specialist.name !== getRootAdminSpecialistName())
      .filter((specialist) => this.isCliSpecialist(specialist.name))
      .filter((specialist) => {
        const runtime = runtimeHealthGetter(specialist.name);
        return runtime.state !== 'unavailable';
      });

    if (candidates.length === 0) return null;

    const ranked = candidates
      .map((specialist) => {
        const runtime = runtimeHealthGetter(specialist.name);
        const capabilityScore = specialist.capabilities.includes(task.taskType) ? 6 : 0;
        const healthyBonus = runtime.state === 'healthy' ? 3 : runtime.state === 'idle' ? 1 : -3;
        const failurePenalty = runtime.consecutiveFailures * 4;
        return {
          specialist,
          score: capabilityScore + healthyBonus - failurePenalty,
        };
      })
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.specialist.name || null;
  }

  /**
   * Choose the fastest completed specialist to take over a slow task
   */
  chooseFastestCompletedSpecialist(
    batch: SwarmBatch,
    taskMap: Map<string, SwarmTask>,
    exclude: Set<string>,
    runtimeHealthGetter: (name: string) => SpecialistRuntimeHealth,
  ): string | null {
    const ranked = batch.assignments
      .filter((assignment) => assignment.status === 'completed')
      .filter((assignment) => !exclude.has(assignment.specialist))
      .filter((assignment) => this.isCliSpecialist(assignment.specialist))
      .map((assignment) => {
        const task = taskMap.get(assignment.taskId);
        const runtime = runtimeHealthGetter(assignment.specialist);
        const duration = task?.startedAt && task?.completedAt
          ? task.completedAt.getTime() - task.startedAt.getTime()
          : runtime.averageLatencyMs || Number.MAX_SAFE_INTEGER;
        return {
          specialist: assignment.specialist,
          duration,
          healthPenalty: runtime.state === 'healthy' ? 0 : runtime.state === 'idle' ? 10_000 : 30_000,
        };
      })
      .sort((a, b) => (a.duration + a.healthPenalty) - (b.duration + b.healthPenalty));

    return ranked[0]?.specialist || null;
  }

  /**
   * Check if a specialist is CLI-based
   */
  isCliSpecialist(specialistName: string): boolean {
    return Boolean({
      'gemini-cli-agent': true,
      'codex-cli-agent': true,
      'claude-cli-agent': true,
      'openai-cli-agent': true,
    }[specialistName]);
  }
}

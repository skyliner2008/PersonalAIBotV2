/**
 * Swarm Health Tracker
 * Manages per-specialist health state, metrics computation, and health tracking.
 * Extracts health-tracking logic from SwarmCoordinator into a standalone module.
 */

import type { SpecialistRuntimeHealth } from './swarmTypes.js';

export class SwarmHealthTracker {
  private specialistRuntime: Map<string, SpecialistRuntimeHealth> = new Map();

  /**
   * Get or create health tracking for a specialist
   */
  getOrCreateRuntimeHealth(specialistName: string): SpecialistRuntimeHealth {
    const existing = this.specialistRuntime.get(specialistName);
    if (existing) return existing;

    const created: SpecialistRuntimeHealth = {
      specialist: specialistName,
      state: 'idle',
      totalTasks: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      timeouts: 0,
      reroutes: 0,
    };
    this.specialistRuntime.set(specialistName, created);
    return created;
  }

  /**
   * Record a successful task execution
   */
  recordSuccess(specialistName: string, latencyMs?: number): void {
    const health = this.getOrCreateRuntimeHealth(specialistName);
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
  recordFailure(specialistName: string, errorMsg: string, latencyMs?: number): void {
    const health = this.getOrCreateRuntimeHealth(specialistName);
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
   * Record a timeout for a specialist
   */
  recordTimeout(specialistName: string, latencyMs?: number): void {
    const health = this.getOrCreateRuntimeHealth(specialistName);
    health.totalTasks += 1;
    health.timeouts += 1;
    health.consecutiveFailures += 1;
    health.lastError = 'timeout';
    health.lastFailureAt = new Date().toISOString();
    if (Number.isFinite(latencyMs) && latencyMs! >= 0 && !health.averageLatencyMs) {
      health.averageLatencyMs = Math.round(latencyMs!);
    }
    this.recomputeRuntimeState(health);
  }

  /**
   * Record a reroute occurred for a specialist
   */
  recordReroute(specialistName: string): void {
    const health = this.getOrCreateRuntimeHealth(specialistName);
    health.reroutes += 1;
    this.recomputeRuntimeState(health);
  }

  /**
   * Check if a specialist is healthy
   */
  isHealthy(specialistName: string): boolean {
    const health = this.getOrCreateRuntimeHealth(specialistName);
    return health.state === 'healthy' || health.state === 'idle';
  }

  /**
   * Get health snapshot for a specialist
   */
  getHealthSnapshot(specialistName: string): SpecialistRuntimeHealth {
    const health = this.getOrCreateRuntimeHealth(specialistName);
    return { ...health };
  }

  /**
   * Get all specialist health data, sorted by specialist name
   */
  getSpecialistRuntimeHealth(): SpecialistRuntimeHealth[] {
    return Array.from(this.specialistRuntime.values())
      .map((item) => ({ ...item }))
      .sort((a, b) => a.specialist.localeCompare(b.specialist));
  }

  /**
   * Get the raw specialist runtime map (for advanced access)
   */
  getSpecialistRuntime(): Map<string, SpecialistRuntimeHealth> {
    return this.specialistRuntime;
  }

  /**
   * Compute runtime state based on failure/success metrics
   * This implements circuit-breaker-like state transitions.
   */
  private recomputeRuntimeState(health: SpecialistRuntimeHealth): void {
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
   * Clear all health tracking state (for shutdown or reset)
   */
  clear(): void {
    this.specialistRuntime.clear();
  }
}

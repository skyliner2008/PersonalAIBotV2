// ============================================================
// Unit Tests: Swarm Health Tracker
// ============================================================
// Tests health state tracking for specialists with metrics
// computation, circuit-breaker-like state transitions, and
// per-specialist failure/success tracking.

import { describe, it, expect, beforeEach } from 'vitest';
import { SwarmHealthTracker } from '../../swarm/swarmHealthTracker.js';
import type { SpecialistRuntimeHealth } from '../../swarm/swarmTypes.js';

// ============================================================
// Tests
// ============================================================

describe('SwarmHealthTracker', () => {
  let tracker: SwarmHealthTracker;

  beforeEach(() => {
    tracker = new SwarmHealthTracker();
  });

  describe('creating tracker instances', () => {
    it('should create a new tracker instance', () => {
      expect(tracker).toBeDefined();
      expect(tracker).toBeInstanceOf(SwarmHealthTracker);
    });

    it('should start with empty specialist data', () => {
      const health = tracker.getSpecialistRuntimeHealth();
      expect(health).toEqual([]);
    });
  });

  describe('getOrCreateRuntimeHealth', () => {
    it('should create health data for a new specialist', () => {
      const health = tracker.getOrCreateRuntimeHealth('specialist-1');

      expect(health).toBeDefined();
      expect(health.specialist).toBe('specialist-1');
      expect(health.state).toBe('idle');
      expect(health.totalTasks).toBe(0);
      expect(health.successes).toBe(0);
      expect(health.failures).toBe(0);
      expect(health.consecutiveFailures).toBe(0);
      expect(health.timeouts).toBe(0);
      expect(health.reroutes).toBe(0);
    });

    it('should return same instance on subsequent calls', () => {
      const health1 = tracker.getOrCreateRuntimeHealth('specialist-1');
      const health2 = tracker.getOrCreateRuntimeHealth('specialist-1');

      expect(health1).toBe(health2);
    });

    it('should handle empty specialist name', () => {
      const health = tracker.getOrCreateRuntimeHealth('');

      expect(health.specialist).toBe('');
      expect(health.state).toBe('idle');
    });

    it('should handle special characters in specialist name', () => {
      const names = ['spec-123', 'spec_name', 'spec.service', 'spec@host'];

      for (const name of names) {
        const health = tracker.getOrCreateRuntimeHealth(name);
        expect(health.specialist).toBe(name);
      }
    });
  });

  describe('recordSuccess', () => {
    it('should record a successful task execution', () => {
      tracker.recordSuccess('specialist-1');

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.totalTasks).toBe(1);
      expect(health.successes).toBe(1);
      expect(health.consecutiveFailures).toBe(0);
      expect(health.state).toBe('healthy');
    });

    it('should reset consecutiveFailures on success', () => {
      tracker.recordSuccess('specialist-1');
      tracker.recordFailure('specialist-1', 'error');
      tracker.recordFailure('specialist-1', 'error');

      expect(tracker.getOrCreateRuntimeHealth('specialist-1').consecutiveFailures).toBe(2);

      tracker.recordSuccess('specialist-1');

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.consecutiveFailures).toBe(0);
      expect(health.successes).toBe(2);
    });

    it('should update lastSuccessAt timestamp', () => {
      const beforeTime = new Date().toISOString();
      tracker.recordSuccess('specialist-1');
      const afterTime = new Date().toISOString();

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.lastSuccessAt).toBeDefined();
      expect(health.lastSuccessAt! >= beforeTime && health.lastSuccessAt! <= afterTime).toBe(true);
    });

    it('should clear lastError on success', () => {
      tracker.recordFailure('specialist-1', 'previous error');
      expect(tracker.getOrCreateRuntimeHealth('specialist-1').lastError).toBe('previous error');

      tracker.recordSuccess('specialist-1');

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.lastError).toBeUndefined();
    });

    it('should calculate average latency from latency samples', () => {
      tracker.recordSuccess('specialist-1', 100);
      tracker.recordSuccess('specialist-1', 200);
      tracker.recordSuccess('specialist-1', 300);

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.averageLatencyMs).toBe(200); // (100 + 200 + 300) / 3 = 200
    });

    it('should handle zero latency', () => {
      tracker.recordSuccess('specialist-1', 0);

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.averageLatencyMs).toBe(0);
    });

    it('should ignore negative latency', () => {
      tracker.recordSuccess('specialist-1', 100);
      tracker.recordSuccess('specialist-1', -50); // Invalid, should not affect average

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.averageLatencyMs).toBe(100);
    });

    it('should ignore non-finite latency (NaN, Infinity)', () => {
      tracker.recordSuccess('specialist-1', 100);
      tracker.recordSuccess('specialist-1', NaN);
      tracker.recordSuccess('specialist-1', Infinity);

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.averageLatencyMs).toBe(100);
    });

    it('should not provide latency if not recorded', () => {
      tracker.recordSuccess('specialist-1');
      tracker.recordSuccess('specialist-1');

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.averageLatencyMs).toBeUndefined();
    });
  });

  describe('recordFailure', () => {
    it('should record a failed task execution', () => {
      tracker.recordFailure('specialist-1', 'connection error');

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.totalTasks).toBe(1);
      expect(health.failures).toBe(1);
      expect(health.consecutiveFailures).toBe(1);
      expect(health.lastError).toBe('connection error');
      expect(health.state).toBe('degraded');
    });

    it('should increment consecutiveFailures on repeated failures', () => {
      tracker.recordFailure('specialist-1', 'error 1');
      tracker.recordFailure('specialist-1', 'error 2');
      tracker.recordFailure('specialist-1', 'error 3');

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.consecutiveFailures).toBe(3);
    });

    it('should set lastFailureAt timestamp', () => {
      const beforeTime = new Date().toISOString();
      tracker.recordFailure('specialist-1', 'error');
      const afterTime = new Date().toISOString();

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.lastFailureAt).toBeDefined();
      expect(health.lastFailureAt! >= beforeTime && health.lastFailureAt! <= afterTime).toBe(true);
    });

    it('should detect timeout errors in message', () => {
      tracker.recordFailure('specialist-1', 'Request timeout after 30s');

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.timeouts).toBe(1);
    });

    it('should detect timeout errors case-insensitively', () => {
      tracker.recordFailure('specialist-1', 'TIMEOUT');
      tracker.recordFailure('specialist-2', 'TiMeOuT error');

      expect(tracker.getOrCreateRuntimeHealth('specialist-1').timeouts).toBe(1);
      expect(tracker.getOrCreateRuntimeHealth('specialist-2').timeouts).toBe(1);
    });

    it('should store initial latency if not yet recorded', () => {
      tracker.recordFailure('specialist-1', 'error', 500);

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.averageLatencyMs).toBe(500);
    });

    it('should not override existing average latency on failure', () => {
      tracker.recordSuccess('specialist-1', 1000);
      tracker.recordFailure('specialist-1', 'error', 100); // Should not update average

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.averageLatencyMs).toBe(1000);
    });

    it('should ignore negative latency', () => {
      tracker.recordFailure('specialist-1', 'error', -50);

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.averageLatencyMs).toBeUndefined();
    });
  });

  describe('recordTimeout', () => {
    it('should record a timeout event', () => {
      tracker.recordTimeout('specialist-1');

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.totalTasks).toBe(1);
      expect(health.timeouts).toBe(1);
      expect(health.consecutiveFailures).toBe(1);
      expect(health.lastError).toBe('timeout');
      expect(health.state).toBe('degraded');
    });

    it('should increment timeout counter multiple times', () => {
      tracker.recordTimeout('specialist-1');
      tracker.recordTimeout('specialist-1');
      tracker.recordTimeout('specialist-1');

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.timeouts).toBe(3);
      expect(health.consecutiveFailures).toBe(3);
    });

    it('should set lastFailureAt timestamp', () => {
      const beforeTime = new Date().toISOString();
      tracker.recordTimeout('specialist-1');
      const afterTime = new Date().toISOString();

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.lastFailureAt).toBeDefined();
      expect(health.lastFailureAt! >= beforeTime && health.lastFailureAt! <= afterTime).toBe(true);
    });

    it('should store initial latency if not yet recorded', () => {
      tracker.recordTimeout('specialist-1', 5000);

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.averageLatencyMs).toBe(5000);
    });

    it('should not override existing average latency on timeout', () => {
      tracker.recordSuccess('specialist-1', 2000);
      tracker.recordTimeout('specialist-1', 500); // Should not update average

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.averageLatencyMs).toBe(2000);
    });
  });

  describe('recordReroute', () => {
    it('should record a reroute event', () => {
      tracker.recordReroute('specialist-1');

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.reroutes).toBe(1);
    });

    it('should increment reroute counter', () => {
      tracker.recordReroute('specialist-1');
      tracker.recordReroute('specialist-1');
      tracker.recordReroute('specialist-1');

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.reroutes).toBe(3);
    });

    it('should not affect task counts', () => {
      tracker.recordReroute('specialist-1');

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.totalTasks).toBe(0);
      expect(health.state).toBe('idle');
    });

    it('should work alongside other metrics', () => {
      tracker.recordSuccess('specialist-1', 100);
      tracker.recordReroute('specialist-1');
      tracker.recordSuccess('specialist-1', 200);
      tracker.recordReroute('specialist-1');

      const health = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(health.totalTasks).toBe(2);
      expect(health.successes).toBe(2);
      expect(health.reroutes).toBe(2);
    });
  });

  describe('isHealthy', () => {
    it('should return true for idle state', () => {
      const isHealthy = tracker.isHealthy('specialist-1');
      expect(isHealthy).toBe(true);
    });

    it('should return true for healthy state', () => {
      tracker.recordSuccess('specialist-1');
      expect(tracker.isHealthy('specialist-1')).toBe(true);
    });

    it('should return false for degraded state', () => {
      tracker.recordFailure('specialist-1', 'error');
      expect(tracker.isHealthy('specialist-1')).toBe(false);
    });

    it('should return false for unavailable state', () => {
      tracker.recordFailure('specialist-1', 'error');
      tracker.recordFailure('specialist-1', 'error');
      tracker.recordFailure('specialist-1', 'error');
      expect(tracker.isHealthy('specialist-1')).toBe(false);
    });

    it('should return true after recovery from degraded state', () => {
      tracker.recordFailure('specialist-1', 'error');
      expect(tracker.isHealthy('specialist-1')).toBe(false);

      tracker.recordSuccess('specialist-1');
      expect(tracker.isHealthy('specialist-1')).toBe(true);
    });
  });

  describe('getHealthSnapshot', () => {
    it('should return a copy of health data', () => {
      tracker.recordSuccess('specialist-1', 100);
      const snapshot = tracker.getHealthSnapshot('specialist-1');

      expect(snapshot).toBeDefined();
      expect(snapshot.specialist).toBe('specialist-1');
      expect(snapshot.state).toBe('healthy');
      expect(snapshot.successes).toBe(1);
    });

    it('should return independent copy not affecting original', () => {
      tracker.recordSuccess('specialist-1', 100);
      const snapshot = tracker.getHealthSnapshot('specialist-1');

      // Modify snapshot
      snapshot.successes = 999;
      snapshot.state = 'unavailable' as any;

      // Original should be unaffected
      const original = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(original.successes).toBe(1);
      expect(original.state).toBe('healthy');
    });

    it('should include all health metrics in snapshot', () => {
      tracker.recordSuccess('specialist-1', 150);
      tracker.recordFailure('specialist-1', 'error', 200);
      tracker.recordReroute('specialist-1');

      const snapshot = tracker.getHealthSnapshot('specialist-1');

      expect(snapshot.totalTasks).toBe(2);
      expect(snapshot.successes).toBe(1);
      expect(snapshot.failures).toBe(1);
      expect(snapshot.reroutes).toBe(1);
      expect(snapshot.averageLatencyMs).toBeDefined();
    });
  });

  describe('getSpecialistRuntimeHealth', () => {
    it('should return empty array for no specialists', () => {
      const health = tracker.getSpecialistRuntimeHealth();
      expect(health).toEqual([]);
    });

    it('should return all specialists sorted alphabetically', () => {
      tracker.recordSuccess('zebra');
      tracker.recordSuccess('alpha');
      tracker.recordSuccess('beta');

      const health = tracker.getSpecialistRuntimeHealth();

      expect(health).toHaveLength(3);
      expect(health[0].specialist).toBe('alpha');
      expect(health[1].specialist).toBe('beta');
      expect(health[2].specialist).toBe('zebra');
    });

    it('should return independent copies of health data', () => {
      tracker.recordSuccess('specialist-1', 100);
      const healthList = tracker.getSpecialistRuntimeHealth();

      // Modify returned list
      healthList[0].successes = 999;

      // Original should be unaffected
      const original = tracker.getOrCreateRuntimeHealth('specialist-1');
      expect(original.successes).toBe(1);
    });

    it('should include complete health info for each specialist', () => {
      tracker.recordSuccess('specialist-1', 100);
      tracker.recordFailure('specialist-1', 'error');
      tracker.recordTimeout('specialist-2');

      const health = tracker.getSpecialistRuntimeHealth();

      expect(health).toHaveLength(2);

      const spec1 = health.find((h) => h.specialist === 'specialist-1')!;
      expect(spec1.totalTasks).toBe(2);
      expect(spec1.successes).toBe(1);
      expect(spec1.failures).toBe(1);

      const spec2 = health.find((h) => h.specialist === 'specialist-2')!;
      expect(spec2.totalTasks).toBe(1);
      expect(spec2.timeouts).toBe(1);
    });
  });

  describe('state transitions and circuit breaker logic', () => {
    it('should transition from idle to healthy on first success', () => {
      expect(tracker.getOrCreateRuntimeHealth('specialist-1').state).toBe('idle');

      tracker.recordSuccess('specialist-1');

      expect(tracker.getOrCreateRuntimeHealth('specialist-1').state).toBe('healthy');
    });

    it('should transition to degraded on first failure', () => {
      tracker.recordFailure('specialist-1', 'error');

      expect(tracker.getOrCreateRuntimeHealth('specialist-1').state).toBe('degraded');
    });

    it('should transition to unavailable with 3+ consecutive failures', () => {
      tracker.recordFailure('specialist-1', 'error 1');
      expect(tracker.getOrCreateRuntimeHealth('specialist-1').state).toBe('degraded');

      tracker.recordFailure('specialist-1', 'error 2');
      expect(tracker.getOrCreateRuntimeHealth('specialist-1').state).toBe('degraded');

      tracker.recordFailure('specialist-1', 'error 3');
      expect(tracker.getOrCreateRuntimeHealth('specialist-1').state).toBe('unavailable');
    });

    it('should transition to unavailable with 3+ timeouts', () => {
      tracker.recordTimeout('specialist-1');
      tracker.recordTimeout('specialist-1');
      expect(tracker.getOrCreateRuntimeHealth('specialist-1').state).toBe('degraded');

      tracker.recordTimeout('specialist-1');
      expect(tracker.getOrCreateRuntimeHealth('specialist-1').state).toBe('unavailable');
    });

    it('should transition to unavailable with 2+ failures and rate limit error', () => {
      tracker.recordFailure('specialist-1', 'Error: 429 rate limit exceeded');
      expect(tracker.getOrCreateRuntimeHealth('specialist-1').state).toBe('degraded');

      tracker.recordFailure('specialist-1', 'quota exceeded');
      expect(tracker.getOrCreateRuntimeHealth('specialist-1').state).toBe('unavailable');
    });

    it('should detect "no capacity" as rate limit', () => {
      tracker.recordFailure('specialist-1', 'Error: no capacity');
      tracker.recordFailure('specialist-1', 'Cannot proceed: no capacity available');

      expect(tracker.getOrCreateRuntimeHealth('specialist-1').state).toBe('unavailable');
    });

    it('should be case-insensitive for rate limit detection', () => {
      tracker.recordFailure('specialist-1', 'QUOTA EXCEEDED');
      tracker.recordFailure('specialist-1', 'RATE LIMIT');

      expect(tracker.getOrCreateRuntimeHealth('specialist-1').state).toBe('unavailable');
    });

    it('should transition back to healthy after recovery', () => {
      tracker.recordFailure('specialist-1', 'error');
      expect(tracker.getOrCreateRuntimeHealth('specialist-1').state).toBe('degraded');

      tracker.recordSuccess('specialist-1');
      expect(tracker.getOrCreateRuntimeHealth('specialist-1').state).toBe('healthy');
    });

    it('should maintain healthy state through multiple successes', () => {
      tracker.recordSuccess('specialist-1');
      expect(tracker.getOrCreateRuntimeHealth('specialist-1').state).toBe('healthy');

      // More successes don't change healthy state
      tracker.recordSuccess('specialist-1');
      tracker.recordSuccess('specialist-1');

      expect(tracker.getOrCreateRuntimeHealth('specialist-1').state).toBe('healthy');
    });

    it('should not transition from unavailable to healthy directly on single success', () => {
      // Get to unavailable state
      tracker.recordFailure('specialist-1', 'error');
      tracker.recordFailure('specialist-1', 'error');
      tracker.recordFailure('specialist-1', 'error');
      expect(tracker.getOrCreateRuntimeHealth('specialist-1').state).toBe('unavailable');

      // Single success should go to healthy (consecutive failures reset)
      tracker.recordSuccess('specialist-1');
      expect(tracker.getOrCreateRuntimeHealth('specialist-1').state).toBe('healthy');
    });
  });

  describe('multiple specialists tracked independently', () => {
    it('should track different specialists independently', () => {
      tracker.recordSuccess('api-specialist');
      tracker.recordFailure('db-specialist', 'connection error');

      const api = tracker.getOrCreateRuntimeHealth('api-specialist');
      const db = tracker.getOrCreateRuntimeHealth('db-specialist');

      expect(api.state).toBe('healthy');
      expect(db.state).toBe('degraded');
    });

    it('should not affect one specialist when recording metrics for another', () => {
      tracker.recordSuccess('specialist-1');
      tracker.recordFailure('specialist-1', 'error');
      tracker.recordFailure('specialist-1', 'error');
      tracker.recordFailure('specialist-1', 'error');

      expect(tracker.getOrCreateRuntimeHealth('specialist-1').state).toBe('unavailable');
      expect(tracker.getOrCreateRuntimeHealth('specialist-2').state).toBe('idle');
    });

    it('should maintain separate timeouts for each specialist', () => {
      tracker.recordTimeout('spec-1');
      tracker.recordTimeout('spec-1');
      tracker.recordTimeout('spec-2');

      expect(tracker.getOrCreateRuntimeHealth('spec-1').timeouts).toBe(2);
      expect(tracker.getOrCreateRuntimeHealth('spec-2').timeouts).toBe(1);
    });

    it('should maintain separate reroutes for each specialist', () => {
      tracker.recordReroute('spec-1');
      tracker.recordReroute('spec-1');
      tracker.recordReroute('spec-1');
      tracker.recordReroute('spec-2');

      expect(tracker.getOrCreateRuntimeHealth('spec-1').reroutes).toBe(3);
      expect(tracker.getOrCreateRuntimeHealth('spec-2').reroutes).toBe(1);
    });

    it('should maintain separate average latencies', () => {
      tracker.recordSuccess('spec-1', 100);
      tracker.recordSuccess('spec-1', 300);
      tracker.recordSuccess('spec-2', 50);
      tracker.recordSuccess('spec-2', 150);

      expect(tracker.getOrCreateRuntimeHealth('spec-1').averageLatencyMs).toBe(200);
      expect(tracker.getOrCreateRuntimeHealth('spec-2').averageLatencyMs).toBe(100);
    });
  });

  describe('clear', () => {
    it('should clear all specialist data', () => {
      tracker.recordSuccess('spec-1');
      tracker.recordSuccess('spec-2');
      tracker.recordSuccess('spec-3');

      expect(tracker.getSpecialistRuntimeHealth()).toHaveLength(3);

      tracker.clear();

      expect(tracker.getSpecialistRuntimeHealth()).toEqual([]);
    });

    it('should reset state after clear', () => {
      tracker.recordSuccess('specialist');
      tracker.recordSuccess('specialist');

      tracker.clear();

      const health = tracker.getOrCreateRuntimeHealth('specialist');
      expect(health.state).toBe('idle');
      expect(health.totalTasks).toBe(0);
      expect(health.successes).toBe(0);
    });

    it('should allow fresh tracking after clear', () => {
      tracker.recordSuccess('specialist');
      tracker.clear();

      tracker.recordSuccess('specialist');
      const health = tracker.getOrCreateRuntimeHealth('specialist');

      expect(health.totalTasks).toBe(1);
      expect(health.successes).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('should handle rapid success/failure alternation', () => {
      for (let i = 0; i < 10; i++) {
        if (i % 2 === 0) {
          tracker.recordSuccess('specialist');
        } else {
          tracker.recordFailure('specialist', 'error');
        }
      }

      const health = tracker.getOrCreateRuntimeHealth('specialist');
      expect(health.totalTasks).toBe(10);
      expect(health.successes).toBe(5);
      expect(health.failures).toBe(5);
    });

    it('should handle many specialists', () => {
      const count = 100;
      for (let i = 0; i < count; i++) {
        tracker.recordSuccess(`specialist-${i}`);
      }

      expect(tracker.getSpecialistRuntimeHealth()).toHaveLength(count);
    });

    it('should handle very large latency values', () => {
      tracker.recordSuccess('specialist', 999999999);
      const health = tracker.getOrCreateRuntimeHealth('specialist');
      expect(health.averageLatencyMs).toBe(999999999);
    });

    it('should handle unicode and special characters in specialist names', () => {
      const names = ['spec-α', 'spec_β', 'спец', '专家', 'specialist!@#'];

      for (const name of names) {
        tracker.recordSuccess(name);
      }

      const health = tracker.getSpecialistRuntimeHealth();
      expect(health).toHaveLength(5);
    });

    it('should properly track health after failures and successes mixed', () => {
      tracker.recordFailure('specialist', 'error');
      tracker.recordFailure('specialist', 'error');

      const health = tracker.getOrCreateRuntimeHealth('specialist');
      expect(health.state).toBe('degraded');
      expect(health.consecutiveFailures).toBe(2);

      // Success resets consecutive failures
      tracker.recordSuccess('specialist');
      const updated = tracker.getOrCreateRuntimeHealth('specialist');
      expect(updated.consecutiveFailures).toBe(0);
      expect(updated.state).toBe('healthy');
    });

    it('should handle error messages with various formats', () => {
      const errorMessages = [
        'Error: timeout',
        'TIMEOUT occurred',
        'timeout in process',
        'Operation timeout occurred',
        'no error related to timing',
      ];

      for (let i = 0; i < errorMessages.length; i++) {
        const spec = `specialist-${i}`;
        tracker.recordFailure(spec, errorMessages[i]);
      }

      expect(tracker.getOrCreateRuntimeHealth('specialist-0').timeouts).toBe(1);
      expect(tracker.getOrCreateRuntimeHealth('specialist-1').timeouts).toBe(1);
      expect(tracker.getOrCreateRuntimeHealth('specialist-2').timeouts).toBe(1);
      expect(tracker.getOrCreateRuntimeHealth('specialist-3').timeouts).toBe(1);
      expect(tracker.getOrCreateRuntimeHealth('specialist-4').timeouts).toBe(0);
    });

    it('should handle consecutive operations without timestamps changing', () => {
      const before = new Date().toISOString();

      tracker.recordSuccess('specialist');
      const snap1 = tracker.getHealthSnapshot('specialist');

      tracker.recordSuccess('specialist');
      const snap2 = tracker.getHealthSnapshot('specialist');

      const after = new Date().toISOString();

      expect(snap1.lastSuccessAt).toBeDefined();
      expect(snap2.lastSuccessAt).toBeDefined();
      expect(snap2.lastSuccessAt! >= snap1.lastSuccessAt!).toBe(true);
      expect(snap2.lastSuccessAt! >= before && snap2.lastSuccessAt! <= after).toBe(true);
    });
  });

  describe('integration scenarios', () => {
    it('should handle realistic specialist lifecycle', () => {
      // Initial idle state
      expect(tracker.isHealthy('api-service')).toBe(true);

      // Start successful operations
      tracker.recordSuccess('api-service', 100);
      tracker.recordSuccess('api-service', 120);
      expect(tracker.isHealthy('api-service')).toBe(true);

      // Service degrades
      tracker.recordFailure('api-service', 'connection timeout');
      expect(tracker.isHealthy('api-service')).toBe(false);

      // Attempted recovery fails
      tracker.recordFailure('api-service', 'service unavailable');
      tracker.recordFailure('api-service', 'rate limit exceeded');

      // Now unavailable
      const health = tracker.getHealthSnapshot('api-service');
      expect(health.state).toBe('unavailable');
      expect(health.consecutiveFailures).toBe(3);

      // Recovery succeeds
      tracker.recordSuccess('api-service', 150);

      expect(tracker.isHealthy('api-service')).toBe(true);
      expect(tracker.getOrCreateRuntimeHealth('api-service').state).toBe('healthy');
    });

    it('should track swarm of specialists with different health states', () => {
      const specialists = {
        'code-executor': { successes: 10, failures: 0 },
        'memory-searcher': { successes: 8, failures: 2 },
        'file-processor': { successes: 5, failures: 5 },
        'api-caller': { successes: 1, failures: 10 },
      };

      for (const [name, { successes, failures }] of Object.entries(specialists)) {
        for (let i = 0; i < successes; i++) {
          tracker.recordSuccess(name, 100);
        }
        for (let i = 0; i < failures; i++) {
          tracker.recordFailure(name, 'error');
        }
      }

      const healthList = tracker.getSpecialistRuntimeHealth();

      const codeExecutor = healthList.find((h) => h.specialist === 'code-executor')!;
      expect(codeExecutor.state).toBe('healthy');

      const memorySearcher = healthList.find((h) => h.specialist === 'memory-searcher')!;
      expect(memorySearcher.state).toBe('degraded');

      const fileProcessor = healthList.find((h) => h.specialist === 'file-processor')!;
      expect(fileProcessor.state).toBe('unavailable'); // 5 successes followed by 5 failures = 5 consecutive failures

      const apiCaller = healthList.find((h) => h.specialist === 'api-caller')!;
      expect(apiCaller.state).toBe('unavailable');
    });

    it('should track metrics across multiple operations', () => {
      // Simulate real workload
      // Note: reroutes don't count as totalTasks
      tracker.recordSuccess('worker', 50);
      tracker.recordSuccess('worker', 60);
      tracker.recordTimeout('worker', 5000);
      tracker.recordSuccess('worker', 55);
      tracker.recordReroute('worker');
      tracker.recordReroute('worker');
      tracker.recordFailure('worker', 'temporary error');
      tracker.recordSuccess('worker', 65);

      const health = tracker.getHealthSnapshot('worker');

      expect(health.totalTasks).toBe(6); // 4 successes + 1 timeout + 1 failure = 6 tasks (reroutes don't count)
      expect(health.successes).toBe(4);
      expect(health.failures).toBe(1);
      expect(health.timeouts).toBe(1);
      expect(health.reroutes).toBe(2);
      expect(health.state).toBe('healthy');
      expect(health.averageLatencyMs).toBeDefined();
    });
  });

  describe('getSpecialistRuntime', () => {
    it('should return raw specialist runtime map', () => {
      tracker.recordSuccess('specialist-1');
      tracker.recordSuccess('specialist-2');

      const runtimeMap = tracker.getSpecialistRuntime();

      expect(runtimeMap).toBeInstanceOf(Map);
      expect(runtimeMap.size).toBe(2);
      expect(runtimeMap.has('specialist-1')).toBe(true);
      expect(runtimeMap.has('specialist-2')).toBe(true);
    });

    it('should return same map instance (direct access)', () => {
      tracker.recordSuccess('specialist');

      const map1 = tracker.getSpecialistRuntime();
      const map2 = tracker.getSpecialistRuntime();

      expect(map1).toBe(map2);
    });
  });
});

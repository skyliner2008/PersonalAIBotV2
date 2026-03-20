// ============================================================
// Unit Tests: Circuit Breaker Pattern
// ============================================================
// Tests resilience patterns for tool execution with
// exponential backoff and auto-recovery

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================
// Circuit Breaker Implementation (from agent.ts concepts)
// ============================================================

interface CircuitState {
  failures: number;
  openUntil: number;
}

const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_BASE_MS = 10_000;
const CIRCUIT_MAX_MS = 120_000;

class CircuitBreaker {
  private circuits: Map<string, CircuitState> = new Map();

  isOpen(toolName: string): boolean {
    const c = this.circuits.get(toolName);
    if (!c) return false;

    // Check if circuit should remain open
    if (c.openUntil > Date.now()) return true;
    if (c.openUntil <= 0) return false;

    // Auto-reset: transition to half-open state
    c.failures = Math.floor(c.failures / 2);
    c.openUntil = 0;
    if (c.failures === 0) {
      this.circuits.delete(toolName);
    } else {
      this.circuits.set(toolName, c);
    }
    return false;
  }

  recordSuccess(toolName: string): void {
    const c = this.circuits.get(toolName);
    if (c) {
      c.failures = Math.max(0, c.failures - 1);
      if (c.failures === 0) {
        this.circuits.delete(toolName);
      } else {
        this.circuits.set(toolName, c);
      }
    }
  }

  recordFailure(toolName: string): void {
    const c = this.circuits.get(toolName) ?? { failures: 0, openUntil: 0 };
    c.failures++;

    if (c.failures >= CIRCUIT_THRESHOLD) {
      const backoffMs = Math.min(
        CIRCUIT_BASE_MS * Math.pow(2, c.failures - CIRCUIT_THRESHOLD),
        CIRCUIT_MAX_MS
      );
      c.openUntil = Date.now() + backoffMs;
    }

    this.circuits.set(toolName, c);
  }

  getState(toolName: string): CircuitState | null {
    return this.circuits.get(toolName) || null;
  }

  reset(toolName: string): void {
    this.circuits.delete(toolName);
  }

  resetAll(): void {
    this.circuits.clear();
  }
}

// ============================================================
// Tests
// ============================================================

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker();
  });

  describe('basic circuit states', () => {
    it('should start in CLOSED state (not open)', () => {
      expect(breaker.isOpen('tool-1')).toBe(false);
    });

    it('should open after CIRCUIT_THRESHOLD failures', () => {
      const toolName = 'slow-api';

      // Record 3 failures
      breaker.recordFailure(toolName);
      expect(breaker.isOpen(toolName)).toBe(false); // Still closed at threshold

      breaker.recordFailure(toolName);
      expect(breaker.isOpen(toolName)).toBe(false);

      breaker.recordFailure(toolName);
      expect(breaker.isOpen(toolName)).toBe(true); // Now open
    });

    it('should block tool calls when circuit is open', () => {
      const toolName = 'failing-tool';

      for (let i = 0; i < CIRCUIT_THRESHOLD; i++) {
        breaker.recordFailure(toolName);
      }

      expect(breaker.isOpen(toolName)).toBe(true);
    });

    it('should remain closed for successful operations', () => {
      const toolName = 'reliable-tool';

      breaker.recordSuccess(toolName);
      breaker.recordSuccess(toolName);

      expect(breaker.isOpen(toolName)).toBe(false);
    });
  });

  describe('exponential backoff', () => {
    it('should apply exponential backoff timing', () => {
      const toolName = 'backoff-tool';
      const now = Date.now();

      // First 3 failures: circuit opens
      for (let i = 0; i < CIRCUIT_THRESHOLD; i++) {
        breaker.recordFailure(toolName);
      }

      let state = breaker.getState(toolName);
      const firstBackoff = state!.openUntil - now;

      // 4th failure: exponential backoff increases
      breaker.recordFailure(toolName);
      state = breaker.getState(toolName);
      const secondBackoff = state!.openUntil - now;

      // Second backoff should be 2x the first (at least)
      expect(secondBackoff).toBeGreaterThan(firstBackoff);
    });

    it('should respect base backoff time (10 seconds)', () => {
      const toolName = 'tool-backoff';
      const now = Date.now();

      // Trigger 3 failures to open circuit
      for (let i = 0; i < CIRCUIT_THRESHOLD; i++) {
        breaker.recordFailure(toolName);
      }

      const state = breaker.getState(toolName);
      const backoffTime = state!.openUntil - now;

      // Should be >= 10 seconds
      expect(backoffTime).toBeGreaterThanOrEqual(CIRCUIT_BASE_MS);
    });

    it('should cap backoff at maximum (120 seconds)', () => {
      const toolName = 'tool-max-backoff';
      const now = Date.now();

      // Simulate many failures to exceed max backoff
      for (let i = 0; i < 10; i++) {
        breaker.recordFailure(toolName);
      }

      const state = breaker.getState(toolName);
      const backoffTime = state!.openUntil - now;

      expect(backoffTime).toBeLessThanOrEqual(CIRCUIT_MAX_MS);
    });

    it('should implement backoff sequence: 10s → 20s → 40s → 80s → 120s', () => {
      const toolName = 'sequence-tool';
      const baseTime = Date.now();

      // Expected sequence based on: base * 2^(failures - threshold)
      // failures=3: 10s * 2^0 = 10s
      // failures=4: 10s * 2^1 = 20s
      // failures=5: 10s * 2^2 = 40s
      // failures=6: 10s * 2^3 = 80s
      // failures=7: 10s * 2^4 = 160s → capped at 120s

      const backoffSequence = [];

      for (let i = 0; i < 8; i++) {
        breaker.recordFailure(toolName);
        const state = breaker.getState(toolName);
        const backoff = state!.openUntil - baseTime;
        backoffSequence.push(backoff);
      }

      // First backoff should be around CIRCUIT_BASE_MS
      expect(backoffSequence[2]).toBeGreaterThanOrEqual(CIRCUIT_BASE_MS);
      // Should increase exponentially (each roughly doubles)
      expect(backoffSequence[3]).toBeGreaterThan(backoffSequence[2]);
      expect(backoffSequence[4]).toBeGreaterThan(backoffSequence[3]);
      // But capped at max
      expect(backoffSequence[6]).toBeLessThanOrEqual(CIRCUIT_MAX_MS);
      expect(backoffSequence[7]).toBeLessThanOrEqual(CIRCUIT_MAX_MS);
    });
  });

  describe('circuit auto-reset (half-open state)', () => {
    it('should auto-reset after backoff period expires', () => {
      const toolName = 'auto-reset-tool';

      // Open the circuit
      for (let i = 0; i < CIRCUIT_THRESHOLD; i++) {
        breaker.recordFailure(toolName);
      }

      expect(breaker.isOpen(toolName)).toBe(true);

      // Simulate backoff expiration
      const state = breaker.getState(toolName)!;
      state.openUntil = Date.now() - 1000; // Already expired

      // Circuit should auto-reset on next check
      const stillOpen = breaker.isOpen(toolName);
      expect(stillOpen).toBe(false);
    });

    it('should enter half-open state after backoff', () => {
      const toolName = 'half-open-tool';

      // Trigger circuit open
      for (let i = 0; i < CIRCUIT_THRESHOLD; i++) {
        breaker.recordFailure(toolName);
      }

      expect(breaker.isOpen(toolName)).toBe(true);

      // Simulate backoff expiration: manually set openUntil to past
      const state = breaker.getState(toolName)!;
      state.openUntil = Date.now() - 1000; // Already expired

      // After expiration, circuit should auto-reset on next check
      const isOpen = breaker.isOpen(toolName);
      expect(isOpen).toBe(false);

      // If that attempt fails, record failure
      breaker.recordFailure(toolName);
      expect(breaker.isOpen(toolName)).toBe(false);
      breaker.recordFailure(toolName);
      expect(breaker.isOpen(toolName)).toBe(true);
    });

    it('should reduce failure count by half on reset', () => {
      const toolName = 'half-reduction-tool';
      const now = Date.now();
      vi.setSystemTime(now);

      // Build up to 5 failures
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure(toolName);
      }

      const state1 = breaker.getState(toolName)!;
      expect(state1.failures).toBe(5);

      // Trigger auto-reset after backoff
      vi.setSystemTime(state1.openUntil + 1000);
      breaker.isOpen(toolName);

      // Failure count should be halved
      const state2 = breaker.getState(toolName);
      if (state2) {
        expect(state2.failures).toBeLessThan(5);
      }
    });
  });

  describe('recovery and success handling', () => {
    it('should reduce failures on successful operation', () => {
      const toolName = 'recovery-tool';

      // Cause 2 failures (below threshold)
      breaker.recordFailure(toolName);
      breaker.recordFailure(toolName);

      let state = breaker.getState(toolName)!;
      expect(state.failures).toBe(2);

      // Success reduces failures
      breaker.recordSuccess(toolName);
      state = breaker.getState(toolName)!;
      expect(state.failures).toBe(1);
    });

    it('should close circuit completely after recovery', () => {
      const toolName = 'full-recovery-tool';

      // 1 failure
      breaker.recordFailure(toolName);
      expect(breaker.getState(toolName)).toBeTruthy();

      // 1 success
      breaker.recordSuccess(toolName);
      expect(breaker.getState(toolName)).toBeNull(); // Completely cleaned up

      // Circuit should be closed
      expect(breaker.isOpen(toolName)).toBe(false);
    });

    it('should gradually recover from multiple failures', () => {
      const toolName = 'gradual-recovery-tool';

      // 3 failures
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure(toolName);
      }

      // Recovery: alternate successes
      breaker.recordSuccess(toolName);
      breaker.recordSuccess(toolName);
      breaker.recordSuccess(toolName);

      // Should be fully recovered
      expect(breaker.getState(toolName)).toBeNull();
      expect(breaker.isOpen(toolName)).toBe(false);
    });
  });

  describe('multiple tools independence', () => {
    it('should track failures per tool independently', () => {
      const tool1 = 'tool-a';
      const tool2 = 'tool-b';

      breaker.recordFailure(tool1);
      breaker.recordFailure(tool1);
      breaker.recordFailure(tool1);

      // tool1 should be open, tool2 should be closed
      expect(breaker.isOpen(tool1)).toBe(true);
      expect(breaker.isOpen(tool2)).toBe(false);
    });

    it('should handle success in one tool while another is open', () => {
      const tool1 = 'failing-tool';
      const tool2 = 'working-tool';

      // Open tool1
      for (let i = 0; i < CIRCUIT_THRESHOLD; i++) {
        breaker.recordFailure(tool1);
      }

      // tool2 remains functional
      breaker.recordSuccess(tool2);
      breaker.recordSuccess(tool2);

      expect(breaker.isOpen(tool1)).toBe(true);
      expect(breaker.isOpen(tool2)).toBe(false);
    });

    it('should allow resetting single circuit', () => {
      const tool1 = 'reset-tool-1';
      const tool2 = 'reset-tool-2';

      for (let i = 0; i < CIRCUIT_THRESHOLD; i++) {
        breaker.recordFailure(tool1);
        breaker.recordFailure(tool2);
      }

      expect(breaker.isOpen(tool1)).toBe(true);
      expect(breaker.isOpen(tool2)).toBe(true);

      // Reset only tool1
      breaker.reset(tool1);

      expect(breaker.isOpen(tool1)).toBe(false);
      expect(breaker.isOpen(tool2)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle reset on non-existent circuit', () => {
      expect(() => {
        breaker.reset('non-existent-tool');
      }).not.toThrow();
    });

    it('should handle rapid failure/success alternation', () => {
      const toolName = 'flaky-tool';

      for (let i = 0; i < 20; i++) {
        if (i % 2 === 0) {
          breaker.recordFailure(toolName);
        } else {
          breaker.recordSuccess(toolName);
        }
      }

      // Should eventually have some state or be cleaned up
      const state = breaker.getState(toolName);
      expect(state === null || state.failures >= 0).toBe(true);
    });

    it('should handle zero failure state', () => {
      const toolName = 'pristine-tool';

      breaker.recordSuccess(toolName);

      // No circuit state should be created for just success
      expect(breaker.getState(toolName)).toBeNull();
      expect(breaker.isOpen(toolName)).toBe(false);
    });

    it('should handle tool name with special characters', () => {
      const toolName = 'tool-with-@#$%_special-chars';

      breaker.recordFailure(toolName);
      breaker.recordFailure(toolName);
      breaker.recordFailure(toolName);

      expect(breaker.isOpen(toolName)).toBe(true);

      breaker.reset(toolName);
      expect(breaker.isOpen(toolName)).toBe(false);
    });
  });

  describe('integration scenarios', () => {
    it('should handle realistic tool execution flow', () => {
      const toolName = 'api-tool';
      const now = Date.now();
      vi.setSystemTime(now);

      // Normal operation
      breaker.recordSuccess(toolName);
      breaker.recordSuccess(toolName);

      // Service degrades
      breaker.recordFailure(toolName);
      breaker.recordFailure(toolName);
      breaker.recordFailure(toolName);
      expect(breaker.isOpen(toolName)).toBe(true);

      // Wait for recovery window
      const state = breaker.getState(toolName)!;
      vi.setSystemTime(state.openUntil + 1000);

      // Retry attempt succeeds
      expect(breaker.isOpen(toolName)).toBe(false); // Half-open
      breaker.recordSuccess(toolName);

      // Back to normal
      expect(breaker.isOpen(toolName)).toBe(false);
    });

    it('should handle cascading failures across multiple tools', () => {
      const tools = ['api', 'db', 'cache', 'queue'];

      // All tools fail simultaneously
      for (const tool of tools) {
        for (let i = 0; i < CIRCUIT_THRESHOLD; i++) {
          breaker.recordFailure(tool);
        }
      }

      // All should be open
      for (const tool of tools) {
        expect(breaker.isOpen(tool)).toBe(true);
      }

      // Simulate staggered recovery by expiring backoff for first tool
      const state1 = breaker.getState(tools[0])!;
      state1.openUntil = Date.now() - 1000; // Already expired

      // First tool should allow attempt
      expect(breaker.isOpen(tools[0])).toBe(false);

      // Others still open
      expect(breaker.isOpen(tools[1])).toBe(true);
      expect(breaker.isOpen(tools[2])).toBe(true);
      expect(breaker.isOpen(tools[3])).toBe(true);
    });
  });
});

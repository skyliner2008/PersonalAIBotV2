/**
 * Swarm State Store
 * Manages all Maps and state related to batches, task-to-batch mappings, and specialist metrics
 */

import type { SwarmBatch, SpecialistRuntimeHealth, CliDispatchMode, BatchListener } from './swarmTypes.js';

export class SwarmStateStore {
  private batches: Map<string, SwarmBatch> = new Map();
  private taskToBatch: Map<string, string> = new Map();
  private batchUpdateListeners: BatchListener[] = [];
  private batchCompleteListeners: BatchListener[] = [];
  private specialistRuntime: Map<string, SpecialistRuntimeHealth> = new Map();
  private cliPreferredDispatchMode: Map<string, CliDispatchMode> = new Map();
  private supervisorLoopRunning: Set<string> = new Set();
  private lastSupervisorScanAt: Map<string, number> = new Map();

  /**
   * Get all batches
   */
  getBatches(): Map<string, SwarmBatch> {
    return this.batches;
  }

  /**
   * Get a single batch by ID
   */
  getBatch(batchId: string): SwarmBatch | null {
    return this.batches.get(batchId) || null;
  }

  /**
   * Store a batch
   */
  setBatch(batchId: string, batch: SwarmBatch): void {
    this.batches.set(batchId, batch);
  }

  /**
   * Get task-to-batch mapping
   */
  getTaskToBatch(): Map<string, string> {
    return this.taskToBatch;
  }

  /**
   * Get batch ID for a task
   */
  getBatchIdForTask(taskId: string): string | null {
    return this.taskToBatch.get(taskId) || null;
  }

  /**
   * Link a task to a batch
   */
  linkTaskToBatch(taskId: string, batchId: string): void {
    this.taskToBatch.set(taskId, batchId);
  }

  /**
   * Unlink a task from a batch
   */
  unlinkTaskFromBatch(taskId: string): void {
    this.taskToBatch.delete(taskId);
  }

  /**
   * Get specialist runtime health
   */
  getSpecialistRuntime(): Map<string, SpecialistRuntimeHealth> {
    return this.specialistRuntime;
  }

  /**
   * Get health for a specialist, creating if not exists
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
   * Get CLI preferred dispatch mode
   */
  getCliPreferredDispatchMode(): Map<string, CliDispatchMode> {
    return this.cliPreferredDispatchMode;
  }

  /**
   * Get supervisor loop running set
   */
  getSupervisorLoopRunning(): Set<string> {
    return this.supervisorLoopRunning;
  }

  /**
   * Get last supervisor scan timestamps
   */
  getLastSupervisorScanAt(): Map<string, number> {
    return this.lastSupervisorScanAt;
  }

  /**
   * Get batch update listeners
   */
  getBatchUpdateListeners(): BatchListener[] {
    return this.batchUpdateListeners;
  }

  /**
   * Add a batch update listener
   */
  addBatchUpdateListener(listener: BatchListener): void {
    this.batchUpdateListeners.push(listener);
  }

  /**
   * Remove a batch update listener
   */
  removeBatchUpdateListener(listener: BatchListener): void {
    this.batchUpdateListeners = this.batchUpdateListeners.filter((l) => l !== listener);
  }

  /**
   * Get batch complete listeners
   */
  getBatchCompleteListeners(): BatchListener[] {
    return this.batchCompleteListeners;
  }

  /**
   * Add a batch complete listener
   */
  addBatchCompleteListener(listener: BatchListener): void {
    this.batchCompleteListeners.push(listener);
  }

  /**
   * Remove a batch complete listener
   */
  removeBatchCompleteListener(listener: BatchListener): void {
    this.batchCompleteListeners = this.batchCompleteListeners.filter((l) => l !== listener);
  }

  /**
   * Clear all state (for shutdown)
   */
  clear(): void {
    this.batches.clear();
    this.taskToBatch.clear();
    this.specialistRuntime.clear();
    this.cliPreferredDispatchMode.clear();
    this.supervisorLoopRunning.clear();
    this.lastSupervisorScanAt.clear();
    this.batchUpdateListeners = [];
    this.batchCompleteListeners = [];
  }
}

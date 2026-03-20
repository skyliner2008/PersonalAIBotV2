import { describe, it, expect, beforeEach } from 'vitest';
import { SwarmStateStore } from '../../swarm/swarmStateStore.js';
import type { SwarmBatch, SpecialistRuntimeHealth } from '../../swarm/swarmTypes.js';

function createMockBatch(overrides: Partial<SwarmBatch> = {}): SwarmBatch {
  return {
    id: 'batch_test_001',
    objective: 'Test objective',
    taskIds: [],
    assignments: [],
    status: 'queued',
    progress: { total: 0, queued: 0, processing: 0, completed: 0, failed: 0 },
    createdBy: 'test-user',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('SwarmStateStore', () => {
  let store: SwarmStateStore;

  beforeEach(() => {
    store = new SwarmStateStore();
  });

  // ── Batch CRUD ──

  it('returns null for unknown batch', () => {
    expect(store.getBatch('nonexistent')).toBeNull();
  });

  it('stores and retrieves a batch', () => {
    const batch = createMockBatch({ id: 'b1' });
    store.setBatch('b1', batch);
    expect(store.getBatch('b1')).toBe(batch);
  });

  it('getAllBatches returns all stored batches', () => {
    store.setBatch('a', createMockBatch({ id: 'a' }));
    store.setBatch('b', createMockBatch({ id: 'b' }));
    expect(store.getBatches().size).toBe(2);
  });

  // ── Task-to-Batch mapping ──

  it('links and retrieves task-to-batch', () => {
    store.linkTaskToBatch('task_1', 'batch_1');
    expect(store.getBatchIdForTask('task_1')).toBe('batch_1');
  });

  it('returns null for unmapped task', () => {
    expect(store.getBatchIdForTask('unknown_task')).toBeNull();
  });

  it('unlinks task from batch', () => {
    store.linkTaskToBatch('task_1', 'batch_1');
    store.unlinkTaskFromBatch('task_1');
    expect(store.getBatchIdForTask('task_1')).toBeNull();
  });

  // ── Specialist Runtime Health ──

  it('creates default health for new specialist', () => {
    const health = store.getOrCreateRuntimeHealth('gemini-cli-agent');
    expect(health.specialist).toBe('gemini-cli-agent');
    expect(health.state).toBe('idle');
    expect(health.totalTasks).toBe(0);
    expect(health.successes).toBe(0);
    expect(health.failures).toBe(0);
    expect(health.consecutiveFailures).toBe(0);
  });

  it('returns same health object on second call', () => {
    const h1 = store.getOrCreateRuntimeHealth('claude-cli-agent');
    h1.totalTasks = 5;
    const h2 = store.getOrCreateRuntimeHealth('claude-cli-agent');
    expect(h2.totalTasks).toBe(5);
    expect(h1).toBe(h2);
  });

  // ── Listeners ──

  it('adds and removes batch update listeners', () => {
    const listener = (_b: SwarmBatch) => {};
    store.addBatchUpdateListener(listener);
    expect(store.getBatchUpdateListeners()).toHaveLength(1);
    store.removeBatchUpdateListener(listener);
    expect(store.getBatchUpdateListeners()).toHaveLength(0);
  });

  it('adds and removes batch complete listeners', () => {
    const listener = (_b: SwarmBatch) => {};
    store.addBatchCompleteListener(listener);
    expect(store.getBatchCompleteListeners()).toHaveLength(1);
    store.removeBatchCompleteListener(listener);
    expect(store.getBatchCompleteListeners()).toHaveLength(0);
  });

  // ── Clear ──

  it('clear() resets all state', () => {
    store.setBatch('b1', createMockBatch());
    store.linkTaskToBatch('t1', 'b1');
    store.getOrCreateRuntimeHealth('gemini');
    store.addBatchUpdateListener(() => {});

    store.clear();

    expect(store.getBatches().size).toBe(0);
    expect(store.getTaskToBatch().size).toBe(0);
    expect(store.getSpecialistRuntime().size).toBe(0);
    expect(store.getBatchUpdateListeners()).toHaveLength(0);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { SwarmBatchManager } from '../../swarm/swarmBatchManager.js';
import type { SwarmBatch, SwarmBatchAssignment } from '../../swarm/swarmTypes.js';

function createAssignment(overrides: Partial<SwarmBatchAssignment> = {}): SwarmBatchAssignment {
  return {
    index: 0,
    taskId: 'task_001',
    specialist: 'gemini-cli-agent',
    title: 'Test Task',
    status: 'queued',
    taskType: 'general',
    ...overrides,
  };
}

function createBatch(assignments: SwarmBatchAssignment[] = [], overrides: Partial<SwarmBatch> = {}): SwarmBatch {
  return {
    id: 'batch_test_001',
    objective: 'Analyze market trends',
    taskIds: assignments.map(a => a.taskId),
    assignments,
    status: 'queued',
    progress: { total: assignments.length, queued: assignments.length, processing: 0, completed: 0, failed: 0 },
    createdBy: 'test-user',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('SwarmBatchManager', () => {
  let manager: SwarmBatchManager;

  beforeEach(() => {
    manager = new SwarmBatchManager();
  });

  // ── Batch ID generation ──

  it('generateBatchId: returns unique IDs', () => {
    const id1 = manager.generateBatchId();
    const id2 = manager.generateBatchId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^batch_\d+_[a-z0-9]+$/);
  });

  it('generateBatchId: starts with "batch_"', () => {
    expect(manager.generateBatchId().startsWith('batch_')).toBe(true);
  });

  // ── Progress computation ──

  it('recomputeBatchProgress: all queued', () => {
    const batch = createBatch([
      createAssignment({ taskId: 't1', status: 'queued' }),
      createAssignment({ taskId: 't2', status: 'queued' }),
    ]);
    manager.recomputeBatchProgress(batch);
    expect(batch.progress).toEqual({ total: 2, queued: 2, processing: 0, completed: 0, failed: 0 });
    expect(batch.status).toBe('queued');
  });

  it('recomputeBatchProgress: mixed statuses → running', () => {
    const batch = createBatch([
      createAssignment({ taskId: 't1', status: 'completed' }),
      createAssignment({ taskId: 't2', status: 'processing' }),
      createAssignment({ taskId: 't3', status: 'queued' }),
    ]);
    manager.recomputeBatchProgress(batch);
    expect(batch.progress).toEqual({ total: 3, queued: 1, processing: 1, completed: 1, failed: 0 });
    expect(batch.status).toBe('running');
  });

  it('recomputeBatchProgress: all completed does not override to running', () => {
    const batch = createBatch([
      createAssignment({ taskId: 't1', status: 'completed' }),
      createAssignment({ taskId: 't2', status: 'completed' }),
    ]);
    batch.status = 'completed'; // pre-set
    manager.recomputeBatchProgress(batch);
    // The method returns early when completed + failed == total
    expect(batch.progress.completed).toBe(2);
  });

  // ── Summary building ──

  it('buildBatchSummary: includes completed results', () => {
    const batch = createBatch([
      createAssignment({ taskId: 't1', status: 'completed', result: 'Market is bullish.', title: 'Analysis', specialist: 'gemini-cli-agent' }),
    ]);
    const summary = manager.buildBatchSummary(batch, (s) => s);
    expect(summary).toContain('[Analysis]');
    expect(summary).toContain('gemini-cli-agent');
    expect(summary).toContain('Market is bullish.');
  });

  it('buildBatchSummary: includes failed errors', () => {
    const batch = createBatch([
      createAssignment({ taskId: 't1', status: 'failed', error: 'Timeout after 120s', title: 'Research', specialist: 'codex-cli-agent' }),
    ]);
    const summary = manager.buildBatchSummary(batch, (s) => s);
    expect(summary).toContain('FAILED');
    expect(summary).toContain('Timeout after 120s');
  });

  it('buildBatchSummary: detects duplicate outputs', () => {
    const sameOutput = 'This is the exact same output repeated for both agents in the batch';
    const batch = createBatch([
      createAssignment({ taskId: 't1', status: 'completed', result: sameOutput, title: 'Task A', specialist: 'gemini-cli-agent' }),
      createAssignment({ taskId: 't2', status: 'completed', result: sameOutput, title: 'Task B', specialist: 'codex-cli-agent' }),
    ]);
    const summary = manager.buildBatchSummary(batch, (s) => s);
    expect(summary).toContain('WARNING');
    expect(summary).toContain('Duplicate output');
  });

  it('buildBatchSummary: truncates to 12000 chars', () => {
    const longResult = 'x'.repeat(15000);
    const batch = createBatch([
      createAssignment({ taskId: 't1', status: 'completed', result: longResult, title: 'Big', specialist: 'gemini-cli-agent' }),
    ]);
    const summary = manager.buildBatchSummary(batch, (s) => s);
    expect(summary.length).toBeLessThanOrEqual(12000);
  });

  // ── Clone ──

  it('cloneBatch: returns deep copy', () => {
    const original = createBatch([
      createAssignment({ taskId: 't1', status: 'completed' }),
    ]);
    const cloned = manager.cloneBatch(original);

    expect(cloned.id).toBe(original.id);
    expect(cloned).not.toBe(original);
    expect(cloned.assignments).not.toBe(original.assignments);
    expect(cloned.taskIds).not.toBe(original.taskIds);
    expect(cloned.progress).not.toBe(original.progress);

    // Modifying clone doesn't affect original
    cloned.assignments[0].status = 'failed';
    expect(original.assignments[0].status).toBe('completed');
  });

  // ── Lane highlights ──

  it('extractLaneHighlights: returns first few lines', () => {
    const output = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6';
    const highlights = manager.extractLaneHighlights(output, (s) => s, 3);
    expect(highlights).toContain('Line 1');
    expect(highlights).toContain('Line 3');
    expect(highlights).not.toContain('Line 5');
  });

  it('extractLaneHighlights: returns "(no output)" for empty', () => {
    expect(manager.extractLaneHighlights('', (s) => s)).toBe('(no output)');
  });

  // ── Local synthesis ──

  it('buildLocalSynthesisForBatch: includes objective and coverage', () => {
    const batch = createBatch([
      createAssignment({ taskId: 't1', status: 'completed', result: 'Good analysis of the market with supporting evidence and confidence metrics.'.repeat(5), title: 'Research', specialist: 'gemini-cli-agent' }),
      createAssignment({ taskId: 't2', status: 'failed', error: 'Timeout', title: 'Review', specialist: 'codex-cli-agent' }),
    ], { objective: 'Analyze Q1 results' });

    const synthesis = manager.buildLocalSynthesisForBatch(
      batch,
      (s) => s,
      (s) => s.slice(0, 100),
    );

    expect(synthesis).toContain('Analyze Q1 results');
    expect(synthesis).toContain('completed=1');
    expect(synthesis).toContain('failed=1');
    expect(synthesis).toContain('Jarvis Local Synthesis');
  });
});

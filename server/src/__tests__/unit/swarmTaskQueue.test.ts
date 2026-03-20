import { describe, expect, it } from 'vitest';
import TaskQueue from '../../swarm/taskQueue.js';

function createTaskPayload(overrides: Partial<Parameters<TaskQueue['enqueue']>[0]> = {}) {
  return {
    fromPlatform: 'custom',
    fromChatId: 'chat_test',
    toPlatform: 'swarm',
    taskType: 'general' as const,
    payload: { message: 'test-task' },
    priority: 3,
    timeout: 120000,
    ...overrides,
  };
}

describe('TaskQueue cancel', () => {
  it('cancels a queued task', async () => {
    const queue = new TaskQueue();
    const taskId = await queue.enqueue(createTaskPayload());

    const result = await queue.cancel(taskId, 'manual cancel');
    const task = await queue.getStatus(taskId);

    expect(result.success).toBe(true);
    expect(task?.status).toBe('failed');
    expect(task?.error).toContain('Cancelled: manual cancel');
  });

  it('does not cancel tasks that already started processing', async () => {
    const queue = new TaskQueue();
    const taskId = await queue.enqueue(createTaskPayload());
    await queue.startProcessing(taskId);

    const result = await queue.cancel(taskId);

    expect(result.success).toBe(false);
    expect(result.error).toContain('status: processing');
  });

  it('aborts a processing task and ignores late completion writes', async () => {
    const queue = new TaskQueue();
    const taskId = await queue.enqueue(createTaskPayload());
    await queue.startProcessing(taskId);

    const aborted = await queue.abortProcessing(taskId, 'handover to another specialist');
    await queue.complete(taskId, 'late result that should be ignored');
    const task = await queue.getStatus(taskId);

    expect(aborted).toBe(true);
    expect(task?.status).toBe('failed');
    expect(task?.error).toContain('Aborted: handover to another specialist');
    expect(task?.result).toBeUndefined();
  });

  it('cascade-fails dependent queued tasks when parent is cancelled', async () => {
    const queue = new TaskQueue();
    const parentId = await queue.enqueue(createTaskPayload({ payload: { message: 'parent-task' } }));
    const childId = await queue.enqueue(createTaskPayload({
      payload: { message: 'child-task' },
      dependsOn: [parentId],
    }));

    const result = await queue.cancel(parentId, 'parent aborted');
    const child = await queue.getStatus(childId);

    expect(result.success).toBe(true);
    expect(child?.status).toBe('failed');
    expect(child?.error).toContain(`Dependency ${parentId} cancelled`);
  });

  it('moves a retried task back to queued and notifies queued listeners', async () => {
    const queue = new TaskQueue();
    const queuedEvents: string[] = [];
    queue.onAnyQueued((task) => {
      queuedEvents.push(task.status);
    });

    const taskId = await queue.enqueue(createTaskPayload({ maxRetries: 1 }));
    await queue.startProcessing(taskId);

    const willRetry = await queue.fail(taskId, 'temporary failure');
    const task = await queue.getStatus(taskId);

    expect(willRetry).toBe(true);
    expect(task?.status).toBe('queued');
    expect(task?.error).toContain('temporary failure');
    expect(queuedEvents).toEqual(['queued', 'queued']);
  });

  it('allows quorum-based dependent tasks to continue after one dependency fails', async () => {
    const queue = new TaskQueue();
    const aId = await queue.enqueue(createTaskPayload({ payload: { message: 'lane-a' } }));
    const bId = await queue.enqueue(createTaskPayload({ payload: { message: 'lane-b' } }));
    const synthesisId = await queue.enqueue(createTaskPayload({
      payload: { message: 'final synthesis' },
      dependsOn: [aId, bId],
      dependencyMode: 'minimum_completed',
      minCompletedDependencies: 1,
    }));

    await queue.startProcessing(aId);
    await queue.complete(aId, 'lane-a done');
    await queue.startProcessing(bId);
    await queue.fail(bId, 'lane-b timeout');

    const synthesis = await queue.getStatus(synthesisId);
    const pending = await queue.listPending();

    expect(synthesis?.status).toBe('queued');
    expect(pending.map((task) => task.id)).toContain(synthesisId);
  });

  it('starts quorum-based dependent tasks as soon as minimum completions are met', async () => {
    const queue = new TaskQueue();
    const aId = await queue.enqueue(createTaskPayload({ payload: { message: 'lane-a' } }));
    const bId = await queue.enqueue(createTaskPayload({ payload: { message: 'lane-b' } }));
    const synthesisId = await queue.enqueue(createTaskPayload({
      payload: { message: 'final synthesis' },
      dependsOn: [aId, bId],
      dependencyMode: 'minimum_completed',
      minCompletedDependencies: 1,
    }));

    await queue.startProcessing(aId);
    await queue.complete(aId, 'lane-a done');
    await queue.startProcessing(bId);

    const pending = await queue.listPending();

    expect(pending.map((task) => task.id)).toContain(synthesisId);
  });

  it('fails quorum-based dependent tasks when minimum completion is impossible', async () => {
    const queue = new TaskQueue();
    const aId = await queue.enqueue(createTaskPayload({ payload: { message: 'lane-a' } }));
    const bId = await queue.enqueue(createTaskPayload({ payload: { message: 'lane-b' } }));
    const synthesisId = await queue.enqueue(createTaskPayload({
      payload: { message: 'final synthesis' },
      dependsOn: [aId, bId],
      dependencyMode: 'minimum_completed',
      minCompletedDependencies: 2,
    }));

    await queue.startProcessing(aId);
    await queue.fail(aId, 'lane-a failed');

    const synthesis = await queue.getStatus(synthesisId);

    expect(synthesis?.status).toBe('failed');
    expect(synthesis?.error).toContain(`Dependency ${aId} failed`);
  });

  it('can requeue completed tasks without leaving stale completed stats behind', async () => {
    const queue = new TaskQueue();
    const taskId = await queue.enqueue(createTaskPayload());

    await queue.startProcessing(taskId);
    await queue.complete(taskId, 'done once');
    const requeued = await queue.requeue(taskId, {
      payload: { message: 'do it again' },
    }, 'jarvis requested revision');

    const task = await queue.getStatus(taskId);
    const stats = queue.getStats();

    expect(requeued).toBe(true);
    expect(task?.status).toBe('queued');
    expect(task?.result).toBeUndefined();
    expect(stats.completed).toBe(0);
  });
});

/**
 * Swarm Task Queue — Internal communication system for multi-agent delegation
 * Enables bots to delegate subtasks to specialist agents across platforms
 */

/**
 * Task status indicates where the task is in its lifecycle
 */
import { createLogger } from '../utils/logger';

const logger = createLogger('SwarmQueue');

export type TaskStatus = 'queued' | 'processing' | 'completed' | 'failed';

/**
 * Task type indicates what kind of work needs to be done
 */
export type TaskType =
  | 'vision_analysis'
  | 'code_review'
  | 'code_generation'
  | 'translation'
  | 'web_search'
  | 'data_analysis'
  | 'summarization'
  | 'general';

export type DependencyMode = 'all_success' | 'all_settled' | 'minimum_completed';

/**
 * Task callback for notification when task completes/fails
 */
export type TaskCallback = (task: SwarmTask) => void | Promise<void>;

/**
 * Internal task structure for cross-platform communication
 */
export interface SwarmTask {
  /** Unique task ID — usually UUID or timestamp-based */
  id: string;

  /** Originating platform: 'telegram' | 'line' | 'facebook' | 'discord' | 'custom' */
  fromPlatform: string;

  /** Originating chat/conversation ID */
  fromChatId: string;

  /** Target platform or 'swarm' for specialist routing */
  toPlatform: string;

  /** Optional specialist name (e.g., 'vision', 'coder', 'researcher') */
  toSpecialist?: string;

  /** Task classification */
  taskType: TaskType;

  /** Task payload */
  payload: {
    message: string;
    attachments?: Array<{ type: string; data: string; mimeType?: string }>;
    context?: string;
  };

  /** Current task status */
  status: TaskStatus;

  /** Result after task completion */
  result?: string;

  /** Error message if task failed */
  error?: string;

  /** Creation timestamp */
  createdAt: Date;

  /** Completion timestamp */
  completedAt?: Date;

  /** Processing start timestamp */
  startedAt?: Date;

  /** Priority level: 1=low, 3=normal, 5=high */
  priority: number;

  /** Task timeout in milliseconds (default 120000) */
  timeout: number;

  /** Optional metadata for debugging */
  metadata?: Record<string, unknown>;

  // ── Dependency & Retry Fields ──────────────────────
  /** Task IDs that must complete before this task can run */
  dependsOn?: string[];

  /** How dependency resolution should work */
  dependencyMode?: DependencyMode;

  /** Minimum completed dependencies required when dependencyMode=minimum_completed */
  minCompletedDependencies?: number;

  /** Number of retries attempted so far */
  retryCount?: number;

  /** Maximum number of retries allowed (default 0 = no retry) */
  maxRetries?: number;

  /** Delay multiplier for exponential backoff (ms), default 5000 */
  retryBackoffMs?: number;

  /** Timestamp when a queued retry should become eligible */
  retryAfter?: number;

  /** Parent task ID (for sub-task relationships) */
  parentTaskId?: string;
}

/**
 * Task queue statistics
 */
export interface TaskQueueStats {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  total: number;
  avgProcessingTimeMs?: number;
}

const SWARM_VERBOSE_LOGS = process.env.SWARM_VERBOSE_LOGS === '1';

function queueInfo(...args: unknown[]): void {
  if (SWARM_VERBOSE_LOGS) {
    console.log(...args);
  }
}

/**
 * In-memory task queue with optional SQLite persistence
 */
export class TaskQueue {
  private tasks: Map<string, SwarmTask> = new Map();
  private processingTasks: Set<string> = new Set();
  private taskIdCounter = 0;

  // Tracking for stats
  private completedTasks: SwarmTask[] = [];
  private failedTasks: SwarmTask[] = [];

  // Callbacks for task lifecycle events
  private callbacks: Map<string, TaskCallback[]> = new Map();
  private globalCallbacks: {
    onQueued: TaskCallback[];
    onStarted: TaskCallback[];
    onComplete: TaskCallback[];
    onFail: TaskCallback[];
  } = {
    onQueued: [],
    onStarted: [],
    onComplete: [],
    onFail: [],
  };

  // Cleanup interval
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly CLEANUP_INTERVAL_MS = 3600000; // 1 hour
  private readonly ARCHIVAL_AGE_MS = 86400000; // 24 hours

  constructor() {
    queueInfo('[TaskQueue] Initialized (in-memory)');
  }

  /**
   * Register a callback for when a specific task completes or fails
   */
  onTaskDone(taskId: string, callback: TaskCallback): void {
    const existing = this.callbacks.get(taskId) || [];
    existing.push(callback);
    this.callbacks.set(taskId, existing);
  }

  /**
   * Register global callbacks for all task completions/failures
   */
  onAnyComplete(callback: TaskCallback): void {
    this.globalCallbacks.onComplete.push(callback);
  }

  onAnyFail(callback: TaskCallback): void {
    this.globalCallbacks.onFail.push(callback);
  }

  onAnyQueued(callback: TaskCallback): void {
    this.globalCallbacks.onQueued.push(callback);
  }

  onAnyStarted(callback: TaskCallback): void {
    this.globalCallbacks.onStarted.push(callback);
  }

  /**
   * Fire callbacks for a task (both specific and global)
   */
  private async fireCallbacks(task: SwarmTask): Promise<void> {
    const taskCallbacks = this.callbacks.get(task.id) || [];
    const globalCbs = task.status === 'completed'
      ? this.globalCallbacks.onComplete
      : task.status === 'failed'
        ? this.globalCallbacks.onFail
        : [];

    for (const cb of [...taskCallbacks, ...globalCbs]) {
      try { await cb(task); } catch (err) {
        console.error(`[TaskQueue] Callback error for task ${task.id}:`, err);
      }
    }
    this.callbacks.delete(task.id);
  }

  /**
   * Fire non-terminal global callbacks for queue/processing lifecycle events
   */
  private async fireGlobalCallbacks(
    event: 'onQueued' | 'onStarted',
    task: SwarmTask,
  ): Promise<void> {
    const callbacks = this.globalCallbacks[event];
    for (const cb of callbacks) {
      try { await cb(task); } catch (err) {
        console.error(`[TaskQueue] Global callback error (${event}) for task ${task.id}:`, err);
      }
    }
  }

  private getDependencyTasks(task: SwarmTask): SwarmTask[] {
    if (!task.dependsOn || task.dependsOn.length === 0) return [];
    return task.dependsOn
      .map((depId) => this.tasks.get(depId))
      .filter((dep): dep is SwarmTask => Boolean(dep));
  }

  private getMinimumCompletedDependencies(task: SwarmTask, totalDeps: number): number {
    if ((task.dependencyMode || 'all_success') !== 'minimum_completed') {
      return totalDeps;
    }
    const configured = Number(task.minCompletedDependencies || 0);
    if (!Number.isFinite(configured) || configured <= 0) {
      return Math.min(totalDeps, 1);
    }
    return Math.min(totalDeps, Math.max(1, Math.floor(configured)));
  }

  /**
   * Check if all dependencies for a task are met (completed)
   */
  areDependenciesMet(task: SwarmTask): boolean {
    if (!task.dependsOn || task.dependsOn.length === 0) return true;
    const dependencies = this.getDependencyTasks(task);
    const mode = task.dependencyMode || 'all_success';
    const completed = dependencies.filter((dep) => dep.status === 'completed').length;
    const unsettled = dependencies.filter((dep) => dep.status === 'queued' || dep.status === 'processing').length;

    if (mode === 'all_settled') {
      return unsettled === 0;
    }

    if (mode === 'minimum_completed') {
      const minCompleted = this.getMinimumCompletedDependencies(task, dependencies.length);
      return completed >= minCompleted;
    }

    return dependencies.length === task.dependsOn.length
      && dependencies.every((dep) => dep.status === 'completed');
  }

  /**
   * Check if any dependency has failed (task should fail too)
   */
  hasDependencyFailed(task: SwarmTask): boolean {
    if (!task.dependsOn || task.dependsOn.length === 0) return false;
    const dependencies = this.getDependencyTasks(task);
    const mode = task.dependencyMode || 'all_success';
    const failed = dependencies.filter((dep) => dep.status === 'failed').length;

    if (mode === 'all_settled') return false;

    if (mode === 'minimum_completed') {
      const completed = dependencies.filter((dep) => dep.status === 'completed').length;
      const unsettled = dependencies.filter((dep) => dep.status === 'queued' || dep.status === 'processing').length;
      const minCompleted = this.getMinimumCompletedDependencies(task, dependencies.length);
      const maxPossibleCompleted = completed + unsettled;
      return maxPossibleCompleted < minCompleted || (failed > 0 && unsettled === 0 && completed < minCompleted);
    }

    return failed > 0;
  }

  /**
   * Check if a task is eligible to run (retry cooldown passed)
   */
  isEligibleForProcessing(task: SwarmTask): boolean {
    if (task.retryAfter && Date.now() < task.retryAfter) return false;
    return true;
  }

  /**
   * Add a new task to the queue
   */
  async enqueue(taskData: Omit<SwarmTask, 'id' | 'status' | 'createdAt'>): Promise<string> {
    const task: SwarmTask = {
      ...taskData,
      id: this.generateTaskId(),
      status: 'queued',
      createdAt: new Date(),
      priority: taskData.priority || 3,
      timeout: taskData.timeout || 120000,
    };

    this.tasks.set(task.id, task);
    queueInfo(`[TaskQueue] Enqueued task: ${task.id} (${task.taskType}) from ${task.fromPlatform}`);
    await this.fireGlobalCallbacks('onQueued', task);

    return task.id;
  }

  /**
   * Get the next task for a specialist/platform (FIFO with priority)
   */
  async dequeue(platform: string, specialist?: string): Promise<SwarmTask | null> {
    const queuedTasks = Array.from(this.tasks.values())
      .filter(t =>
        t.status === 'queued' &&
        t.toPlatform === platform &&
        (!specialist || t.toSpecialist === specialist)
      )
      .sort((a, b) => {
        // Sort by priority (descending) then by creation time (ascending)
        if (a.priority !== b.priority) return b.priority - a.priority;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

    if (queuedTasks.length === 0) return null;

    const task = queuedTasks[0];
    await this.startProcessing(task.id);

    queueInfo(`[TaskQueue] Dequeued task: ${task.id} to ${platform}${specialist ? `/${specialist}` : ''}`);

    return task;
  }

  /**
   * Mark a queued task as processing.
   */
  async startProcessing(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) {
      console.warn(`[TaskQueue] Task not found: ${taskId}`);
      return false;
    }

    if (task.status === 'processing') return true;
    if (task.status !== 'queued') return false;

    task.status = 'processing';
    task.startedAt = new Date();
    this.processingTasks.add(task.id);
    await this.fireGlobalCallbacks('onStarted', task);

    return true;
  }

  /**
   * Mark a task as completed with result
   */
  async complete(taskId: string, result: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      console.warn(`[TaskQueue] Task not found: ${taskId}`);
      return;
    }

    // Ignore late completions after a task was cancelled/rerouted/failed.
    if (task.status !== 'processing') {
      return;
    }

    task.status = 'completed';
    task.result = result;
    task.completedAt = new Date();
    this.processingTasks.delete(taskId);
    this.completedTasks.push(task);

    queueInfo(`[TaskQueue] Completed task: ${taskId} in ${task.completedAt.getTime() - task.createdAt.getTime()}ms`);

    // Fire callbacks (includes notifying dependent tasks)
    await this.fireCallbacks(task);
  }

  /**
   * Mark a task as failed — auto-retry if maxRetries not exhausted
   * Returns true if the task will be retried, false if permanently failed
   */
  async fail(taskId: string, error: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) {
      console.warn(`[TaskQueue] Task not found: ${taskId}`);
      return false;
    }

    if (task.status === 'completed' || task.status === 'failed') {
      return false;
    }

    this.processingTasks.delete(taskId);

    const retryCount = (task.retryCount || 0) + 1;
    const maxRetries = task.maxRetries || 0;

    if (retryCount <= maxRetries) {
      // Schedule retry with exponential backoff
      const backoffMs = (task.retryBackoffMs || 5000) * Math.pow(2, retryCount - 1);
      task.status = 'queued';
      task.retryCount = retryCount;
      task.retryAfter = Date.now() + backoffMs;
      task.error = error; // Keep last error for debugging
      console.warn(`[TaskQueue] Task ${taskId} retry ${retryCount}/${maxRetries} in ${backoffMs}ms — ${error}`);
      await this.fireGlobalCallbacks('onQueued', task);
      return true;
    }

    // Permanently failed
    task.status = 'failed';
    task.error = error;
    task.retryCount = retryCount - 1; // Record actual retries done
    task.completedAt = new Date();
    this.failedTasks.push(task);

    console.error(`[TaskQueue] Failed task: ${taskId} (after ${task.retryCount} retries) — ${error}`);

    // Fire failure callbacks
    await this.fireCallbacks(task);

    // Cascade-fail tasks that depend on this one
    await this.cascadeFailDependents(taskId, `Dependency ${taskId} failed: ${error}`);

    return false;
  }

  /**
   * Abort an in-flight processing task without retry (used for supervisor preemptive reroute).
   */
  async abortProcessing(
    taskId: string,
    reason: string = 'Aborted by supervisor',
  ): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status !== 'processing') return false;

    task.status = 'failed';
    task.error = `Aborted: ${reason}`;
    task.completedAt = new Date();
    this.processingTasks.delete(taskId);
    this.failedTasks.push(task);
    queueInfo(`[TaskQueue] Aborted processing task: ${taskId} — ${reason}`);
    await this.fireCallbacks(task);
    return true;
  }

  /**
   * Cancel a queued task before it starts processing.
   * Returns success=false if task doesn't exist or is no longer queued.
   */
  async cancel(
    taskId: string,
    reason: string = 'Cancelled by user',
  ): Promise<{ success: boolean; error?: string }> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { success: false, error: 'Task not found' };
    }

    if (task.status !== 'queued') {
      return { success: false, error: `Cannot cancel task with status: ${task.status}` };
    }

    task.status = 'failed';
    task.error = `Cancelled: ${reason}`;
    task.completedAt = new Date();
    this.failedTasks.push(task);

    queueInfo(`[TaskQueue] Cancelled task: ${taskId} — ${reason}`);

    await this.fireCallbacks(task);
    await this.cascadeFailDependents(taskId, `Dependency ${taskId} cancelled: ${reason}`);

    return { success: true };
  }

  /**
   * Requeue a task after changing specialist/message for adaptive rerouting.
   */
  async requeue(
    taskId: string,
    updates?: Partial<Pick<
      SwarmTask,
      'toSpecialist' | 'taskType' | 'payload' | 'timeout' | 'metadata' | 'dependsOn' | 'dependencyMode' | 'minCompletedDependencies'
    >>,
    note?: string,
    delayMs: number = 0,
  ): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) {
      console.warn(`[TaskQueue] Task not found: ${taskId}`);
      return false;
    }

    if (!['queued', 'processing', 'completed', 'failed'].includes(task.status)) {
      return false;
    }

    this.processingTasks.delete(taskId);
    this.completedTasks = this.completedTasks.filter((item) => item.id !== taskId);
    this.failedTasks = this.failedTasks.filter((item) => item.id !== taskId);
    if (updates) {
      Object.assign(task, updates);
    }
    task.status = 'queued';
    task.startedAt = undefined;
    task.completedAt = undefined;
    task.result = undefined;
    task.error = note || undefined;
    task.retryAfter = delayMs > 0 ? Date.now() + delayMs : undefined;
    await this.fireGlobalCallbacks('onQueued', task);
    return true;
  }

  /**
   * Cascade-fail all tasks that depend on the given failed task
   */
  private async cascadeFailDependents(failedTaskId: string, reason: string): Promise<void> {
    for (const [id, task] of this.tasks.entries()) {
      if (task.status === 'queued' && task.dependsOn?.includes(failedTaskId) && this.hasDependencyFailed(task)) {
        task.status = 'failed';
        task.error = reason;
        task.completedAt = new Date();
        this.failedTasks.push(task);
        console.warn(`[TaskQueue] Cascade-failed dependent task: ${id}`);
        await this.fireCallbacks(task);
        // Recursively cascade
        await this.cascadeFailDependents(id, reason);
      }
    }
  }

  /**
   * Get task status and result
   */
  async getStatus(taskId: string): Promise<SwarmTask | null> {
    return this.tasks.get(taskId) || null;
  }

  /**
   * List all pending tasks (queued or processing)
   * Filters out tasks whose dependencies aren't met or are in retry cooldown
   */
  async listPending(): Promise<SwarmTask[]> {
    return Array.from(this.tasks.values())
      .filter(t => {
        if (t.status === 'processing') return true;
        if (t.status !== 'queued') return false;
        // Check dependency chain
        if (this.hasDependencyFailed(t)) return false;
        if (!this.areDependenciesMet(t)) return false;
        // Check retry cooldown
        if (!this.isEligibleForProcessing(t)) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });
  }

  /**
   * List all tasks with optional filtering
   */
  async listAll(filter?: {
    status?: TaskStatus;
    platform?: string;
    specialist?: string;
    limit?: number;
  }): Promise<SwarmTask[]> {
    let result = Array.from(this.tasks.values());

    if (filter?.status) {
      result = result.filter(t => t.status === filter.status);
    }
    if (filter?.platform) {
      result = result.filter(t => t.fromPlatform === filter.platform);
    }
    if (filter?.specialist) {
      result = result.filter(t => t.toSpecialist === filter.specialist);
    }

    result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (filter?.limit) {
      result = result.slice(0, filter.limit);
    }

    return result;
  }

  /**
   * Clean up old completed/failed tasks (older than 24 hours)
   */
  cleanup(): void {
    const now = Date.now();
    let removed = 0;

    for (const [id, task] of this.tasks.entries()) {
      if (
        (task.status === 'completed' || task.status === 'failed') &&
        task.completedAt &&
        now - task.completedAt.getTime() > this.ARCHIVAL_AGE_MS
      ) {
        this.tasks.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      queueInfo(`[TaskQueue] Cleaned up ${removed} old tasks`);
    }
  }

  /**
   * Get queue statistics
   */
  getStats(): TaskQueueStats {
    const tasks = Array.from(this.tasks.values());
    const queued = tasks.filter(t => t.status === 'queued').length;
    const processing = tasks.filter(t => t.status === 'processing').length;
    const completed = this.completedTasks.length;
    const failed = this.failedTasks.length;

    let avgProcessingTimeMs: number | undefined;
    if (this.completedTasks.length > 0) {
      const totalTime = this.completedTasks.reduce((sum, t) => {
        if (!t.completedAt) return sum;
        return sum + (t.completedAt.getTime() - t.createdAt.getTime());
      }, 0);
      avgProcessingTimeMs = Math.round(totalTime / this.completedTasks.length);
    }

    return {
      queued,
      processing,
      completed,
      failed,
      total: queued + processing + completed + failed,
      avgProcessingTimeMs,
    };
  }

  /**
   * Start automatic cleanup interval
   */
  startCleanup(): void {
    if (this.cleanupInterval) return;

    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.CLEANUP_INTERVAL_MS);

    queueInfo('[TaskQueue] Cleanup interval started (every 1 hour)');
  }

  /**
   * Stop cleanup interval
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      queueInfo('[TaskQueue] Cleanup interval stopped');
    }
  }

  /**
   * Clear all tasks (useful for shutdown)
   */
  clear(): void {
    this.tasks.clear();
    this.processingTasks.clear();
    this.completedTasks = [];
    this.failedTasks = [];
    queueInfo('[TaskQueue] All tasks cleared');
  }

  /**
   * Generate unique task ID
   */
  private generateTaskId(): string {
    const timestamp = Date.now();
    const counter = ++this.taskIdCounter;
    return `task_${timestamp}_${counter}`;
  }
}

export default TaskQueue;



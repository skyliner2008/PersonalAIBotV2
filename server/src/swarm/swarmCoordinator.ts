/**
 * Swarm Coordinator - Orchestrates multi-agent communication and task delegation.
 * Handles queueing, specialist routing, and Jarvis-led team orchestration batches.
 *
 * This module delegates to specialized sub-modules:
 * - swarmTypes: Shared type definitions
 * - swarmStateStore: Batch and state management
 * - specialistDispatcher: Routing and health checking
 * - swarmBatchManager: Batch lifecycle and summaries
 */

import TaskQueue, {
  type SwarmTask,
  type TaskStatus,
  type TaskType,
  type TaskCallback,
  type DependencyMode,
} from './taskQueue.js';
import {
  findSpecialistForTask,
  getSpecialistByName,
  getAvailableSpecialists,
} from './specialists.js';
import type { BotContext } from '../bot_agents/types.js';
import type { Agent } from '../bot_agents/agent.js';
import { executeCommandDetailed, type CommandTokenUsage } from '../terminal/terminalGateway.js';
import { saveArchivalFact } from '../memory/unifiedMemory.js';
import { getRootAdminIdentity, getRootAdminSpecialistName } from '../system/rootAdmin.js';
import {
  type SwarmBatch,
  type SwarmBatchStatus,
  type SwarmBatchProgress,
  type SwarmBatchAssignment,
  type JarvisDelegationTask,
  type BatchListener,
  type SpecialistExecutionResult,
  type CliDispatchMode,
  type CliDispatchAttempt,
  type SpecialistRuntimeHealth,
  type JarvisLeaderState,
} from './swarmTypes.js';
import { SwarmStateStore } from './swarmStateStore.js';
import { SpecialistDispatcher } from './specialistDispatcher.js';
import { SwarmBatchManager } from './swarmBatchManager.js';
import { SwarmHealthTracker } from './swarmHealthTracker.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Swarm');

// Re-export types from swarmTypes for backward compatibility
export type {
  SwarmBatchStatus,
  SwarmBatchProgress,
  SwarmBatchAssignment,
  SwarmBatch,
  JarvisDelegationTask,
  BatchListener,
  SpecialistExecutionResult,
  CliDispatchMode,
  CliDispatchAttempt,
  SpecialistRuntimeHealth,
  JarvisLeaderState,
};

const CLI_SPECIALIST_PREFIX: Record<string, string> = {
  'gemini-cli-agent': '@gemini',
  'codex-cli-agent': '@codex',
  'claude-cli-agent': '@claude',
};

const SWARM_VERBOSE_LOGS = process.env.SWARM_VERBOSE_LOGS === '1';
const SWARM_CLI_DIRECT_COMMAND_MODE = process.env.SWARM_CLI_DIRECT_COMMAND_MODE !== '0';
const SWARM_CLI_SHELL_STYLE_MODE = process.env.SWARM_CLI_SHELL_STYLE_MODE !== '0';
const SWARM_LOCAL_SYNTHESIS = process.env.SWARM_LOCAL_SYNTHESIS !== '0';
const SWARM_ENABLE_SUPERVISOR_ACTIONS = process.env.SWARM_ENABLE_SUPERVISOR_ACTIONS === '1';
const SWARM_ENABLE_ASSIST_TASKS = process.env.SWARM_ENABLE_ASSIST_TASKS === '1';
const SWARM_ENABLE_PREEMPTIVE_REROUTE = process.env.SWARM_ENABLE_PREEMPTIVE_REROUTE === '1';

function swarmInfo(...args: unknown[]): void {
  if (SWARM_VERBOSE_LOGS && args.length > 0) {
    const msg = typeof args[0] === 'string' ? args[0] : String(args[0]);
    if (args.length > 1) {
      logger.info(msg, { meta: args.slice(1) });
    } else {
      logger.info(msg);
    }
  }
}

const JARVIS_MAX_FOLLOW_UP_ROUNDS = readPositiveIntEnv('SWARM_MAX_SUPERVISOR_FOLLOWUPS', 2);
const JARVIS_MIN_ACCEPTABLE_OUTPUT = 220;
const JARVIS_SLOW_TASK_MIN_MS = readPositiveIntEnv('SWARM_ASSIST_SLOW_TASK_MS', 180_000);
const JARVIS_SUPERVISOR_SCAN_MS = 10_000;
const DEFAULT_SWARM_CLI_TASK_TIMEOUT_MS = 120_000;
const DEFAULT_SWARM_AGENT_TASK_TIMEOUT_MS = 45_000;
const DEFAULT_SWARM_CLI_ADAPTIVE_MAX_ATTEMPTS = 2;
const DEFAULT_SWARM_CLI_ADAPTIVE_TIMEOUT_STEP_MS = 45_000;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = Number.parseInt(String(raw || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function isCliSpecialistName(name: string): boolean {
  return Boolean(CLI_SPECIALIST_PREFIX[name]);
}

function toShellQuotedArg(value: string): string {
  const compact = String(value || '')
    .replace(/\r/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const escaped = compact
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/%/g, '%%');
  return `"${escaped}"`;
}

function buildShellStyleCliCommand(specialistName: string, prompt: string): string {
  const quotedPrompt = toShellQuotedArg(prompt);
  if (specialistName === 'gemini-cli-agent') {
    return `gemini --prompt ${quotedPrompt}`;
  }
  if (specialistName === 'codex-cli-agent') {
    return `codex exec --skip-git-repo-check --color never ${quotedPrompt}`;
  }
  if (specialistName === 'claude-cli-agent') {
    return `claude --print ${quotedPrompt}`;
  }
  return prompt;
}

/**
 * Swarm Coordinator manages task routing and execution.
 * Delegates to specialized modules for state management, batch handling, and specialist routing.
 */
export class SwarmCoordinator {
  private taskQueue: TaskQueue;
  private agentInstance: Agent | null = null;
  private processingInterval: NodeJS.Timeout | null = null;
  private processingIntervalMs = 1000;
  private lastPendingLogCount = 0;

  // Delegated management modules
  private stateStore: SwarmStateStore;
  private dispatcher: SpecialistDispatcher;
  private batchManager: SwarmBatchManager;
  private healthTracker: SwarmHealthTracker;

  constructor() {
    this.taskQueue = new TaskQueue();
    this.stateStore = new SwarmStateStore();
    this.dispatcher = new SpecialistDispatcher();
    this.batchManager = new SwarmBatchManager();
    this.healthTracker = new SwarmHealthTracker();

    this.taskQueue.onAnyQueued(async (task) => this.handleTaskLifecycleUpdate(task));
    this.taskQueue.onAnyStarted(async (task) => this.handleTaskLifecycleUpdate(task));
    this.taskQueue.onAnyComplete(async (task) => this.handleTaskLifecycleUpdate(task));
    this.taskQueue.onAnyFail(async (task) => this.handleTaskLifecycleUpdate(task));
    for (const specialist of getAvailableSpecialists()) {
      this.healthTracker.getOrCreateRuntimeHealth(specialist.name);
      if (isCliSpecialistName(specialist.name)) {
        this.stateStore.getCliPreferredDispatchMode().set(
          specialist.name,
          SWARM_CLI_SHELL_STYLE_MODE ? 'shell' : 'prefix',
        );
      }
    }
    swarmInfo('[SwarmCoordinator] Initialized');
  }

  /**
   * Initialize coordinator with agent instance and start processing loop.
   */
  async init(agent: Agent): Promise<void> {
    this.agentInstance = agent;
    this.taskQueue.startCleanup();
    this.startProcessingLoop();
    swarmInfo('[SwarmCoordinator] Initialized with agent, processing loop started');
  }

  /**
   * Register listeners for batch lifecycle updates.
   */
  onBatchUpdate(listener: BatchListener): () => void {
    this.stateStore.addBatchUpdateListener(listener);
    return () => {
      this.stateStore.removeBatchUpdateListener(listener);
    };
  }

  onBatchComplete(listener: BatchListener): () => void {
    this.stateStore.addBatchCompleteListener(listener);
    return () => {
      this.stateStore.removeBatchCompleteListener(listener);
    };
  }

  /**
   * Delegate a task from one bot to the swarm.
   */
  async delegateTask(
    from: BotContext,
    taskType: TaskType,
    payload: {
      message: string;
      attachments?: Array<{ type: string; data: string; mimeType?: string }>;
      context?: string;
    },
    options?: {
      toSpecialist?: string;
      priority?: number;
      timeout?: number;
      dependsOn?: string[];
      dependencyMode?: DependencyMode;
      minCompletedDependencies?: number;
      maxRetries?: number;
      retryBackoffMs?: number;
      metadata?: Record<string, unknown>;
      parentTaskId?: string;
      fromChatId?: string;
      onComplete?: TaskCallback;
      onFail?: TaskCallback;
    },
  ): Promise<string> {
    const taskId = await this.taskQueue.enqueue({
      fromPlatform: from.platform,
      fromChatId: options?.fromChatId || `${from.platform}_${from.botId}`,
      toPlatform: 'swarm',
      toSpecialist: options?.toSpecialist,
      taskType,
      payload,
      priority: options?.priority || 3,
      timeout: options?.timeout || 120000,
      dependsOn: options?.dependsOn,
      dependencyMode: options?.dependencyMode,
      minCompletedDependencies: options?.minCompletedDependencies,
      maxRetries: options?.maxRetries || 0,
      retryBackoffMs: options?.retryBackoffMs || 5000,
      metadata: options?.metadata,
      parentTaskId: options?.parentTaskId,
    });

    if (options?.onComplete || options?.onFail) {
      this.taskQueue.onTaskDone(taskId, async (task) => {
        if (task.status === 'completed' && options.onComplete) await options.onComplete(task);
        if (task.status === 'failed' && options.onFail) await options.onFail(task);
      });
    }

    const deps = options?.dependsOn?.length ? ` (depends on: ${options.dependsOn.join(', ')})` : '';
    swarmInfo(`[SwarmCoordinator] Task delegated: ${taskId} (${taskType}) from ${from.botName}${deps}`);

    return taskId;
  }

  /**
   * Delegate a chain of tasks with sequential dependencies.
   */
  async delegateTaskChain(
    from: BotContext,
    tasks: Array<{
      taskType: TaskType;
      payload: { message: string; context?: string };
      toSpecialist?: string;
      maxRetries?: number;
    }>,
    options?: {
      basePriority?: number;
      timeout?: number;
      onChainComplete?: (results: SwarmTask[]) => void | Promise<void>;
    },
  ): Promise<string[]> {
    const taskIds: string[] = [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const taskId = await this.delegateTask(from, task.taskType, task.payload, {
        toSpecialist: task.toSpecialist,
        priority: options?.basePriority || 3,
        timeout: options?.timeout,
        dependsOn: i > 0 ? [taskIds[i - 1]] : undefined,
        maxRetries: task.maxRetries || 1,
      });
      taskIds.push(taskId);
    }

    if (options?.onChainComplete && taskIds.length > 0) {
      const lastId = taskIds[taskIds.length - 1];
      this.taskQueue.onTaskDone(lastId, async () => {
        const results: SwarmTask[] = [];
        for (const id of taskIds) {
          const task = await this.taskQueue.getStatus(id);
          if (task) results.push(task);
        }
        await options.onChainComplete!(results);
      });
    }

    swarmInfo(`[SwarmCoordinator] Task chain delegated: ${taskIds.length} tasks`);
    return taskIds;
  }

  /**
   * Create and execute a Jarvis-led orchestration batch.
   */
  async orchestrateJarvisTeam(
    from: BotContext,
    objective: string,
    tasks: JarvisDelegationTask[],
    options?: {
      initiatorId?: string;
      fromChatId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<SwarmBatch> {
    if (!objective.trim()) {
      throw new Error('Objective is required');
    }
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error('At least one delegation task is required');
    }

    const batchId = this.batchManager.generateBatchId();
    const createdBy = options?.initiatorId || `${from.platform}:${from.botId}`;
    const assignments: SwarmBatchAssignment[] = [];
    const taskIds: string[] = [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const dependsOn = (task.dependsOn || [])
        .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < taskIds.length)
        .map((idx) => taskIds[idx]);
      const cliSpecialist = isCliSpecialistName(task.specialist);
      const defaultTimeoutMs = cliSpecialist
        ? readPositiveIntEnv('SWARM_CLI_TASK_TIMEOUT_MS', DEFAULT_SWARM_CLI_TASK_TIMEOUT_MS)
        : readPositiveIntEnv('SWARM_AGENT_TASK_TIMEOUT_MS', DEFAULT_SWARM_AGENT_TASK_TIMEOUT_MS);
      const timeoutMs = task.timeout ?? defaultTimeoutMs;
      const defaultMaxRetries = cliSpecialist
        ? readPositiveIntEnv('SWARM_CLI_TASK_RETRIES', 0)
        : readPositiveIntEnv('SWARM_AGENT_TASK_RETRIES', 1);
      const maxRetries = task.maxRetries ?? defaultMaxRetries;

      const taskId = await this.delegateTask(
        from,
        task.taskType || 'general',
        {
          message: task.message,
          context: `Batch Objective: ${objective}`,
        },
        {
          toSpecialist: task.specialist,
          priority: task.priority || 3,
          timeout: timeoutMs,
          dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
          dependencyMode: task.dependencyMode,
          minCompletedDependencies: task.minCompletedDependencies,
          maxRetries,
          fromChatId: options?.fromChatId || `${from.platform}_${from.botId}`,
          metadata: {
            ...(options?.metadata || {}),
            ...(task.metadata || {}),
            batchId,
            batchObjective: objective,
            batchTaskIndex: i,
            batchTaskTitle: task.title,
            sharedUserId: createdBy,
          },
        },
      );

      taskIds.push(taskId);
      this.stateStore.linkTaskToBatch(taskId, batchId);
      assignments.push({
        index: i,
        title: task.title,
        instruction: task.message,
        specialist: task.specialist,
        specialistHistory: [task.specialist],
        batchStage: typeof task.metadata?.batchStage === 'string' ? task.metadata.batchStage : undefined,
        workIntent: typeof task.metadata?.workIntent === 'string' ? task.metadata.workIntent : undefined,
        supervisorAction: task.specialist === getRootAdminSpecialistName() ? 'synthesis' : undefined,
        taskId,
        taskType: task.taskType || 'general',
        status: 'queued',
      });
    }

    const batch: SwarmBatch = {
      id: batchId,
      objective,
      createdBy,
      createdAt: new Date().toISOString(),
      status: 'queued',
      taskIds,
      assignments,
      progress: {
        total: assignments.length,
        queued: assignments.length,
        processing: 0,
        completed: 0,
        failed: 0,
      },
      metadata: {
        ...(options?.metadata || {}),
        leaderState: {
          followUpRounds: 0,
          assistedTaskIds: [],
          revisedTaskIds: [],
          recoveredTaskIds: [],
          preemptedTaskIds: [],
        },
      },
    };

    this.stateStore.setBatch(batch.id, batch);
    await this.emitBatchUpdate(batch);
    swarmInfo(`[SwarmCoordinator] Batch orchestrated: ${batch.id} (${batch.assignments.length} tasks)`);

    return this.batchManager.cloneBatch(batch);
  }

  /**
   * Get task status and result (wait for completion).
   */
  async waitForTaskResult(
    taskId: string,
    timeoutMs: number = 120000,
  ): Promise<{
    status: TaskStatus;
    result?: string;
    error?: string;
  }> {
    // Event-driven: try to resolve immediately via task listener
    const earlyResult = await new Promise<{ status: TaskStatus; result?: string; error?: string } | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), Math.min(timeoutMs, 500));
      this.taskQueue.onTaskDone(taskId, async (task) => {
        clearTimeout(timeout);
        if (task.status === 'completed') resolve({ status: 'completed', result: task.result });
        else if (task.status === 'failed') resolve({ status: 'failed', error: task.error });
        else resolve(null);
      });
    });
    if (earlyResult) return earlyResult;

    // Fallback: poll with reduced interval (250ms)
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const task = await this.taskQueue.getStatus(taskId);
      if (!task) return { status: 'failed', error: 'Task not found' };
      if (task.status === 'completed') return { status: 'completed', result: task.result };
      if (task.status === 'failed') return { status: 'failed', error: task.error };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { status: 'failed', error: 'Task timeout' };
  }

  /**
   * Process pending tasks in queue (called periodically).
   */
  private async processPendingTasks(): Promise<void> {
    const pendingTasks = await this.taskQueue.listPending();
    if (pendingTasks.length === 0) {
      this.lastPendingLogCount = 0;
      await this.monitorActiveBatches();
      return;
    }

    if (pendingTasks.length !== this.lastPendingLogCount) {
      swarmInfo(`[SwarmCoordinator] Processing ${pendingTasks.length} pending tasks`);
      this.lastPendingLogCount = pendingTasks.length;
    }

    // Separate independent tasks (no dependencies) from dependent ones
    const independent: SwarmTask[] = [];
    const dependent: SwarmTask[] = [];
    for (const task of pendingTasks) {
      if (task.status === 'processing') continue;
      if (task.dependsOn && task.dependsOn.length > 0) {
        dependent.push(task);
      } else {
        independent.push(task);
      }
    }

    // Run independent tasks in parallel (max 3 concurrent)
    const PARALLEL_LIMIT = 3;
    for (let i = 0; i < independent.length; i += PARALLEL_LIMIT) {
      const batch = independent.slice(i, i + PARALLEL_LIMIT);
      const results = await Promise.allSettled(
        batch.map(async (task) => {
          try {
            await this.executeTask(task);
          } catch (err) {
            console.error(`[SwarmCoordinator] Error executing task ${task.id}:`, err);
            const willRetry = await this.taskQueue.fail(task.id, `Execution error: ${String(err)}`);
            if (willRetry) swarmInfo(`[SwarmCoordinator] Task ${task.id} scheduled for retry`);
          }
        }),
      );
      for (const r of results) {
        if (r.status === 'rejected') {
          console.error('[SwarmCoordinator] Unhandled parallel task error:', r.reason);
        }
      }
    }

    // Run dependent tasks sequentially
    for (const task of dependent) {
      try {
        await this.executeTask(task);
      } catch (err) {
        console.error(`[SwarmCoordinator] Error executing task ${task.id}:`, err);
        const willRetry = await this.taskQueue.fail(task.id, `Execution error: ${String(err)}`);
        if (willRetry) swarmInfo(`[SwarmCoordinator] Task ${task.id} scheduled for retry`);
      }
    }

    await this.monitorActiveBatches();
  }

  /**
   * Execute a task by routing it to the appropriate specialist.
   */
  private async executeTask(task: SwarmTask): Promise<void> {
    let specialist = task.toSpecialist
      ? getSpecialistByName(task.toSpecialist)
      : findSpecialistForTask(task.taskType);

    if (!specialist) {
      throw new Error(`No specialist available for task type: ${task.taskType}`);
    }

    // Health-aware pre-check: if selected specialist is unhealthy, try fallback first
    const health = this.getOrCreateRuntimeHealth(specialist.name);
    if (health.state === 'unavailable' || (health.state === 'degraded' && health.consecutiveFailures >= 2)) {
      const fallbackName = this.chooseFallbackSpecialist(task, specialist.name);
      if (fallbackName) {
        const fallbackSpec = getSpecialistByName(fallbackName);
        if (fallbackSpec) {
          swarmInfo(`[SwarmCoordinator] Pre-routing: ${specialist.name} (${health.state}) -> ${fallbackName}`);
          specialist = fallbackSpec;
        }
      }
    }

    const started = await this.taskQueue.startProcessing(task.id);
    if (!started) return;

    swarmInfo(`[SwarmCoordinator] Executing task ${task.id} with specialist: ${specialist.name}`);

    const taskMessage = this.resolveTaskMessage(task);
    const executionStartedAt = Date.now();

    try {
      const execution = this.isCliSpecialist(specialist.name)
        ? await this.executeCliSpecialistTask(task, specialist.name, taskMessage)
        : this.shouldUseLocalSynthesis(task, specialist.name)
          ? { output: this.buildLocalSynthesisForTask(task) }
          : { output: await this.executeAgentSpecialistTask(task, specialist.name, taskMessage) };

      const latestTaskState = await this.taskQueue.getStatus(task.id);
      if (!latestTaskState || latestTaskState.status !== 'processing') {
        swarmInfo(
          `[SwarmCoordinator] Ignoring late result for task ${task.id} (status=${latestTaskState?.status || 'missing'})`,
        );
        return;
      }

      if (execution.tokenUsage) {
        this.attachAssignmentTokenUsage(task.id, execution.tokenUsage);
      }

      const sanitizedOutput = this.sanitizeAssignmentOutput(execution.output);
      this.recordSpecialistSuccess(specialist.name, Date.now() - executionStartedAt);
      await this.taskQueue.complete(task.id, sanitizedOutput || '(no response)');
      swarmInfo(`[SwarmCoordinator] Task completed: ${task.id}`);
      await this.reportResult(task);
    } catch (err) {
      const latestTaskState = await this.taskQueue.getStatus(task.id);
      if (!latestTaskState || latestTaskState.status !== 'processing') {
        swarmInfo(
          `[SwarmCoordinator] Ignoring late error for task ${task.id} (status=${latestTaskState?.status || 'missing'})`,
        );
        return;
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      this.recordSpecialistFailure(specialist.name, errorMsg, Date.now() - executionStartedAt);

      const nextRetryCount = (task.retryCount || 0) + 1;
      const hasRetryLeft = nextRetryCount <= (task.maxRetries || 0);
      if (hasRetryLeft) {
        const willRetry = await this.taskQueue.fail(task.id, errorMsg);
        if (willRetry) {
          swarmInfo(`[SwarmCoordinator] Task ${task.id} will retry - ${errorMsg}`);
          return;
        }
      }

      const rerouted = await this.tryAdaptiveReroute(task, specialist.name, errorMsg);
      if (rerouted) {
        swarmInfo(`[SwarmCoordinator] Task ${task.id} rerouted after ${specialist.name} failure`);
        return;
      }

      const willRetry = await this.taskQueue.fail(task.id, errorMsg);
      if (willRetry) {
        swarmInfo(`[SwarmCoordinator] Task ${task.id} will retry - ${errorMsg}`);
      } else {
        console.error(`[SwarmCoordinator] Task permanently failed: ${task.id} - ${errorMsg}`);
      }
    }
  }

  private resolveTaskMessage(task: SwarmTask): string {
    let base = task.payload.message || '';
    base = base.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    const includeRawContext = task.metadata?.omitRawBatchObjective !== true;
    let rawContext = includeRawContext ? (task.payload.context || '').trim() : '';
    // Aggressive stripping to save Swarm token delegation cost
    rawContext = rawContext.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    rawContext = rawContext.replace(/data:image\/[^;]+;base64,[a-zA-Z0-9+/=]+/gi, '[Base64 Image Truncated]');

    const parts = [
      rawContext,
      this.buildBatchExecutionContext(task),
    ].filter(Boolean);

    if (parts.length === 0) return base;

    // Line trimming
    const limitedParts = parts.join('\n\n').split('\n')
      .map(l => l.length > 2500 ? l.substring(0, 2500) + '...[Truncated]' : l).join('\n');

    return `${base}\n\nAdditional context:\n${limitedParts}`;
  }

  private sanitizeAssignmentOutput(output: string): string {
    return String(output || '')
      .replace(/\r/g, '')
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        if (trimmed.startsWith('{') && trimmed.includes('"type"')) return false;
        if (trimmed.includes('{"type":"')) return false;
        if (/"type"\s*:\s*"(thread|turn|item|response|message)\./i.test(trimmed)) return false;
        if (trimmed.startsWith('Loaded cached credentials')) return false;
        if (trimmed === 'tokens used') return false;
        if (/^[\d,]+$/.test(trimmed)) return false;
        return true;
      })
      .join('\n')
      .trim();
  }

  private detectUnusableCliOutput(specialistName: string, output: string): string | null {
    const normalized = String(output || '').toLowerCase();
    if (!normalized) return 'CLI returned no usable output';

    const genericReadinessMarkers = [
      'what would you like me to help you with',
      'what specific task would you like me to assist with',
      'please provide more details about the task',
      'please provide more details',
      'i can see this project',
      'i can see some',
      'i can see you have',
      'based on your mention of',
      'i can help you with your software engineering tasks',
      'i am ready to help',
      "i'm ready to help",
      "i'm ready to assist",
      'provide the target outcome',
    ];
    if (genericReadinessMarkers.some((marker) => normalized.includes(marker))) {
      return `${specialistName} returned a readiness message instead of the requested output`;
    }

    const hardFailureMarkers = [
      'attempt 1 failed with status',
      'gaxioserror',
      'apierror',
      'resource exhausted',
      'resource_exhausted',
      'model_capacity_exhausted',
      'no capacity available for model',
      'rate limit exceeded',
      'retrying with backoff',
      'quota exceeded',
      'is not recognized as the name of a cmdlet',
      'command not found',
      'cannot find module',
    ];
    if (
      hardFailureMarkers.some((marker) => normalized.includes(marker))
      && /(429|rate limit|capacity|quota|resource exhausted|gaxioserror|apierror|not recognized|not found|cannot find)/i.test(normalized)
    ) {
      return `${specialistName} returned provider/runtime error output instead of a final answer`;
    }

    if (
      /^\s*attempt\s+\d+\s+failed\s+with\s+status\s+\d+/i.test(normalized)
      || (/error/i.test(normalized) && /\bat\s+[^\n]+\([^)]+:\d+:\d+\)/i.test(output))
    ) {
      return `${specialistName} returned stack/error logs instead of a final answer`;
    }

    if (/^\s*(analyzing and processing|processing)\.{0,3}\s*$/i.test(normalized.trim())) {
      return `${specialistName} returned progress text without final output`;
    }

    if (specialistName === 'codex-cli-agent') {
      const codexEncodingFailure = [
        'appears unreadable',
        'came through corrupted',
        'ข้อความที่ส่งมาขึ้นเป็น',
        'น่าจะเป็นปัญหา encoding',
        'resend the prompt',
        'send the scenario',
        'send the scenario or task',
        'send the task when ready',
        'operating as codex cli',
        'paste the actual task brief',
      ].find((marker) => normalized.includes(marker));
      if (codexEncodingFailure) {
        return `Codex CLI did not receive a usable prompt (${codexEncodingFailure})`;
      }

      if (
        normalized.includes('supporting jarvis') &&
        normalized.includes('focus on codebase inspection')
      ) {
        return 'Codex CLI returned a generic readiness message instead of the requested analysis';
      }
    }

    return null;
  }

  private isCliSpecialist(specialistName: string): boolean {
    return Boolean(CLI_SPECIALIST_PREFIX[specialistName]);
  }

  private getOrCreateRuntimeHealth(specialistName: string): SpecialistRuntimeHealth {
    return this.healthTracker.getOrCreateRuntimeHealth(specialistName);
  }

  private recordSpecialistSuccess(specialistName: string, latencyMs?: number): void {
    this.healthTracker.recordSuccess(specialistName, latencyMs);
  }

  private recordSpecialistFailure(specialistName: string, errorMsg: string, latencyMs?: number): void {
    this.healthTracker.recordFailure(specialistName, errorMsg, latencyMs);
  }

  private markReroute(specialistName: string): void {
    this.healthTracker.recordReroute(specialistName);
  }

  private extractEnglishHandoffBlock(value: string): string {
    const text = String(value || '').replace(/\r/g, '\n');
    if (!text.trim()) return '';

    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const markerIndex = lines.findIndex((line) => /^#{0,3}\s*english handoff\b/i.test(line) || /^english handoff\b/i.test(line));
    if (markerIndex < 0) return '';

    const handoffLines = lines
      .slice(markerIndex + 1)
      .filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
      .map((line) => line.replace(/^[-*]\s+/, '').trim())
      .filter((line) => Boolean(line));

    if (handoffLines.length === 0) return '';
    return handoffLines.slice(0, 4).join(' | ');
  }

  private toAsciiCompact(value: string, maxLength = 500): string {
    const compact = String(value || '')
      .replace(/[^\x00-\x7F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return compact.slice(0, maxLength);
  }

  private getDependencySummaryForTask(task: SwarmTask, assignment: SwarmBatchAssignment): string {
    const raw = this.sanitizeAssignmentOutput(assignment.result || assignment.error || '');
    if (!raw) return '(no output)';

    if (task.metadata?.omitRawBatchObjective === true) {
      const handoff = this.extractEnglishHandoffBlock(raw);
      if (handoff) return handoff.slice(0, 500);

      const asciiFallback = this.toAsciiCompact(raw, 500);
      return asciiFallback || '(no usable dependency handoff)';
    }

    return raw.slice(0, 500);
  }

  private buildBatchExecutionContext(task: SwarmTask): string {
    const batchId = typeof task.metadata?.batchId === 'string' ? task.metadata.batchId : '';
    if (!batchId) return '';

    const batch = this.stateStore.getBatch(batchId);
    if (!batch) return '';

    const otherAssignments = batch.assignments.filter((assignment) => assignment.taskId !== task.id);
    const completed = otherAssignments.filter((assignment) => assignment.status === 'completed');
    const failed = otherAssignments.filter((assignment) => assignment.status === 'failed');
    const pending = otherAssignments.filter((assignment) =>
      assignment.status === 'queued' || assignment.status === 'processing');

    const lines: string[] = [];
    lines.push(
      `Batch status snapshot: completed=${completed.length}, failed=${failed.length}, pending=${pending.length}.`,
    );

    if (completed.length > 0) {
      lines.push(`Completed lanes: ${completed.map((assignment) => assignment.specialist).join(', ')}.`);
    }
    if (failed.length > 0) {
      lines.push(`Failed lanes: ${failed.map((assignment) => assignment.specialist).join(', ')}.`);
    }

    const dependencySummaries = (task.dependsOn || [])
      .map((depId) => batch.assignments.find((assignment) => assignment.taskId === depId))
      .filter((assignment): assignment is SwarmBatchAssignment => Boolean(assignment))
      .map((assignment) => {
        const output = this.getDependencySummaryForTask(task, assignment);
        return `${assignment.title} (${assignment.specialist}, ${assignment.status}): ${output || '(no output)'}`;
      });

    if (dependencySummaries.length > 0) {
      lines.push('Dependency context:');
      lines.push(...dependencySummaries);
    } else if (task.metadata?.batchStage === 'synthesis') {
      const completedOutputs = completed
        .map((assignment) => {
          const output = this.sanitizeAssignmentOutput(assignment.result || '').slice(0, 700);
          return output ? `${assignment.title} (${assignment.specialist}): ${output}` : '';
        })
        .filter((value) => Boolean(value));
      if (completedOutputs.length > 0) {
        lines.push('Available specialist outputs:');
        lines.push(...completedOutputs);
      }
    }

    return lines.join('\n');
  }

  private isRecoverableSpecialistFailure(errorMsg: string): boolean {
    return this.dispatcher.isRecoverableSpecialistFailure(errorMsg);
  }

  private chooseFallbackSpecialist(task: SwarmTask, failedSpecialist: string): string | null {
    return this.dispatcher.chooseFallbackSpecialist(
      task,
      failedSpecialist,
      (name) => this.getOrCreateRuntimeHealth(name),
    );
  }

  private async tryAdaptiveReroute(
    task: SwarmTask,
    failedSpecialist: string,
    errorMsg: string,
  ): Promise<boolean> {
    if (!this.isRecoverableSpecialistFailure(errorMsg)) return false;
    if (task.toSpecialist === getRootAdminSpecialistName()) return false;

    const rerouteCount = Number(task.metadata?.rerouteCount || 0);
    if (rerouteCount >= 1) return false;

    const nextSpecialist = this.chooseFallbackSpecialist(task, failedSpecialist);
    if (!nextSpecialist) return false;

    const rerouteContext = [
      typeof task.payload.context === 'string' ? task.payload.context.trim() : '',
      `Adaptive reroute: previous lane ${failedSpecialist} failed with "${errorMsg}".`,
      `Pick up only the missing work and use any completed specialist outputs instead of restarting from scratch.`,
    ]
      .filter((value) => Boolean(value))
      .join('\n');

    const requeued = await this.taskQueue.requeue(
      task.id,
      {
        toSpecialist: nextSpecialist,
        payload: {
          ...task.payload,
          context: rerouteContext,
        },
        metadata: {
          ...(task.metadata || {}),
          rerouteCount: rerouteCount + 1,
          previousSpecialist: failedSpecialist,
          lastRerouteReason: errorMsg,
        },
      },
      `Rerouted from ${failedSpecialist} to ${nextSpecialist}: ${errorMsg}`,
      1000,
    );

    if (!requeued) return false;

    this.markReroute(failedSpecialist);
    const batchId = this.stateStore.getBatchIdForTask(task.id);
    if (batchId) {
      const batch = this.stateStore.getBatch(batchId);
      const assignment = batch?.assignments.find((item) => item.taskId === task.id);
      if (assignment) {
        assignment.specialist = nextSpecialist;
        assignment.specialistHistory = Array.from(new Set([...(assignment.specialistHistory || []), nextSpecialist]));
        assignment.error = `Rerouted from ${failedSpecialist}: ${errorMsg}`;
      }
    }

    return true;
  }

  private getLeaderState(batch: SwarmBatch): JarvisLeaderState {
    if (!batch.metadata) batch.metadata = {};
    const rawState = batch.metadata.leaderState as Partial<JarvisLeaderState> | undefined;
    const state: JarvisLeaderState = {
      followUpRounds: Number(rawState?.followUpRounds || 0),
      assistedTaskIds: Array.isArray(rawState?.assistedTaskIds) ? [...rawState!.assistedTaskIds!] : [],
      revisedTaskIds: Array.isArray(rawState?.revisedTaskIds) ? [...rawState!.revisedTaskIds!] : [],
      recoveredTaskIds: Array.isArray(rawState?.recoveredTaskIds) ? [...rawState!.recoveredTaskIds!] : [],
      preemptedTaskIds: Array.isArray(rawState?.preemptedTaskIds) ? [...rawState!.preemptedTaskIds!] : [],
    };
    batch.metadata.leaderState = state;
    return state;
  }

  private async getBatchTaskMap(batch: SwarmBatch): Promise<Map<string, SwarmTask>> {
    const map = new Map<string, SwarmTask>();
    for (const taskId of batch.taskIds) {
      const task = await this.taskQueue.getStatus(taskId);
      if (task) {
        map.set(taskId, task);
      }
    }
    return map;
  }

  private replaceTaskIdInCollection(values: string[], fromTaskId: string, toTaskId: string): string[] {
    return values.map((value) => (value === fromTaskId ? toTaskId : value));
  }

  private replaceLeaderStateTaskId(
    leaderState: JarvisLeaderState,
    fromTaskId: string,
    toTaskId: string,
  ): void {
    leaderState.assistedTaskIds = this.replaceTaskIdInCollection(
      leaderState.assistedTaskIds,
      fromTaskId,
      toTaskId,
    );
    leaderState.revisedTaskIds = this.replaceTaskIdInCollection(
      leaderState.revisedTaskIds,
      fromTaskId,
      toTaskId,
    );
    leaderState.recoveredTaskIds = this.replaceTaskIdInCollection(
      leaderState.recoveredTaskIds,
      fromTaskId,
      toTaskId,
    );
    leaderState.preemptedTaskIds = this.replaceTaskIdInCollection(
      leaderState.preemptedTaskIds,
      fromTaskId,
      toTaskId,
    );
  }

  private async replaceQueuedDependencyReferences(
    batch: SwarmBatch,
    fromTaskId: string,
    toTaskId: string,
  ): Promise<void> {
    for (const taskId of batch.taskIds) {
      if (taskId === toTaskId) continue;
      const task = await this.taskQueue.getStatus(taskId);
      if (!task || task.status !== 'queued') continue;
      if (!Array.isArray(task.dependsOn) || !task.dependsOn.includes(fromTaskId)) continue;
      const nextDependsOn = Array.from(new Set(task.dependsOn.map((depId) => (
        depId === fromTaskId ? toTaskId : depId
      ))));
      await this.taskQueue.requeue(task.id, {
        dependsOn: nextDependsOn,
      });
    }
  }

  private async preemptiveRerouteSlowTask(
    batch: SwarmBatch,
    assignment: SwarmBatchAssignment,
    task: SwarmTask,
    nextSpecialist: string,
    reason: string,
  ): Promise<boolean> {
    const preemptiveCount = Number(task.metadata?.preemptiveRerouteCount || 0);
    if (preemptiveCount >= 1) return false;

    const latestTask = await this.taskQueue.getStatus(task.id);
    if (!latestTask || latestTask.status !== 'processing') return false;

    const originalTaskId = task.id;
    const originalSpecialist = assignment.specialist;

    const takeoverMessage = [
      assignment.instruction || task.payload.message,
      '',
      `Jarvis preemptive reroute: previous lane ${originalSpecialist} was cancelled because ${reason}.`,
      'Continue now and return the final lane result directly with no follow-up questions.',
    ]
      .filter((value) => Boolean(value))
      .join('\n');

    const takeoverContext = [
      typeof task.payload.context === 'string' ? task.payload.context.trim() : '',
      `Batch Objective: ${batch.objective}`,
      `Supervisor action: preemptive reroute from ${originalSpecialist} to ${nextSpecialist}.`,
    ]
      .filter((value) => Boolean(value))
      .join('\n');

    const rootAdmin = getRootAdminIdentity();
    const replacementTaskId = await this.delegateTask(
      {
        botId: rootAdmin.botId,
        botName: rootAdmin.botName,
        platform: 'custom',
        replyWithFile: async () => '',
      },
      task.taskType,
      {
        message: takeoverMessage,
        attachments: task.payload.attachments,
        context: takeoverContext,
      },
      {
        toSpecialist: nextSpecialist,
        priority: Math.max(task.priority || 3, 4),
        timeout: task.timeout,
        dependsOn: task.dependsOn,
        dependencyMode: task.dependencyMode,
        minCompletedDependencies: task.minCompletedDependencies,
        maxRetries: task.maxRetries || 0,
        retryBackoffMs: task.retryBackoffMs || 5000,
        parentTaskId: task.parentTaskId,
        fromChatId: task.fromChatId,
        metadata: {
          ...(task.metadata || {}),
          supervisorAction: 'recovery',
          preemptiveRerouteCount: preemptiveCount + 1,
          previousTaskId: originalTaskId,
          previousSpecialist: originalSpecialist,
          sourceTaskId: originalTaskId,
        },
      },
    );

    // Detach old task from batch before aborting so late lifecycle events are ignored.
    this.stateStore.unlinkTaskFromBatch(originalTaskId);
    const abortReason = `Jarvis preemptive reroute to ${nextSpecialist}: ${reason}`;
    const aborted = await this.taskQueue.abortProcessing(originalTaskId, abortReason);
    if (!aborted) {
      // Original task already settled; keep the original mapping and drop replacement lane.
      this.stateStore.linkTaskToBatch(originalTaskId, batch.id);
      const cancelResult = await this.taskQueue.cancel(
        replacementTaskId,
        'Preemptive reroute skipped because original lane settled before cancel',
      );
      if (!cancelResult.success) {
        await this.taskQueue.abortProcessing(
          replacementTaskId,
          'Preemptive reroute skipped because original lane settled before cancel',
        );
      }
      this.stateStore.unlinkTaskFromBatch(replacementTaskId);
      return false;
    }

    this.markReroute(originalSpecialist);
    this.stateStore.linkTaskToBatch(replacementTaskId, batch.id);
    const batchTaskIndex = batch.taskIds.indexOf(originalTaskId);
    if (batchTaskIndex >= 0) {
      batch.taskIds[batchTaskIndex] = replacementTaskId;
    } else {
      batch.taskIds.push(replacementTaskId);
    }

    await this.replaceQueuedDependencyReferences(batch, originalTaskId, replacementTaskId);

    const leaderState = this.getLeaderState(batch);
    this.replaceLeaderStateTaskId(leaderState, originalTaskId, replacementTaskId);

    assignment.taskId = replacementTaskId;
    assignment.specialist = nextSpecialist;
    assignment.specialistHistory = Array.from(new Set([...(assignment.specialistHistory || []), nextSpecialist]));
    assignment.status = 'queued';
    assignment.result = undefined;
    assignment.error = `Jarvis preemptive reroute: ${reason}`;
    assignment.supervisorAction = 'recovery';
    assignment.sourceTaskId = originalTaskId;

    swarmInfo(
      `[SwarmCoordinator] Preemptive reroute ${originalTaskId} (${originalSpecialist}) -> ${replacementTaskId} (${nextSpecialist})`,
    );

    return true;
  }

  private isWeakAssignmentOutput(assignment: SwarmBatchAssignment): string | null {
    const text = this.sanitizeAssignmentOutput(assignment.result || '');
    if (!text || text === '(no response)') {
      return 'previous response was empty';
    }
    const minLength = assignment.workIntent === 'fact_gathering'
      ? 90
      : assignment.workIntent === 'scenario_mapping'
        ? 160
        : assignment.workIntent === 'risk_review'
          ? 150
          : JARVIS_MIN_ACCEPTABLE_OUTPUT;
    if (text.length < minLength) {
      return 'previous response was too short to support synthesis';
    }

    const normalized = text.toLowerCase();
    const genericMarkers = [
      'need more information',
      'insufficient context',
      'not enough context',
      'cannot determine',
      'unknown',
      'placeholder',
      'no response',
      'attempt 1 failed with status',
      'gaxioserror',
      'resource exhausted',
      'no capacity available for model',
      'rate limit exceeded',
      'send the scenario or task',
      'send the task when ready',
      'appears unreadable',
      'came through corrupted',
      'ปัญหา encoding',
    ];
    if (genericMarkers.some((marker) => normalized.includes(marker))) {
      return 'previous response was generic or unresolved';
    }

    if (assignment.workIntent === 'risk_review' && !/(risk|mitigation|likelihood|impact)/i.test(text)) {
      return 'risk review missed risk-control detail';
    }
    const isFastLookupLane = /fast fact lookup/i.test(assignment.title || '');
    if (
      assignment.workIntent === 'fact_gathering'
      && !isFastLookupLane
      && !/(confidence|uncertainty|signal|evidence|source|http|reuters|imf|world bank|ธปท|สภาพัฒน์)/i.test(text)
    ) {
      return 'fact gathering missed evidence quality notes';
    }

    return null;
  }

  private isSlowTask(task: SwarmTask | undefined | null): boolean {
    if (!task || task.status !== 'processing' || !task.startedAt) return false;
    const startedAt = task.startedAt instanceof Date ? task.startedAt.getTime() : Date.parse(String(task.startedAt));
    if (!Number.isFinite(startedAt)) return false;
    const threshold = Math.min(task.timeout * 0.6, Math.max(JARVIS_SLOW_TASK_MIN_MS, 20_000));
    return Date.now() - startedAt >= threshold;
  }

  private chooseFastestCompletedSpecialist(
    batch: SwarmBatch,
    taskMap: Map<string, SwarmTask>,
    exclude: Set<string>,
  ): string | null {
    return this.dispatcher.chooseFastestCompletedSpecialist(
      batch,
      taskMap,
      exclude,
      (name) => this.getOrCreateRuntimeHealth(name),
    );
  }

  private async requeueForSupervisorReview(
    task: SwarmTask,
    assignment: SwarmBatchAssignment,
    supervisorAction: 'revision' | 'recovery',
    nextSpecialist: string,
    reason: string,
  ): Promise<boolean> {
    const currentCount = Number(task.metadata?.[`${supervisorAction}Count`] || 0);
    if (currentCount >= 1) return false;

    const noteLabel = supervisorAction === 'revision' ? 'revise and strengthen the answer' : 'recover the missing lane';
    const supervisorMessage = [
      assignment.instruction || task.payload.message,
      '',
      `Jarvis supervisor request: ${noteLabel}.`,
      `Reason: ${reason}.`,
      assignment.result ? `Previous output:\n${this.sanitizeAssignmentOutput(assignment.result).slice(0, 1200)}` : '',
      assignment.error ? `Previous failure:\n${assignment.error}` : '',
      'Return a decision-ready answer with concrete detail, explicit assumptions, and enough signal for Jarvis to synthesize confidently.',
    ]
      .filter((value) => Boolean(value))
      .join('\n');

    const requeued = await this.taskQueue.requeue(
      task.id,
      {
        toSpecialist: nextSpecialist,
        payload: {
          ...task.payload,
          message: supervisorMessage,
          context: [
            typeof task.payload.context === 'string' ? task.payload.context.trim() : '',
            `Supervisor action: ${supervisorAction}.`,
            `Jarvis note: ${reason}.`,
          ].filter((value) => Boolean(value)).join('\n'),
        },
        metadata: {
          ...(task.metadata || {}),
          supervisorAction,
          [`${supervisorAction}Count`]: currentCount + 1,
        },
      },
      `Jarvis ${supervisorAction} requested: ${reason}`,
      0,
    );

    if (!requeued) return false;

    assignment.supervisorAction = supervisorAction;
    assignment.specialist = nextSpecialist;
    assignment.specialistHistory = Array.from(new Set([...(assignment.specialistHistory || []), nextSpecialist]));
    assignment.error = `Jarvis ${supervisorAction} requested: ${reason}`;
    return true;
  }

  private async appendAdaptiveAssistTask(
    batch: SwarmBatch,
    sourceAssignment: SwarmBatchAssignment,
    supportSpecialist: string,
  ): Promise<void> {
    const title = `Support - ${sourceAssignment.title}`;
    const rootAdmin = getRootAdminIdentity();
    const taskId = await this.delegateTask(
      {
        botId: rootAdmin.botId,
        botName: rootAdmin.botName,
        platform: 'custom',
        replyWithFile: async () => '',
      },
      sourceAssignment.taskType,
      {
        message: [
          sourceAssignment.instruction || `Objective: ${batch.objective}`,
          '',
          `Jarvis supervisor assist request: lane ${sourceAssignment.specialist} is slow.`,
          'Produce an independent backup answer for the same focus so Jarvis can keep momentum.',
        ].join('\n'),
        context: `Batch Objective: ${batch.objective}\nSupervisor action: assist backup for ${sourceAssignment.title}`,
      },
      {
        toSpecialist: supportSpecialist,
        priority: 4,
        timeout: 120000,
        maxRetries: 1,
        fromChatId: `batch_${batch.id}`,
        metadata: {
          ...(batch.metadata || {}),
          batchId: batch.id,
          batchObjective: batch.objective,
          batchTaskIndex: batch.assignments.length,
          batchTaskTitle: title,
          sharedUserId: batch.createdBy,
          batchStage: 'assist',
          workIntent: sourceAssignment.workIntent || 'structured_analysis',
          supervisorAction: 'assist',
          sourceTaskId: sourceAssignment.taskId,
        },
      },
    );

    this.stateStore.linkTaskToBatch(taskId, batch.id);
    batch.taskIds.push(taskId);
    batch.assignments.push({
      index: batch.assignments.length,
      title,
      instruction: `Jarvis assist backup for ${sourceAssignment.title}`,
      specialist: supportSpecialist,
      specialistHistory: [supportSpecialist],
      batchStage: 'assist',
      workIntent: sourceAssignment.workIntent,
      supervisorAction: 'assist',
      sourceTaskId: sourceAssignment.taskId,
      taskId,
      taskType: sourceAssignment.taskType,
      status: 'queued',
    });

    await this.linkTaskToFinalSynthesis(batch, taskId);
  }

  private async linkTaskToFinalSynthesis(batch: SwarmBatch, taskId: string): Promise<void> {
    const finalAssignment = batch.assignments.find((assignment) => assignment.batchStage === 'synthesis');
    if (!finalAssignment) return;

    const finalTask = await this.taskQueue.getStatus(finalAssignment.taskId);
    if (!finalTask || finalTask.status !== 'queued') return;

    const nextDependsOn = Array.from(new Set([...(finalTask.dependsOn || []), taskId]));
    await this.taskQueue.requeue(finalTask.id, {
      dependsOn: nextDependsOn,
    });
  }

  private canSynthesizeWithCurrentCoverage(batch: SwarmBatch, taskMap: Map<string, SwarmTask>): boolean {
    const finalAssignment = batch.assignments.find((assignment) => assignment.batchStage === 'synthesis');
    if (!finalAssignment) return false;

    const finalTask = taskMap.get(finalAssignment.taskId);
    if (!finalTask) return false;
    if (finalTask.status === 'processing' || finalTask.status === 'completed') return true;

    const completedCount = batch.assignments
      .filter((assignment) => assignment.batchStage !== 'synthesis')
      .filter((assignment) => assignment.status === 'completed')
      .length;

    const requiredCompleted = finalTask.dependencyMode === 'minimum_completed'
      ? Math.max(1, finalTask.minCompletedDependencies || 1)
      : Math.max(1, finalTask.dependsOn?.length || 1);

    return completedCount >= requiredCompleted;
  }

  private async maybeRunSupervisorLoop(batchId: string): Promise<void> {
    const batch = this.stateStore.getBatch(batchId);
    if (!batch || batch.completedAt) return;
    if (this.stateStore.getSupervisorLoopRunning().has(batchId)) return;

    this.stateStore.getSupervisorLoopRunning().add(batchId);
    try {
      const leaderState = this.getLeaderState(batch);
      if (leaderState.followUpRounds >= JARVIS_MAX_FOLLOW_UP_ROUNDS) return;
      if (!SWARM_ENABLE_SUPERVISOR_ACTIONS && !SWARM_ENABLE_PREEMPTIVE_REROUTE) return;

      const taskMap = await this.getBatchTaskMap(batch);
      const activeAssignments = batch.assignments.filter((assignment) => assignment.batchStage !== 'synthesis');
      const synthesisReady = this.canSynthesizeWithCurrentCoverage(batch, taskMap);

      if (SWARM_ENABLE_SUPERVISOR_ACTIONS) {
        for (const assignment of activeAssignments) {
          if (assignment.status !== 'completed') continue;
          if (leaderState.revisedTaskIds.includes(assignment.taskId)) continue;

          const reason = this.isWeakAssignmentOutput(assignment);
          if (!reason) continue;

          const task = taskMap.get(assignment.taskId);
          if (!task) continue;

          const sameLaneHealth = this.getOrCreateRuntimeHealth(assignment.specialist);
          const nextSpecialist = sameLaneHealth.state === 'unavailable'
            ? this.chooseFallbackSpecialist(task, assignment.specialist) || assignment.specialist
            : assignment.specialist;

          const requeued = await this.requeueForSupervisorReview(task, assignment, 'revision', nextSpecialist, reason);
          if (requeued) {
            leaderState.followUpRounds += 1;
            leaderState.revisedTaskIds.push(assignment.taskId);
            return;
          }
        }

        for (const assignment of activeAssignments) {
          if (assignment.status !== 'failed') continue;
          if (synthesisReady) continue;
          if (leaderState.recoveredTaskIds.includes(assignment.taskId)) continue;

          const task = taskMap.get(assignment.taskId);
          if (!task) continue;

          const nextSpecialist = this.chooseFallbackSpecialist(task, assignment.specialist)
            || this.chooseFastestCompletedSpecialist(batch, taskMap, new Set([assignment.specialist]));
          if (!nextSpecialist) continue;

          const requeued = await this.requeueForSupervisorReview(
            task,
            assignment,
            'recovery',
            nextSpecialist,
            assignment.error || 'lane failed before producing usable output',
          );
          if (requeued) {
            leaderState.followUpRounds += 1;
            leaderState.recoveredTaskIds.push(assignment.taskId);
            return;
          }
        }

        if (SWARM_ENABLE_ASSIST_TASKS) {
          for (const assignment of activeAssignments) {
            if (assignment.status !== 'processing') continue;
            if (synthesisReady) continue;
            if (leaderState.assistedTaskIds.includes(assignment.taskId)) continue;

            const task = taskMap.get(assignment.taskId);
            if (!this.isSlowTask(task)) continue;

            const supportSpecialist = this.chooseFastestCompletedSpecialist(batch, taskMap, new Set([assignment.specialist]));
            if (!supportSpecialist) continue;

            await this.appendAdaptiveAssistTask(batch, assignment, supportSpecialist);
            leaderState.followUpRounds += 1;
            leaderState.assistedTaskIds.push(assignment.taskId);
            return;
          }
        }
      }

      if (SWARM_ENABLE_PREEMPTIVE_REROUTE) {
        for (const assignment of activeAssignments) {
          if (assignment.status !== 'processing') continue;
          if (synthesisReady) continue;
          if (leaderState.preemptedTaskIds.includes(assignment.taskId)) continue;

          const task = taskMap.get(assignment.taskId);
          if (!this.isSlowTask(task)) continue;
          if (!task) continue;

          const nextSpecialist = this.chooseFastestCompletedSpecialist(batch, taskMap, new Set([assignment.specialist]))
            || this.chooseFallbackSpecialist(task, assignment.specialist);
          if (!nextSpecialist || nextSpecialist === assignment.specialist) continue;

          const reason = `lane timeout risk: ${assignment.specialist} exceeded slow threshold`;
          const rerouted = await this.preemptiveRerouteSlowTask(
            batch,
            assignment,
            task,
            nextSpecialist,
            reason,
          );
          if (rerouted) {
            leaderState.followUpRounds += 1;
            leaderState.preemptedTaskIds.push(assignment.taskId);
            return;
          }
        }
      }
    } finally {
      this.stateStore.getSupervisorLoopRunning().delete(batchId);
    }
  }

  private async monitorActiveBatches(): Promise<void> {
    const now = Date.now();
    for (const batch of this.stateStore.getBatches().values()) {
      if (batch.status !== 'running' && batch.status !== 'queued') continue;
      const lastScan = this.stateStore.getLastSupervisorScanAt().get(batch.id) || 0;
      if (now - lastScan < JARVIS_SUPERVISOR_SCAN_MS) continue;
      this.stateStore.getLastSupervisorScanAt().set(batch.id, now);
      await this.maybeRunSupervisorLoop(batch.id);
    }
  }

  private shouldUseLocalSynthesis(task: SwarmTask, specialistName: string): boolean {
    if (!SWARM_LOCAL_SYNTHESIS) return false;
    if (specialistName !== getRootAdminSpecialistName()) return false;
    if (String(task.metadata?.batchStage || '') !== 'synthesis') return false;
    return true;
  }

  private getBatchObjectiveFromTask(task: SwarmTask): string {
    if (typeof task.metadata?.batchObjective === 'string' && task.metadata.batchObjective.trim()) {
      return task.metadata.batchObjective.trim();
    }
    const context = String(task.payload.context || '').trim();
    const match = context.match(/^Batch Objective:\s*(.+)$/i);
    return match?.[1]?.trim() || context || '(no objective)';
  }

  private buildLocalSynthesisForTask(task: SwarmTask): string {
    const objective = this.getBatchObjectiveFromTask(task);
    const batchId = typeof task.metadata?.batchId === 'string' ? task.metadata.batchId : '';
    const batch = batchId ? this.stateStore.getBatch(batchId) : null;

    if (!batch) {
      return [
        'Jarvis Local Synthesis',
        `Objective: ${objective}`,
        'Status: batch context not found; returning direct fallback response.',
      ].join('\n');
    }
    return this.batchManager.buildLocalSynthesisForBatch(
      batch,
      (output) => this.sanitizeAssignmentOutput(output),
      (output) => this.batchManager.extractLaneHighlights(output, (o) => this.sanitizeAssignmentOutput(o)),
      objective,
    );
  }

  private getCliPreferredDispatchMode(specialistName: string): CliDispatchMode {
    const preferred = this.stateStore.getCliPreferredDispatchMode().get(specialistName);
    if (preferred === 'prefix' || preferred === 'shell') return preferred;
    return SWARM_CLI_SHELL_STYLE_MODE ? 'shell' : 'prefix';
  }

  private setCliPreferredDispatchMode(specialistName: string, mode: CliDispatchMode): void {
    this.stateStore.getCliPreferredDispatchMode().set(specialistName, mode);
  }

  private buildCliDispatchCommand(
    specialistName: string,
    prefix: string,
    outboundMessage: string,
    mode: CliDispatchMode,
  ): string {
    if (outboundMessage.startsWith('@')) return outboundMessage;
    if (mode === 'shell') return buildShellStyleCliCommand(specialistName, outboundMessage);
    return `${prefix} ${outboundMessage}`;
  }

  private buildCliDispatchAttempts(
    task: SwarmTask,
    specialistName: string,
    prefix: string,
    outboundMessage: string,
  ): CliDispatchAttempt[] {
    const maxAttempts = Math.max(
      1,
      Math.min(
        3,
        readPositiveIntEnv('SWARM_CLI_ADAPTIVE_MAX_ATTEMPTS', DEFAULT_SWARM_CLI_ADAPTIVE_MAX_ATTEMPTS),
      ),
    );
    const timeoutStepMs = readPositiveIntEnv(
      'SWARM_CLI_ADAPTIVE_TIMEOUT_STEP_MS',
      DEFAULT_SWARM_CLI_ADAPTIVE_TIMEOUT_STEP_MS,
    );
    const configuredTimeoutMs = readPositiveIntEnv(
      'SWARM_CLI_TASK_TIMEOUT_MS',
      DEFAULT_SWARM_CLI_TASK_TIMEOUT_MS,
    );
    const baseTimeoutMs = Math.max(task.timeout || 0, configuredTimeoutMs);

    const preferredMode = this.getCliPreferredDispatchMode(specialistName);
    const orderedModes: CliDispatchMode[] = preferredMode === 'shell'
      ? ['shell', 'prefix']
      : ['prefix', 'shell'];

    const attempts: CliDispatchAttempt[] = [];
    const seenCommands = new Set<string>();

    for (let i = 0; i < orderedModes.length && attempts.length < maxAttempts; i++) {
      const mode = orderedModes[i];
      const command = this.buildCliDispatchCommand(specialistName, prefix, outboundMessage, mode);
      if (!command || seenCommands.has(command)) continue;
      seenCommands.add(command);
      attempts.push({
        mode,
        command,
        timeoutMs: baseTimeoutMs + (attempts.length * timeoutStepMs),
      });
    }

    if (attempts.length === 0) {
      attempts.push({
        mode: preferredMode,
        command: this.buildCliDispatchCommand(specialistName, prefix, outboundMessage, preferredMode),
        timeoutMs: baseTimeoutMs,
      });
    }

    return attempts.slice(0, maxAttempts);
  }

  private normalizeCliAttemptOutput(
    specialistName: string,
    execution: {
      output: string;
      tokenUsage?: CommandTokenUsage;
    },
  ): SpecialistExecutionResult {
    const output = String(execution.output || '').trim();
    if (!output) {
      return {
        output: '(no response)',
        tokenUsage: execution.tokenUsage,
      };
    }

    if (/CLI timeout exceeded/i.test(output)) {
      const partial = output
        .replace(/\n?CLI timeout exceeded[\s\S]*$/i, '')
        .trim();
      if (partial.length >= 160) {
        return {
          output: partial,
          tokenUsage: execution.tokenUsage,
        };
      }
      throw new Error('CLI timeout exceeded');
    }
    if (/^\(no final assistant response/i.test(output)) {
      throw new Error(output);
    }

    if (/^\[(?:error|agent error)\]/i.test(output)) {
      throw new Error(output);
    }

    const unusableReason = this.detectUnusableCliOutput(specialistName, output);
    if (unusableReason) {
      throw new Error(unusableReason);
    }

    // Minimum output quality: too short responses are likely not useful
    if (output.length < 50) {
      throw new Error(`${specialistName} returned too-short output (${output.length} chars)`);
    }

    return {
      output,
      tokenUsage: execution.tokenUsage,
    };
  }

  private async executeCliSpecialistTask(
    task: SwarmTask,
    specialistName: string,
    message: string,
  ): Promise<SpecialistExecutionResult> {
    const prefix = CLI_SPECIALIST_PREFIX[specialistName];
    if (!prefix) {
      throw new Error(`Unsupported CLI specialist: ${specialistName}`);
    }

    const sharedUserId = typeof task.metadata?.sharedUserId === 'string'
      ? task.metadata.sharedUserId
      : task.fromChatId;
    const specialistMessage = String(message || '').trim();
    if (!specialistMessage) {
      throw new Error(`Missing delegated prompt for ${specialistName}`);
    }
    const legacyInstruction = [
      'Return one final answer only.',
      'Do not ask what task to do; execute the task brief now.',
      'Do not wait for user confirmation.',
    ].join('\n');
    const outboundMessage = SWARM_CLI_DIRECT_COMMAND_MODE
      ? specialistMessage
      : [legacyInstruction, specialistMessage].join('\n\n');
    const attempts = this.buildCliDispatchAttempts(task, specialistName, prefix, outboundMessage);
    let lastError: Error | null = null;

    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];
      try {
        const execution = await Promise.race([
          executeCommandDetailed(attempt.command, 'swarm', sharedUserId),
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error(`Task execution timeout (${attempt.timeoutMs}ms)`)),
              attempt.timeoutMs,
            );
          }),
        ]) as Awaited<ReturnType<typeof executeCommandDetailed>>;

        const normalized = this.normalizeCliAttemptOutput(specialistName, execution);
        this.setCliPreferredDispatchMode(specialistName, attempt.mode);
        return normalized;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        lastError = err instanceof Error ? err : new Error(errorMsg);
        swarmInfo(
          `[SwarmCoordinator] ${specialistName} attempt ${i + 1}/${attempts.length} failed (${attempt.mode}): ${errorMsg}`,
        );
      }
    }

    throw lastError || new Error(`${specialistName} failed with no usable output`);
  }

  private async executeAgentSpecialistTask(
    task: SwarmTask,
    specialistName: string,
    message: string,
  ): Promise<string> {
    if (!this.agentInstance) {
      throw new Error('Agent instance not available');
    }

    const isJarvisLeader = specialistName === getRootAdminSpecialistName();
    const rootAdmin = getRootAdminIdentity();
    const executionContext: BotContext = {
      botId: isJarvisLeader ? rootAdmin.botId : `specialist_${specialistName}`,
      botName: isJarvisLeader ? rootAdmin.botName : `Specialist: ${specialistName}`,
      platform: 'custom',
      replyWithFile: async (filePath: string) => `[Swarm] Would send file: ${filePath}`,
    };

    return await Promise.race([
      this.agentInstance.processMessage(`swarm_${task.id}`, message, executionContext),
      new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error('Task execution timeout')), task.timeout);
      }),
    ]);
  }

  private attachAssignmentTokenUsage(taskId: string, tokenUsage: CommandTokenUsage): void {
    const batchId = this.stateStore.getBatchIdForTask(taskId);
    if (!batchId) return;

    const batch = this.stateStore.getBatch(batchId);
    if (!batch) return;

    const assignment = batch.assignments.find((item: SwarmBatchAssignment) => item.taskId === taskId);
    if (!assignment) return;

    const promptTokens = tokenUsage.promptTokens;
    const completionTokens = tokenUsage.completionTokens;
    const totalTokens =
      tokenUsage.totalTokens !== undefined
        ? tokenUsage.totalTokens
        : (promptTokens || 0) + (completionTokens || 0);

    assignment.tokenUsage = {
      ...tokenUsage,
      promptTokens,
      completionTokens,
      totalTokens,
    };
  }

  /**
   * Report result back to originator (placeholder for future integration).
   */
  private async reportResult(task: SwarmTask): Promise<void> {
    if (task.result) {
      swarmInfo(`[SwarmCoordinator] Result for task ${task.id}: ${task.result.substring(0, 100)}...`);
    }
  }

  private async handleTaskLifecycleUpdate(task: SwarmTask): Promise<void> {
    const batchId = this.stateStore.getBatchIdForTask(task.id);
    if (!batchId) return;

    const batch = this.stateStore.getBatch(batchId);
    if (!batch) return;

    const assignment = batch.assignments.find((item) => item.taskId === task.id);
    if (!assignment) return;

    if (task.toSpecialist) {
      assignment.specialist = task.toSpecialist;
      assignment.specialistHistory = Array.from(new Set([...(assignment.specialistHistory || []), task.toSpecialist]));
    }
    if (typeof task.metadata?.batchStage === 'string') {
      assignment.batchStage = task.metadata.batchStage;
    }
    if (typeof task.metadata?.workIntent === 'string') {
      assignment.workIntent = task.metadata.workIntent;
    }
    if (typeof task.metadata?.supervisorAction === 'string') {
      assignment.supervisorAction = task.metadata.supervisorAction as SwarmBatchAssignment['supervisorAction'];
    }
    if (typeof task.metadata?.sourceTaskId === 'string') {
      assignment.sourceTaskId = task.metadata.sourceTaskId;
    }
    assignment.status = task.status;
    assignment.result = task.result;
    assignment.error = task.error;
    const synthesisAssignment = batch.assignments.find((item) => item.batchStage === 'synthesis');

    if (assignment.batchStage === 'synthesis' && typeof task.result === 'string' && task.result.trim()) {
      batch.summary = this.sanitizeAssignmentOutput(task.result);
    }
    if (SWARM_LOCAL_SYNTHESIS && synthesisAssignment && synthesisAssignment.status === 'completed') {
      const refreshedSummary = this.batchManager.buildLocalSynthesisForBatch(
        batch,
        (output) => this.sanitizeAssignmentOutput(output),
        (output) => this.batchManager.extractLaneHighlights(output, (o) => this.sanitizeAssignmentOutput(o)),
      );
      batch.summary = refreshedSummary;
      synthesisAssignment.result = refreshedSummary;
    }

    if (!batch.startedAt && (task.status === 'processing' || task.status === 'completed' || task.status === 'failed')) {
      batch.startedAt = new Date().toISOString();
    }

    await this.maybeRunSupervisorLoop(batch.id);
    this.batchManager.recomputeBatchProgress(batch);
    await this.emitBatchUpdate(batch);

    const doneCount = batch.progress.completed + batch.progress.failed;
    const allDone = doneCount >= batch.progress.total;
    if (allDone && !batch.completedAt) {
      batch.completedAt = new Date().toISOString();
      batch.status = batch.progress.failed === 0
        ? 'completed'
        : batch.progress.completed === 0
          ? 'failed'
          : 'partial';
      if (!batch.summary?.trim()) {
        batch.summary = this.batchManager.buildBatchSummary(batch, (output) => this.sanitizeAssignmentOutput(output));
      }
      await this.emitBatchComplete(batch);
      // Save batch results to archival memory for future recall
      this.saveBatchToArchival(batch).catch((err) =>
        console.error('[SwarmCoordinator] Failed to save batch to archival:', err),
      );
    }
  }


  /**
   * Save batch results to archival memory for future recall.
   */
  private async saveBatchToArchival(batch: SwarmBatch): Promise<void> {
    if (!batch.summary?.trim()) return;
    const completedCount = batch.progress.completed;
    if (completedCount === 0) return;

    const chatId = typeof batch.createdBy === 'string' && batch.createdBy.includes('_')
      ? batch.createdBy.split('_').slice(-1)[0]
      : batch.createdBy || 'swarm';

    const fact = [
      `[Swarm Batch ${batch.id}]`,
      `Objective: ${batch.objective}`,
      `Status: ${batch.status} (${completedCount}/${batch.progress.total} completed)`,
      `Summary: ${batch.summary.slice(0, 500)}`,
    ].join(' | ');

    try {
      await saveArchivalFact(chatId, fact);
      swarmInfo(`[SwarmCoordinator] Batch ${batch.id} saved to archival memory`);
    } catch (err) {
      console.error('[SwarmCoordinator] Archival save failed:', err);
    }
  }

  private async emitBatchUpdate(batch: SwarmBatch): Promise<void> {
    const snapshot = this.batchManager.cloneBatch(batch);
    for (const listener of this.stateStore.getBatchUpdateListeners()) {
      try { await listener(snapshot); } catch (err) {
        console.error('[SwarmCoordinator] Batch update listener error:', err);
      }
    }
  }

  private async emitBatchComplete(batch: SwarmBatch): Promise<void> {
    const snapshot = this.batchManager.cloneBatch(batch);
    for (const listener of this.stateStore.getBatchCompleteListeners()) {
      try { await listener(snapshot); } catch (err) {
        console.error('[SwarmCoordinator] Batch complete listener error:', err);
      }
    }
  }

  /**
   * Start periodic processing loop.
   */
  private startProcessingLoop(): void {
    if (this.processingInterval) return;

    this.processingInterval = setInterval(async () => {
      try {
        await this.processPendingTasks();
      } catch (err) {
        console.error('[SwarmCoordinator] Error in processing loop:', err);
      }
    }, this.processingIntervalMs);

    swarmInfo(`[SwarmCoordinator] Processing loop started (every ${this.processingIntervalMs}ms)`);
  }

  /**
   * Stop processing loop.
   */
  private stopProcessingLoop(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
      swarmInfo('[SwarmCoordinator] Processing loop stopped');
    }
  }

  /**
   * Get internal task queue (for registering global callbacks).
   */
  getTaskQueue(): TaskQueue {
    return this.taskQueue;
  }

  /**
   * Get current swarm status.
   */
  getStatus(): {
    isRunning: boolean;
    agentReady: boolean;
    queue: ReturnType<TaskQueue['getStats']>;
    specialists: ReturnType<typeof getAvailableSpecialists>;
    specialistRuntime: SpecialistRuntimeHealth[];
    batches: { total: number; active: number; completed: number };
  } {
    const allBatches = Array.from(this.stateStore.getBatches().values());
    const active = allBatches.filter((batch) => batch.status === 'queued' || batch.status === 'running').length;
    const completed = allBatches.filter((batch) =>
      batch.status === 'completed' || batch.status === 'failed' || batch.status === 'partial').length;

    return {
      isRunning: this.processingInterval !== null,
      agentReady: this.agentInstance !== null,
      queue: this.taskQueue.getStats(),
      specialists: getAvailableSpecialists(),
      specialistRuntime: this.getSpecialistRuntimeHealth(),
      batches: {
        total: allBatches.length,
        active,
        completed,
      },
    };
  }

  /**
   * Get task details.
   */
  async getTask(taskId: string): Promise<SwarmTask | null> {
    return this.taskQueue.getStatus(taskId);
  }

  /**
   * List tasks with optional filtering.
   */
  async listTasks(filter?: {
    status?: TaskStatus;
    platform?: string;
    specialist?: string;
    batchId?: string;
    limit?: number;
  }): Promise<SwarmTask[]> {
    const tasks = await this.taskQueue.listAll(filter);
    if (!filter?.batchId) return tasks;
    return tasks.filter((task) => task.metadata?.batchId === filter.batchId);
  }

  /**
   * Cancel a queued task.
   */
  async cancelTask(taskId: string, reason: string = 'Cancelled by user'): Promise<{ success: boolean; error?: string }> {
    return this.taskQueue.cancel(taskId, reason);
  }

  getBatch(batchId: string): SwarmBatch | null {
    const batch = this.stateStore.getBatch(batchId);
    return batch ? this.batchManager.cloneBatch(batch) : null;
  }

  listBatches(limit: number = 50): SwarmBatch[] {
    return Array.from(this.stateStore.getBatches().values())
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, Math.max(1, limit))
      .map((batch) => this.batchManager.cloneBatch(batch));
  }

  /**
   * Get all available specialists.
   */
  getAvailableSpecialists() {
    return getAvailableSpecialists();
  }

  getSpecialistRuntimeHealth(): SpecialistRuntimeHealth[] {
    return this.healthTracker.getSpecialistRuntimeHealth();
  }

  /**
   * Graceful shutdown.
   */
  async shutdown(): Promise<void> {
    swarmInfo('[SwarmCoordinator] Shutting down...');

    this.stopProcessingLoop();
    this.taskQueue.stopCleanup();
    this.taskQueue.clear();
    this.stateStore.clear();
    this.healthTracker.clear();

    swarmInfo('[SwarmCoordinator] Shutdown complete');
  }

}

/**
 * Global coordinator instance.
 */
let _coordinatorInstance: SwarmCoordinator | null = null;

/**
 * Get or create global coordinator instance.
 */
export function getSwarmCoordinator(): SwarmCoordinator {
  if (!_coordinatorInstance) {
    _coordinatorInstance = new SwarmCoordinator();
  }
  return _coordinatorInstance;
}

export default SwarmCoordinator;

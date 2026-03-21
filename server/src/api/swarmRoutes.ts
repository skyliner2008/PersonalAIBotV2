/**
 * Swarm Coordination API Routes
 * Provides endpoints for managing swarm tasks and monitoring coordination
 */

import express from 'express';
import { getSwarmCoordinator, type JarvisDelegationTask } from '../swarm/swarmCoordinator.js';
import { getSpecialistMetrics } from '../swarm/specialists.js';
import { buildJarvisDelegationPlan, type JarvisPlannerOptions } from '../swarm/jarvisPlanner.js';
import { buildRuntimeJarvisPlannerOptions } from '../swarm/jarvisRuntimePlanning.js';
import { requireReadWriteAuth } from '../utils/auth.js';
import { startMeeting, formatMeetingResult, type MeetingSession } from '../swarm/roundtable.js';
import { Agent } from '../bot_agents/agent.js';
import { getRootAdminIdentity, getRootAdminSpecialistName } from '../system/rootAdmin.js';
import { classifySwarmError } from '../swarm/swarmErrorCodes.js';

const router = express.Router();
const coordinator = getSwarmCoordinator();
router.use(requireReadWriteAuth('viewer'));

function toOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return undefined;
}

async function buildDefaultJarvisPlan(objective: string, multipass?: boolean): Promise<JarvisDelegationTask[]> {
  const runtimeHealth = coordinator.getSpecialistRuntimeHealth();
  const options: JarvisPlannerOptions = await buildRuntimeJarvisPlannerOptions(objective, runtimeHealth, multipass);
  return buildJarvisDelegationPlan(objective, options);
}

/**
 * GET /api/swarm/status
 * Get current swarm coordinator status and statistics
 */
router.get('/status', async (_req, res) => {
  try {
    const status = coordinator.getStatus();
    res.json({
      success: true,
      status,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * GET /api/swarm/tasks
 * List all tasks with optional filtering
 * Query params: status, platform, specialist, limit
 */
router.get('/tasks', async (req, res) => {
  try {
    const { status, platform, specialist, limit, batchId } = req.query;

    const tasks = await coordinator.listTasks({
      status: status as any,
      platform: platform as string,
      specialist: specialist as string,
      batchId: batchId as string,
      limit: limit ? parseInt(String(limit)) : 50,
    });

    res.json({
      success: true,
      tasks,
      count: tasks.length,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * GET /api/swarm/batches
 * List Jarvis orchestration batches.
 */
router.get('/batches', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    const batches = coordinator.listBatches(Number.isFinite(limit) ? limit : 50);
    res.json({
      success: true,
      batches,
      count: batches.length,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * GET /api/swarm/batches/:id
 * Get one Jarvis orchestration batch.
 */
router.get('/batches/:id', async (req, res) => {
  try {
    const batch = coordinator.getBatch(req.params.id);
    if (!batch) {
      return res.status(404).json({
        success: false,
        error: 'Batch not found',
      });
    }
    return res.json({
      success: true,
      batch,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * GET /api/swarm/tasks/:id
 * Get detailed task status and result
 */
router.get('/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const task = await coordinator.getTask(id);

    if (!task) {
      return res.status(404).json({
        success: false,
        error: 'Task not found',
      });
    }

    res.json({
      success: true,
      task,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * GET /api/swarm/specialists
 * List all available specialists and their capabilities
 */
router.get('/specialists', async (_req, res) => {
  try {
    const specialists = coordinator.getAvailableSpecialists();
    const metrics = getSpecialistMetrics();
    const runtimeHealth = coordinator.getSpecialistRuntimeHealth();

    res.json({
      success: true,
      specialists,
      metrics,
      runtimeHealth,
      count: specialists.length,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * POST /api/swarm/tasks
 * Manually submit a task to the swarm
 * Body: { fromPlatform, taskType, message, specialist?, priority?, timeout? }
 */
router.post('/tasks', async (req, res) => {
  try {
    const { fromPlatform, taskType, message, specialist, priority, timeout, dependsOn, maxRetries } = req.body;

    if (!fromPlatform || !taskType || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: fromPlatform, taskType, message',
      });
    }

    // Create a temporary context for manual submission
    const ctx = {
      botId: 'manual_submission',
      botName: 'Manual Submission',
      platform: fromPlatform as any,
      replyWithFile: async () => '',
    };

    const taskId = await coordinator.delegateTask(ctx, taskType as any, { message }, {
      toSpecialist: specialist,
      priority: priority ? parseInt(priority) : undefined,
      timeout: timeout ? parseInt(timeout) : undefined,
      dependsOn: dependsOn as string[] | undefined,
      maxRetries: maxRetries ? parseInt(maxRetries) : 0,
    });

    res.json({
      success: true,
      taskId,
      message: 'Task submitted to swarm',
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * POST /api/swarm/jarvis/orchestrate
 * Launch a multi-agent batch where Jarvis delegates to Gemini/Codex/Claude and aggregates results.
 * Body:
 * {
 *   objective: string,
 *   fromPlatform?: string,
 *   fromChatId?: string,
 *   initiatorId?: string,
 *   multipass?: boolean,
 *   tasks?: Array<{ title, specialist, message, taskType?, dependsOn?, priority?, timeout?, maxRetries? }>
 * }
 */
router.post('/jarvis/orchestrate', async (req, res) => {
  try {
    const {
      objective,
      fromPlatform = 'custom',
      fromChatId = 'jarvis_dashboard',
      initiatorId,
      tasks,
      multipass,
    } = req.body || {};

    if (!objective || typeof objective !== 'string' || !objective.trim()) {
      return res.status(400).json({
        success: false,
        error: 'objective is required',
      });
    }

    const rootAdmin = getRootAdminIdentity();
    const rootSpecialist = getRootAdminSpecialistName();
    const ctx = {
      botId: rootAdmin.botId,
      botName: rootAdmin.botName,
      platform: String(fromPlatform) as any,
      replyWithFile: async () => '',
    };

    const normalizedTasks: JarvisDelegationTask[] = Array.isArray(tasks) && tasks.length > 0
      ? tasks.map((task: any, index: number) => ({
        title: String(task?.title || `Task ${index + 1}`),
        specialist: String(task?.specialist || rootSpecialist),
        message: String(task?.message || ''),
        taskType: (task?.taskType || 'general') as any,
        dependsOn: Array.isArray(task?.dependsOn)
          ? task.dependsOn.map((v: any) => parseInt(String(v), 10)).filter((v: number) => Number.isFinite(v))
          : undefined,
        dependencyMode: typeof task?.dependencyMode === 'string' ? task.dependencyMode : undefined,
        minCompletedDependencies: task?.minCompletedDependencies
          ? parseInt(String(task.minCompletedDependencies), 10)
          : undefined,
        priority: task?.priority ? parseInt(String(task.priority), 10) : undefined,
        timeout: task?.timeout ? parseInt(String(task.timeout), 10) : undefined,
        maxRetries: task?.maxRetries ? parseInt(String(task.maxRetries), 10) : undefined,
        metadata: task?.metadata && typeof task.metadata === 'object' ? task.metadata : undefined,
      }))
      : await buildDefaultJarvisPlan(objective.trim(), toOptionalBoolean(multipass));

    const invalidTask = normalizedTasks.find((task) => !task.message || !task.message.trim());
    if (invalidTask) {
      return res.status(400).json({
        success: false,
        error: `Task "${invalidTask.title}" has empty message`,
      });
    }

    const batch = await coordinator.orchestrateJarvisTeam(
      ctx,
      objective.trim(),
      normalizedTasks,
      {
        initiatorId: initiatorId ? String(initiatorId) : undefined,
        fromChatId: String(fromChatId),
        metadata: {
          source: 'swarmRoutes.jarvis.orchestrate',
        },
      },
    );

    return res.json({
      success: true,
      batch,
      message: `Batch created with ${batch.assignments.length} delegated tasks`,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * POST /api/swarm/task-chain
 * Submit a chain of dependent tasks
 * Body: { fromPlatform, tasks: [{ taskType, message, specialist? }], priority?, timeout? }
 */
router.post('/task-chain', async (req, res) => {
  try {
    const { fromPlatform, tasks, priority, timeout } = req.body;

    if (!fromPlatform || !tasks || !Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: fromPlatform, tasks (array)',
      });
    }

    const ctx = {
      botId: 'manual_chain',
      botName: 'Manual Chain Submission',
      platform: fromPlatform as any,
      replyWithFile: async () => '',
    };

    const chainTasks = tasks.map((t: any) => ({
      taskType: t.taskType as any,
      payload: { message: t.message, context: t.context },
      toSpecialist: t.specialist,
      maxRetries: t.maxRetries || 1,
    }));

    const taskIds = await coordinator.delegateTaskChain(ctx, chainTasks, {
      basePriority: priority ? parseInt(priority) : 3,
      timeout: timeout ? parseInt(timeout) : undefined,
    });

    res.json({
      success: true,
      taskIds,
      count: taskIds.length,
      message: `Task chain submitted: ${taskIds.length} tasks with sequential dependencies`,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * GET /api/swarm/stats
 * Get detailed queue and performance statistics
 */
router.get('/stats', async (_req, res) => {
  try {
    const status = coordinator.getStatus();
    const tasks = await coordinator.listTasks({ limit: 100 });

    // Calculate stats
    const stats = {
      uptime: process.uptime(),
      queue: status.queue,
      tasksByStatus: {
        queued: tasks.filter(t => t.status === 'queued').length,
        processing: tasks.filter(t => t.status === 'processing').length,
        completed: tasks.filter(t => t.status === 'completed').length,
        failed: tasks.filter(t => t.status === 'failed').length,
      },
      tasksByType: {} as Record<string, number>,
      tasksBySpecialist: {} as Record<string, number>,
    };

    for (const task of tasks) {
      stats.tasksByType[task.taskType] = (stats.tasksByType[task.taskType] || 0) + 1;
      if (task.toSpecialist) {
        stats.tasksBySpecialist[task.toSpecialist] = (stats.tasksBySpecialist[task.toSpecialist] || 0) + 1;
      }
    }

    res.json({
      success: true,
      stats,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * POST /api/swarm/task/:id/cancel
 * Cancel a pending task (not yet started)
 */
router.post('/task/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim()
      : 'Cancelled by API request';
    const task = await coordinator.getTask(id);

    if (!task) {
      return res.status(404).json({
        success: false,
        error: 'Task not found',
      });
    }

    if (task.status !== 'queued') {
      return res.status(400).json({
        success: false,
        error: `Cannot cancel task with status: ${task.status}`,
      });
    }

    const cancelled = await coordinator.cancelTask(id, reason);
    if (!cancelled.success) {
      return res.status(400).json({
        success: false,
        error: cancelled.error || 'Unable to cancel task',
      });
    }

    return res.json({
      success: true,
      taskId: id,
      status: 'failed',
      reason: `Cancelled: ${reason}`,
      message: 'Task cancelled successfully',
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * GET /api/swarm/lane-metrics
 * Per-specialist (lane) performance metrics with computed rates
 */
router.get('/lane-metrics', async (_req, res) => {
  try {
    const runtimeHealth = coordinator.getSpecialistRuntimeHealth();

    const metrics = runtimeHealth.map((h) => {
      const successRate = h.totalTasks > 0 ? h.successes / h.totalTasks : 0;
      const failureRate = h.totalTasks > 0 ? h.failures / h.totalTasks : 0;
      const timeoutRate = h.totalTasks > 0 ? h.timeouts / h.totalTasks : 0;
      const rerouteRate = h.totalTasks > 0 ? h.reroutes / h.totalTasks : 0;

      return {
        specialist: h.specialist,
        state: h.state,
        totalTasks: h.totalTasks,
        successes: h.successes,
        failures: h.failures,
        timeouts: h.timeouts,
        reroutes: h.reroutes,
        consecutiveFailures: h.consecutiveFailures,
        averageLatencyMs: h.averageLatencyMs ?? null,
        lastError: h.lastError ?? null,
        lastSuccessAt: h.lastSuccessAt ?? null,
        lastFailureAt: h.lastFailureAt ?? null,
        rates: {
          success: Math.round(successRate * 10000) / 100,
          failure: Math.round(failureRate * 10000) / 100,
          timeout: Math.round(timeoutRate * 10000) / 100,
          reroute: Math.round(rerouteRate * 10000) / 100,
        },
      };
    });

    res.json({
      success: true,
      metrics,
      count: metrics.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * GET /api/swarm/batches/:id/failures
 * Drilldown into failed tasks of a specific batch
 */
router.get('/batches/:id/failures', async (req, res) => {
  try {
    const batch = coordinator.getBatch(req.params.id);
    if (!batch) {
      return res.status(404).json({
        success: false,
        error: 'Batch not found',
      });
    }

    const failedAssignments = batch.assignments
      .filter((a) => a.status === 'failed')
      .map((a) => ({
        index: a.index,
        taskId: a.taskId,
        title: a.title,
        specialist: a.specialist,
        specialistHistory: a.specialistHistory ?? [],
        taskType: a.taskType,
        error: a.error ?? 'Unknown error',
        errorCode: classifySwarmError(a.error),
        supervisorAction: a.supervisorAction ?? null,
      }));

    return res.json({
      success: true,
      batchId: batch.id,
      objective: batch.objective,
      status: batch.status,
      totalTasks: batch.assignments.length,
      failedCount: failedAssignments.length,
      failures: failedAssignments,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * GET /api/swarm/health
 * Health check for swarm system
 */
router.get('/health', async (_req, res) => {
  try {
    const status = coordinator.getStatus();
    const isHealthy = status.isRunning && status.agentReady;

    res.json({
      success: true,
      healthy: isHealthy,
      status: {
        running: status.isRunning,
        agentReady: status.agentReady,
        queueHealth: {
          hasQueuedTasks: status.queue.queued > 0,
          processingCount: status.queue.processing,
          completedCount: status.queue.completed,
          failedCount: status.queue.failed,
        },
      },
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});


/**
 * POST /api/swarm/preflight
 * Pre-batch health check: validates whether requested specialists are healthy enough to accept work.
 * Body: { specialists?: string[], minHealthyLanes?: number }
 * Returns per-specialist readiness and an overall go/no-go recommendation.
 */
router.post('/preflight', async (req, res) => {
  try {
    const { specialists, minHealthyLanes } = req.body || {};
    const runtimeHealth = coordinator.getSpecialistRuntimeHealth();

    // If specific specialists are requested, filter; otherwise check all
    const requestedNames: string[] = Array.isArray(specialists) && specialists.length > 0
      ? specialists.map(String)
      : runtimeHealth.map((h) => h.specialist);

    const healthMap = new Map(runtimeHealth.map((h) => [h.specialist, h]));
    const laneChecks = requestedNames.map((name) => {
      const health = healthMap.get(name);
      if (!health) {
        return { specialist: name, ready: false, state: 'unknown' as const, reason: 'No runtime data available' };
      }
      const ready = health.state === 'idle' || health.state === 'healthy' || health.state === 'degraded';
      return {
        specialist: name,
        ready,
        state: health.state,
        consecutiveFailures: health.consecutiveFailures,
        reason: ready ? null : `State is ${health.state} with ${health.consecutiveFailures} consecutive failures`,
      };
    });

    const healthyCount = laneChecks.filter((l) => l.ready).length;
    const requiredCount = typeof minHealthyLanes === 'number' && minHealthyLanes > 0
      ? minHealthyLanes
      : Math.max(1, Math.ceil(requestedNames.length * 0.5)); // default: at least 50% healthy

    const go = healthyCount >= requiredCount;

    res.json({
      success: true,
      go,
      healthyLanes: healthyCount,
      totalLanes: requestedNames.length,
      requiredHealthyLanes: requiredCount,
      lanes: laneChecks,
      recommendation: go
        ? 'All systems ready for batch execution'
        : `Only ${healthyCount}/${requiredCount} required lanes are healthy — consider delaying or reducing scope`,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// --- MeetingRoom (Roundtable) Endpoints ---

const meetingSessions = new Map<string, MeetingSession>();
const MAX_STORED_MEETINGS = 50;

function storeMeeting(session: MeetingSession): void {
  meetingSessions.set(session.id, session);
  if (meetingSessions.size > MAX_STORED_MEETINGS) {
    const oldest = meetingSessions.keys().next().value;
    if (oldest) meetingSessions.delete(oldest);
  }
}

router.post('/meeting/start', async (req, res) => {
  try {
    const { objective, maxRounds, timeoutPerCliMs } = req.body || {};
    if (!objective || typeof objective !== 'string' || !objective.trim()) {
      return res.status(400).json({ success: false, error: 'objective is required' });
    }

    let agentInstance: Agent | undefined;
    try { agentInstance = new Agent(); } catch (e) { console.warn('[SwarmRoutes] Agent init failed:', String(e)); }

    const placeholderId = `meeting_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const placeholder: MeetingSession = {
      id: placeholderId,
      objective: objective.trim(),
      participants: [],
      rounds: [],
      transcript: [],
      maxRounds: Math.min(3, Math.max(1, maxRounds || 2)),
      status: 'preparing',
      createdAt: Date.now(),
    };
    storeMeeting(placeholder);

    startMeeting(objective.trim(), {
      id: placeholderId,
      maxRounds: placeholder.maxRounds,
      timeoutPerCliMs: timeoutPerCliMs || 90_000,
      agentInstance,
      onParticipantsDiscovered: (participants) => {
        placeholder.participants = participants;
      },
      onStatusChanged: (status) => {
        placeholder.status = status;
      }
    }).then((session) => {
      meetingSessions.delete(placeholderId);
      storeMeeting(session);
    }).catch((err) => {
      placeholder.status = 'failed';
      placeholder.synthesis = `Meeting failed: ${err instanceof Error ? err.message : String(err)}`;
      placeholder.completedAt = Date.now();
    });

    return res.json({ success: true, meetingId: placeholderId, message: 'Meeting started' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/meeting/:id', async (req, res) => {
  try {
    const session = meetingSessions.get(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Meeting not found' });
    return res.json({
      success: true,
      meeting: session,
      formatted: (session.status === 'done' || session.status === 'failed') ? formatMeetingResult(session) : undefined,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/meetings', async (_req, res) => {
  try {
    const sessions = Array.from(meetingSessions.values()).sort((a, b) => b.createdAt - a.createdAt);
    return res.json({
      success: true,
      meetings: sessions.map((s) => ({
        id: s.id, objective: s.objective, status: s.status,
        participants: s.participants, rounds: s.rounds.length,
        createdAt: s.createdAt, completedAt: s.completedAt, totalDurationMs: s.totalDurationMs,
      })),
      count: sessions.length,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;

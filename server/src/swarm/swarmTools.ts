/**
 * Swarm tools that let agents delegate and coordinate specialist work.
 */

import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { getSwarmCoordinator } from './swarmCoordinator.js';
import type { BotContext } from '../bot_agents/types.js';
import { startNewWorkspace } from './workspace.js';
import { Agent } from '../bot_agents/agent.js';
import { startMeeting, formatMeetingResult } from './roundtable.js';

/**
 * Delegate a subtask to a specialist lane.
 */
export const delegateTaskDeclaration: FunctionDeclaration = {
  name: 'delegate_task',
  description: 'Delegate a subtask to a swarm specialist (vision, code, translation, research, analysis, summary).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      task_type: {
        type: Type.STRING,
        description: 'Task type: vision_analysis, code_review, code_generation, translation, web_search, data_analysis, summarization',
      },
      message: {
        type: Type.STRING,
        description: 'Task instruction for the specialist',
      },
      specialist: {
        type: Type.STRING,
        description: 'Optional specialist name override (for example: vision, coder, researcher, translator, analyst)',
      },
      priority: {
        type: Type.STRING,
        description: 'Priority: low (1), normal (3), high (5). Default is 3.',
      },
    },
    required: ['task_type', 'message'],
  },
};

/**
 * Ask reviewer lane for strict critique.
 */
export const requestPeerReviewDeclaration: FunctionDeclaration = {
  name: 'request_peer_review',
  description: 'Request strict peer review for code, reasoning, or plan quality.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      content_to_review: {
        type: Type.STRING,
        description: 'Content to review',
      },
      specific_concerns: {
        type: Type.STRING,
        description: 'Optional focus points or concerns',
      },
    },
    required: ['content_to_review'],
  },
};

/**
 * Check swarm queue and runtime status.
 */
export const checkSwarmStatusDeclaration: FunctionDeclaration = {
  name: 'check_swarm_status',
  description: 'Check swarm status, queue depth, and specialist readiness.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      detail_level: {
        type: Type.STRING,
        description: 'summary or detailed',
      },
    },
  },
};

/**
 * List available specialists.
 */
export const listSpecialistsDeclaration: FunctionDeclaration = {
  name: 'list_specialists',
  description: 'List available specialists and their capabilities.',
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

/**
 * Start background project workspace loop.
 */
export const startProjectWorkspaceDeclaration: FunctionDeclaration = {
  name: 'start_project_workspace',
  description: 'Start a background project workspace where manager/coder/tester/reviewer can iterate toward a goal.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      goal: {
        type: Type.STRING,
        description: 'Main project objective',
      },
      max_turns: {
        type: Type.NUMBER,
        description: 'Optional max turns, default 50',
      },
    },
    required: ['goal'],
  },
};

/**
 * Start a roundtable discussion where all CLI agents collaborate.
 */
export const startRoundtableDeclaration: FunctionDeclaration = {
  name: 'start_roundtable',
  description: 'Start a roundtable discussion where Jarvis leads Gemini, Codex, and Claude CLIs in a collaborative multi-round discussion to answer a complex question.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      objective: {
        type: Type.STRING,
        description: 'Main topic or question for the roundtable discussion',
      },
      max_rounds: {
        type: Type.NUMBER,
        description: 'Maximum discussion rounds (1-3). Default is 2.',
      },
    },
    required: ['objective'],
  },
};

/**
 * Runtime handlers for swarm tools.
 */
async function handleDelegateTask(coordinator: any, ctx: BotContext, args: any) {
  const taskType = String(args.task_type ?? '').toLowerCase() as any;
  const message = String(args.message ?? '');
  const specialist = args.specialist ? String(args.specialist).toLowerCase() : undefined;
  const priorityStr = args.priority ? String(args.priority).toLowerCase() : '3';

  let priority = 3;
  if (priorityStr === 'low' || priorityStr === '1') priority = 1;
  if (priorityStr === 'high' || priorityStr === '5') priority = 5;

  if (!message) {
    return '[ERR] message is required';
  }

  try {
    const taskId = await coordinator.delegateTask(
      ctx,
      taskType,
      { message },
      { toSpecialist: specialist, priority },
    );

    const result = await coordinator.waitForTaskResult(taskId, 120000);

    if (result.status === 'completed' && result.result) {
      return `[OK] Task completed\n${result.result}`;
    }
    if (result.status === 'failed') {
      return `[ERR] Task failed: ${result.error}`;
    }
    return `[WAIT] Task still running (taskId=${taskId})`;
  } catch (err) {
    return `[ERR] Failed to delegate task: ${String(err)}`;
  }
}

async function handleRequestPeerReview(coordinator: any, ctx: BotContext, args: any) {
  const contentToReview = String(args.content_to_review ?? '');
  const specificConcerns = args.specific_concerns
    ? String(args.specific_concerns)
    : 'Provide strict quality review and identify critical weaknesses.';

  if (!contentToReview) return '[ERR] content_to_review is required';

  const reviewPrompt = [
    'Perform strict peer review on the content below.',
    '',
    '[Content]',
    contentToReview,
    '',
    `[Concerns] ${specificConcerns}`,
    '',
    'Return PASS/FAIL and concrete fixes.',
  ].join('\n');

  try {
    const taskId = await coordinator.delegateTask(
      ctx,
      'code_review' as any,
      { message: reviewPrompt },
      { toSpecialist: 'reviewer', priority: 5 },
    );

    const result = await coordinator.waitForTaskResult(taskId, 120000);

    if (result.status === 'completed' && result.result) {
      return `[Peer Review]\n${result.result}`;
    }
    if (result.status === 'failed') {
      return `[ERR] Peer review failed: ${result.error}`;
    }
    return `[WAIT] Peer review still running (taskId=${taskId})`;
  } catch (err) {
    return `[ERR] Failed to request peer review: ${String(err)}`;
  }
}

async function handleCheckSwarmStatus(coordinator: any, args: any) {
  const detailLevel = args.detail_level ? String(args.detail_level).toLowerCase() : 'summary';

  try {
    const status = coordinator.getStatus();

    if (detailLevel === 'detailed') {
      const tasks = await coordinator.listTasks({ limit: 10 });

      let detail = '[Swarm Status - Detailed]\n';
      detail += `running: ${status.isRunning ? 'yes' : 'no'}\n`;
      detail += `agentReady: ${status.agentReady ? 'yes' : 'no'}\n`;
      detail += `queueQueued: ${status.queue.queued}\n`;
      detail += `queueProcessing: ${status.queue.processing}\n`;
      detail += `queueCompleted: ${status.queue.completed}\n`;
      detail += `queueFailed: ${status.queue.failed}\n`;

      if (status.queue.avgProcessingTimeMs) {
        detail += `queueAvgMs: ${status.queue.avgProcessingTimeMs}\n`;
      }

      detail += `specialists: ${status.specialists.length}\n`;
      for (const spec of status.specialists) {
        detail += `- ${spec.name}: ${spec.capabilities.join(', ')}\n`;
      }

      if (tasks.length > 0) {
        detail += '\nrecentTasks:\n';
        for (const task of tasks.slice(0, 5)) {
          detail += `- ${task.id}: ${task.status}\n`;
        }
      }

      return detail;
    }

    return [
      '[Swarm Status]',
      `queued: ${status.queue.queued}`,
      `processing: ${status.queue.processing}`,
      `completed: ${status.queue.completed}`,
      `failed: ${status.queue.failed}`,
      `specialists: ${status.specialists.length}`,
    ].join('\n');
  } catch (err) {
    return `[ERR] Failed to read swarm status: ${String(err)}`;
  }
}

async function handleListSpecialists(coordinator: any) {
  try {
    const specialists = coordinator.getAvailableSpecialists();

    let result = `[Specialists] total=${specialists.length}\n\n`;
    for (const spec of specialists) {
      result += `${spec.name.toUpperCase()}\n`;
      result += `  description: ${spec.description}\n`;
      result += `  capabilities: ${spec.capabilities.join(', ')}\n`;
      result += `  preferredModel: ${spec.preferredModel}\n\n`;
    }

    return result;
  } catch (err) {
    return `[ERR] Failed to list specialists: ${String(err)}`;
  }
}

async function handleStartProjectWorkspace(args: any) {
  const goal = String(args.goal ?? '');
  const maxTurns = typeof args.max_turns === 'number' ? args.max_turns : 50;

  if (!goal) return '[ERR] goal is required';

  try {
    const agentInstance = new Agent();
    const chatId = `workspace_root_${Date.now()}`;
    const workspaceId = await startNewWorkspace(goal, chatId, agentInstance, maxTurns);

    return [
      '[OK] Project workspace started',
      `workspaceId: ${workspaceId}`,
      `goal: ${goal}`,
      'Background manager loop is now active.',
    ].join('\n');
  } catch (err) {
    return `[ERR] Failed to start workspace: ${String(err)}`;
  }
}

async function handleStartRoundtable(args: any) {
  const objective = String(args.objective ?? '');
  const maxRounds = typeof args.max_rounds === 'number'
    ? Math.min(3, Math.max(1, args.max_rounds))
    : 2;

  if (!objective) return '[ERR] objective is required';

  try {
    let agentInstance: Agent | undefined;
    try {
      agentInstance = new Agent();
    } catch (err: any) { console.warn('Agent instantiation failed for synthesis (optional)', err); }

    const session = await startMeeting(objective, {
      maxRounds,
      agentInstance,
    });

    const result = formatMeetingResult(session);
    const participantCount = session.rounds[0]?.responses
      .filter((r: any) => r.status === 'success').length ?? 0;

    return [
      `[Roundtable Complete]`,
      `Status: ${session.status}`,
      `Participants: ${participantCount} responded`,
      `Rounds: ${session.rounds.length}`,
      `Duration: ${session.totalDurationMs}ms`,
      '',
      result,
    ].join('\n');
  } catch (err) {
    return `[ERR] Roundtable failed: ${String(err)}`;
  }
}

export function getSwarmToolHandlers(ctx: BotContext) {
  const coordinator = getSwarmCoordinator();

  return {
    delegate_task: (args: any) => handleDelegateTask(coordinator, ctx, args),
    request_peer_review: (args: any) => handleRequestPeerReview(coordinator, ctx, args),
    check_swarm_status: (args: any) => handleCheckSwarmStatus(coordinator, args),
    list_specialists: () => handleListSpecialists(coordinator),
    start_project_workspace: (args: any) => handleStartProjectWorkspace(args),
    start_roundtable: (args: any) => handleStartRoundtable(args),
  };
}

export const swarmToolDeclarations = [
  delegateTaskDeclaration,
  requestPeerReviewDeclaration,
  checkSwarmStatusDeclaration,
  listSpecialistsDeclaration,
  startProjectWorkspaceDeclaration,
  startRoundtableDeclaration,
];

export default {
  declarations: swarmToolDeclarations,
  getHandlers: getSwarmToolHandlers,
};

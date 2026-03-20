import { TaskType } from './config/aiConfig.js';

export interface ParsedExecutionPlan {
  objective: string;
  steps: string[];
}

export interface ReviewerDecision {
  verdict: 'pass' | 'revise';
  issues: string[];
  revisedReply?: string;
}

const REVIEWABLE_TASK_TYPES = new Set<TaskType>([
  TaskType.COMPLEX,
  TaskType.CODE,
  TaskType.DATA,
  TaskType.THINKING,
  TaskType.WEB_BROWSER,
]);

function cleanLine(text: string): string {
  return text
    .trim()
    .replace(/^\[+|\]+$/g, '')
    .replace(/\s+/g, ' ');
}

export function parseExecutionPlan(planText: string, fallbackObjective = ''): ParsedExecutionPlan | null {
  if (!planText.trim()) return null;

  const normalized = planText.replace(/\r/g, '');
  const goalMatch = normalized.match(/^\s*GOAL\s*:\s*(.+)$/im);
  const objective = cleanLine(goalMatch?.[1] ?? fallbackObjective);
  const steps: string[] = [];
  let inStepsSection = false;

  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^STEPS\s*:?\s*$/i.test(line)) {
      inStepsSection = true;
      continue;
    }

    if (inStepsSection && /^[A-Z_ ]+\s*:/i.test(line) && !/^\d+[\.\)]/.test(line)) {
      break;
    }

    const stepMatch = line.match(/^(?:\d+[\.\)]|[-*])\s+(.+)$/);
    if (!stepMatch) continue;
    if (!inStepsSection && !goalMatch) continue;

    const cleaned = cleanLine(stepMatch[1]);
    if (cleaned) steps.push(cleaned);
  }

  const uniqueSteps = steps.filter((step, index) => steps.indexOf(step) === index);
  if (!objective || uniqueSteps.length === 0) return null;

  return {
    objective,
    steps: uniqueSteps,
  };
}

export function isRetryableToolError(error: unknown): boolean {
  const err = error instanceof Error ? error : new Error(String(error));
  const message = `${err.name}: ${err.message}`.toLowerCase();

  const retryablePatterns = [
    'timeout',
    'timed out',
    'aborterror',
    '429',
    'too many requests',
    'rate limit',
    'resource exhausted',
    'temporarily unavailable',
    'temporary failure',
    'service unavailable',
    'bad gateway',
    'gateway timeout',
    'econnreset',
    'econnrefused',
    'etimedout',
    'socket hang up',
    'network',
    'fetch failed',
    'connection reset',
  ];

  const nonRetryablePatterns = [
    'validation',
    'invalid argument',
    'missing required',
    'not found',
    'enoent',
    'permission denied',
    'unauthorized',
    'forbidden',
    'syntaxerror',
  ];

  return retryablePatterns.some((pattern) => message.includes(pattern))
    && !nonRetryablePatterns.some((pattern) => message.includes(pattern));
}

export function shouldRunReviewerGate(
  taskType: TaskType,
  draftReply: string,
  turns: number,
  toolCallCount: number,
): boolean {
  if (!REVIEWABLE_TASK_TYPES.has(taskType)) return false;
  if (!draftReply.trim()) return false;
  if (toolCallCount > 0) return true;
  if (turns > 1) return true;
  return draftReply.trim().length >= 280;
}

export function parseReviewerDecision(reviewText: string): ReviewerDecision {
  const normalized = reviewText.replace(/\r/g, '').trim();
  const verdictMatch = normalized.match(/^\s*VERDICT\s*:\s*(PASS|REVISE|FAIL)\b/im);
  const verdict = verdictMatch?.[1]?.toUpperCase() === 'PASS' ? 'pass' : 'revise';

  const revisedIndex = normalized.search(/^\s*REVISED_REPLY\s*:/im);
  const revisedReply = revisedIndex >= 0
    ? normalized.slice(revisedIndex).replace(/^\s*REVISED_REPLY\s*:\s*/i, '').trim() || undefined
    : undefined;

  const issuesMatch = normalized.match(/^\s*ISSUES\s*:\s*(.*)$/im);
  let issuesSection = '';
  if (issuesMatch && typeof issuesMatch.index === 'number') {
    const inlineIssues = issuesMatch[1].trim();
    const blockStart = issuesMatch.index + issuesMatch[0].length;
    const blockEnd = revisedIndex >= 0 ? revisedIndex : normalized.length;
    const trailingIssues = normalized.slice(blockStart, blockEnd).trim();
    issuesSection = [inlineIssues, trailingIssues].filter(Boolean).join('\n');
  }

  const issues = issuesSection
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean);

  return {
    verdict,
    issues,
    revisedReply,
  };
}

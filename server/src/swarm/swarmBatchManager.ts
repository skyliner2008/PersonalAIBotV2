/**
 * Swarm Batch Manager
 * Handles batch lifecycle: creation, progress tracking, and summary generation
 */

import type { SwarmBatch, SwarmBatchAssignment, SwarmBatchProgress } from './swarmTypes.js';
import type { TaskStatus } from './taskQueue.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SwarmBatchManager');

export class SwarmBatchManager {
  /**
   * Generate a unique batch ID
   */
  generateBatchId(): string {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    return `batch_${ts}_${rand}`;
  }

  /**
   * Recompute batch progress based on assignment statuses
   */
  recomputeBatchProgress(batch: SwarmBatch): void {
    let queued = 0;
    let processing = 0;
    let completed = 0;
    let failed = 0;

    for (const assignment of batch.assignments) {
      if (assignment.status === 'queued') queued++;
      if (assignment.status === 'processing') processing++;
      if (assignment.status === 'completed') completed++;
      if (assignment.status === 'failed') failed++;
    }

    batch.progress = {
      total: batch.assignments.length,
      queued,
      processing,
      completed,
      failed,
    };

    if (completed + failed === batch.assignments.length) return;
    if (processing > 0 || completed > 0 || failed > 0) {
      batch.status = 'running';
      return;
    }
    batch.status = 'queued';
  }

  /**
   * Build a summary of batch results
   */
  buildBatchSummary(batch: SwarmBatch, sanitizeOutput: (output: string) => string): string {
    const sections = batch.assignments.map((assignment) => {
      const history = assignment.specialistHistory && assignment.specialistHistory.length > 1
        ? ` | history: ${assignment.specialistHistory.join(' -> ')}`
        : '';
      const header = `[${assignment.title}] (${assignment.specialist}${history})`;
      if (assignment.status === 'completed' && assignment.result) {
        return `${header}\n${assignment.result}`;
      }
      return `${header}\nFAILED: ${assignment.error || 'Unknown error'}`;
    });

    // Duplicate output detection: warn if two assignments produced very similar outputs
    const completedOutputs = batch.assignments
      .filter((a) => a.status === 'completed' && a.result)
      .map((a) => ({ title: a.title, specialist: a.specialist, result: a.result!.slice(0, 300).toLowerCase() }));
    for (let i = 0; i < completedOutputs.length; i++) {
      for (let j = i + 1; j < completedOutputs.length; j++) {
        if (completedOutputs[i].result === completedOutputs[j].result) {
          console.log(
            `[SwarmBatchManager] WARNING: Duplicate output detected between ${completedOutputs[i].specialist} and ${completedOutputs[j].specialist}`,
          );
          sections.push(`[WARNING] Duplicate output: ${completedOutputs[i].specialist} and ${completedOutputs[j].specialist} produced identical results`);
        }
      }
    }

    return sections.join('\n\n').slice(0, 12000);
  }

  /**
   * Clone a batch (deep copy for safe external sharing)
   */
  cloneBatch(batch: SwarmBatch): SwarmBatch {
    return {
      ...batch,
      taskIds: [...batch.taskIds],
      assignments: batch.assignments.map((assignment) => ({ ...assignment })),
      progress: { ...batch.progress },
      metadata: batch.metadata ? { ...batch.metadata } : undefined,
    };
  }

  /**
   * Extract lane highlights from output (first few lines)
   */
  extractLaneHighlights(value: string, sanitizeOutput: (output: string) => string, maxLines = 4, maxChars = 700): string {
    const lines = sanitizeOutput(value || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return '(no output)';
    const selected = lines.slice(0, maxLines).join(' | ');
    return selected.length > maxChars ? `${selected.slice(0, maxChars - 3)}...` : selected;
  }

  /**
   * Build local synthesis (fallback when LLM reviewer unavailable)
   */
  buildLocalSynthesisForBatch(
    batch: SwarmBatch,
    sanitizeOutput: (output: string) => string,
    extractHighlights: (value: string) => string,
    objectiveOverride?: string,
  ): string {
    const objective = (objectiveOverride || batch.objective || '(no objective)').trim();
    const lanes = batch.assignments.filter((assignment) => assignment.batchStage !== 'synthesis');
    const completed = lanes.filter((assignment) => assignment.status === 'completed');
    const failed = lanes.filter((assignment) => assignment.status === 'failed');
    const pending = lanes.filter((assignment) =>
      assignment.status === 'queued' || assignment.status === 'processing');
    const insufficient = completed
      .map((assignment) => ({
        assignment,
        reason: this.isWeakAssignmentOutput(assignment, sanitizeOutput),
      }))
      .filter((item): item is { assignment: SwarmBatchAssignment; reason: string } => Boolean(item.reason));
    const usableCompleted = completed.filter((assignment) =>
      !insufficient.some((item) => item.assignment.taskId === assignment.taskId));

    const completedText = usableCompleted.length > 0
      ? usableCompleted
        .map((assignment) => `- ${assignment.title} (${assignment.specialist}): ${extractHighlights(assignment.result || '')}`)
        .join('\n')
      : '- none';

    const failedText = failed.length > 0
      ? failed
        .map((assignment) => `- ${assignment.title} (${assignment.specialist}): ${assignment.error || 'failed'}`)
        .join('\n')
      : '- none';

    const pendingText = pending.length > 0
      ? pending
        .map((assignment) => `- ${assignment.title} (${assignment.specialist})`)
        .join('\n')
      : '- none';

    const insufficientText = insufficient.length > 0
      ? insufficient
        .map((item) => `- ${item.assignment.title} (${item.assignment.specialist}): ${item.reason}`)
        .join('\n')
      : '- none';

    const completeness = failed.length === 0 && pending.length === 0 && insufficient.length === 0
      ? 'complete'
      : usableCompleted.length > 0
        ? 'partial'
        : 'incomplete';

    const confidence = failed.length > 0 || insufficient.length > 0
      ? 'medium-low (one or more lanes failed/insufficient)'
      : pending.length > 0
        ? 'medium (some lanes still pending)'
        : 'medium-high';

    return [
      'Jarvis Local Synthesis',
      'Mode: local synthesis fallback (LLM reviewer/provider bypass for swarm stability)',
      `Objective: ${objective}`,
      `Coverage: completed=${usableCompleted.length}, failed=${failed.length}, pending=${pending.length}, insufficient=${insufficient.length}`,
      `Completeness: ${completeness}`,
      '',
      'Completed lanes:',
      completedText,
      '',
      'Failed lanes:',
      failedText,
      '',
      'Pending lanes:',
      pendingText,
      '',
      'Insufficient lanes:',
      insufficientText,
      '',
      'Recommendation:',
      '- Use only completed usable lanes as the base answer and clearly mark missing/insufficient lanes.',
      '- If failed or insufficient lanes are critical, rerun only those lanes or reroute to healthy specialists.',
      '',
      `Confidence: ${confidence}`,
    ].join('\n');
  }

  /**
   * Check if an assignment output is weak (too short, generic, or error-like)
   */
  private isWeakAssignmentOutput(
    assignment: SwarmBatchAssignment,
    sanitizeOutput: (output: string) => string,
    jarvisMinAcceptableOutput: number = 220,
  ): string | null {
    const text = sanitizeOutput(assignment.result || '');
    if (!text || text === '(no response)') {
      return 'previous response was empty';
    }
    const minLength = assignment.workIntent === 'fact_gathering'
      ? 90
      : assignment.workIntent === 'scenario_mapping'
        ? 160
        : assignment.workIntent === 'risk_review'
          ? 150
          : jarvisMinAcceptableOutput;
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
}

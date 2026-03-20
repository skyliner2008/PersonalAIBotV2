import { describe, expect, it } from 'vitest';
import { TaskType } from '../../bot_agents/config/aiConfig.js';
import {
  isRetryableToolError,
  parseExecutionPlan,
  parseReviewerDecision,
  shouldRunReviewerGate,
} from '../../bot_agents/agentPhase2.js';

describe('agentPhase2 helpers', () => {
  describe('parseExecutionPlan', () => {
    it('parses goal and numbered steps', () => {
      const parsed = parseExecutionPlan([
        'GOAL: Ship Phase 2 safely',
        'STEPS:',
        '1. Add tracked planning',
        '2. Add tool retries',
        '3. Add reviewer gate',
        'TOOLS_NEEDED: run_command, read_file',
      ].join('\n'));

      expect(parsed).toEqual({
        objective: 'Ship Phase 2 safely',
        steps: [
          'Add tracked planning',
          'Add tool retries',
          'Add reviewer gate',
        ],
      });
    });

    it('uses fallback objective when goal line is missing', () => {
      const parsed = parseExecutionPlan([
        'STEPS:',
        '1. Inspect the code',
        '2. Implement the fix',
      ].join('\n'), 'Fix the startup flow');

      expect(parsed).toEqual({
        objective: 'Fix the startup flow',
        steps: ['Inspect the code', 'Implement the fix'],
      });
    });

    it('returns null when there are no usable steps', () => {
      expect(parseExecutionPlan('GOAL: Nothing here')).toBeNull();
    });
  });

  describe('isRetryableToolError', () => {
    it('treats timeouts and network issues as retryable', () => {
      expect(isRetryableToolError(new Error('ETIMEDOUT while calling API'))).toBe(true);
      expect(isRetryableToolError(new Error('429 Too Many Requests'))).toBe(true);
    });

    it('does not retry validation-style failures', () => {
      expect(isRetryableToolError(new Error('Validation failed: missing required field'))).toBe(false);
      expect(isRetryableToolError(new Error('ENOENT: no such file or directory'))).toBe(false);
    });
  });

  describe('shouldRunReviewerGate', () => {
    it('enables reviewer gate for tool-heavy complex work', () => {
      expect(shouldRunReviewerGate(TaskType.CODE, 'final answer', 2, 1)).toBe(true);
    });

    it('skips reviewer gate for short general chat', () => {
      expect(shouldRunReviewerGate(TaskType.GENERAL, 'hi', 1, 0)).toBe(false);
    });
  });

  describe('parseReviewerDecision', () => {
    it('parses pass verdicts', () => {
      expect(parseReviewerDecision('VERDICT: PASS\nISSUES:\n- none')).toEqual({
        verdict: 'pass',
        issues: ['none'],
        revisedReply: undefined,
      });
    });

    it('extracts revised replies when review requests changes', () => {
      const decision = parseReviewerDecision([
        'VERDICT: REVISE',
        'ISSUES:',
        '- Missing the health endpoint',
        '- Needs clearer wording',
        'REVISED_REPLY:',
        'Open http://localhost:3000/health to verify the server is ready.',
      ].join('\n'));

      expect(decision).toEqual({
        verdict: 'revise',
        issues: ['Missing the health endpoint', 'Needs clearer wording'],
        revisedReply: 'Open http://localhost:3000/health to verify the server is ready.',
      });
    });
  });
});

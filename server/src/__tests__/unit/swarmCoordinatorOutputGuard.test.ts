import { describe, expect, it } from 'vitest';
import { SwarmCoordinator } from '../../swarm/swarmCoordinator.js';

describe('SwarmCoordinator output guard', () => {
  it('treats Claude readiness chatter as unusable output', () => {
    const coordinator = new SwarmCoordinator() as any;
    const output = [
      'I can see you have a Codex Swarm configuration set up with GPT-5.4 model and elevated sandbox.',
      'Based on your mention of "Jarvis in batch mode", what specific task would you like me to assist with?',
    ].join(' ');

    const reason = coordinator.detectUnusableCliOutput('claude-cli-agent', output);
    expect(reason).toContain('readiness message');
  });

  it('keeps concrete structured analysis output as usable', () => {
    const coordinator = new SwarmCoordinator() as any;
    const output = [
      'Assumptions:',
      '- Border conflict remains limited to short-term disruption.',
      'Scenario map:',
      '- Base case: tourism sentiment softens but recovers in 2 quarters.',
      '- Downside: prolonged conflict raises logistics and energy costs.',
      'Decision criteria:',
      '- FX volatility, CPI trend, border trade volume, fiscal response timing.',
    ].join('\n');

    const reason = coordinator.detectUnusableCliOutput('claude-cli-agent', output);
    expect(reason).toBeNull();
  });

  it('treats provider 429/backoff logs as unusable output', () => {
    const coordinator = new SwarmCoordinator() as any;
    const output = [
      'Attempt 1 failed with status 429. Retrying with backoff...',
      'GaxiosError: No capacity available for model gemini-3-flash-preview on the server',
    ].join(' ');

    const reason = coordinator.detectUnusableCliOutput('gemini-cli-agent', output);
    expect(reason).toContain('provider/runtime error output');
  });

  it('uses adaptive CLI attempts with fallback command styles', () => {
    const coordinator = new SwarmCoordinator() as any;
    const attempts = coordinator.buildCliDispatchAttempts(
      { timeout: 20_000 },
      'gemini-cli-agent',
      '@gemini',
      'Analyze current gold trend',
    );

    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.some((item: any) => String(item.command).includes('gemini --prompt'))).toBe(true);
    expect(attempts.some((item: any) => String(item.command).startsWith('@gemini '))).toBe(true);
    expect(Math.max(...attempts.map((item: any) => item.timeoutMs))).toBeGreaterThanOrEqual(120_000);
  });

  it('keeps substantial partial output when timeout marker appears at the end', () => {
    const coordinator = new SwarmCoordinator() as any;
    const partial = `${'analysis '.repeat(40)}\nCLI timeout exceeded`;
    const normalized = coordinator.normalizeCliAttemptOutput('gemini-cli-agent', { output: partial });

    expect(normalized.output).not.toContain('CLI timeout exceeded');
    expect(normalized.output.length).toBeGreaterThan(160);
  });

  it('enables local synthesis for jarvis synthesis stage tasks', () => {
    const coordinator = new SwarmCoordinator() as any;
    const shouldUse = coordinator.shouldUseLocalSynthesis(
      {
        metadata: { batchStage: 'synthesis' },
      },
      'jarvis-root-admin',
    );

    expect(shouldUse).toBe(true);
  });

  it('flags local synthesis completeness when completed lane output is unusable', () => {
    const coordinator = new SwarmCoordinator() as any;
    const summary = coordinator.buildLocalSynthesisForBatch({
      objective: 'Test objective',
      assignments: [
        {
          title: 'A1 - Evidence gathering',
          specialist: 'gemini-cli-agent',
          batchStage: 'analysis',
          status: 'completed',
          taskId: 't1',
          taskType: 'web_search',
          result: 'Attempt 1 failed with status 429. Retrying with backoff... GaxiosError: No capacity available for model',
        },
      ],
    });

    expect(summary).toContain('insufficient=1');
    expect(summary).toContain('Completeness: incomplete');
  });
});

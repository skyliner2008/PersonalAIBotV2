import { describe, expect, it } from 'vitest';
import { buildJarvisDelegationPlan } from '../../swarm/jarvisPlanner.js';

describe('buildJarvisDelegationPlan', () => {
  it('builds research plans with quorum-based final synthesis', () => {
    const tasks = buildJarvisDelegationPlan(
      'Analyze the direction of the Thailand economy after border conflict pressure with Cambodia',
    );

    const finalTask = tasks[tasks.length - 1];
    const upstreamTasks = tasks.slice(0, -1);

    expect(upstreamTasks.length).toBeGreaterThanOrEqual(2);
    expect(upstreamTasks.some((task) => task.taskType === 'web_search')).toBe(true);
    expect(finalTask.specialist).toBe('jarvis-root-admin');
    expect(finalTask.dependencyMode).toBe('minimum_completed');
    expect(finalTask.minCompletedDependencies).toBeGreaterThanOrEqual(1);
  });

  it('avoids forcing evidence gathering for engineering objectives', () => {
    const tasks = buildJarvisDelegationPlan(
      'Fix a TypeScript build failure in the React dashboard and propose a safe implementation path',
    );

    const upstreamTasks = tasks.slice(0, -1);

    expect(upstreamTasks.some((task) => task.taskType === 'web_search')).toBe(false);
    expect(upstreamTasks.some((task) => task.taskType === 'code_generation')).toBe(true);
    expect(upstreamTasks.some((task) => task.taskType === 'code_review')).toBe(true);
  });

  it('avoids unhealthy specialists when planning new batches', () => {
    const tasks = buildJarvisDelegationPlan(
      'Analyze the economic impact of a regional conflict on Thailand with recent evidence and scenarios',
      {
        health: {
          'gemini-cli-agent': {
            state: 'unavailable',
            consecutiveFailures: 3,
            lastError: 'CLI timeout exceeded',
          },
        },
      },
    );

    const upstreamTasks = tasks.slice(0, -1);
    expect(upstreamTasks.some((task) => task.specialist === 'gemini-cli-agent')).toBe(false);
  });

  it('uses direct terminal payload format for delegated lanes', () => {
    const objective = 'Analyze the economic direction of Thailand under border conflict pressure with Cambodia';
    const tasks = buildJarvisDelegationPlan(objective);
    const upstreamTasks = tasks.slice(0, -1);

    expect(upstreamTasks.length).toBeGreaterThan(0);
    for (const task of upstreamTasks) {
      expect(task.message).toContain(`Objective: ${objective}`);
      expect(task.message).toContain('Output now as final result.');
      expect(task.message).not.toContain('Assigned to ');
      expect(task.message).not.toContain('Why now:');
    }
  });

  it('prefers original objective in direct mode even when english handoff is provided', () => {
    const originalObjective = 'Analyze Thailand economic direction impacted by Thailand-Cambodia conflict';
    const englishObjective = 'This english handoff should be ignored in direct mode';
    const tasks = buildJarvisDelegationPlan(
      originalObjective,
      { englishObjective },
    );

    const upstreamTasks = tasks.slice(0, -1);
    for (const task of upstreamTasks) {
      expect(task.message).toContain(`Objective: ${originalObjective}`);
      expect(task.message).not.toContain(englishObjective);
    }
  });

  it('supports explicit single-lane terminal style delegation', () => {
    const tasks = buildJarvisDelegationPlan(
      'Gemini collect data and statistics about Thai economy impact from Thailand-Cambodia conflict',
    );

    expect(tasks.length).toBe(2);
    expect(tasks[0].specialist).toBe('gemini-cli-agent');
    expect(tasks[0].message).toContain('Objective: collect data and statistics');
    expect(tasks[1].specialist).toBe('jarvis-root-admin');
    expect(tasks[1].dependsOn).toEqual([0]);
  });

  it('uses a single analysis lane for simple fact lookup objectives', () => {
    const tasks = buildJarvisDelegationPlan('ราคาน้ำมันวันนี้เท่าไหร่');
    const upstreamTasks = tasks.slice(0, -1);

    expect(upstreamTasks).toHaveLength(1);
    expect(upstreamTasks[0].taskType).toBe('web_search');
    expect(tasks[tasks.length - 1].minCompletedDependencies).toBe(1);
  });

  it('can expand beyond three lanes for high-complexity objectives', () => {
    const tasks = buildJarvisDelegationPlan(
      'Analyze geopolitical conflict impacts with latest evidence, build scenarios, propose an execution roadmap, assess risks, and run a quality coherence check before final recommendation',
    );
    const upstreamTasks = tasks.slice(0, -1);

    expect(upstreamTasks.length).toBeGreaterThan(3);
    expect(upstreamTasks.some((task) => task.metadata?.workIntent === 'quality_gate')).toBe(true);
  });
});

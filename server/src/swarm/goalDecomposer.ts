/**
 * Goal Decomposition System
 *
 * Breaks down high-level objectives into structured sub-tasks:
 * - Parses objectives into phases (research → plan → execute → verify)
 * - Maps tasks to specialist types
 * - Builds execution order respecting dependencies
 * - Estimates complexity based on keyword analysis
 */

import { createLogger } from '../utils/logger.js';
import { SPECIALISTS } from './specialists.js';
import type { TaskType } from './taskQueue.js';

const log = createLogger('GoalDecomposer');

export type ComplexityLevel = 'low' | 'medium' | 'high';
export type ExecutionStrategy = 'sequential' | 'parallel' | 'hybrid';

export interface SubTask {
  id: string;
  title: string;
  description: string;
  specialist: string;
  dependencies: string[]; // IDs of subtasks this depends on
  estimatedComplexity: ComplexityLevel;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  estimatedDurationMs?: number;
}

export interface DecomposedPlan {
  goalId: string;
  objective: string;
  subTasks: SubTask[];
  estimatedTotalTime: number;
  strategy: ExecutionStrategy;
  context?: Record<string, unknown>;
}

/**
 * Goal Decomposer - Breaks objectives into structured plans
 */
export class GoalDecomposer {
  constructor() {
    log.info('GoalDecomposer initialized');
  }

  /**
   * Decompose a high-level objective into sub-tasks
   */
  decomposeGoal(objective: string, context?: Record<string, unknown>): DecomposedPlan {
    const goalId = `goal_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Extract key themes/phases from objective
    const phases = this.extractPhases(objective);
    const subTasks: SubTask[] = [];
    let taskIndex = 0;

    // Standard decomposition flow: research → plan → execute → verify
    const flowPhases = ['research', 'planning', 'implementation', 'verification'];

    for (const phase of flowPhases) {
      const phaseMatch = phases.find(p => p.toLowerCase().includes(phase));
      if (!phaseMatch) continue;

      const phaseSubTasks = this.decomposePhase(
        phase,
        objective,
        taskIndex,
        phases
      );

      // Link dependencies
      if (subTasks.length > 0) {
        for (const task of phaseSubTasks) {
          task.dependencies = [subTasks[subTasks.length - 1].id];
        }
      }

      subTasks.push(...phaseSubTasks);
      taskIndex += phaseSubTasks.length;
    }

    // If no phases matched, create generic decomposition
    if (subTasks.length === 0) {
      const genericTasks = this.createGenericDecomposition(objective, taskIndex);
      subTasks.push(...genericTasks);
    }

    // Build execution order
    this.buildExecutionOrder(subTasks);

    // Determine strategy
    const strategy = this.determineStrategy(subTasks);
    const estimatedTotalTime = subTasks.reduce(
      (sum, task) => sum + (task.estimatedDurationMs || 5000),
      0
    );

    const plan: DecomposedPlan = {
      goalId,
      objective,
      subTasks,
      estimatedTotalTime,
      strategy,
      context,
    };

    log.info('Goal decomposed', {
      goalId,
      objective: objective.substring(0, 50),
      taskCount: subTasks.length,
      strategy,
    });

    return plan;
  }

  /**
   * Extract phases/themes from objective
   */
  private extractPhases(objective: string): string[] {
    const keywords = objective.toLowerCase();
    const phases: string[] = [];

    if (keywords.includes('research') || keywords.includes('find') || keywords.includes('search')) {
      phases.push('research');
    }
    if (keywords.includes('plan') || keywords.includes('design') || keywords.includes('architect')) {
      phases.push('planning');
    }
    if (keywords.includes('implement') || keywords.includes('build') || keywords.includes('create') || keywords.includes('write')) {
      phases.push('implementation');
    }
    if (keywords.includes('verify') || keywords.includes('test') || keywords.includes('check') || keywords.includes('validate')) {
      phases.push('verification');
    }
    if (keywords.includes('analyze') || keywords.includes('review')) {
      phases.push('analysis');
    }

    return phases.length > 0 ? phases : ['analysis', 'implementation'];
  }

  /**
   * Decompose a specific phase into sub-tasks
   */
  private decomposePhase(
    phase: string,
    objective: string,
    baseIndex: number,
    allPhases: string[]
  ): SubTask[] {
    const tasks: SubTask[] = [];

    switch (phase) {
      case 'research':
        tasks.push(this.createSubTask(
          baseIndex,
          'Identify information sources',
          'Find and evaluate relevant sources',
          'researcher',
          []
        ));
        tasks.push(this.createSubTask(
          baseIndex + 1,
          'Gather information',
          'Collect data from sources',
          'researcher',
          [tasks[0].id]
        ));
        tasks.push(this.createSubTask(
          baseIndex + 2,
          'Synthesize findings',
          'Analyze and summarize information',
          'reviewer',
          [tasks[1].id]
        ));
        break;

      case 'planning':
        tasks.push(this.createSubTask(
          baseIndex,
          'Define strategy',
          'Outline approach and methodology',
          'reviewer',
          []
        ));
        tasks.push(this.createSubTask(
          baseIndex + 1,
          'Set milestones',
          'Define key checkpoints and deliverables',
          'reviewer',
          [tasks[0].id]
        ));
        break;

      case 'implementation':
        tasks.push(this.createSubTask(
          baseIndex,
          'Setup environment',
          'Prepare workspace and dependencies',
          'coder',
          []
        ));
        tasks.push(this.createSubTask(
          baseIndex + 1,
          'Execute tasks',
          'Implement main objectives',
          'coder',
          [tasks[0].id]
        ));
        break;

      case 'verification':
        tasks.push(this.createSubTask(
          baseIndex,
          'Run tests',
          'Validate implementation',
          'tester',
          allPhases.includes('implementation') ? [objective] : []
        ));
        tasks.push(this.createSubTask(
          baseIndex + 1,
          'Final review',
          'Quality assurance and sign-off',
          'reviewer',
          [tasks[0].id]
        ));
        break;

      case 'analysis':
      default:
        tasks.push(this.createSubTask(
          baseIndex,
          'Analyze objective',
          'Break down and understand requirements',
          'reviewer',
          []
        ));
        break;
    }

    return tasks;
  }

  /**
   * Create generic decomposition for undefined objectives
   */
  private createGenericDecomposition(objective: string, baseIndex: number): SubTask[] {
    const complexity = this.estimateComplexity(objective);

    return [
      this.createSubTask(
        baseIndex,
        'Understand requirements',
        objective,
        'reviewer',
        [],
        complexity
      ),
      this.createSubTask(
        baseIndex + 1,
        'Execute task',
        `Complete the objective: ${objective}`,
        'coder',
        [`task_${baseIndex}`],
        complexity
      ),
      this.createSubTask(
        baseIndex + 2,
        'Validate results',
        'Ensure task completed successfully',
        'tester',
        [`task_${baseIndex + 1}`],
        complexity
      ),
    ];
  }

  /**
   * Create a sub-task with all properties
   */
  private createSubTask(
    index: number,
    title: string,
    description: string,
    specialistName: string,
    dependencies: string[],
    complexity?: ComplexityLevel
  ): SubTask {
    const complexity_level = complexity || this.estimateComplexity(description);
    const estimatedDurationMs = this.estimateDuration(complexity_level);

    return {
      id: `task_${index}`,
      title,
      description,
      specialist: specialistName,
      dependencies,
      estimatedComplexity: complexity_level,
      status: 'pending',
      estimatedDurationMs,
    };
  }

  /**
   * Map specialist based on task description keywords
   */
  mapToSpecialists(subTasks: SubTask[]): void {
    for (const task of subTasks) {
      const bestSpecialist = this.findBestSpecialist(task.description);
      if (bestSpecialist) {
        task.specialist = bestSpecialist;
      }
    }
  }

  /**
   * Find best specialist for a task description
   */
  private findBestSpecialist(description: string): string | null {
    const descLower = description.toLowerCase();

    // Match specialists by keywords
    if (descLower.includes('vision') || descLower.includes('image') || descLower.includes('visual')) {
      return 'vision';
    }
    if (descLower.includes('code') || descLower.includes('implement') || descLower.includes('build')) {
      return 'coder';
    }
    if (descLower.includes('test') || descLower.includes('validate') || descLower.includes('verify')) {
      return 'tester';
    }
    if (descLower.includes('research') || descLower.includes('search') || descLower.includes('find')) {
      return 'researcher';
    }
    if (descLower.includes('review') || descLower.includes('analyze') || descLower.includes('critique')) {
      return 'reviewer';
    }

    // Return a default specialist that's available
    const available = SPECIALISTS.find(s => s.isAvailable());
    return available?.name || 'reviewer';
  }

  /**
   * Build topological sort respecting dependencies
   */
  buildExecutionOrder(subTasks: SubTask[]): SubTask[] {
    const sorted: SubTask[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (task: SubTask) => {
      if (visited.has(task.id)) return;
      if (visiting.has(task.id)) {
        log.warn('Circular dependency detected', { taskId: task.id });
        return;
      }

      visiting.add(task.id);

      // Visit dependencies first
      for (const depId of task.dependencies) {
        const depTask = subTasks.find(t => t.id === depId);
        if (depTask) visit(depTask);
      }

      visiting.delete(task.id);
      visited.add(task.id);
      sorted.push(task);
    };

    for (const task of subTasks) {
      visit(task);
    }

    return sorted;
  }

  /**
   * Estimate complexity based on keywords and description length
   */
  estimateComplexity(description: string): ComplexityLevel {
    const descLower = description.toLowerCase();
    const length = description.length;

    // High complexity indicators
    if (
      descLower.includes('complex') ||
      descLower.includes('advanced') ||
      descLower.includes('integration') ||
      descLower.includes('architecture') ||
      length > 200
    ) {
      return 'high';
    }

    // Low complexity indicators
    if (
      descLower.includes('simple') ||
      descLower.includes('basic') ||
      descLower.includes('utility') ||
      length < 50
    ) {
      return 'low';
    }

    return 'medium';
  }

  /**
   * Estimate duration based on complexity
   */
  private estimateDuration(complexity: ComplexityLevel): number {
    switch (complexity) {
      case 'low':
        return 5000; // 5 seconds
      case 'medium':
        return 15000; // 15 seconds
      case 'high':
        return 30000; // 30 seconds
      default:
        return 10000;
    }
  }

  /**
   * Determine execution strategy (sequential/parallel/hybrid)
   */
  private determineStrategy(subTasks: SubTask[]): ExecutionStrategy {
    // Count how many tasks can run in parallel
    const independentGroups = this.findParallelGroups(subTasks);

    if (independentGroups.length === subTasks.length) {
      return 'parallel'; // All independent
    } else if (independentGroups.length === 1) {
      return 'sequential'; // All dependent
    } else {
      return 'hybrid'; // Mix of dependent and independent
    }
  }

  /**
   * Find groups of tasks that can run in parallel
   */
  private findParallelGroups(subTasks: SubTask[]): SubTask[][] {
    const groups: SubTask[][] = [];
    const processed = new Set<string>();

    for (const task of subTasks) {
      if (processed.has(task.id)) continue;

      const group: SubTask[] = [task];
      processed.add(task.id);

      // Find tasks with same dependencies (can run in parallel)
      for (const other of subTasks) {
        if (processed.has(other.id)) continue;
        if (JSON.stringify(other.dependencies) === JSON.stringify(task.dependencies)) {
          group.push(other);
          processed.add(other.id);
        }
      }

      groups.push(group);
    }

    return groups;
  }
}

// Singleton instance
let instance: GoalDecomposer | null = null;

export function getGoalDecomposer(): GoalDecomposer {
  if (!instance) {
    instance = new GoalDecomposer();
  }
  return instance;
}

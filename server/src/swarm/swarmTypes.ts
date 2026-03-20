/**
 * Swarm Types and Interfaces
 * Shared type definitions used across swarm modules
 */

import type { SwarmTask, TaskStatus, TaskType, DependencyMode, TaskCallback } from './taskQueue.js';
import type { CommandTokenUsage } from '../terminal/terminalGateway.js';

export type SwarmBatchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'partial';

export interface SwarmBatchProgress {
  total: number;
  queued: number;
  processing: number;
  completed: number;
  failed: number;
}

export interface SwarmBatchAssignment {
  index: number;
  title: string;
  instruction?: string;
  specialist: string;
  specialistHistory?: string[];
  batchStage?: string;
  workIntent?: string;
  supervisorAction?: 'revision' | 'recovery' | 'assist' | 'synthesis';
  sourceTaskId?: string;
  taskId: string;
  taskType: TaskType;
  status: TaskStatus;
  tokenUsage?: CommandTokenUsage;
  result?: string;
  error?: string;
}

export interface SwarmBatch {
  id: string;
  objective: string;
  createdBy: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  status: SwarmBatchStatus;
  taskIds: string[];
  assignments: SwarmBatchAssignment[];
  progress: SwarmBatchProgress;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface JarvisDelegationTask {
  title: string;
  message: string;
  specialist: string;
  taskType?: TaskType;
  dependsOn?: number[]; // Assignment indexes
  dependencyMode?: DependencyMode;
  minCompletedDependencies?: number;
  priority?: number;
  timeout?: number;
  maxRetries?: number;
  metadata?: Record<string, unknown>;
}

export type BatchListener = (batch: SwarmBatch) => void | Promise<void>;

export interface SpecialistExecutionResult {
  output: string;
  tokenUsage?: CommandTokenUsage;
}

export type CliDispatchMode = 'shell' | 'prefix';

export interface CliDispatchAttempt {
  mode: CliDispatchMode;
  command: string;
  timeoutMs: number;
}

export interface SpecialistRuntimeHealth {
  specialist: string;
  state: 'idle' | 'healthy' | 'degraded' | 'unavailable';
  totalTasks: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  timeouts: number;
  reroutes: number;
  averageLatencyMs?: number;
  lastError?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
}

export interface JarvisLeaderState {
  followUpRounds: number;
  assistedTaskIds: string[];
  revisedTaskIds: string[];
  recoveredTaskIds: string[];
  preemptedTaskIds: string[];
}

export type { SwarmTask, TaskStatus, TaskType, DependencyMode, TaskCallback };

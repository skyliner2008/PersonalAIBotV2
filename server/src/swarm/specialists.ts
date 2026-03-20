/**
 * Specialist Definitions — AI agent specialists with specific capabilities
 * Each specialist is optimized for particular types of tasks
 */

import type { TaskType } from './taskQueue.js';
import { getRootAdminSpecialistName } from '../system/rootAdmin.js';

const ROOT_ADMIN_RUNTIME_TAG = '__root_admin_runtime__';

/**
 * A specialist represents a capability node in the swarm
 * Can be assigned to a bot or run as standalone
 */
export interface Specialist {
  /** Unique specialist name (e.g., 'vision', 'coder', 'researcher') */
  name: string;

  /** Human-readable description */
  description: string;

  /** List of task types this specialist can handle */
  capabilities: TaskType[];

  /** Best/preferred AI model for this specialist */
  preferredModel: string;

  /** Preferred platform (or null for any platform) */
  platform?: string | null;

  /** Whether this specialist is currently available */
  isAvailable: () => boolean;

  /** Optional metadata */
  tags?: string[];
}

/**
 * Built-in specialist definitions
 */
export const SPECIALISTS: Specialist[] = [
  {
    name: 'vision',
    description: 'Specializes in image analysis, OCR, visual understanding',
    capabilities: ['vision_analysis'],
    preferredModel: 'gemini-2.0-flash',
    platform: null, // works on all platforms
    isAvailable: () => true,
    tags: ['image', 'visual', 'multimodal'],
  },
  {
    name: 'coder',
    description: 'Specializes in writing complex code, architecting software, and executing system commands.',
    capabilities: ['code_review', 'code_generation', 'general'],
    preferredModel: 'gemini-2.5-flash',
    platform: null,
    isAvailable: () => true,
    tags: ['code', 'development', 'debugging'],
  },
  {
    name: 'tester',
    description: 'Specializes in writing automated tests, finding edge cases, and simulating user flows.',
    capabilities: ['code_review', 'code_generation', 'general'],
    preferredModel: 'gemini-2.5-flash',
    platform: null,
    isAvailable: () => true,
    tags: ['testing', 'qa', 'automation', 'test'],
  },
  {
    name: 'researcher',
    description: 'Specializes in web search, fact-checking, information gathering',
    capabilities: ['web_search', 'summarization', 'data_analysis'],
    preferredModel: 'gemini-2.0-flash',
    platform: null,
    isAvailable: () => true,
    tags: ['research', 'web', 'facts'],
  },
  {
    name: 'reviewer',
    description: 'Specializes in scrutinizing, critiquing, and finding flaws in code or logic. Strict and analytical.',
    capabilities: ['code_review', 'data_analysis', 'general'],
    preferredModel: 'gemini-2.5-pro',
    platform: null,
    isAvailable: () => true,
    tags: ['review', 'critic', 'qa'],
  },
  {
    name: 'translator',
    description: 'Specializes in language translation and localization',
    capabilities: ['translation'],
    preferredModel: 'gemini-2.0-flash',
    platform: null,
    isAvailable: () => true,
    tags: ['language', 'translation', 'localization'],
  },
  {
    name: 'analyst',
    description: 'Specializes in data analysis, report generation, insights',
    capabilities: ['data_analysis', 'summarization'],
    preferredModel: 'gemini-2.5-flash',
    platform: null,
    isAvailable: () => true,
    tags: ['data', 'analysis', 'reporting'],
  },
  {
    name: 'gemini-cli-agent',
    description: 'Specialized Gemini CLI worker for research, translation, and summarization tasks.',
    capabilities: ['web_search', 'translation', 'summarization', 'data_analysis', 'general'],
    preferredModel: 'gemini-cli',
    platform: 'custom',
    isAvailable: () => true,
    tags: ['cli', 'gemini', 'worker'],
  },
  {
    name: 'codex-cli-agent',
    description: 'Specialized Codex CLI worker for implementation and code-focused tasks.',
    capabilities: ['code_generation', 'code_review', 'data_analysis', 'summarization', 'general'],
    preferredModel: 'codex-cli',
    platform: 'custom',
    isAvailable: () => true,
    tags: ['cli', 'codex', 'code'],
  },
  {
    name: 'claude-cli-agent',
    description: 'Specialized Claude CLI worker for critique, review, and synthesis tasks.',
    capabilities: ['code_review', 'summarization', 'data_analysis', 'general'],
    preferredModel: 'claude-cli',
    platform: 'custom',
    isAvailable: () => true,
    tags: ['cli', 'claude', 'review'],
  },
  {
    name: 'openai-cli-agent',
    description: 'Specialized OpenAI CLI worker for implementation and general intelligence tasks.',
    capabilities: ['code_generation', 'code_review', 'data_analysis', 'general'],
    preferredModel: 'openai-cli',
    platform: 'custom',
    isAvailable: () => true,
    tags: ['cli', 'openai', 'code'],
  },
  {
    name: 'jarvis-root-admin',
    description: 'Root orchestrator specialist used to aggregate delegated outputs and provide final synthesis.',
    capabilities: ['general', 'summarization'],
    preferredModel: 'jarvis-root-admin',
    platform: 'custom',
    isAvailable: () => true,
    tags: ['jarvis', 'orchestrator', 'admin', ROOT_ADMIN_RUNTIME_TAG],
  },
  {
    name: 'general',
    description: 'General-purpose assistant for any task type',
    capabilities: ['general', 'vision_analysis', 'code_review', 'code_generation', 'translation', 'web_search', 'data_analysis', 'summarization'],
    preferredModel: 'gemini-2.0-flash',
    platform: null,
    isAvailable: () => true,
    tags: ['general', 'fallback'],
  },
];

function resolveSpecialistsRuntime(): Specialist[] {
  const rootAdminSpecialist = getRootAdminSpecialistName();
  return SPECIALISTS.map((specialist) => {
    if (!specialist.tags?.includes(ROOT_ADMIN_RUNTIME_TAG)) return specialist;
    return {
      ...specialist,
      name: rootAdminSpecialist,
      preferredModel: rootAdminSpecialist,
    };
  });
}

/**
 * Find best specialist for a given task type
 */
export function findSpecialistForTask(taskType: TaskType): Specialist | null {
  const specialists = resolveSpecialistsRuntime();

  // First, try to find exact match
  for (const specialist of specialists) {
    if (specialist.isAvailable() && specialist.capabilities.includes(taskType)) {
      // Prefer non-general specialists if available
      if (specialist.name !== 'general') {
        return specialist;
      }
    }
  }

  // Fallback to general specialist
  return specialists.find(s => s.name === 'general') || null;
}

/**
 * Get all available specialists
 */
export function getAvailableSpecialists(): Specialist[] {
  return resolveSpecialistsRuntime().filter(s => s.isAvailable());
}

/**
 * Get specialist by name
 */
export function getSpecialistByName(name: string): Specialist | null {
  return resolveSpecialistsRuntime().find(s => s.name === name) || null;
}

/**
 * Search specialists by capability
 */
export function searchSpecialistsByCapability(taskType: TaskType): Specialist[] {
  return resolveSpecialistsRuntime().filter(
    s => s.isAvailable() && s.capabilities.includes(taskType)
  );
}

/**
 * Get specialist metrics (for debugging/status)
 */
export function getSpecialistMetrics() {
  const specialists = resolveSpecialistsRuntime();
  const available = specialists.filter((specialist) => specialist.isAvailable());
  const byCapability = new Map<TaskType, number>();

  for (const specialist of available) {
    for (const cap of specialist.capabilities) {
      byCapability.set(cap, (byCapability.get(cap) || 0) + 1);
    }
  }

  return {
    totalSpecialists: specialists.length,
    availableSpecialists: available.length,
    capabilities: Object.fromEntries(byCapability),
  };
}

export default {
  SPECIALISTS,
  findSpecialistForTask,
  getAvailableSpecialists,
  getSpecialistByName,
  searchSpecialistsByCapability,
  getSpecialistMetrics,
};

/**
 * Terminal Gateway Types, Interfaces, and Constants
 *
 * Central location for all shared types and constants used across
 * terminal-related modules (sessionManager, ptyManager, etc.)
 */

import type { SessionType, TerminalSession } from './sessionManager.js';
import type { PTYProcess } from './ptyManager.js';

/**
 * Public API: Token usage statistics from CLI commands
 */
export interface CommandTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  source: 'reported' | 'estimated';
}

/**
 * Public API: Result of executing a command programmatically
 */
export interface CommandExecutionResult {
  output: string;
  backend: string;
  tokenUsage?: CommandTokenUsage;
}

/**
 * CLI execution mode for command invocation
 */
export type CliExecutionMode = 'pipe' | 'shell';

/**
 * Memory profile for a CLI backend (contextual conversation parameters)
 */
export interface CliMemoryProfile {
  contextMaxMessages: number;
  contextCharBudget: number;
  contextStoreUserMax: number;
  contextStoreAssistantMax: number;
  summaryMaxChars: number;
  summaryEntryUserMax: number;
  summaryEntryAssistantMax: number;
  latestUserMessageMax: number;
}

/**
 * In-memory state for CLI command prompt and context
 */
export interface CliPromptMemory {
  prompt: string;
  conversationId: string | null;
  shouldPersist: boolean;
  profile: CliMemoryProfile;
}

/**
 * Persistent lane for swarm-based CLI sessions
 */
export interface SwarmPersistentLane {
  backendId: `${string}-cli`;
  command: string;
  argsKey: string;
  process: PTYProcess | null;
  outputBuffer: string;
  queue: Promise<unknown>;
  lastUsedAt: number;
}

/**
 * CLI Subcommands for Gemini CLI
 */
export const GEMINI_CLI_SUBCOMMANDS = new Set([
  'mcp',
  'extensions',
  'extension',
  'skills',
  'skill',
  'hooks',
  'hook',
]);

/**
 * CLI Subcommands for Claude CLI
 */
export const CLAUDE_CLI_SUBCOMMANDS = new Set([
  'mcp',
  'config',
  'update',
  'doctor',
  'login',
  'logout',
  'completion',
  'help',
  'version',
]);

/**
 * CLI Subcommands for Kilo CLI
 */
export const KILO_CLI_SUBCOMMANDS = new Set([
  'completion',
  'acp',
  'mcp',
  'attach',
  'run',
  'debug',
  'auth',
  'agent',
  'upgrade',
  'uninstall',
  'serve',
  'models',
  'stats',
  'export',
  'import',
  'pr',
  'session',
  'db',
]);

/**
 * CLI Subcommands for Codex CLI
 */
export const CODEX_CLI_SUBCOMMANDS = new Set([
  'exec',
  'e',
  'review',
  'apply',
  'resume',
  'fork',
  'cloud',
  'features',
  'login',
  'logout',
  'auth',
  'mcp',
  'mcp-server',
  'app-server',
  'sandbox',
  'debug',
  'completion',
  'help',
  'version',
  '--help',
  '--version',
  '-h',
  '-v',
]);

/**
 * CLI Subcommands for OpenCode CLI
 */
export const OPENCODE_CLI_SUBCOMMANDS = new Set([
  'completion',
  'acp',
  'mcp',
  'attach',
  'run',
  'debug',
  'providers',
  'auth',
  'agent',
  'upgrade',
  'uninstall',
  'serve',
  'web',
  'models',
  'stats',
  'export',
  'import',
  'github',
  'pr',
  'session',
  'db',
  'help',
  'version',
  '--help',
  '--version',
  '-h',
  '-v',
]);

/**
 * CLI backends that support contextual memory (hybrid memory approach)
 */
export const CONTEXTUAL_CLI_BACKENDS = new Set<`${string}-cli`>([
  'gemini-cli',
  'codex-cli',
  'claude-cli',
  'opencode-cli',
]);

/**
 * Default memory profile for CLI commands
 */
export const DEFAULT_CLI_MEMORY_PROFILE: CliMemoryProfile = {
  contextMaxMessages: 3,
  contextCharBudget: 900,
  contextStoreUserMax: 320,
  contextStoreAssistantMax: 520,
  summaryMaxChars: 540,
  summaryEntryUserMax: 120,
  summaryEntryAssistantMax: 160,
  latestUserMessageMax: 520,
};

/**
 * CLI-specific memory profile overrides by backend
 */
export const CLI_MEMORY_PROFILE_OVERRIDES: Partial<Record<`${string}-cli`, Partial<CliMemoryProfile>>> = {
  'codex-cli': {
    // Codex CLI tends to consume a larger baseline prompt internally.
    // Keep injected hybrid memory very compact to control prompt tokens.
    contextMaxMessages: 2,
    contextCharBudget: 520,
    contextStoreUserMax: 220,
    contextStoreAssistantMax: 320,
    summaryMaxChars: 320,
    summaryEntryUserMax: 90,
    summaryEntryAssistantMax: 110,
    latestUserMessageMax: 360,
  },
  'claude-cli': {
    contextMaxMessages: 3,
    contextCharBudget: 760,
    latestUserMessageMax: 460,
  },
};

/**
 * CLI backends safe for pipe-based execution in swarm mode
 */
export const SWARM_PIPE_SAFE_CLI_BACKENDS = new Set<`${string}-cli`>([
  'gemini-cli',
  'claude-cli',
  'codex-cli',
  'opencode-cli',
]);

/**
 * CLI backends that support persistent lane mode in swarm
 * Disabled for specific CLIs because they are not OS shells and cannot properly handle marker echoes.
 */
export const SWARM_PERSISTENT_CLI_BACKENDS = new Set<`${string}-cli`>([]);

/**
 * Shell-style CLI aliases for swarm mode (e.g., @gemini, @claude)
 */
export const SWARM_SHELL_STYLE_CLI_ALIASES: Record<string, 'gemini' | 'claude' | 'codex' | 'opencode'> = {
  gemini: 'gemini',
  'gemini-cli': 'gemini',
  claude: 'claude',
  'claude-cli': 'claude',
  codex: 'codex',
  'codex-cli': 'codex',
  opencode: 'opencode',
  'opencode-cli': 'opencode',
};

/**
 * Swarm persistent lane timeout (2 minutes)
 */
export const DEFAULT_SWARM_LANE_TIMEOUT_MS = 120_000;

/**
 * Swarm persistent lane idle timeout (10 minutes)
 */
export const DEFAULT_SWARM_LANE_IDLE_TIMEOUT_MS = 10 * 60_000;

/**
 * Maximum buffer size for swarm lane output (250KB)
 */
export const SWARM_LANE_MAX_BUFFER_CHARS = 250_000;

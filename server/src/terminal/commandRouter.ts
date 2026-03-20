/**
 * Command Router - Routes terminal commands to built-in and discovered CLI backends.
 *
 * Prefix examples:
 *   @agent <msg>   -> Root Admin Agent
 *   @jarvis <msg>  -> alias of @agent
/**
 * Command Router - Routes terminal commands to built-in and discovered CLI backends.
 *
 * Prefix examples:
 *   @agent <msg>   -> Root Admin Agent
 *   @jarvis <msg>  -> alias of @agent
 *   @admin <msg>   -> alias of @agent
 *   @gemini <msg>  -> Gemini CLI
 *   @claude <msg>  -> Claude CLI
 *   @openai <msg>  -> OpenAI CLI
 *   @kilo <msg>    -> Kilo CLI
 *   @<any> <msg>   -> dynamic <any>-cli backend (if installed)
 *   no prefix      -> native shell
 */

import path from 'path';
import { execFileSync } from 'child_process';
import os from 'os';
import { createLogger } from '../utils/logger.js';
import fs from 'fs';

const log = createLogger('CommandRouter');

export type BackendType = 'shell' | 'agent' | `${string}-cli`;

export interface CliRuntimeStatus {
  lastError: string | null;
  errorTimestamp: number | null;
}

const cliRuntimeStatuses = new Map<string, CliRuntimeStatus>();

export function getCliRuntimeStatus(id: string): CliRuntimeStatus {
  return cliRuntimeStatuses.get(id) || { lastError: null, errorTimestamp: null };
}

export function reportCliError(id: string, errorMessage: string | null): void {
  cliRuntimeStatuses.set(id, {
    lastError: errorMessage,
    errorTimestamp: errorMessage ? Date.now() : null,
  });
}

export interface RoutedCommand {
  backend: BackendType;
  command: string;
  rawInput: string;
  prefix?: string;
}

export interface BackendInfo {
  id: BackendType;
  name: string;
  available: boolean;
  path?: string;
  description: string;
  kind: 'builtin' | 'cli';
  prefix?: string;
  command?: string;
  startupCommand?: string;
}

interface CliConfig {
  command: string;
  args: string[];
}

interface CliCandidate {
  id: `${string}-cli`;
  command: string;
  name: string;
  description: string;
  aliases?: string[];
  envPathVar?: string;
  args?: string[];
}

const DISCOVERY_TTL_MS = 15_000;
const CODEX_NPX_PACKAGE = '@openai/codex';
const CLAUDE_NPX_PACKAGE = '@anthropic-ai/claude-code';

const BUILTIN_BACKENDS: BackendInfo[] = [
  {
    id: 'shell',
    name: 'Local Shell',
    available: true,
    path: process.platform === 'win32' ? (process.env.COMSPEC || 'powershell.exe') : (process.env.SHELL || '/bin/bash'),
    description: process.platform === 'win32' ? 'Native shell (PowerShell/cmd)' : 'Native shell (bash/zsh/sh)',
    kind: 'builtin',
    prefix: '',
  },
  {
    id: 'agent',
    name: 'Agent (Jarvis)',
    available: true,
    description: 'Root Admin Agent with high-privilege orchestration',
    kind: 'builtin',
    prefix: '@agent',
  },
];

const KNOWN_CLI_CANDIDATES: CliCandidate[] = [
  {
    id: 'gemini-cli',
    command: 'gemini',
    name: 'Gemini CLI',
    description: 'Google Gemini CLI',
    aliases: ['google-gemini'],
    envPathVar: 'GEMINI_CLI_PATH',
  },
  {
    id: 'claude-cli',
    command: 'claude',
    name: 'Claude Code',
    description: 'Anthropic Claude CLI',
    envPathVar: 'CLAUDE_CLI_PATH',
  },
  {
    id: 'openai-cli',
    command: 'openai',
    name: 'OpenAI CLI',
    description: 'OpenAI CLI',
    envPathVar: 'OPENAI_CLI_PATH',
  },
  {
    id: 'kilo-cli',
    command: 'kilo',
    name: 'Kilo Code',
    description: 'Kilo Code CLI',
    envPathVar: 'KILO_CLI_PATH',
  },
  {
    id: 'aider-cli',
    command: 'aider',
    name: 'Aider',
    description: 'Aider coding assistant CLI',
    envPathVar: 'AIDER_CLI_PATH',
  },
  {
    id: 'codex-cli',
    command: 'codex',
    name: 'Codex CLI',
    description: 'OpenAI Codex CLI',
    envPathVar: 'CODEX_CLI_PATH',
  },
  {
    id: 'qwen-cli',
    command: 'qwen',
    name: 'Qwen CLI',
    description: 'Qwen CLI',
    envPathVar: 'QWEN_CLI_PATH',
  },
  {
    id: 'ollama-cli',
    command: 'ollama',
    name: 'Ollama CLI',
    description: 'Local Ollama CLI',
    envPathVar: 'OLLAMA_CLI_PATH',
  },
  {
    id: 'llm-cli',
    command: 'llm',
    name: 'LLM CLI',
    description: 'Simon Willison llm CLI',
    envPathVar: 'LLM_CLI_PATH',
  },
  {
    id: 'opencode-cli',
    command: 'opencode',
    name: 'OpenCode CLI',
    description: 'OpenCode CLI',
    envPathVar: 'OPENCODE_CLI_PATH',
  },
];

type DiscoveryState = {
  expiresAt: number;
  backends: BackendInfo[];
  cliConfigs: Map<string, CliConfig>;
  prefixToBackend: Map<string, `${string}-cli`>;
};

let cache: DiscoveryState | null = null;
let codexDiscoveryWarned = false;
let codexFallbackWarned = false;
let claudeDiscoveryWarned = false;
let claudeFallbackWarned = false;

function toBackendId(token: string): `${string}-cli` {
  const slug = token
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'custom'}-cli`;
}

export function toCliBackendId(token: string): `${string}-cli` {
  return toBackendId(token);
}

function parseExtraCliCandidates(): CliCandidate[] {
  const raw = process.env.JARVIS_EXTRA_CLIS || '';
  if (!raw.trim()) return [];

  const tokens = raw
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const out: CliCandidate[] = [];
  for (const cmd of tokens) {
    const id = toBackendId(cmd);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      command: cmd,
      name: `${cmd} CLI`,
      description: `Custom CLI from JARVIS_EXTRA_CLIS (${cmd})`,
    });
  }
  return out;
}

function getAllCandidates(): CliCandidate[] {
  const merged = [...KNOWN_CLI_CANDIDATES, ...parseExtraCliCandidates()];
  const byId = new Map<string, CliCandidate>();
  for (const c of merged) {
    if (!byId.has(c.id)) byId.set(c.id, c);
  }
  return Array.from(byId.values());
}

function resolveExecutablePath(inputPath: string): string {
  const cleanPath = inputPath.trim().replace(/^"|"$/g, '');
  if (process.platform !== 'win32') return cleanPath;
  if (/\.[^\\/]+$/.test(cleanPath)) return cleanPath;

  const candidates = [
    `${cleanPath}.cmd`,
    `${cleanPath}.exe`,
    `${cleanPath}.bat`,
    `${cleanPath}.ps1`,
    cleanPath,
  ];
  const existing = candidates.find(p => fs.existsSync(p));
  return existing || cleanPath;
}

function findExecutable(name: string, customPath?: string): string | null {
  if (customPath) {
    const resolvedCustomPath = resolveExecutablePath(customPath);
    if (fs.existsSync(resolvedCustomPath)) {
      return resolvedCustomPath;
    }
    log.warn(`Custom path for ${name} was not found: ${customPath}`);
  }

  // Windows fallback: check NPM global path directly if "where" fails or for reliability
  if (process.platform === 'win32') {
    const npmPath = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', `${name}.cmd`);
    if (fs.existsSync(npmPath)) {
      return npmPath;
    }
  }

  try {
    const resolver = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(resolver, [name], {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!result) return null;
    const rawPaths = result.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    if (rawPaths.length === 0) return null;

    const resolvedPaths = Array.from(
      new Set(rawPaths.map((p) => resolveExecutablePath(p)))
    );

    if (process.platform === 'win32') {
      // Prefer user/global CLI shims over protected WindowsApps package paths.
      const score = (p: string): number => {
        const lower = p.toLowerCase();
        if (lower.includes('\\program files\\windowsapps\\')) return 100;
        if (lower.endsWith('.cmd') || lower.endsWith('.bat')) return 0;
        if (lower.includes('\\appdata\\roaming\\npm\\')) return 1;
        return 10;
      };

      const sorted = [...resolvedPaths].sort((a, b) => score(a) - score(b));
      const chosen = sorted.find(Boolean);
      if (chosen) return chosen;
      return name;
    }

    return resolvedPaths[0] || null;
  } catch {
    return null;
  }
}

function isWindowsAppsPath(executablePath?: string | null): boolean {
  if (process.platform !== 'win32' || !executablePath) return false;
  return executablePath.toLowerCase().includes('\\program files\\windowsapps\\');
}

function getCodexNpxFallback(): CliConfig | null {
  const npxPath = findExecutable('npx');
  if (!npxPath) return null;
  return {
    command: npxPath,
    args: ['-y', CODEX_NPX_PACKAGE],
  };
}

function getClaudeNpxFallback(): CliConfig | null {
  const npxPath = findExecutable('npx');
  if (!npxPath) return null;
  return {
    command: npxPath,
    args: ['-y', CLAUDE_NPX_PACKAGE],
  };
}

function discover(forceRefresh = false): DiscoveryState {
  const now = Date.now();
  if (!forceRefresh && cache && cache.expiresAt > now) {
    return cache;
  }

  const cliConfigs = new Map<string, CliConfig>();
  const prefixToBackend = new Map<string, `${string}-cli`>();
  const backends: BackendInfo[] = [...BUILTIN_BACKENDS];

  for (const c of getAllCandidates()) {
    const resolvedPath = findExecutable(c.command, c.envPathVar ? process.env[c.envPathVar] : undefined);
    let available = !!resolvedPath;
    let cliConfig: CliConfig | null = available
      ? { command: resolvedPath!, args: c.args || [] }
      : null;
    let displayPath = resolvedPath || undefined;

    if (c.id === 'codex-cli') {
      const npxFallback = getCodexNpxFallback();

      if ((!resolvedPath || isWindowsAppsPath(resolvedPath)) && npxFallback) {
        available = true;
        cliConfig = npxFallback;
        displayPath = `${npxFallback.command} ${npxFallback.args.join(' ')}`;

        if (!codexFallbackWarned) {
          codexFallbackWarned = true;
          log.debug('Codex CLI executable not directly runnable; using npx fallback (@openai/codex).');
        }
        codexDiscoveryWarned = false;
      } else if (!resolvedPath && !npxFallback && !codexDiscoveryWarned) {
        codexDiscoveryWarned = true;
        codexFallbackWarned = false;
        log.warn('Codex CLI not discovered. Set CODEX_CLI_PATH or install @openai/codex.');
      } else if (resolvedPath && !isWindowsAppsPath(resolvedPath)) {
        codexDiscoveryWarned = false;
        codexFallbackWarned = false;
      }
    }

    if (c.id === 'claude-cli') {
      const npxFallback = getClaudeNpxFallback();

      if (!resolvedPath && npxFallback) {
        available = true;
        cliConfig = npxFallback;
        displayPath = `${npxFallback.command} ${npxFallback.args.join(' ')}`;

        if (!claudeFallbackWarned) {
          claudeFallbackWarned = true;
          log.debug('Claude CLI executable not directly found; using npx fallback (@anthropic-ai/claude-code).');
        }
        claudeDiscoveryWarned = false;
      } else if (!resolvedPath && !npxFallback && !claudeDiscoveryWarned) {
        claudeDiscoveryWarned = true;
        claudeFallbackWarned = false;
        log.warn('Claude CLI not discovered. Set CLAUDE_CLI_PATH or install @anthropic-ai/claude-code.');
      } else if (resolvedPath) {
        claudeDiscoveryWarned = false;
        claudeFallbackWarned = false;
      }
    }

    const prefix = `@${c.command.toLowerCase()}`;
    prefixToBackend.set(c.command.toLowerCase(), c.id);
    for (const alias of c.aliases || []) {
      prefixToBackend.set(alias.toLowerCase(), c.id);
    }

    backends.push({
      id: c.id,
      name: c.name,
      available,
      path: displayPath,
      description: c.description,
      kind: 'cli',
      prefix,
      command: c.command,
      startupCommand: c.command,
    });

    if (available && cliConfig) {
      cliConfigs.set(c.id, cliConfig);
    }
  }

  cache = {
    expiresAt: now + DISCOVERY_TTL_MS,
    backends,
    cliConfigs,
    prefixToBackend,
  };
  return cache;
}

export function refreshAvailableBackends(): BackendInfo[] {
  return discover(true).backends;
}

export function getAvailableBackends(): BackendInfo[] {
  return discover(false).backends;
}

export function getBackendById(id: BackendType): BackendInfo | null {
  return getAvailableBackends().find(b => b.id === id) || null;
}

function resolveCliBackendFromPrefix(prefixToken: string): `${string}-cli` {
  const lower = prefixToken.toLowerCase();
  const { prefixToBackend } = discover(false);
  const mapped = prefixToBackend.get(lower);
  if (mapped) return mapped;

  if (lower.endsWith('-cli')) {
    return lower as `${string}-cli`;
  }
  return toBackendId(lower);
}

/**
 * Route a raw user input to the appropriate backend.
 */
export function routeCommand(input: string): RoutedCommand {
  const trimmed = input.trim();
  const prefixed = trimmed.match(/^(?:\[TS:[^\]]+\]\s*)?@([a-zA-Z0-9._-]+)\s*([\s\S]*)$/);

  if (!prefixed) {
    return {
      backend: 'shell',
      command: trimmed,
      rawInput: trimmed,
    };
  }

  const prefix = prefixed[1].toLowerCase();
  const command = prefixed[2].trim();

  if (prefix === 'agent' || prefix === 'jarvis' || prefix === 'admin') {
    return {
      backend: 'agent',
      command,
      rawInput: trimmed,
      prefix,
    };
  }

  return {
    backend: resolveCliBackendFromPrefix(prefix),
    command,
    rawInput: trimmed,
    prefix,
  };
}

/**
 * Resolve CLI executable config for a backend id.
 */
export function getCLIConfig(backend: BackendType): CliConfig | null {
  if (backend === 'shell' || backend === 'agent') return null;

  const state = discover(false);
  const cachedConfig = state.cliConfigs.get(backend);
  if (cachedConfig) return cachedConfig;

  const known = getAllCandidates().find((candidate) => candidate.id === backend);
  if (known) {
    const envPath = known.envPathVar ? process.env[known.envPathVar] : undefined;
    const resolved = findExecutable(known.command, envPath);
    if (known.id === 'claude-cli') {
      if (resolved) {
        return { command: resolved, args: known.args || [] };
      }

      const npxFallback = getClaudeNpxFallback();
      if (npxFallback) {
        return npxFallback;
      }

      return { command: known.command, args: known.args || [] };
    }

    if (known.id === 'codex-cli') {
      // Prefer a directly-runnable binary, but avoid WindowsApps aliases
      // because they often fail with EPERM when spawned from Node.
      if (resolved && !isWindowsAppsPath(resolved)) {
        return { command: resolved, args: known.args || [] };
      }

      const npxFallback = getCodexNpxFallback();
      if (npxFallback) {
        return npxFallback;
      }

      if (resolved) {
        return { command: resolved, args: known.args || [] };
      }

      // Last-resort best effort to surface clear ENOENT/permission errors.
      return { command: known.command, args: known.args || [] };
    }

    if (resolved) {
      return { command: resolved, args: known.args || [] };
    }
  }

  // Best-effort dynamic fallback for unknown @<name> prefixes.
  if (backend.endsWith('-cli')) {
    const commandName = backend.slice(0, -4);
    const resolved = findExecutable(commandName);
    if (resolved) {
      return { command: resolved, args: [] };
    }
  }

  return null;
}

/**
 * Format help text for terminal clients.
 */
export function getHelpText(): string {
  const backends = getAvailableBackends();
  const lines: string[] = [
    '\x1b[1;36m+--------------------------------------------------+\x1b[0m',
    '\x1b[1;36m|        Jarvis Terminal - Command Help            |\x1b[0m',
    '\x1b[1;36m+--------------------------------------------------+\x1b[0m',
    '\x1b[1;33m  Core Prefixes:\x1b[0m',
    '  @agent <message>   -> Root Admin Agent',
    '  @jarvis <message>  -> Alias for @agent',
    '  @admin <message>   -> Alias for @agent',
    '  (no prefix)        -> Native shell command',
    '',
    '\x1b[1;33m  Discovered CLI Prefixes:\x1b[0m',
  ];

  const cliBackends = backends.filter(b => b.kind === 'cli');
  if (cliBackends.length === 0) {
    lines.push('  (none discovered)');
  } else {
    for (const b of cliBackends) {
      lines.push(`  ${b.prefix || '@?'} <input>  -> ${b.name}`);
    }
  }

  lines.push('');
  lines.push('\x1b[1;33m  Backend Status:\x1b[0m');
  for (const b of backends) {
    const status = b.available ? '\x1b[32m[OK]\x1b[0m' : '\x1b[31m[NO]\x1b[0m';
    lines.push(`  ${status} ${b.name.padEnd(20)} ${b.description}`);
  }

  lines.push('');

  lines.push('');
  lines.push('\x1b[1;33m  Special Commands:\x1b[0m');
  lines.push('  @help              -> Show this help');
  lines.push('  @backends          -> List available backends');
  lines.push('  @sessions          -> List active sessions');
  lines.push('\x1b[1;36m+--------------------------------------------------+\x1b[0m');

  return lines.join('\r\n') + '\r\n';
}

/**
 * Actively ping discovered CLIs to check for API Rate Limits or Quota Exceeded errors.
 * Uses the same execution pipeline (buildCliInvocationArgs + runCliCommand) that the
 * terminal gateway uses, so the prompt is properly formatted for each CLI backend
 * (e.g. `codex exec "Reply OK"`, `gemini -p "Reply OK"`, `claude --print "Reply OK"`).
 */
export async function verifyCliConnections(): Promise<void> {
  // Lazy-import to avoid circular dependency at module load time
  const { buildCliInvocationArgs, runCliCommand, getCliEnvironmentOverrides } = await import('./cliCommandExecutor.js');

  const state = discover(true);
  const cliBackends = state.backends.filter(b => b.kind === 'cli' && b.available);

  log.info(`[Health] Starting active connection tests for ${cliBackends.length} discovered CLI backends.`);

  for (const backend of cliBackends) {
    const config = state.cliConfigs.get(backend.id);
    if (!config) continue;

    const backendId = backend.id as `${string}-cli`;
    const testPrompt = 'Reply with OK';

    try {
      // Build proper CLI arguments using the same logic the terminal gateway uses
      const args = buildCliInvocationArgs(backendId, testPrompt, config.args, 'pipe');

      // Use a short timeout (15s) — we only care about fast rate-limit rejections
      const rawOutput = await runCliCommand(
        config.command,
        args,
        backendId,
        undefined,   // no stdin
        'pipe',
        15_000,      // 15s timeout for health check
      );

      // Strip the internal "CLI timeout exceeded" suffix that runCliCommand appends on timeout.
      // We need to check the REAL CLI output for API error keywords, not the internal marker.
      const didTimeout = /CLI timeout exceeded/i.test(rawOutput);
      const output = rawOutput.replace(/\n?CLI timeout exceeded$/i, '').trim();

      const ERROR_PATTERN = /rate.?limit|quota.?exceeded|too many requests|usage.?limit|upgrade to pro|hit your.*limit|resource.?exhausted|credits/i;
      const hasErrorKeywords = ERROR_PATTERN.test(output);

      if (hasErrorKeywords) {
        log.warn(`[Health] CLI ${backend.id} degraded: ${output.slice(0, 120)}`);
        reportCliError(backend.id, `API Error: ${output.slice(0, 200)}`);
      } else {
        // Timeout with no API error keywords = CLI is just slow or interactive, not rate-limited
        log.info(`[Health] CLI ${backend.id} verified as healthy.${didTimeout ? ' (timed out but no API errors)' : ''}`);
        reportCliError(backend.id, null);
      }
    } catch (err: any) {
      const errMsg = String(err?.message || err || '');
      const ERROR_PATTERN = /rate.?limit|quota.?exceeded|too many requests|usage.?limit|upgrade to pro|hit your.*limit|resource.?exhausted|credits/i;

      if (ERROR_PATTERN.test(errMsg)) {
        log.warn(`[Health] CLI ${backend.id} degraded (exception): ${errMsg.slice(0, 120)}`);
        reportCliError(backend.id, `API Error: ${errMsg.slice(0, 200)}`);
      } else {
        log.debug(`[Health] CLI ${backend.id} health check error: ${errMsg.slice(0, 100)}`);
        reportCliError(backend.id, null);
      }
    }
  }

  log.info(`[Health] Finished verifying CLI connections.`);
}

/**
 * CLI Command Executor
 *
 * Handles execution of CLI commands with proper environment setup,
 * argument building, stdin handling, token extraction, and output normalization.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CliExecutionMode,
  GEMINI_CLI_SUBCOMMANDS,
  CLAUDE_CLI_SUBCOMMANDS,
  KILO_CLI_SUBCOMMANDS,
  CODEX_CLI_SUBCOMMANDS,
  OPENCODE_CLI_SUBCOMMANDS,
} from './terminalTypes.js';
import { spawnCLI, detectShell, type PTYProcess } from './ptyManager.js';
import { getProviderApiKey } from '../config/settingsSecurity.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('CliCommandExecutor');
const warnedCliEnvBackends = new Set<string>();

/**
 * Format error message from Error or unknown type
 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Remove ANSI escape sequences from text
 */
export function stripAnsi(input: string): string {
  return input
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B[@-_][0-?]*[ -/]*[@-~]/g, '');
}

/**
 * Parse command line input, respecting quotes
 */
export function splitCommandLine(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escape = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === '\\') {
      escape = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === '\'') {
      quote = ch as '"' | '\'';
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current) out.push(current);
  return out;
}

/**
 * Create directory if it doesn't exist
 */
function ensureCliStateDir(dirPath: string): string | null {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
  } catch (err) {
    log.warn(`Failed to prepare state dir: ${dirPath}`, {
      error: errorMessage(err),
    });
    return null;
  }
}

/**
 * Copy file if source is newer or target doesn't exist
 */
function copyCliFileIfNeeded(sourcePath: string, targetPath: string): boolean {
  try {
    if (!fs.existsSync(sourcePath)) return false;

    const sourceStat = fs.statSync(sourcePath);
    const targetStat = fs.existsSync(targetPath) ? fs.statSync(targetPath) : null;
    const shouldCopy = !targetStat
      || sourceStat.size !== targetStat.size
      || sourceStat.mtimeMs > targetStat.mtimeMs;

    if (!shouldCopy) {
      return false;
    }

    fs.copyFileSync(sourcePath, targetPath);
    return true;
  } catch (err) {
    log.warn(`Failed to sync file ${path.basename(sourcePath)}`, {
      sourcePath,
      targetPath,
      error: errorMessage(err),
    });
    return false;
  }
}

/**
 * Resolve Codex auth source home directory
 */
function resolveCodexAuthSourceHome(isolatedHome: string): string | null {
  const candidates = [
    process.env.SWARM_CODEX_AUTH_SOURCE?.trim(),
    process.env.CODEX_HOME?.trim(),
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.codex') : null,
    process.env.HOME ? path.join(process.env.HOME, '.codex') : null,
  ]
    .filter((candidate): candidate is string => !!candidate)
    .map((candidate) => path.resolve(candidate));

  const isolatedResolved = path.resolve(isolatedHome);
  for (const candidate of candidates) {
    if (candidate === isolatedResolved) continue;
    if (fs.existsSync(path.join(candidate, 'auth.json'))) {
      return candidate;
    }
  }

  return null;
}

/**
 * Bootstrap Codex authentication state from source directory
 */
function bootstrapCodexAuthState(isolatedHome: string): boolean {
  const authSourceHome = resolveCodexAuthSourceHome(isolatedHome);
  if (!authSourceHome) {
    return false;
  }

  const sourceAuthPath = path.join(authSourceHome, 'auth.json');
  const targetAuthPath = path.join(isolatedHome, 'auth.json');

  return copyCliFileIfNeeded(sourceAuthPath, targetAuthPath);
}

/**
 * Get environment variable overrides for a CLI backend
 */
export function getCliEnvironmentOverrides(backendId?: `${string}-cli`): Record<string, string> {
  if (!backendId) return {};

  if (backendId === 'codex-cli') {
    const configuredHome = process.env.SWARM_CODEX_HOME?.trim()
      || path.join(process.cwd(), 'server', '.codex-swarm');
    const codexHome = ensureCliStateDir(configuredHome);
    if (!codexHome) {
      const openAiKey = getProviderApiKey('openai') || process.env.OPENAI_API_KEY || '';
      if (!openAiKey) {
        return {};
      }
      return { OPENAI_API_KEY: openAiKey };
    }

    if (!warnedCliEnvBackends.has(backendId)) {
      warnedCliEnvBackends.add(backendId);
      log.info(`Using isolated CODEX_HOME for ${backendId}`, {
        codexHome,
      });
    }

    if (bootstrapCodexAuthState(codexHome)) {
      return {
        CODEX_HOME: codexHome,
      };
    }

    const openAiKey = getProviderApiKey('openai') || process.env.OPENAI_API_KEY || '';
    if (openAiKey) {
      return {
        OPENAI_API_KEY: openAiKey,
        CODEX_HOME: codexHome,
      };
    }

    return {
      CODEX_HOME: codexHome,
    };
  }

  return {};
}

/**
 * Get a grounding persona hint for the CLI agent to prevent identity confusion.
 * Acts as a context anchor rather than a restriction.
 */
function getPersonaHint(backendId: string): string {
  const name = backendId.replace('-cli', '').toUpperCase();
  return `[IDENTITY: ${name} CLI Agent | SYSTEM: PersonalAIBotV2]\nYou are the ${name} autonomous specialist for this ecosystem. Assist with the user's request using your full capabilities and tools. If asked about your identity, confirm your role as the ${name} specialist here.\n\n`;
}

/**
 * Build CLI invocation arguments based on backend and mode
 */
export function buildCliInvocationArgs(
  backendId: `${string}-cli`,
  userInput: string,
  baseArgs: string[] = [],
  executionMode: CliExecutionMode = 'pipe',
  isSwarmTask: boolean = false
): string[] {
  const trimmed = userInput.trim();
  const parsed = splitCommandLine(trimmed);
  const first = (parsed[0] || '').toLowerCase();
  const nonEngineeringHint =
    /this is not a software engineering task/i.test(userInput)
    || /ignore the current repository/i.test(userInput);

  // Apply persona grounding to prevent hallucination about models/identity
  const groundedInput = getPersonaHint(backendId) + trimmed;

  if (backendId === 'gemini-cli') {
    if (first.startsWith('-') || GEMINI_CLI_SUBCOMMANDS.has(first)) {
      return [...baseArgs, ...parsed];
    }
    const geminiModeArgs = isSwarmTask ? ['--approval-mode', 'yolo'] : [];
    return [...baseArgs, ...geminiModeArgs, '-p', groundedInput];
  }

  if (backendId === 'claude-cli') {
    if (first.startsWith('-') || CLAUDE_CLI_SUBCOMMANDS.has(first)) {
      return [...baseArgs, ...parsed];
    }
    const disableTools = nonEngineeringHint || isSwarmTask;
    const claudeModeArgs = disableTools ? ['--tools', ''] : [];
    return [...baseArgs, ...claudeModeArgs, '--print', groundedInput];
  }

  if (backendId === 'kilo-cli') {
    if (first.startsWith('-') || KILO_CLI_SUBCOMMANDS.has(first)) {
      return [...baseArgs, ...parsed];
    }
    return [...baseArgs, 'run', '--model', 'kilo/kilo-auto/free', groundedInput];
  }

  if (backendId === 'codex-cli') {
    if (first.startsWith('-') || CODEX_CLI_SUBCOMMANDS.has(first)) {
      return [...baseArgs, ...parsed];
    }
    return [...baseArgs, 'exec', groundedInput];
  }

  if (backendId === 'opencode-cli') {
    if (first.startsWith('-') || OPENCODE_CLI_SUBCOMMANDS.has(first)) {
      return [...baseArgs, ...parsed];
    }
    return [...baseArgs, 'run', groundedInput];
  }

  // Default for any other discovered CLI
  return [...baseArgs, groundedInput];
}

/**
 * Get stdin input for CLI invocation (if needed)
 */
export function getCliInvocationStdin(
  backendId: `${string}-cli`,
  userInput: string,
  executionMode: CliExecutionMode = 'pipe',
): string | null {
  if (executionMode === 'shell') {
    return null;
  }

  const trimmed = userInput.trim();
  const parsed = splitCommandLine(trimmed);
  const first = (parsed[0] || '').toLowerCase();

  // All CLIs now receive prompt as argument (not stdin) for reliability
  return null;
}

/**
 * Run a CLI command and capture output
 */
export async function runCliCommand(
  command: string,
  args: string[],
  backendId?: `${string}-cli`,
  stdinInput?: string,
  executionMode: CliExecutionMode = 'pipe',
  timeoutOverrideMs?: number,
): Promise<string> {
  return await new Promise((resolve) => {
    let out = '';
    let done = false;
    let timer: NodeJS.Timeout | null = null;
    const cleanupPaths: string[] = [];
    const timeoutMs = timeoutOverrideMs || (
      backendId === 'kilo-cli'
        ? 120_000
        : backendId === 'gemini-cli' || backendId === 'claude-cli' || backendId === 'codex-cli'
          ? 180_000
          : 90_000
    );

    const cleanupTempFiles = () => {
      for (const filePath of cleanupPaths) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // best effort
        }
      }
    };

    const finish = (result: string) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      cleanupTempFiles();
      resolve(stripAnsi(result).trim());
    };

    let proc: PTYProcess;
    try {
      const cliEnv = getCliEnvironmentOverrides(backendId);
      if (executionMode === 'shell') {
        const shell = detectShell();
        if (process.platform === 'win32') {
          const lower = shell.toLowerCase();
          if (lower.includes('powershell') || lower.includes('pwsh')) {
            const quotePs = (value: string) => `'${String(value ?? '').replace(/'/g, '\'\'')}'`;
            const commandSegments = [command, ...args].map(quotePs).join(' ');
            let script = `& ${commandSegments}; exit $LASTEXITCODE`;
            if (stdinInput) {
              const tempFile = path.join(
                os.tmpdir(),
                `jarvis-cli-${backendId || 'shell'}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
              );
              fs.writeFileSync(tempFile, stdinInput, 'utf8');
              cleanupPaths.push(tempFile);
              if (backendId === 'codex-cli') {
                const quotedArgs = args.map((arg) => String(arg ?? '').replace(/"/g, '\\"')).join(' ');
                const envAssignments = Object.entries(cliEnv).map(([key, value]) =>
                  `$psi.Environment[${quotePs(key)}] = ${quotePs(value)}`
                );
                script = [
                  '$psi = New-Object System.Diagnostics.ProcessStartInfo',
                  `$psi.FileName = ${quotePs(command)}`,
                  `$psi.Arguments = ${quotePs(quotedArgs)}`,
                  `$psi.WorkingDirectory = ${quotePs(process.cwd())}`,
                  '$psi.UseShellExecute = $false',
                  '$psi.RedirectStandardInput = $true',
                  '$psi.RedirectStandardOutput = $true',
                  '$psi.RedirectStandardError = $true',
                  '$psi.StandardInputEncoding = [System.Text.Encoding]::UTF8',
                  '$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8',
                  '$psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8',
                  ...envAssignments,
                  '$p = New-Object System.Diagnostics.Process',
                  '$p.StartInfo = $psi',
                  '$null = $p.Start()',
                  `$inputText = Get-Content -LiteralPath ${quotePs(tempFile)} -Raw -Encoding UTF8`,
                  '$p.StandardInput.Write($inputText)',
                  '$p.StandardInput.Close()',
                  '$stdout = $p.StandardOutput.ReadToEnd()',
                  '$stderr = $p.StandardError.ReadToEnd()',
                  '$p.WaitForExit()',
                  'if ($stdout) { [Console]::Out.Write($stdout) }',
                  'if ($stderr) { [Console]::Error.Write($stderr) }',
                  'exit $p.ExitCode',
                ].join('; ');
              } else {
                script = [
                  `$inputText = Get-Content -LiteralPath ${quotePs(tempFile)} -Raw -Encoding UTF8`,
                  `$inputText | & ${commandSegments}`,
                  '$exitCode = $LASTEXITCODE',
                  'exit $exitCode',
                ].join('; ');
              }
            }
            proc = spawnCLI(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
              cwd: process.cwd(),
              env: {
                TERM: 'dumb',
                NO_COLOR: '1',
                FORCE_COLOR: '0',
                CLICOLOR: '0',
                CLICOLOR_FORCE: '0',
                ...cliEnv,
              },
            });
          } else {
            const quoteCmd = (value: string) => {
              const clean = String(value ?? '');
              if (!/[ \t"&|<>^()%!]/.test(clean)) return clean;
              return `"${clean.replace(/(["^])/g, '^$1')}"`;
            };
            let commandLine = [command, ...args].map(quoteCmd).join(' ');
            if (stdinInput) {
              const tempFile = path.join(
                os.tmpdir(),
                `jarvis-cli-${backendId || 'shell'}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
              );
              fs.writeFileSync(tempFile, stdinInput, 'utf8');
              cleanupPaths.push(tempFile);
              commandLine = `type ${quoteCmd(tempFile)} | ${commandLine}`;
            }
            proc = spawnCLI(shell, ['/d', '/s', '/c', commandLine], {
              cwd: process.cwd(),
              env: {
                TERM: 'dumb',
                NO_COLOR: '1',
                FORCE_COLOR: '0',
                CLICOLOR: '0',
                CLICOLOR_FORCE: '0',
                ...cliEnv,
              },
            });
          }
        } else {
          const quoteSh = (value: string) => `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
          let commandLine = [command, ...args].map(quoteSh).join(' ');
          if (stdinInput) {
            const tempFile = path.join(
              os.tmpdir(),
              `jarvis-cli-${backendId || 'shell'}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
            );
            fs.writeFileSync(tempFile, stdinInput, 'utf8');
            cleanupPaths.push(tempFile);
            commandLine = `cat ${quoteSh(tempFile)} | ${commandLine}`;
          }
          proc = spawnCLI('/bin/sh', ['-lc', commandLine], {
            cwd: process.cwd(),
            env: {
              TERM: 'dumb',
              NO_COLOR: '1',
              FORCE_COLOR: '0',
              CLICOLOR: '0',
              CLICOLOR_FORCE: '0',
              ...cliEnv,
            },
          });
        }
      } else {
        proc = spawnCLI(command, args, {
          cwd: process.cwd(),
          env: {
            TERM: 'dumb',
            NO_COLOR: '1',
            FORCE_COLOR: '0',
            CLICOLOR: '0',
            CLICOLOR_FORCE: '0',
            ...cliEnv,
          },
        });
      }
    } catch (err) {
      const msg = errorMessage(err);
      log.error(`Failed to spawn ${backendId || 'cli'}: ${msg}`, {
        command,
        args: args.slice(0, 10),
      });
      const hint = backendId === 'codex-cli'
        ? '\nHint: set CODEX_CLI_PATH to a runnable codex binary (not protected WindowsApps path).'
        : backendId === 'claude-cli'
          ? '\nHint: set CLAUDE_CLI_PATH to a runnable Claude CLI binary.'
          : '';
      finish(`${msg}${hint}`);
      return;
    }

    try {
      if (proc.process.stdin && !proc.process.stdin.destroyed) {
        if (stdinInput) {
          proc.process.stdin.write(stdinInput);
          if (!stdinInput.endsWith('\n')) {
            proc.process.stdin.write('\n');
          }
        }
        proc.process.stdin.end();
      }
    } catch {
      // best effort
    }

    timer = setTimeout(() => {
      proc.kill();
      if (backendId === 'kilo-cli') {
        // Detect common kilo auth/provider errors and give actionable message
        const outLower = out.toLowerCase();
        if (/invalid api key|ProviderModelNotFoundError|provider.*not found/i.test(out)) {
          finish(`${out}\n\n⚠️ kilo CLI ต้องการ authentication ก่อนใช้งาน — กรุณารัน "kilo auth" ใน terminal เพื่อตั้งค่า`);
        } else if (!out.trim()) {
          finish('CLI timeout exceeded — kilo อาจต้องการ authentication: ลอง "kilo auth" ใน terminal');
        } else {
          finish(`${out}\nCLI timeout exceeded`);
        }
      } else {
        finish(out ? `${out}\nCLI timeout exceeded` : 'CLI timeout exceeded');
      }
    }, timeoutMs);

    proc.onData((chunk: string) => {
      out += chunk;
      // Early exit for kilo auth errors — don't wait for full timeout
      if (backendId === 'kilo-cli' && /invalid api key|ProviderModelNotFoundError/i.test(out)) {
        proc.kill();
        finish(`${out.trim()}\n\n⚠️ kilo CLI ต้องการ authentication — กรุณารัน "kilo auth" ใน terminal`);
      }
    });
    proc.onExit(() => finish(out));
    proc.process.on('error', (err: Error) => finish(out || errorMessage(err) || 'CLI command failed'));
  });
}

/**
 * CLI Initializer - Handles initialization and spawning of CLI specialist processes.
 *
 * Responsibilities:
 * - Initialize CLI sessions for gemini-cli, codex-cli, claude-cli, etc.
 * - Spawn native PTY processes with proper environment configuration
 * - Validate CLI availability before spawning
 * - Wrap node-pty IPty interface to PTYProcess interface
 */

import * as nodePty from 'node-pty';
import { getCLIConfig } from './commandRouter.js';
import { createLogger } from '../utils/logger.js';
import type { PTYProcess } from './ptyManager.js';

const log = createLogger('CliInitializer');

/**
 * Format error message from Error or unknown type
 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Check if session type is a CLI session (ends with '-cli')
 */
export function isCliSessionType(type: string): type is `${string}-cli` {
  return type.endsWith('-cli');
}

/**
 * Check if a CLI backend is available for the given session type
 */
export function isCLIAvailable(sessionType: string): boolean {
  if (!isCliSessionType(sessionType)) {
    return false;
  }
  const cliConfig = getCLIConfig(sessionType as `${string}-cli`);
  return !!cliConfig;
}

/**
 * Wrap node-pty IPty into our PTYProcess interface for compatibility
 */
export function wrapNodePtyProcess(ptyProc: nodePty.IPty): PTYProcess {
  return {
    process: ptyProc as any, // Cast to ChildProcess for compatibility
    write: (data: string) => {
      try {
        ptyProc.write(data);
      } catch {
        // best effort
      }
    },
    resize: (cols: number, rows: number) => {
      try {
        ptyProc.resize(cols, rows);
      } catch {
        // best effort
      }
    },
    kill: () => {
      try {
        ptyProc.kill();
      } catch {
        // best effort
      }
    },
    onData: (cb: (data: string) => void) => {
      ptyProc.onData((data) => cb(data));
    },
    onExit: (cb: (code: number | null) => void) => {
      ptyProc.onExit((e) => cb(e.exitCode ?? null));
    },
  };
}

/**
 * Get environment overrides for CLI session (delegated to cliCommandExecutor)
 */
import { getCliEnvironmentOverrides } from './cliCommandExecutor.js';

/**
 * Spawn a CLI process and return the wrapped PTYProcess
 *
 * @param sessionType - CLI type (e.g., 'gemini-cli', 'claude-cli', 'codex-cli')
 * @param cols - Terminal columns
 * @param rows - Terminal rows
 * @param cwd - Working directory
 * @returns Wrapped PTYProcess or null if CLI is unavailable
 * @throws Error if CLI process creation fails
 */
export function spawnCliProcess(
  sessionType: string,
  cols: number,
  rows: number,
  cwd: string,
): PTYProcess | null {
  const cliType = sessionType as `${string}-cli`;
  const cliConfig = getCLIConfig(cliType);
  if (!cliConfig) {
    return null;
  }

  const cliEnv = getCliEnvironmentOverrides(cliType);

  try {
    const ptyProc = nodePty.spawn(cliConfig.command, cliConfig.args || [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env as Record<string, string>,
        ...cliEnv,
        TERM: 'xterm-256color',
        FORCE_COLOR: '1',
        COLORTERM: 'truecolor',
      },
    });

    log.debug(`Spawned native PTY CLI: ${cliConfig.command} (PID: ${ptyProc.pid})`);

    return wrapNodePtyProcess(ptyProc);
  } catch (procErr: unknown) {
    log.error(`Failed to create CLI PTY: ${errorMessage(procErr)}`, {
      backend: sessionType,
    });
    throw procErr;
  }
}

/**
 * Get a user-friendly error message for CLI initialization failure
 */
export function getCliInitErrorMessage(sessionType: string, err: unknown): string {
  const errorMsg = errorMessage(err);

  const cliType = sessionType as `${string}-cli`;
  if (cliType === 'codex-cli') {
    return `${errorMsg}\nHint: set CODEX_CLI_PATH in .env and restart the server.`;
  } else if (cliType === 'claude-cli') {
    return `${errorMsg}\nHint: install Claude CLI and/or set CLAUDE_CLI_PATH in .env, then restart the server.`;
  }

  return errorMsg;
}

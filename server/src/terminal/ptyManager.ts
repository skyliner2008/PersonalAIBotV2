/**
 * PTY Manager — Process-based Terminal Emulation
 *
 * Uses child_process.spawn instead of node-pty (no native modules needed).
 * Spawns real shell processes (bash/zsh/sh) with piped I/O.
 * Handles output streaming, input writing, and process lifecycle.
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { createLogger } from '../utils/logger.js';

const log = createLogger('PTYManager');

// Rate limiting: max writes per second
const MAX_WRITES_PER_SEC = 100;
const MAX_WRITE_SIZE = 4096; // 4KB per write

function shortCommandName(command: string): string {
  const normalized = String(command || '').trim().replace(/"/g, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || normalized || 'unknown';
}

function compactArgsPreview(args: string[], maxChars = 180): string {
  const joined = (args || [])
    .map((arg) => String(arg || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
  if (!joined) return '';
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, maxChars)}...`;
}

export interface PTYOptions {
  shell?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface PTYProcess {
  process: ChildProcess;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (callback: (data: string) => void) => void;
  onExit: (callback: (code: number | null) => void) => void;
}

/**
 * Detect the default shell available in the system.
 * On Windows, always use PowerShell or cmd.exe — even if SHELL env is set
 * (Git Bash sets SHELL=/bin/bash which can't be spawned as a Windows process).
 */
export function detectShell(): string {
  // User-specified override always wins (but only if it exists on this platform)
  const override = process.env.PTY_SHELL_PATH;
  if (override) return override;

  // Windows: MUST use a native Windows shell
  if (process.platform === 'win32') {
    // Try PowerShell 7+ first, then Windows PowerShell, then cmd
    for (const ps of ['pwsh.exe', 'powershell.exe']) {
      try {
        execSync(`where ${ps}`, { timeout: 3000, stdio: 'ignore' });
        return ps;
      } catch (err) { log.debug(`Shell ${ps} not found on Windows`, { error: String(err) }); }
    }
    return process.env.COMSPEC || 'cmd.exe';
  }

  // Unix/macOS: respect SHELL env var
  const envShell = process.env.SHELL;
  if (envShell) return envShell;

  // Try common Unix shells in order
  for (const sh of ['/bin/bash', '/bin/zsh', '/bin/sh']) {
    try {
      execSync(`test -x ${sh}`, { timeout: 2000 });
      return sh;
    } catch (err) { log.debug(`Shell ${sh} not found`, { error: String(err) }); }
  }
  return '/bin/sh';
}

/**
 * Helper to build environment with terminal capabilities
 */
function getPTYEnv(opts: PTYOptions, cols: number, rows: number): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    ...(opts.env || {}),
    TERM: 'xterm-256color',
    COLUMNS: String(cols),
    LINES: String(rows),
    COLORTERM: 'truecolor',
    LANG: process.env.LANG || 'en_US.UTF-8',
    FORCE_COLOR: '1',
    CLICOLOR: '1',
    CLICOLOR_FORCE: '1',
  };
}

/**
 * Helper to determine shell arguments based on shell type
 */
function getShellArgs(shell: string): string[] {
  const shellLower = shell.toLowerCase();
  if (shellLower.includes('bash')) return ['--login'];
  if (shellLower.includes('zsh')) return [];
  if (shellLower.includes('powershell') || shellLower.includes('pwsh')) return ['-NoLogo'];
  if (shellLower.includes('cmd')) return ['/Q'];
  return [];
}

/**
 * Create a new PTY-like process using child_process.spawn
 */
export function createPTY(opts: PTYOptions = {}): PTYProcess {
  const shell = opts.shell ?? detectShell();
  const cwd = opts.cwd ?? process.cwd();
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 30;

  const proc = spawn(shell, getShellArgs(shell), {
    cwd,
    env: getPTYEnv(opts, cols, rows),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    detached: false,
    windowsHide: process.platform === 'win32',
  });

  log.debug(`Spawned shell: ${shell} (PID: ${proc.pid}) in ${cwd}`);

  let writeCount = 0;
  const writeResetInterval = setInterval(() => { writeCount = 0; }, 1000);
  const dataCallbacks: Array<(data: string) => void> = [];
  const exitCallbacks: Array<(code: number | null) => void> = [];

  const emitData = (chunk: Buffer) => {
    const str = chunk.toString('utf-8');
    dataCallbacks.forEach((cb) => {
      try { cb(str); } catch (e) { log.warn(`Data callback error: ${e}`); }
    });
  };

  proc.stdout?.on('data', emitData);
  proc.stderr?.on('data', emitData);
  proc.on('error', (err) => log.error(`Shell process error: ${err.message}`));
  proc.on('exit', (code) => {
    clearInterval(writeResetInterval);
    log.debug(`Shell process exited with code ${code}`);
    exitCallbacks.forEach((cb) => {
      try { cb(code); } catch (e) { log.warn(`Exit callback error: ${e}`); }
    });
  });

  return {
    process: proc,
    write(data: string) {
      if (proc.killed || !proc.stdin?.writable) return;
      if (writeCount >= MAX_WRITES_PER_SEC) {
        log.warn('Write rate limit exceeded');
        return;
      }
      const trimmed = data.length > MAX_WRITE_SIZE ? data.slice(0, MAX_WRITE_SIZE) : data;
      writeCount++;
      try { proc.stdin.write(trimmed); } catch (err) { log.warn(`Write error: ${err}`); }
    },
    resize(c: number, r: number) {
      try {
        if (!proc.killed && proc.stdin?.writable) proc.stdin.write(`\x1b[8;${r};${c}t`);
      } catch { /* best-effort */ }
    },
    kill() {
      clearInterval(writeResetInterval);
      if (proc.killed) return;
      try {
        proc.kill('SIGTERM');
        setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 3000);
      } catch (err) { log.warn(`Kill error: ${err}`); }
    },
    onData: (cb) => dataCallbacks.push(cb),
    onExit: (cb) => exitCallbacks.push(cb),
  };
}

/**
 * Spawn a specific CLI tool (gemini, claude, etc.) as a subprocess
 */
export function spawnCLI(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {}
): PTYProcess {
  const cwd = opts.cwd ?? process.cwd();
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    TERM: 'xterm-256color',
    FORCE_COLOR: '1',
    ...(opts.env || {}),
  };

  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command.trim());
  const spawnCommand = useShell && /\s/.test(command.trim())
    ? `"${command.trim().replace(/"/g, '\\"')}"`
    : command;
  const spawnArgs = useShell
    ? args.map((arg) => {
      const clean = String(arg ?? '');
      if (!/[ \t"]/.test(clean)) return clean;
      return `"${clean.replace(/"/g, '\\"')}"`;
    })
    : args;
  const proc = spawn(spawnCommand, spawnArgs, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: useShell,
    detached: false,
    windowsHide: process.platform === 'win32',
  });

  const commandName = shortCommandName(command);
  const argsPreview = compactArgsPreview(args);
  log.debug(`Spawned CLI: ${commandName}${argsPreview ? ` ${argsPreview}` : ''} (PID: ${proc.pid})`);

  const dataCallbacks: Array<(data: string) => void> = [];
  const exitCallbacks: Array<(code: number | null) => void> = [];

  proc.stdout?.on('data', (chunk: Buffer) => {
    const str = chunk.toString('utf-8');
    for (const cb of dataCallbacks) {
      try { cb(str); } catch (err) { log.debug('Callback error', { error: String(err) }); }
    }
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    const str = chunk.toString('utf-8');
    for (const cb of dataCallbacks) {
      try { cb(str); } catch (err) { log.debug('Callback error', { error: String(err) }); }
    }
  });

  proc.on('exit', (code) => {
    for (const cb of exitCallbacks) {
      try { cb(code); } catch (err) { log.debug('Exit callback error', { error: String(err) }); }
    }
  });

  return {
    process: proc,
    write(data: string) {
      if (!proc.killed && proc.stdin?.writable) {
        proc.stdin.write(data);
      }
    },
    resize() { /* No-op for CLI subprocesses */ },
    kill() {
      if (!proc.killed) {
        proc.kill('SIGTERM');
        setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 3000);
      }
    },
    onData(cb) { dataCallbacks.push(cb); },
    onExit(cb) { exitCallbacks.push(cb); },
  };
}

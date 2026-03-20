/**
 * Terminal Gateway - Socket.IO namespace for terminal sessions.
 *
 * Orchestrates terminal functionality by delegating to focused modules:
 * - terminalTypes.ts: Types and constants
 * - cliMemoryManager.ts: CLI conversation context and memory
 * - swarmLaneManager.ts: Persistent PTY lanes for swarm mode
 * - cliCommandExecutor.ts: CLI command execution
 * - terminalUtils.ts: Token extraction and output normalization
 * - cliInitializer.ts: CLI process initialization and spawning
 *
 * Supports:
 * - Built-in shell sessions (live PTY)
 * - Built-in agent sessions (command mode)
 * - Dynamic CLI sessions (<name>-cli)
 * - Programmatic command execution for REST/messaging bridges
 */

import { exec as cpExec } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Server as SocketServer, Socket } from 'socket.io';
import { SessionManager, type SessionType, type TerminalSession } from './sessionManager.js';
import { createPTY, detectShell, type PTYProcess } from './ptyManager.js';
import {
  routeCommand,
  getAvailableBackends,
  getCLIConfig,
  getHelpText,
  toCliBackendId,
} from './commandRouter.js';
import { createLogger } from '../utils/logger.js';
import { addLog } from '../database/db.js';

// Import from new modules
import type { CommandExecutionResult, CommandTokenUsage, CliExecutionMode } from './terminalTypes.js';
import {
  prepareCliPromptMemory,
  persistCliPromptMemory,
} from './cliMemoryManager.js';
import {
  shouldUsePersistentSwarmLane,
  executeViaSwarmPersistentLane,
  closeSwarmLane,
  maybeStartSwarmLaneCleanupTimer,
  shutdownSwarmLaneManager,
  getSwarmCommandTimeoutMs,
  getSwarmLaneTimeoutMs,
} from './swarmLaneManager.js';
import {
  buildCliInvocationArgs,
  getCliInvocationStdin,
  getCliEnvironmentOverrides,
  runCliCommand,
  splitCommandLine,
} from './cliCommandExecutor.js';
import {
  normalizeCliOutput,
  extractCliTokenUsage,
} from './terminalUtils.js';
import {
  isCliSessionType,
  isCLIAvailable,
  spawnCliProcess,
  getCliInitErrorMessage,
} from './cliInitializer.js';

const log = createLogger('TerminalGateway');

const ptyProcesses = new Map<string, PTYProcess>();
let sessionManager: SessionManager | null = null;
let agentHandler: ((message: string, platform: string, userId?: string) => Promise<string>) | null = null;

/**
 * Format error message from Error or unknown type
 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// isCliSessionType imported from cliInitializer

/**
 * Normalize session type (shell, agent, or CLI backend)
 */
function normalizeSessionType(input?: string): SessionType {
  if (!input) return 'shell';

  const raw = input.toLowerCase().trim();
  if (!raw) return 'shell';
  if (raw === 'shell' || raw === 'agent') return raw;

  if (isCliSessionType(raw)) {
    return toCliBackendId(raw.slice(0, -4));
  }

  const match = getAvailableBackends().find(b =>
    b.id === raw ||
    b.command?.toLowerCase() === raw ||
    b.prefix === `@${raw}`
  );

  if (match) {
    if (match.id === 'shell' || match.id === 'agent') return match.id;
    return match.id;
  }

  return toCliBackendId(raw);
}

/**
 * Attach handlers to a PTY process
 */
function attachPTYHandlers(sessionId: string, pty: PTYProcess, io: SocketServer): void {
  pty.onData((output) => {
    sessionManager?.appendOutput(sessionId, output);
    io.to(`terminal:${sessionId}`).emit('terminal:output', {
      sessionId,
      data: output,
    });
  });

  pty.onExit((code) => {
    io.to(`terminal:${sessionId}`).emit('terminal:exit', {
      sessionId,
      code,
    });
    ptyProcesses.delete(sessionId);

    const session = sessionManager?.getSession(sessionId);
    if (session) {
      session.process = null;
    }
  });
}

/**
 * Create and spawn a process for a terminal session
 */
function createProcessForSession(session: TerminalSession, shellPath: string, io: SocketServer): void {
  if (session.type === 'agent') {
    return;
  }

  if (session.type === 'shell') {
    const shellPty = createPTY({
      shell: shellPath,
      cols: session.cols,
      rows: session.rows,
      cwd: session.cwd,
    });
    session.process = shellPty.process;
    ptyProcesses.set(session.id, shellPty);
    attachPTYHandlers(session.id, shellPty, io);
    return;
  }

  if (isCliSessionType(session.type)) {
    // Check if CLI is available before attempting to spawn
    if (!isCLIAvailable(session.type)) {
      io.to(`terminal:${session.id}`).emit('terminal:output', {
        sessionId: session.id,
        data: `\x1b[1;31m[CLI unavailable] ${session.type}\x1b[0m\r\n$ `,
      });
      return;
    }

    try {
      const cols = session.cols || 120;
      const rows = session.rows || 30;
      const cwd = session.cwd || process.cwd();

      // Use the new cliInitializer to spawn the CLI process
      const wrappedPty = spawnCliProcess(session.type, cols, rows, cwd);
      if (!wrappedPty) {
        io.to(`terminal:${session.id}`).emit('terminal:output', {
          sessionId: session.id,
          data: `\x1b[1;31m[CLI Error] Failed to spawn process\x1b[0m\r\n$ `,
        });
        return;
      }

      session.process = null; // Node-pty processes are managed via the wrappedPty
      ptyProcesses.set(session.id, wrappedPty);
      attachPTYHandlers(session.id, wrappedPty, io);
    } catch (procErr: unknown) {
      log.error(`Failed to create CLI PTY: ${errorMessage(procErr)}`, {
        backend: session.type,
      });
      const errorMsg = getCliInitErrorMessage(session.type, procErr);
      io.to(`terminal:${session.id}`).emit('terminal:output', {
        sessionId: session.id,
        data: `\x1b[1;31m[CLI Error] ${errorMsg}\x1b[0m\r\n$ `,
      });
    }
  }
}

/**
 * Handle meta-commands that don't execute in a PTY (like @help, @backends)
 */
async function handleMetaCommand(
  sessionId: string,
  command: string,
  session: TerminalSession,
  io: SocketServer
): Promise<void> {
  const result = await executeCommandInternal(command, session.platform || 'api', session.userId);
  const lines = result.output.split('\n');
  for (const line of lines) {
    io.to(`terminal:${sessionId}`).emit('terminal:output', {
      sessionId,
      data: line + '\r\n',
    });
  }
  io.to(`terminal:${sessionId}`).emit('terminal:output', {
    sessionId,
    data: '$ ',
  });
}

/**
 * Internal command execution (core business logic)
 */
async function executeCommandInternal(
  input: string,
  platform: string = 'api',
  userId?: string
): Promise<CommandExecutionResult> {
  const routed = routeCommand(input);

  if (input.trim() === '@help') {
    return {
      output: getHelpText().replace(/\x1b\[[^m]*m/g, ''),
      backend: 'meta:help',
    };
  }

  if (input.trim() === '@backends') {
    const backends = getAvailableBackends();
    return {
      output: backends.map(b => `${b.available ? '[OK]' : '[NO]'} ${b.name}: ${b.description}`).join('\n'),
      backend: 'meta:backends',
    };
  }

  if (routed.backend === 'agent') {
    if (!agentHandler) {
      return {
        output: '[Error] Agent handler not initialized',
        backend: routed.backend,
      };
    }

    try {
      const result = await agentHandler(routed.command, platform, userId);
      addLog('terminal', `Agent command from ${platform}`, routed.command.substring(0, 100), 'info');
      return {
        output: result,
        backend: routed.backend,
      };
    } catch (err: unknown) {
      return {
        output: `[Agent Error] ${errorMessage(err)}`,
        backend: routed.backend,
      };
    }
  }

  if (routed.backend === 'shell') {
    if (platform === 'api') {
      return {
        output: '[Error] Shell backend is disabled for REST execute endpoint',
        backend: routed.backend,
      };
    }

    return new Promise((resolve) => {
      const timeout = 30_000;
      cpExec(routed.command, { timeout, maxBuffer: 1024 * 1024, cwd: process.cwd() }, (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
          resolve({
            output: stderr || errorMessage(err) || 'Command failed',
            backend: routed.backend,
          });
        } else {
          resolve({
            output: stdout + (stderr ? `\n${stderr}` : ''),
            backend: routed.backend,
          });
        }
      });
    });
  }

  const cliConfig = getCLIConfig(routed.backend);
  if (!cliConfig) {
    log.warn(`CLI backend unavailable: ${routed.backend}`, {
      platform,
      userId: userId || 'unknown',
    });
    let backendHint = '';
    if (routed.backend === 'codex-cli') {
      backendHint = '\nHint: set CODEX_CLI_PATH in .env and restart the server.';
    } else if (routed.backend === 'claude-cli') {
      backendHint = '\nHint: install Claude CLI and/or set CLAUDE_CLI_PATH in .env, then restart the server.';
    }
    return {
      output: `[Error] ${routed.backend} is not available on this system${backendHint}`,
      backend: routed.backend,
    };
  }

  if (!routed.command.trim()) {
    return {
      output: `[Error] Missing CLI input for ${routed.backend}`,
      backend: routed.backend,
    };
  }

  const cliMemory = await prepareCliPromptMemory(
    routed.backend,
    routed.command,
    platform,
    userId,
  );

  if (shouldUsePersistentSwarmLane(platform, routed.backend, cliMemory.prompt)) {
    try {
      const rawOutput = await executeViaSwarmPersistentLane(
        routed.backend,
        cliMemory.prompt,
        cliConfig,
      );
      const output = normalizeCliOutput(
        routed.backend,
        rawOutput,
      );
      const tokenUsage = extractCliTokenUsage(
        routed.backend,
        rawOutput,
        output,
        cliMemory.prompt || routed.command,
      );

      return {
        output: output || 'CLI command failed',
        backend: routed.backend,
        tokenUsage,
      };
    } catch (err) {
      log.warn(`Persistent lane failed for ${routed.backend}, falling back to one-shot execution`, {
        error: errorMessage(err),
      });
      closeSwarmLane(routed.backend);
    }
  }

  const usePipeInSwarm =
    platform === 'swarm' &&
    ['gemini-cli', 'claude-cli', 'codex-cli'].includes(routed.backend);
  const executionMode: CliExecutionMode =
    usePipeInSwarm ? 'pipe' : platform === 'swarm' ? 'shell' : 'pipe';
  const args = buildCliInvocationArgs(
    routed.backend,
    cliMemory.prompt,
    cliConfig.args,
    executionMode,
    platform === 'swarm'
  );
  const stdinInput = getCliInvocationStdin(routed.backend, cliMemory.prompt, executionMode);

  const rawOutput = await runCliCommand(
    cliConfig.command,
    args,
    routed.backend,
    stdinInput || undefined,
    executionMode,
    platform === 'swarm' ? getSwarmCommandTimeoutMs() : undefined,
  );
  const output = normalizeCliOutput(
    routed.backend,
    rawOutput,
  );
  const tokenUsage = extractCliTokenUsage(
    routed.backend,
    rawOutput,
    output,
    cliMemory.prompt || routed.command,
  );

  if (cliMemory.shouldPersist && cliMemory.conversationId) {
    await persistCliPromptMemory(
      cliMemory.conversationId,
      routed.command,
      output,
      cliMemory.profile,
    );
  }

  return {
    output: output || 'CLI command failed',
    backend: routed.backend,
    tokenUsage,
  };
}

/**
 * Set the agent handler function (for command routing)
 */
export function setAgentHandler(handler: (message: string, platform: string, userId?: string) => Promise<string>): void {
  agentHandler = handler;
  log.debug('Agent handler registered');
}

/**
 * Get the current session manager
 */
export function getSessionManager(): SessionManager | null {
  return sessionManager;
}

/**
 * Execute a command programmatically and return plain text output.
 */
export async function executeCommand(
  input: string,
  platform: string = 'api',
  userId?: string
): Promise<string> {
  const result = await executeCommandInternal(input, platform, userId);
  return result.output;
}

/**
 * Execute a command programmatically and return output + token metadata.
 */
export async function executeCommandDetailed(
  input: string,
  platform: string = 'api',
  userId?: string
): Promise<CommandExecutionResult> {
  return executeCommandInternal(input, platform, userId);
}

/**
 * Handle terminal:create event
 */
function handleTerminalCreate(
  socket: Socket,
  io: SocketServer,
  shellPath: string,
  socketSessions: Set<string>,
  data: {
    type?: string;
    cols?: number;
    rows?: number;
    label?: string;
    platform?: string;
  } = {}
) {
  try {
    if (!sessionManager) {
      socket.emit('terminal:error', { message: 'Terminal session manager not initialized' });
      return;
    }

    const sessionType = normalizeSessionType(data.type);
    const session = sessionManager.createSession({
      type: sessionType,
      cols: data.cols ?? 120,
      rows: data.rows ?? 30,
      label: data.label,
      platform: data.platform ?? 'web',
    });

    socketSessions.add(session.id);
    socket.join(`terminal:${session.id}`);

    socket.emit('terminal:created', {
      sessionId: session.id,
      label: session.label,
      type: session.type,
    });

    try {
      createProcessForSession(session, shellPath, io);
      if (session.type === 'agent') {
        io.to(`terminal:${session.id}`).emit('terminal:output', {
          sessionId: session.id,
          data: '\x1b[1;35m[Agent session ready]\x1b[0m\r\n$ ',
        });
      }
    } catch (procErr: unknown) {
      log.error(`Failed to create process for session ${session.id}: ${errorMessage(procErr)}`);
      io.to(`terminal:${session.id}`).emit('terminal:output', {
        sessionId: session.id,
        data: `\x1b[1;31m[Session Error] ${errorMessage(procErr)}\x1b[0m\r\n` +
          '\x1b[33mFalling back to command mode. Type commands and press Enter.\x1b[0m\r\n$ ',
      });
    }

    io.emit('terminal:sessions', { sessions: sessionManager.listSessions() });
    addLog('terminal', 'Session created', `${session.id} (${session.type})`, 'info');
  } catch (err: unknown) {
    socket.emit('terminal:error', { message: errorMessage(err) || 'Failed to create session' });
  }
}

/**
 * Handle terminal:input event
 */
async function handleTerminalInput(
  socket: Socket,
  io: SocketServer,
  lineBuffers: Map<string, string>,
  data: { sessionId: string; data: string }
) {
  const { sessionId, data: inputData } = data;
  const session = sessionManager?.getSession(sessionId);
  if (!session) {
    socket.emit('terminal:error', { sessionId, message: 'Session not found' });
    return;
  }

  sessionManager?.touchSession(sessionId);

  const pty = ptyProcesses.get(sessionId);
  const hasPTY = !!pty && !pty.process.killed;
  if (hasPTY) {
    pty.write(inputData);
    return;
  }

  const buf = lineBuffers.get(sessionId) || '';
  const sendOutput = (d: string) => io.to(`terminal:${sessionId}`).emit('terminal:output', { sessionId, data: d });

  if (inputData === '\x7f' || inputData === '\b') {
    if (buf.length > 0) {
      lineBuffers.set(sessionId, buf.slice(0, -1));
      sendOutput('\b \b');
    }
    return;
  }

  if (inputData === '\x03') {
    lineBuffers.set(sessionId, '');
    sendOutput('^C\r\n$ ');
    return;
  }

  const isEnter = inputData.endsWith('\r') || inputData.endsWith('\n');
  if (!isEnter) {
    lineBuffers.set(sessionId, buf + inputData);
    sendOutput(inputData);
    return;
  }

  const command = buf.trim();
  lineBuffers.set(sessionId, '');
  sendOutput('\r\n');

  if (!command) {
    sendOutput('$ ');
    return;
  }

  await handleMetaCommand(sessionId, command, session, io);
}

/**
 * Handle terminal:resize event
 */
function handleTerminalResize(data: { sessionId: string; cols: number; rows: number }) {
  const pty = ptyProcesses.get(data.sessionId);
  if (pty) {
    pty.resize(data.cols, data.rows);
  }
}

/**
 * Handle terminal:close event
 */
function handleTerminalClose(
  socket: Socket,
  io: SocketServer,
  socketSessions: Set<string>,
  data: { sessionId: string }
) {
  const pty = ptyProcesses.get(data.sessionId);
  if (pty) {
    pty.kill();
    ptyProcesses.delete(data.sessionId);
  }

  sessionManager?.closeSession(data.sessionId);
  socketSessions.delete(data.sessionId);
  socket.leave(`terminal:${data.sessionId}`);

  io.emit('terminal:sessions', { sessions: sessionManager?.listSessions() || [] });
}

/**
 * Set up the terminal gateway on a Socket.IO server
 */
export function setupTerminalGateway(io: SocketServer, opts: {
  maxSessions?: number;
  idleTimeoutMs?: number;
  shellPath?: string;
} = {}): void {
  sessionManager = new SessionManager({
    maxSessions: opts.maxSessions ?? 10,
    idleTimeoutMs: opts.idleTimeoutMs ?? 3_600_000,
  });

  const shellPath = opts.shellPath ?? detectShell();
  log.info(
    `[Swarm] CLI mode: persistent=${process.env.SWARM_PERSISTENT_CLI === '1' ? 'on' : 'off'} | laneTimeoutMs=${getSwarmLaneTimeoutMs()} | commandTimeoutMs=${getSwarmCommandTimeoutMs()}`,
  );

  io.on('connection', (socket: Socket) => {
    const socketSessions = new Set<string>();
    const lineBuffers = new Map<string, string>();

    socket.on('terminal:list', () => {
      socket.emit('terminal:sessions', { sessions: sessionManager?.listSessions() || [] });
    });

    socket.on('terminal:create', (data) =>
      handleTerminalCreate(socket, io, shellPath, socketSessions, data));

    socket.on('terminal:input', (data) =>
      handleTerminalInput(socket, io, lineBuffers, data));

    socket.on('terminal:resize', handleTerminalResize);

    socket.on('terminal:close', (data) =>
      handleTerminalClose(socket, io, socketSessions, data));

    socket.on('disconnect', () => {
      log.debug(`Socket disconnected, ${socketSessions.size} sessions preserved for reconnect`);
    });
  });

  maybeStartSwarmLaneCleanupTimer();
  log.info('Terminal gateway initialized');
}

/**
 * Shut down all terminal sessions (for graceful server shutdown)
 */
export function shutdownTerminalGateway(): void {
  for (const [id, pty] of ptyProcesses) {
    pty.kill();
    ptyProcesses.delete(id);
  }

  if (sessionManager) {
    sessionManager.shutdownAll();
    sessionManager = null;
  }

  shutdownSwarmLaneManager();
  log.info('Terminal gateway shut down');
}

// Re-export types for API consumers
export type { CommandExecutionResult, CommandTokenUsage };

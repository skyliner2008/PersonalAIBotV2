/**
 * Swarm Lane Manager
 *
 * Manages persistent PTY lanes for swarm-mode CLI execution.
 * Reduces startup overhead by reusing long-lived processes for multiple commands.
 *
 * Key concepts:
 * - Lane: A persistent process + context for a specific CLI + command pattern
 * - Lane lifecycle: Created on first use, reused, auto-cleaned when idle
 * - Output buffering: Captures output for parsing (tokens, status, etc.)
 */

import {
  SwarmPersistentLane,
  DEFAULT_SWARM_LANE_TIMEOUT_MS,
  DEFAULT_SWARM_LANE_IDLE_TIMEOUT_MS,
  SWARM_LANE_MAX_BUFFER_CHARS,
  SWARM_PERSISTENT_CLI_BACKENDS,
} from './terminalTypes.js';
import type { PTYProcess } from './ptyManager.js';
import { spawnCLI, detectShell } from './ptyManager.js';
import { getCLIConfig } from './commandRouter.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('SwarmLaneManager');

const swarmPersistentLanes = new Map<`${string}-cli`, SwarmPersistentLane>();
let swarmPersistentLaneCleanupTimer: NodeJS.Timeout | null = null;

/**
 * Parse positive integer from environment or fallback
 */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return parsed > 0 ? parsed : fallback;
}

/**
 * Get swarm lane timeout (default 2 minutes, configurable)
 */
export function getSwarmLaneTimeoutMs(): number {
  return parsePositiveInt(process.env.SWARM_LANE_TIMEOUT_MS, DEFAULT_SWARM_LANE_TIMEOUT_MS);
}

/**
 * Get swarm command timeout (default 3 minutes, configurable)
 */
export function getSwarmCommandTimeoutMs(): number {
  return parsePositiveInt(process.env.SWARM_COMMAND_TIMEOUT_MS, 180_000);
}

/**
 * Get swarm lane idle timeout (default 10 minutes, configurable)
 */
export function getSwarmLaneIdleTimeoutMs(): number {
  return parsePositiveInt(process.env.SWARM_LANE_IDLE_TIMEOUT_MS, DEFAULT_SWARM_LANE_IDLE_TIMEOUT_MS);
}

/**
 * Check if we should use persistent swarm lanes for this command
 */
export function shouldUsePersistentSwarmLane(
  platform: string,
  backendId: `${string}-cli`,
  prompt: string
): boolean {
  if (process.env.SWARM_PERSISTENT_CLI !== '1') return false;
  if (platform !== 'swarm') return false;
  if (!SWARM_PERSISTENT_CLI_BACKENDS.has(backendId)) return false;

  // Don't use persistent lane if prompt has too much context
  if (prompt.length > 10_000) return false;

  return true;
}

/**
 * Start cleanup timer for idle persistent lanes
 */
export function maybeStartSwarmLaneCleanupTimer(): void {
  if (swarmPersistentLaneCleanupTimer) return;

  swarmPersistentLaneCleanupTimer = setInterval(() => {
    const now = Date.now();
    const idleTimeout = getSwarmLaneIdleTimeoutMs();

    for (const [backendId, lane] of swarmPersistentLanes) {
      if (now - lane.lastUsedAt > idleTimeout) {
        log.info(`Cleaning up idle swarm lane: ${backendId}`);
        closeSwarmLane(backendId);
      }
    }
  }, 60_000); // Check every minute
}

/**
 * Close a swarm persistent lane (kill process, clear state)
 */
export function closeSwarmLane(backendId: `${string}-cli`): void {
  const lane = swarmPersistentLanes.get(backendId);
  if (!lane) return;

  try {
    if (lane.process && !lane.process.process.killed) {
      lane.process.kill();
    }
  } catch {
    // best effort
  }

  swarmPersistentLanes.delete(backendId);
  log.debug(`Closed swarm lane for ${backendId}`);
}

/**
 * Shut down all swarm persistent lanes
 */
export function shutdownAllSwarmLanes(): void {
  for (const backendId of swarmPersistentLanes.keys()) {
    closeSwarmLane(backendId);
  }

  if (swarmPersistentLaneCleanupTimer) {
    clearInterval(swarmPersistentLaneCleanupTimer);
    swarmPersistentLaneCleanupTimer = null;
  }

  log.info('All swarm lanes shut down');
}

/**
 * Build a key for swarm lane lookup (based on backend + command structure)
 */
function buildSwarmLaneKey(command: string, args: string[]): string {
  // Key includes the first few args to distinguish different command modes
  const keyArgs = args.slice(0, 2).join('|');
  return `${command}:${keyArgs}`;
}

/**
 * Ensure a swarm persistent lane exists (create if needed)
 */
export async function ensureSwarmLane(
  backendId: `${string}-cli`
): Promise<SwarmPersistentLane | null> {
  let lane = swarmPersistentLanes.get(backendId);
  if (lane) {
    // Check if process is still alive
    if (lane.process && !lane.process.process.killed) {
      lane.lastUsedAt = Date.now();
      return lane;
    } else {
      // Process died, remove stale lane
      swarmPersistentLanes.delete(backendId);
      lane = undefined;
    }
  }

  // Create new lane
  const config = getCLIConfig(backendId);
  if (!config) {
    log.warn(`No CLI config for swarm lane: ${backendId}`);
    return null;
  }

  try {
    const shell = detectShell();
    const proc = spawnCLI(config.command, config.args || [], {
      cwd: process.cwd(),
      env: {
        TERM: 'dumb',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
    });

    lane = {
      backendId,
      command: config.command,
      argsKey: buildSwarmLaneKey(config.command, config.args || []),
      process: proc,
      outputBuffer: '',
      queue: Promise.resolve(),
      lastUsedAt: Date.now(),
    };

    // Capture output
    proc.onData((chunk: string) => {
      lane!.outputBuffer += chunk;
      if (lane!.outputBuffer.length > SWARM_LANE_MAX_BUFFER_CHARS) {
        lane!.outputBuffer = lane!.outputBuffer.slice(-SWARM_LANE_MAX_BUFFER_CHARS);
      }
    });

    // Handle process exit
    proc.onExit(() => {
      log.debug(`Swarm lane process exited: ${backendId}`);
      closeSwarmLane(backendId);
    });

    proc.process.on('error', (err: Error) => {
      log.warn(`Swarm lane process error: ${err.message}`, { backendId });
      closeSwarmLane(backendId);
    });

    swarmPersistentLanes.set(backendId, lane);
    maybeStartSwarmLaneCleanupTimer();

    log.info(`Created swarm lane for ${backendId}`);
    return lane;
  } catch (err) {
    log.error(`Failed to create swarm lane: ${err}`, { backendId });
    return null;
  }
}

/**
 * Build a prompt for swarm lane execution with a marker for output parsing
 */
export function buildSwarmLanePrompt(prompt: string, marker: string): string {
  return `${prompt}\necho "SWARM_LANE_MARKER_${marker}"`;
}

/**
 * Execute a command via swarm persistent lane and capture output
 */
export async function executeViaSwarmPersistentLane(
  backendId: `${string}-cli`,
  prompt: string,
  cliConfig: any // getCLIConfig return type
): Promise<string> {
  const lane = await ensureSwarmLane(backendId);
  if (!lane || !lane.process) {
    throw new Error(`Failed to obtain swarm lane for ${backendId}`);
  }

  return new Promise((resolve, reject) => {
    const marker = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const timeoutMs = getSwarmLaneTimeoutMs();
    let timer: NodeJS.Timeout | null = null;
    let foundMarker = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
    };

    const checkOutput = () => {
      const markerStr = `SWARM_LANE_MARKER_${marker}`;
      if (lane.outputBuffer.includes(markerStr)) {
        foundMarker = true;

        // Extract output between last prompt and marker
        const lastPromptIdx = lane.outputBuffer.lastIndexOf('$ ');
        const markerIdx = lane.outputBuffer.indexOf(markerStr);

        let output = '';
        if (lastPromptIdx >= 0) {
          output = lane.outputBuffer.slice(lastPromptIdx + 2, markerIdx).trim();
        } else {
          output = lane.outputBuffer.slice(0, markerIdx).trim();
        }

        // Clear buffer after this command
        lane.outputBuffer = lane.outputBuffer.slice(markerIdx + markerStr.length);
        lane.lastUsedAt = Date.now();

        cleanup();
        resolve(output);
      }
    };

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Swarm lane timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    // Queue the command
    lane.queue = lane.queue
      .then(() => {
        return new Promise<void>((qResolve) => {
          const cmdPrompt = buildSwarmLanePrompt(prompt, marker);

          try {
            if (lane.process && lane.process.process.stdin && !lane.process.process.stdin.destroyed) {
              lane.process.write(cmdPrompt + '\n');

              // Check output periodically
              const checkInterval = setInterval(() => {
                checkOutput();
                if (foundMarker) {
                  clearInterval(checkInterval);
                  qResolve();
                }
              }, 100);

              // Resolve after timeout or marker found
              setTimeout(() => {
                clearInterval(checkInterval);
                if (foundMarker) {
                  qResolve();
                } else {
                  reject(new Error(`No marker found after ${timeoutMs}ms`));
                }
              }, timeoutMs);
            } else {
              reject(new Error('Lane process stdin not available'));
              qResolve();
            }
          } catch (err) {
            reject(err);
            qResolve();
          }
        });
      })
      .catch(reject);
  });
}

/**
 * Get all active swarm lanes
 */
export function getActiveSwarmLanes(): Map<`${string}-cli`, SwarmPersistentLane> {
  return new Map(swarmPersistentLanes);
}

/**
 * Shutdown hook (called on process exit)
 */
export function shutdownSwarmLaneManager(): void {
  shutdownAllSwarmLanes();
}

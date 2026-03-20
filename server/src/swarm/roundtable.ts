/**
 * MeetingRoom — Multi-Agent Roundtable Protocol
 * 
 * A "meeting room" where Jarvis (chairman) orchestrates discussion
 * between CLI agents using DIRECT PROCESS SPAWN + STDIN PIPE.
 * 
 * NO middleware layers — bypasses terminalGateway entirely.
 * Each CLI is spawned as a child process, prompt written via stdin,
 * response read from stdout. Clean, reliable, encoding-safe.
 * 
 * Flow:
 * 1. Jarvis creates agenda from user objective
 * 2. All available CLIs respond in parallel (Round 1)  
 * 3. Round 2: CLIs see each other's Round 1 responses → refine
 * 4. Jarvis synthesizes final answer from all rounds
 */

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getCLIConfig, getAvailableBackends, reportCliError } from '../terminal/commandRouter.js';
import { createLogger } from '../utils/logger.js';
import type { Agent } from '../bot_agents/agent.js';
import { getRootAdminIdentity } from '../system/rootAdmin.js';

const log = createLogger('MeetingRoom');

// ─── Types ───────────────────────────────────────────────────────────

export type MeetingStatus = 'preparing' | 'discussing' | 'synthesizing' | 'done' | 'failed';

export interface ParticipantResponse {
  participant: string;
  response: string;
  durationMs: number;
  status: 'success' | 'failed' | 'timeout' | 'unavailable';
  error?: string;
}

export interface DiscussionRound {
  roundNumber: number;
  topic: string;
  responses: ParticipantResponse[];
  startedAt: number;
  completedAt?: number;
}

export interface MeetingSession {
  id: string;
  objective: string;
  participants: string[];
  rounds: DiscussionRound[];
  transcript: string[];
  maxRounds: number;
  status: MeetingStatus;
  synthesis?: string;
  createdAt: number;
  completedAt?: number;
  totalDurationMs?: number;
}

export interface MeetingOptions {
  id?: string;
  maxRounds?: number;
  timeoutPerCliMs?: number;
  agentInstance?: Agent;
  onParticipantsDiscovered?: (participants: string[]) => void;
  onStatusChanged?: (status: MeetingSession['status']) => void;
}

// ─── CLI Configuration ───────────────────────────────────────────────

interface CliSpawnConfig {
  id: string;
  label: string;
  command: string;
  buildArgs: (prompt: string, tempFile: string) => string[];
  usesStdin: boolean;    // true = pipe prompt via stdin, false = use temp file/args
  extraEnv?: Record<string, string>;
}

const TEMP_DIR = path.join(os.tmpdir(), 'jarvis_meeting');
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_ROUNDS = 2;

import { loadCliProfiles } from './cliProfileManager.js';

/**
 * Discover ALL available CLIs dynamically.
 * Uses commandRouter's getAvailableBackends() — supports ANY installed CLI.
 */
function discoverCliParticipants(): CliSpawnConfig[] {
  const backends = getAvailableBackends();
  const participants: CliSpawnConfig[] = [];
  const cliProfiles = loadCliProfiles();

  for (const backend of backends) {
    // Skip non-CLI backends (shell, agent)
    if (backend.kind !== 'cli' || !backend.available) continue;

    const cliConfig = getCLIConfig(backend.id as `${string}-cli`);
    if (!cliConfig) continue;

    const profile = cliProfiles[backend.id];
    const shortId = backend.id.replace(/-cli$/, '');

    if (profile) {
      // Known CLI — use specific profile
      participants.push({
        id: shortId,
        label: backend.name,
        command: cliConfig.command,
        buildArgs: (prompt, tempFile) => {
          return cliConfig.args.concat(
            profile.argsTemplate.map((arg) => {
              if (arg === '{prompt_content}') return prompt;
              if (arg === '{prompt_content_escaped}') return prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n');
              if (arg === '{tempFile}') return tempFile;
              return arg;
            })
          );
        },
        usesStdin: profile.usesStdin,
        extraEnv: profile.extraEnv,
      });
    } else {
      // Unknown CLI — generic stdin fallback
      participants.push({
        id: shortId,
        label: backend.name,
        command: cliConfig.command,
        buildArgs: (_prompt, _tempFile) => [...cliConfig.args],
        usesStdin: true,  // Most CLIs accept stdin
      });
    }

    log.info(`[MeetingRoom] Discovered participant: ${backend.name} (${backend.id})`);
  }

  return participants;
}

// ─── Direct CLI Spawn ────────────────────────────────────────────────

function ensureTempDir(): void {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

function writeTempFile(sessionId: string, participantId: string, content: string): string {
  ensureTempDir();
  const fileName = `meeting_${sessionId}_${participantId}_${Date.now()}.txt`;
  const filePath = path.join(TEMP_DIR, fileName);
  // Write as UTF-8 without BOM — clean encoding
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function cleanupFile(filePath: string): void {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (err) { log.debug('File cleanup failed', { filePath, error: String(err) }); }
}

function stripAnsi(input: string): string {
  return input
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B[@-_][0-?]*[ -/]*[@-~]/g, '');
}

/**
 * CORE: Spawn CLI process directly, pipe prompt via stdin, read response from stdout.
 * No middleware. No PowerShell wrappers. Just spawn → write → read → done.
 */
function spawnCliDirect(
  config: CliSpawnConfig,
  prompt: string,
  sessionId: string,
  timeoutMs: number,
): Promise<ParticipantResponse> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const tempFile = writeTempFile(sessionId, config.id, prompt);
    let stdout = '';
    let stderr = '';
    let finished = false;
    let proc: ChildProcess | null = null;

    const finish = (status: ParticipantResponse['status'], error?: string) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);

      // Kill process if still running
      if (proc && !proc.killed) {
        try { proc.kill('SIGTERM'); } catch (err) { log.debug('SIGTERM kill failed', { error: String(err) }); }
        setTimeout(() => {
          try { if (proc && !proc.killed) proc.kill('SIGKILL'); } catch (err) { log.debug('SIGKILL kill failed', { error: String(err) }); }
        }, 2000);
      }

      cleanupFile(tempFile);

      const rawResponse = stripAnsi(stdout).trim();
      resolve({
        participant: config.id,
        response: rawResponse,
        durationMs: Date.now() - startTime,
        status,
        error,
      });
    };

    // Timeout
    const timer = setTimeout(() => {
      log.warn(`[MeetingRoom] ${config.label} timed out after ${timeoutMs}ms`);
      // If we have partial output, use it
      if (stdout.trim().length > 50) {
        finish('success');
      } else {
        finish('timeout', `Timeout after ${timeoutMs}ms`);
      }
    }, timeoutMs);

    try {
      const args = config.buildArgs(prompt, tempFile);

      // Build clean environment
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        TERM: 'dumb',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        CLICOLOR: '0',
        LANG: 'en_US.UTF-8',
        ...(config.extraEnv || {}),
      };

      // Handle Windows paths with spaces (e.g., C:\Program Files\...)
      const safeCommand = (process.platform === 'win32' && config.command.includes(' ') && !config.command.startsWith('"'))
        ? `"${config.command}"`
        : config.command;

      proc = spawn(safeCommand, args, {
        cwd: process.cwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        windowsHide: true,
      });

      log.info(`[MeetingRoom] Spawned ${config.label} (PID: ${proc.pid})`);

      // Collect stdout
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8');
      });

      // Collect stderr (for debugging)
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });

      // Process exit
      proc.on('close', (code) => {
        const response = stripAnsi(stdout).trim();
        const hasErrorKeywords = /rate limit|quota|exceeded|too many requests/i.test(stderr) || /rate limit|quota|exceeded|too many requests/i.test(response);
        
        if (code === 0 && response.length > 10 && !hasErrorKeywords) {
          reportCliError(`${config.id}-cli`, null); // Clear error state on success
          finish('success');
        } else if (response.length > 50 && !hasErrorKeywords) {
          // Non-zero exit but meaningful output — still usable
          reportCliError(`${config.id}-cli`, null);
          finish('success');
        } else {
          const errorMsg = (stderr.trim() || response.trim() || `Exit code ${code}`).slice(0, 300);
          if (hasErrorKeywords) {
            reportCliError(`${config.id}-cli`, `Rate Limit / API Error: ${errorMsg}`);
            finish('failed', `Rate Limit / Quota Exceeded API Error: ${errorMsg}`);
          } else {
            reportCliError(`${config.id}-cli`, errorMsg);
            finish('failed', errorMsg);
          }
        }
      });

      proc.on('error', (err) => {
        reportCliError(`${config.id}-cli`, err.message);
        finish('failed', err.message);
      });

      // Write prompt via stdin
      if (config.usesStdin && proc.stdin) {
        proc.stdin.write(prompt, 'utf-8');
        proc.stdin.end();
      } else if (proc.stdin) {
        // For CLIs that don't use stdin (like Gemini with --prompt), just close stdin
        proc.stdin.end();
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      finish('failed', msg);
    }
  });
}

// ─── Meeting Protocol ────────────────────────────────────────────────

function generateId(): string {
  return `meeting_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build the discussion prompt for a participant in a given round.
 */
function buildDiscussionPrompt(
  session: MeetingSession,
  round: number,
  participantId: string,
): string {
  const parts: string[] = [];

  // Core instruction
  parts.push('You are participating in a multi-agent roundtable discussion.');
  parts.push(`Your role: ${participantId.toUpperCase()} specialist.`);
  parts.push('');
  parts.push(`OBJECTIVE: ${session.objective}`);
  parts.push('');
  parts.push('CRITICAL RULES FOR NON-INTERACTIVE PIPELINE:');
  parts.push('- DO NOT ask the user for permission to execute tools (e.g., no JSON approval requests).');
  parts.push('- If you require web search but cannot execute it autonomously, synthesize the best possible analysis using your internal knowledge.');
  parts.push('- For future scenarios (e.g., year 2026/2569+), use logical extrapolation and state your assumptions clearly as a "Scenario Analysis". DO NOT simply reject the prompt.');
  parts.push('- Provide an IN-DEPTH, highly detailed analysis. Do not over-summarize.');
  parts.push('');

  if (round === 1) {
    parts.push('This is Round 1. Provide your expert analysis on the objective.');
    parts.push('Be specific, concrete, and evidence-based.');
    parts.push('Respond in the same language as the objective.');
  } else {
    // Round 2+: Include transcript from previous rounds
    parts.push(`This is Round ${round}. Review the other specialists' responses below.`);
    parts.push('Add NEW insights they missed, correct any errors, or strengthen key points.');
    parts.push('Do NOT repeat what others said. Focus on value-add only.');
    parts.push('Respond in the same language as the objective.');
    parts.push('');

    // Include previous round responses
    const prevRound = session.rounds[session.rounds.length - 1];
    if (prevRound) {
      parts.push('=== PREVIOUS ROUND RESPONSES ===');
      for (const resp of prevRound.responses) {
        if (resp.status === 'success' && resp.participant !== participantId) {
          parts.push(`[${resp.participant.toUpperCase()}]:`);
          parts.push(resp.response.slice(0, 1500));
          parts.push('');
        }
      }
      parts.push('=== END RESPONSES ===');
    }
  }

  return parts.join('\n');
}

/**
 * Execute one discussion round — all available CLIs respond in parallel.
 */
async function executeRound(
  session: MeetingSession,
  roundNumber: number,
  cliConfigs: CliSpawnConfig[],
  timeoutMs: number,
): Promise<DiscussionRound> {
  const round: DiscussionRound = {
    roundNumber,
    topic: session.objective,
    responses: [],
    startedAt: Date.now(),
  };

  log.info(`[MeetingRoom] Round ${roundNumber}: dispatching to ${cliConfigs.length} participants`);

  // Fire all CLIs in parallel
  const promises = cliConfigs.map((config) => {
    const prompt = buildDiscussionPrompt(session, roundNumber, config.id);
    return spawnCliDirect(config, prompt, session.id, timeoutMs);
  });

  const results = await Promise.allSettled(promises);

  for (const result of results) {
    if (result.status === 'fulfilled') {
      round.responses.push(result.value);

      const r = result.value;
      const statusLog = r.status === 'success'
        ? `✓ ${r.response.length} chars in ${r.durationMs}ms`
        : `✗ ${r.status}: ${r.error}`;
      log.info(`[MeetingRoom] ${r.participant}: ${statusLog}`);

      // Add to transcript
      if (r.status === 'success') {
        session.transcript.push(`[Round ${roundNumber}][${r.participant.toUpperCase()}]: ${r.response}`);
      }
    }
  }

  round.completedAt = Date.now();
  session.rounds.push(round);
  return round;
}

/**
 * Build a structured synthesis from all rounds.
 */
function buildRawSynthesis(session: MeetingSession): string {
  const parts: string[] = [];
  parts.push(`# Meeting Summary`);
  parts.push(`**Objective**: ${session.objective}`);
  parts.push(`**Participants**: ${session.participants.join(', ')}`);
  parts.push(`**Rounds**: ${session.rounds.length}`);
  parts.push('');

  for (const round of session.rounds) {
    const successes = round.responses.filter((r) => r.status === 'success');
    if (successes.length === 0) continue;

    parts.push(`## Round ${round.roundNumber}`);
    for (const r of successes) {
      parts.push(`### ${r.participant.toUpperCase()} (${r.durationMs}ms)`);
      parts.push(r.response.slice(0, 8000));
      parts.push('');
    }
  }

  return parts.join('\n').slice(0, 45000);
}

/**
 * Use Jarvis agent for final synthesis.
 */
async function jarvisSynthesize(
  session: MeetingSession,
  agentInstance?: Agent,
): Promise<string> {
  const raw = buildRawSynthesis(session);

  if (!agentInstance) return raw;

  try {
    const prompt = [
      'You are Jarvis, chairman of a multi-agent meeting.',
      'Below is the full transcript from the discussion.',
      'Create a comprehensive, highly detailed, long-form executive summary for the user.',
      '- Synthesize deep insights from ALL participants without losing critical nuances.',
      '- Highlight agreements, disagreements, and unique perspectives.',
      '- For future scenarios, present structured scenario analysis.',
      '- Respond in the SAME LANGUAGE as the original objective.',
      '- DO NOT truncate or over-summarize. The output must be as detailed as possible.',
      '',
      raw,
    ].join('\n');

    // Add a small delay to prevent immediate 429 Rate Limit after aggressive CLI polling
    await new Promise(r => setTimeout(r, 3000));

    const rootAdmin = getRootAdminIdentity();
    const result = await Promise.race([
      agentInstance.processMessage(`meeting_${session.id}`, prompt, {
        botId: rootAdmin.botId,
        botName: rootAdmin.botName,
        platform: 'custom',
        replyWithFile: async () => '',
      }),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Synthesis timeout')), 60_000),
      ),
    ]);

    return result || raw;
  } catch (err: any) {
    log.error(`[MeetingRoom] Synthesis failed (possibly 429 Rate Limit), using raw:`, err.message || err);
    return `⚠️ บันทึกการประชุม (ระบบสรุปผล Jarvis Chairman ถูกจำกัดโควต้าการใช้งาน API กรุณาลองใหม่ภายหลัง)\n\n${raw}`;
  }
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Start a meeting — the main entry point.
 * Discovers available CLIs, runs discussion rounds, synthesizes.
 */
export async function startMeeting(
  objective: string,
  options: MeetingOptions = {},
): Promise<MeetingSession> {
  const maxRounds = Math.min(3, Math.max(1, options.maxRounds ?? DEFAULT_MAX_ROUNDS));
  const timeoutMs = options.timeoutPerCliMs ?? DEFAULT_TIMEOUT_MS;

  // Discover who's available (with safety timeout since execFileSync can block)
  let cliConfigs: CliSpawnConfig[] = [];
  try {
    cliConfigs = await Promise.race([
      new Promise<CliSpawnConfig[]>((resolve) => {
        // Run in next tick to not hold the current stack
        setImmediate(() => resolve(discoverCliParticipants()));
      }),
      new Promise<CliSpawnConfig[]>((_, reject) =>
        setTimeout(() => reject(new Error('CLI Discovery timed out')), 15000)
      )
    ]);
  } catch (err: any) {
    log.error(`[MeetingRoom] CLI Discovery error: ${err.message}`);
    // Fallback if completely stuck
    if (cliConfigs.length === 0) {
      throw new Error(`CLI Discovery failed: ${err.message}. Please restart server or specify valid CLI.`);
    }
  }

  if (cliConfigs.length === 0) {
    throw new Error('No CLI participants available. Install at least one: gemini, claude, or codex CLI.');
  }

  const sessionId = options.id || generateId();
  // Fetch existing placeholder if any
  const session: MeetingSession = {
    id: sessionId,
    objective,
    participants: cliConfigs.map((c) => c.id),
    rounds: [],
    transcript: [],
    maxRounds,
    status: 'preparing',
    createdAt: Date.now(),
  };

  // ─── UPDATE PLACEHOLDER IMMEDIATELY ───
  // If the router already created a placeholder, we update its participants 
  // so the frontend sees who is sitting at the table during 'preparing'
  if (options.onParticipantsDiscovered) {
    options.onParticipantsDiscovered(session.participants);
  }

  log.info(`[MeetingRoom] Starting meeting ${session.id}: "${objective.slice(0, 80)}..." (${cliConfigs.length} participants)`);

  try {
    session.status = 'discussing';
    // Let the caller (if any) know we moved to 'discussing'
    if (options.onStatusChanged) {
      options.onStatusChanged(session.status);
    }

    // ── Round 1: Everyone responds ──
    const round1 = await executeRound(session, 1, cliConfigs, timeoutMs);
    const successes1 = round1.responses.filter((r) => r.status === 'success');

    if (successes1.length === 0) {
      log.warn(`[MeetingRoom] No responses in Round 1 — falling back to raw synthesis`);
      session.status = 'failed';
      session.synthesis = 'ไม่มี CLI ตอบกลับ — กรุณาตรวจสอบการติดตั้ง CLI';
      session.completedAt = Date.now();
      session.totalDurationMs = Date.now() - session.createdAt;
      return session;
    }

    // ── Round 2: Cross-pollination (only if we have 2+ responses) ──
    if (maxRounds >= 2 && successes1.length >= 2) {
      // Only include participants that succeeded in round 1
      const round1Configs = cliConfigs.filter((c) =>
        successes1.some((r) => r.participant === c.id),
      );
      await executeRound(session, 2, round1Configs, timeoutMs);
    }

    // ── Synthesis ──
    session.status = 'synthesizing';
    log.info(`[MeetingRoom] Synthesizing from ${session.transcript.length} transcript entries...`);
    session.synthesis = await jarvisSynthesize(session, options.agentInstance);

    session.status = 'done';
    session.completedAt = Date.now();
    session.totalDurationMs = Date.now() - session.createdAt;

    log.info(`[MeetingRoom] Meeting ${session.id} completed in ${session.totalDurationMs}ms`);
    return session;

  } catch (err) {
    session.status = 'failed';
    session.completedAt = Date.now();
    session.totalDurationMs = Date.now() - session.createdAt;

    if (!session.synthesis && session.transcript.length > 0) {
      session.synthesis = buildRawSynthesis(session);
    }

    log.error(`[MeetingRoom] Meeting failed:`, err);
    return session;
  }
}

/**
 * Get formatted result for display.
 */
export function formatMeetingResult(session: MeetingSession): string {
  return session.synthesis || buildRawSynthesis(session) || '(no results)';
}

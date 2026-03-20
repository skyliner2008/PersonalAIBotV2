/**
 * Messaging Bridge — Routes admin commands from LINE/Telegram to Terminal Gateway
 *
 * When a user sends a message starting with @admin, @jarvis, @agent, or /admin
 * from LINE or Telegram, this bridge intercepts it and routes to the
 * terminal command system for execution.
 *
 * Usage in botManager.ts:
 *   import { isAdminCommand, handleAdminCommand } from '../terminal/messagingBridge.js';
 *   if (isAdminCommand(userMessage) || isBossModeActive(platform, userId)) {
 *     const result = await handleAdminCommand(userMessage, 'telegram', userId);
 *     await ctx.reply(result);
 *     return;
 *   }
 */

import { executeCommand } from './terminalGateway.js';
import { addLog, getSetting } from '../database/db.js';
import { createLogger } from '../utils/logger.js';
import { getSwarmCoordinator, type JarvisDelegationTask } from '../swarm/swarmCoordinator.js';
import { buildJarvisDelegationPlan, type JarvisPlannerOptions } from '../swarm/jarvisPlanner.js';
import { buildRuntimeJarvisPlannerOptions } from '../swarm/jarvisRuntimePlanning.js';
import { resolveJarvisSwarmRequest } from './jarvisSwarmIntent.js';
import { getRootAdminIdentity } from '../system/rootAdmin.js';

const log = createLogger('MessagingBridge');
const swarmCoordinator = getSwarmCoordinator();

// ── Boss Mode Session State ──
// Stores which users are currently in a continuous Boss Mode session
/// Maps: platform_userId -> "jarvis" | "gemini" | "codex" | "claude" | "kilo" | "openai"
const bossModeSessions = new Map<string, string>();

function bossModeLabel(mode?: string): string {
  if (mode === 'gemini') return 'Gemini CLI';
  if (mode === 'codex') return 'Codex CLI';
  if (mode === 'claude') return 'Claude CLI';
  if (mode === 'kilo') return 'Kilo Code CLI';
  if (mode === 'openai') return 'OpenAI CLI';
  if (mode === 'opencode') return 'OpenCode CLI';
  return 'Jarvis Root Agent';
}

/** Check if user is currently in a boss mode session */
export function isBossModeActive(platform: 'telegram' | 'line', userId: string): boolean {
  return bossModeSessions.has(`${platform}_${userId}`);
}

/** Get the active boss mode type */
export function getActiveBossMode(platform: 'telegram' | 'line', userId: string): string | undefined {
  return bossModeSessions.get(`${platform}_${userId}`);
}

/** Exit boss mode session */
export function exitBossMode(platform: 'telegram' | 'line', userId: string): boolean {
  const key = `${platform}_${userId}`;
  if (bossModeSessions.has(key)) {
    bossModeSessions.delete(key);
    log.info(`[${platform}] Boss mode exited for user: ${userId}`);
    return true;
  }
  return false;
}

// ── Admin User Whitelist ──
// Fetch Admin IDs dynamically from DB Settings or fallback to ENV
function getAdminIds(platform: 'telegram' | 'line'): Set<string> {
  const envKey = platform === 'telegram' ? 'ADMIN_TELEGRAM_IDS' : 'ADMIN_LINE_IDS';
  const dbKey = platform === 'telegram' ? 'admin_telegram_ids' : 'admin_line_ids';
  
  // 1. Try DB first
  let raw = getSetting(dbKey);
  // 2. Fallback to Env
  if (!raw) {
    raw = process.env[envKey] || '';
  }

  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  return new Set(ids);
}

/** Check if a user is authorized as an admin on a given platform */
export function isAuthorizedAdmin(platform: 'telegram' | 'line', userId: string): boolean {
  const adminIds = getAdminIds(platform);
  // If no admin IDs configured, deny all (secure by default)
  if (adminIds.size === 0) {
    log.warn(`No admin IDs configured for ${platform}. Set through Dashboard Settings or ${platform.toUpperCase()} env var.`);
    return false;
  }
  return adminIds.has(userId);
}

// ── Admin Command Patterns ──
const ADMIN_PREFIXES = [
  /^\/admin(?:\s+|$)/i,
  /^@admin(?:\s+|$)/i,
  /^@jarvis(?:\s+|$)/i,
  /^@agent(?:\s+|$)/i,
  /^@gemini(?:\s+|$)/i,
  /^@codex(?:\s+|$)/i,
  /^@claude(?:\s+|$)/i,
  /^@kilo(?:\s+|$)/i,
  /^@openai(?:\s+|$)/i,
  /^@opencode(?:\s+|$)/i,
  /^\/terminal(?:\s+|$)/i,
];

/** Check if a message is an admin terminal command */
export function isAdminCommand(message: string): boolean {
  const trimmed = message.trim();
  return ADMIN_PREFIXES.some(p => p.test(trimmed));
}

/** Extract the actual command from an admin message */
function extractCommand(message: string): string {
  const trimmed = message.trim();
  for (const prefix of ADMIN_PREFIXES) {
    const match = trimmed.match(prefix);
    if (match) {
      return trimmed.slice(match[0].length).trim();
    }
  }
  return trimmed;
}

async function buildChatOrchestrationPlan(objective: string): Promise<JarvisDelegationTask[]> {
  const runtimeHealth = swarmCoordinator.getSpecialistRuntimeHealth();
  const options: JarvisPlannerOptions = await buildRuntimeJarvisPlannerOptions(objective, runtimeHealth);
  return buildJarvisDelegationPlan(objective, options);
}

async function waitForBatchCompletion(batchId: string, timeoutMs: number = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const batch = swarmCoordinator.getBatch(batchId);
    if (!batch) return null;
    if (batch.status === 'completed' || batch.status === 'failed' || batch.status === 'partial') {
      return batch;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return null;
}

function getBatchByToken(token?: string) {
  if (token && token !== 'latest') {
    return swarmCoordinator.getBatch(token);
  }
  return swarmCoordinator.listBatches(1)[0] || null;
}

function formatBatchStatus(batch: any): string {
  const p = batch.progress;
  return [
    `Batch: ${batch.id}`,
    `Status: ${batch.status}`,
    `Objective: ${batch.objective}`,
    `Progress: queued=${p.queued}, processing=${p.processing}, completed=${p.completed}, failed=${p.failed}, total=${p.total}`,
  ].join('\n');
}

async function tryHandleJarvisSwarmCommand(
  command: string,
  platform: 'telegram' | 'line',
  userId: string,
): Promise<string | null> {
  const resolved = resolveJarvisSwarmRequest(command);
  if (!resolved) {
    return null;
  }
  const text = resolved.kind === 'explicit_command'
    ? resolved.text.trim()
    : `/swarm ${resolved.text}`.trim();

  if (/^(\/?swarm|multi-agent|ma)(\s+help)?$/i.test(text)) {
    return [
      'Jarvis Multi-Agent Commands',
      '/swarm <objective>               Start orchestration batch',
      '/swarm status [batchId|latest]   Show current progress',
      '/swarm result [batchId|latest]   Show final summary when available',
      '/swarm list                      Show latest 5 batches',
    ].join('\n');
  }

  const statusMatch = text.match(/^(?:\/?swarm|multi-agent|ma)\s+status(?:\s+([a-z0-9_-]+|latest))?$/i);
  if (statusMatch) {
    const batch = getBatchByToken((statusMatch[1] || 'latest').toLowerCase());
    if (!batch) return 'No swarm batch found.';
    return formatBatchStatus(batch);
  }

  const resultMatch = text.match(/^(?:\/?swarm|multi-agent|ma)\s+(?:result|report|summary)(?:\s+([a-z0-9_-]+|latest))?$/i);
  if (resultMatch) {
    const batch = getBatchByToken((resultMatch[1] || 'latest').toLowerCase());
    if (!batch) return 'No swarm batch found.';
    if (batch.summary && (batch.status === 'completed' || batch.status === 'failed' || batch.status === 'partial')) {
      return `${formatBatchStatus(batch)}\n\nSummary:\n${batch.summary}`.slice(0, 3800);
    }
    return `${formatBatchStatus(batch)}\n\nSummary is not ready yet.`;
  }

  if (/^(?:\/?swarm|multi-agent|ma)\s+list$/i.test(text)) {
    const recent = swarmCoordinator.listBatches(5);
    if (recent.length === 0) return 'No swarm batch found.';
    return recent
      .map((batch: any, idx: number) => `${idx + 1}. ${batch.id} | ${batch.status} | ${batch.progress.completed}/${batch.progress.total} | ${batch.objective}`)
      .join('\n');
  }

  const runMatch = text.match(/^(?:\/?swarm|multi-agent|ma)\s+(?:run\s+)?(.+)$/i);
  if (!runMatch || !runMatch[1]?.trim()) {
    return 'Please provide an objective. Example: /swarm build deployment checklist';
  }

  const objective = runMatch[1].trim();
  const rootAdmin = getRootAdminIdentity();
  const ctx = {
    botId: rootAdmin.botId,
    botName: rootAdmin.botName,
    platform: 'custom' as any,
    replyWithFile: async () => '',
  };

  const batch = await swarmCoordinator.orchestrateJarvisTeam(
    ctx,
    objective,
    await buildChatOrchestrationPlan(objective),
    {
      initiatorId: `${platform}:${userId}`,
      fromChatId: `boss_chat_${platform}_${userId}`,
      metadata: {
        source: resolved.kind === 'natural_language_objective' ? 'messagingBridge.chat.intent' : 'messagingBridge.chat',
        originalCommand: resolved.originalText,
      },
    },
  );

  const finished = await waitForBatchCompletion(batch.id, 12000);
  if (!finished) {
    return [
      `Started swarm batch: ${batch.id}`,
      `Objective: ${objective}`,
      'Use `/swarm status latest` to monitor progress and `/swarm result latest` for final summary.',
    ].join('\n');
  }

  if (finished.summary) {
    return `${formatBatchStatus(finished)}\n\nSummary:\n${finished.summary}`.slice(0, 3800);
  }

  return formatBatchStatus(finished);
}

/**
 * Handle an admin command from a messaging platform.
 * Returns the text response to send back to the user.
 */
export async function handleAdminCommand(
  message: string,
  platform: 'telegram' | 'line',
  userId: string
): Promise<string> {
  // Authorization check
  if (!isAuthorizedAdmin(platform, userId)) {
    addLog('security', 'Unauthorized admin command attempt',
      `platform=${platform} userId=${userId} cmd=${message.substring(0, 50)}`, 'warning');
    log.warn(`[${platform}] Unauthorized Boss Mode attempt by user ID: ${userId}`);
    return `⛔ ไม่ได้รับอนุญาต — คุณไม่มีสิทธิ์ใช้คำสั่ง admin\n🔑 ID ของคุณคือ: \`${userId}\`\nกรุณาเพิ่ม ID นี้ในการตั้งค่าแอดมินบน Dashboard เพื่อเข้าใช้งาน`;
  }

  const sessionKey = `${platform}_${userId}`;
  let command = extractCommand(message);
  const activeBoss = bossModeSessions.get(sessionKey);
  const trimmedLower = message.trim().toLowerCase();

  // Handle Exit Command (both explicit and implicit exit)
  if (/^(exit|quit|bye|พอแค่นี้|ไปพักได้)$/i.test(command) || /^(exit|quit|bye|พอแค่นี้|ไปพักได้)$/i.test(trimmedLower)) {
    if (activeBoss) {
      exitBossMode(platform, userId);
      return `👋 ออกจากโหมดหัวหน้า (${bossModeLabel(activeBoss)}) แล้วครับ กลับสู่บอทลูกน้องปกติ`;
    } else {
      return `ℹ️ คุณไม่ได้อยู่ในโหมดหัวหน้าครับ`;
    }
  }

  // Handle Enter Boss Mode Command (@jarvis / @gemini / @codex / @claude alone / @opencode)
  const isSummoning = /^(?:@jarvis|@agent|@gemini|@codex|@claude|@kilo|@openai|@opencode)$/i.test(trimmedLower);
  if (isSummoning) {
    const bossType = trimmedLower.includes('gemini')
      ? 'gemini'
      : trimmedLower.includes('codex')
        ? 'codex'
        : trimmedLower.includes('claude')
          ? 'claude'
          : trimmedLower.includes('kilo')
            ? 'kilo'
            : trimmedLower.includes('openai')
              ? 'openai'
              : trimmedLower.includes('opencode')
                ? 'opencode'
                : 'jarvis';
    bossModeSessions.set(sessionKey, bossType);
    log.info(`[${platform}] User summoned Boss Mode: ${bossType} for ${userId}`);
    return `🫡 รับทราบครับ! เปิดโหมดหัวหน้า (${bossModeLabel(bossType)}) แล้ว\n\nโหมดนี้คุณสามารถคุยต่อเนื่องได้เลย เลิกใช้งานเมื่อไหร่พิมพ์ "exit" หรือ "ไปพักได้" นะครับ`;
  }

  // Prevent running empty command
  if (!command && !activeBoss) {
    return getMessagingHelp();
  }

  // If in Boss Mode and command is not explicitly prefixed, auto-prefix it
  if (activeBoss && !isAdminCommand(message)) {
    // If user is just chatting normally inside the session
    command = message; 
  } else if (!command) {
    return 'กรุณาใส่คำสั่งหลัง @jarvis / @gemini / @codex / @claude / @kilo / @opencode หรือพิมพ์เรียกเฉยๆ เพื่อเข้าสู่ Boss Mode';
  }

  // Jarvis swarm bridge: allow chat commands to create/check Multi-Agent batches directly.
  const resolvedSwarmRequest = resolveJarvisSwarmRequest(command);
  const shouldRouteToJarvisSwarm = Boolean(
    resolvedSwarmRequest && (
      resolvedSwarmRequest.kind === 'explicit_command'
      || activeBoss === 'jarvis'
      || /^@jarvis(?:\s+|$)/i.test(message.trim())
    ),
  );

  if (shouldRouteToJarvisSwarm) {
    try {
      const swarmResult = await tryHandleJarvisSwarmCommand(command, platform, userId);
      if (swarmResult) return swarmResult;
    } catch (err: any) {
      log.error(`[${platform}] Swarm bridge command failed: ${err.message}`);
      return `Swarm command failed: ${err.message}`;
    }
  }

  addLog('admin-command', `${platform} admin command`,
    `userId=${userId} cmd=${command.substring(0, 100)}`, 'info');

  try {
    log.info(`[${platform}] Admin command/msg from ${userId}: ${command.substring(0, 100)}`);

    // Route through terminal system
    // Determine the prefix to use for Terminal Gateway
    let fullCommand = command;
    const hasPrefix = /^@(gemini|codex|claude|kilo|openai|opencode|agent|jarvis)\s+/i.test(command);

    if (!hasPrefix) {
      if (activeBoss === 'gemini') {
        fullCommand = `@gemini ${command}`;
      } else if (activeBoss === 'codex') {
        fullCommand = `@codex ${command}`;
      } else if (activeBoss === 'claude') {
        fullCommand = `@claude ${command}`;
      } else if (activeBoss === 'kilo') {
        fullCommand = `@kilo ${command}`;
      } else if (activeBoss === 'openai') {
        fullCommand = `@openai ${command}`;
      } else if (activeBoss === 'opencode') {
        fullCommand = `@opencode ${command}`;
      } else {
        // Default to AI agent if no session is set but it was an admin command
        fullCommand = `@agent ${command}`;
      }
    }

    const result = await executeCommand(fullCommand, platform, userId);
    if (/^\[(?:error|agent error)\]/i.test(result.trim())) {
      log.warn(`[${platform}] Terminal command failed for ${userId}`, {
        fullCommand: fullCommand.substring(0, 160),
        result: result.substring(0, 240),
      });
    }

    // Trim result for messaging platforms (4096 for Telegram, 5000 for LINE)
    const maxLen = platform === 'telegram' ? 4000 : 4900;
    if (result.length > maxLen) {
      return result.substring(0, maxLen) + '\n\n... (ตัดข้อความเพราะยาวเกินไป)';
    }

    return result || '(ไม่มี output)';
  } catch (err: any) {
    log.error(`Admin command error: ${err.message}`);
    return `❌ Error: ${err.message}`;
  }
}

/** Help text for messaging platform admin commands */
function getMessagingHelp(): string {
  return [
    '🤖 Jarvis Admin Commands',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '',
    '/admin <command>     — รันคำสั่ง shell',
    '/admin @agent <msg>  — สั่ง AI Agent',
    '/admin @jarvis <msg> — เหมือนกับ @agent',
    '/admin @gemini <cmd> — ใช้ Gemini CLI',
    '/admin @codex <cmd>  — ใช้ Codex CLI',
    '/admin @claude <cmd> — ใช้ Claude CLI',
    '/admin @kilo <cmd>   — ใช้ Kilo Code CLI',
    '/admin @openai <cmd> — ใช้ OpenAI CLI',
    '/admin @opencode <cmd> — ใช้ OpenCode CLI',
    '',
    '🔰 **Boss Mode (คุยต่อเนื่อง)**',
    'พิมพ์ `@jarvis` `@gemini` `@codex` `@claude` `@kilo` `@openai` `@opencode` โดดๆ เพื่อเรียกตัวหัวหน้ามาคุยแบบจดจำบริบท',
    'เลิกคุยพิมพ์ `exit` หรือ `bye`',
    '',
    'ตัวอย่าง:',
    '/admin git status',
    '/admin @agent ตรวจสอบสถานะระบบ',
    '/admin @codex fix this bug in current workspace',
    '/admin @claude review this module for risks',
    '/admin @opencode help',
    '',
    '🧩 **Multi-Agent via Jarvis**',
    'ใช้ได้ตอนอยู่ใน @jarvis Boss Mode:',
    '`/swarm <objective>` เริ่มให้ Jarvis กระจายงานไป Gemini/Codex/Claude',
    '`/swarm status latest` ดูสถานะงานล่าสุด',
    '`/swarm result latest` ดูสรุปผลล่าสุด',
    '',
    '⚠️ ต้องกำหนด admin IDs ใน Dashboard > Settings',
    'หรือใช้ ADMIN_TELEGRAM_IDS / ADMIN_LINE_IDS ใน .env',
    'หากหา codex ไม่เจอ ให้ตั้ง CODEX_CLI_PATH ใน .env',
    'หากหา claude ไม่เจอ ให้ตั้ง CLAUDE_CLI_PATH ใน .env',
  ].join('\n');
}


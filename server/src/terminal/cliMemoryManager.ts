/**
 * CLI Memory Manager
 *
 * Handles memory profiles, conversation context, and prompt construction
 * for contextual CLI backends (gemini-cli, codex-cli, claude-cli).
 *
 * Supports hybrid memory: stored conversation history + summarized context.
 */

import {
  CliMemoryProfile,
  CliPromptMemory,
  DEFAULT_CLI_MEMORY_PROFILE,
  CLI_MEMORY_PROFILE_OVERRIDES,
  CONTEXTUAL_CLI_BACKENDS,
} from './terminalTypes.js';
import {
  getConversationSummary,
  getConversationMessages,
  getMessageCount,
  updateConversationSummary,
  upsertConversation,
  addMessage,
  type MessageRow,
} from '../database/db.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('CliMemoryManager');

/**
 * Get memory profile for a CLI backend, applying overrides if available
 */
export function getCliMemoryProfile(backendId: `${string}-cli`): CliMemoryProfile {
  const overrides = CLI_MEMORY_PROFILE_OVERRIDES[backendId];
  if (!overrides) return DEFAULT_CLI_MEMORY_PROFILE;
  return {
    ...DEFAULT_CLI_MEMORY_PROFILE,
    ...overrides,
  };
}

/**
 * Check if a CLI backend supports contextual memory
 */
export function isContextualCliBackend(backendId: `${string}-cli`): boolean {
  return CONTEXTUAL_CLI_BACKENDS.has(backendId);
}

/**
 * Helper to sanitize a value for use in conversation key construction
 */
function sanitizeConversationKeyPart(value: string): string {
  return (value || '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\-]/g, '_')
    .slice(0, 30);
}

/**
 * Build conversation ID for a CLI command with contextual memory
 */
export function buildCliConversationId(
  backendId: `${string}-cli`,
  userInput: string,
  platform: string = 'api',
  userId?: string
): string {
  const cleanBackend = sanitizeConversationKeyPart(backendId);
  const cleanPlatform = sanitizeConversationKeyPart(platform);
  const cleanUserId = sanitizeConversationKeyPart(userId || 'anonymous');
  const cleanCommand = sanitizeConversationKeyPart(userInput.split(/\s+/)[0]);

  return `cli:${cleanBackend}:${cleanCommand}:${cleanPlatform}:${cleanUserId}`;
}

/**
 * Build legacy conversation ID (for backwards compatibility)
 */
export function buildLegacyCliConversationId(
  backendId: `${string}-cli`,
  userInput: string,
  platform: string = 'api',
  userId?: string
): string {
  const cleanBackend = sanitizeConversationKeyPart(backendId);
  const cleanPlatform = sanitizeConversationKeyPart(platform);
  const cleanUserId = sanitizeConversationKeyPart(userId || 'anonymous');
  const cleanCommand = sanitizeConversationKeyPart(userInput.split(/\s+/)[0]);

  return `${cleanBackend}::${cleanCommand}::${cleanPlatform}::${cleanUserId}`;
}

/**
 * Migrate legacy CLI memory to new conversation format if needed
 */
export async function migrateLegacyCliMemoryIfNeeded(
  backendId: `${string}-cli`,
  userInput: string,
  platform: string = 'api',
  userId?: string
): Promise<string | null> {
  const newConversationId = buildCliConversationId(backendId, userInput, platform, userId);
  const legacyConversationId = buildLegacyCliConversationId(backendId, userInput, platform, userId);

  // Check if legacy conversation exists
  const legacySummary = await getConversationSummary(legacyConversationId);
  if (!legacySummary) {
    return null;
  }

  // Migrate to new conversation
  try {
    const legacyMessages = await getConversationMessages(legacyConversationId);
    await upsertConversation(newConversationId, 'legacy-user-id', 'Migrated User');

    for (const msg of legacyMessages) {
      await addMessage(newConversationId, msg.role, msg.content, msg.fb_message_id ?? undefined);
    }

    log.info(`Migrated CLI memory from ${legacyConversationId} to ${newConversationId}`);
    return newConversationId;
  } catch (err) {
    log.warn(`Failed to migrate legacy CLI memory: ${err}`, { legacyConversationId });
    return null;
  }
}

/**
 * Trim text to fit within character budget
 */
function trimTextForContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const trimmed = text.slice(0, maxChars);
  const lastNewline = trimmed.lastIndexOf('\n');
  return lastNewline > 0 ? trimmed.slice(0, lastNewline) : trimmed;
}

/**
 * Strip CLI noise from output for context
 */
function stripCliNoiseForContext(text: string): string {
  let cleaned = text
    // Remove ANSI escape sequences
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_][0-?]*[ -/]*[@-~]/g, '')
    // Remove common spinner/progress chars
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '')
    // Remove repeated dots and dashes that indicate waiting
    .replace(/\.{5,}/g, '...');

  // Collapse excessive blank lines
  cleaned = cleaned.replace(/\n\n\n+/g, '\n\n');

  return cleaned;
}

/**
 * Check if input looks like a prompt-style CLI request (with context instructions)
 */
function isPromptStyleCliInput(backendId: `${string}-cli`, userInput: string): boolean {
  const firstLine = userInput.split('\n')[0];
  const trimmed = firstLine.trim();

  // Heuristics for prompt-style input
  if (trimmed.length > 200) return true;
  if (trimmed.includes('please') || trimmed.includes('help me')) return true;
  if (backendId === 'codex-cli' && trimmed.includes('exec')) return false; // codex exec is usually direct
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return false; // Quoted strings are usually direct

  return false;
}

/**
 * Build contextual prompt with memory for CLI command
 */
function buildContextualCliPrompt(
  backendId: `${string}-cli`,
  userInput: string,
  conversationSummary: string | null,
  recentMessages: MessageRow[],
  profile: CliMemoryProfile
): string {
  let prompt = userInput;

  // Inject summary if available
  if (conversationSummary && !isPromptStyleCliInput(backendId, userInput)) {
    const summaryTrimmed = trimTextForContext(
      stripCliNoiseForContext(conversationSummary),
      profile.summaryMaxChars
    );

    if (summaryTrimmed.length > 0) {
      prompt = `[Context Summary]\n${summaryTrimmed}\n\n[New Command]\n${userInput}`;
    }
  }

  // Inject recent message context if appropriate
  if (recentMessages.length > 0 && !isPromptStyleCliInput(backendId, userInput)) {
    const contextItems = [];

    for (const msg of recentMessages.slice(-profile.contextMaxMessages)) {
      let text = msg.content;
      if (msg.role === 'user') {
        text = trimTextForContext(text, profile.contextStoreUserMax);
      } else {
        text = trimTextForContext(
          stripCliNoiseForContext(text),
          profile.contextStoreAssistantMax
        );
      }

      if (text.length > 0) {
        contextItems.push(`[${msg.role === 'user' ? 'User' : 'Assistant'}]\n${text}`);
      }
    }

    if (contextItems.length > 0) {
      const contextBlock = contextItems.join('\n\n');
      if (prompt.includes('[Context Summary]')) {
        // Insert between summary and command
        prompt = prompt.replace(
          '\n\n[New Command]\n',
          `\n\n[Recent Context]\n${contextBlock}\n\n[New Command]\n`
        );
      } else {
        prompt = `[Recent Context]\n${contextBlock}\n\n[Command]\n${userInput}`;
      }
    }
  }

  // Trim final prompt to context budget
  if (prompt.length > profile.contextCharBudget) {
    prompt = trimTextForContext(prompt, profile.contextCharBudget);
  }

  return prompt;
}

/**
 * Prepare CLI prompt memory (context, summary, etc.) for a command
 */
export async function prepareCliPromptMemory(
  backendId: `${string}-cli`,
  userInput: string,
  platform: string = 'api',
  userId?: string
): Promise<CliPromptMemory> {
  const profile = getCliMemoryProfile(backendId);
  const isContextual = isContextualCliBackend(backendId);

  if (!isContextual) {
    return {
      prompt: userInput,
      conversationId: null,
      shouldPersist: false,
      profile,
    };
  }

  let conversationId = buildCliConversationId(backendId, userInput, platform, userId);

  // Try to migrate legacy memory
  const migratedId = await migrateLegacyCliMemoryIfNeeded(backendId, userInput, platform, userId);
  if (migratedId) {
    conversationId = migratedId;
  }

  try {
    const summary = await getConversationSummary(conversationId);
    const msgCount = await getMessageCount(conversationId);

    let recentMessages: MessageRow[] = [];
    if (msgCount > 0) {
      recentMessages = await getConversationMessages(conversationId, profile.contextMaxMessages * 2);
    }

    const summaryText = summary?.summary || '';
    const prompt = buildContextualCliPrompt(
      backendId,
      userInput,
      summaryText,
      recentMessages,
      profile
    );

    const shouldPersist = msgCount < 100; // Don't persist if conversation is huge

    return {
      prompt,
      conversationId,
      shouldPersist,
      profile,
    };
  } catch (err) {
    log.warn(`Failed to prepare CLI prompt memory: ${err}`, { backendId, conversationId });
    return {
      prompt: userInput,
      conversationId,
      shouldPersist: false,
      profile,
    };
  }
}

/**
 * Check if output should skip context persistence
 */
export function shouldSkipContextPersistence(output: string): boolean {
  // Skip if output is mostly empty or error-like
  if (!output || output.length < 10) return true;
  if (output.includes('[Error]') || output.includes('failed')) return false; // DO log errors
  if (output.toLowerCase().includes('not found')) return true;
  return false;
}

/**
 * Update CLI conversation summary with command + output
 */
export async function updateCliConversationSummary(
  conversationId: string,
  userCommand: string,
  output: string,
  profile: CliMemoryProfile
): Promise<void> {
  try {
    const summaryData = await getConversationSummary(conversationId);
    const currentSummary = summaryData?.summary || '';
    const cleanedOutput = stripCliNoiseForContext(output);
    const trimmedOutput = trimTextForContext(cleanedOutput, profile.summaryEntryAssistantMax);
    const trimmedCommand = trimTextForContext(userCommand, profile.summaryEntryUserMax);

    let newEntry = `[Command] ${trimmedCommand}\n`;
    if (trimmedOutput.length > 0) {
      newEntry += `[Output] ${trimmedOutput}`;
    }

    const updated = currentSummary
      ? `${currentSummary}\n\n---\n\n${newEntry}`
      : newEntry;

    // Keep summary bounded
    const msgCountToStore = summaryData?.summaryMsgCount ? summaryData.summaryMsgCount + 1 : 1;
    if (updated.length > profile.summaryMaxChars) {
      const trimmed = trimTextForContext(updated, profile.summaryMaxChars);
      await updateConversationSummary(conversationId, trimmed, msgCountToStore);
    } else {
      await updateConversationSummary(conversationId, updated, msgCountToStore);
    }
  } catch (err) {
    log.warn(`Failed to update CLI conversation summary: ${err}`, { conversationId });
  }
}

/**
 * Persist CLI prompt memory (save to conversation database)
 */
export async function persistCliPromptMemory(
  conversationId: string,
  userCommand: string,
  output: string,
  profile: CliMemoryProfile
): Promise<void> {
  if (shouldSkipContextPersistence(output)) return;

  try {
    // Store the user command
    await addMessage(conversationId, 'user', userCommand);

    // Store the output (trimmed)
    const cleanedOutput = stripCliNoiseForContext(output);
    const trimmedOutput = trimTextForContext(cleanedOutput, profile.latestUserMessageMax);

    if (trimmedOutput.length > 0) {
      await addMessage(conversationId, 'assistant', trimmedOutput);
    }

    // Update summary
    await updateCliConversationSummary(conversationId, userCommand, output, profile);
  } catch (err) {
    log.warn(`Failed to persist CLI prompt memory: ${err}`, { conversationId });
  }
}

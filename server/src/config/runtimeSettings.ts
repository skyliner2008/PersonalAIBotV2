import { getSetting } from '../database/db.js';
import { config } from '../config.js';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);
export type RuntimeSettingSource = 'db' | 'env' | 'default';

export interface RuntimeControlSnapshotItem {
  key: string;
  value: number | boolean;
  source: RuntimeSettingSource;
}

function safeGetSetting(key: string): string | null {
  try {
    return getSetting(key);
  } catch {
    // Runtime settings can be queried before DB initialization on some startup paths.
    return null;
  }
}

function firstConfiguredValue(settingKey: string, envKeys: string[] = []): string | null {
  const settingValue = safeGetSetting(settingKey);
  if (settingValue != null && settingValue.trim() !== '') {
    return settingValue;
  }

  for (const envKey of envKeys) {
    const envValue = process.env[envKey];
    if (envValue != null && envValue.trim() !== '') {
      return envValue;
    }
  }

  return null;
}

export function resolveRuntimeSettingSource(settingKey: string, envKeys: string[] = []): RuntimeSettingSource {
  const settingValue = safeGetSetting(settingKey);
  if (settingValue != null && settingValue.trim() !== '') {
    return 'db';
  }

  for (const envKey of envKeys) {
    const envValue = process.env[envKey];
    if (envValue != null && envValue.trim() !== '') {
      return 'env';
    }
  }

  return 'default';
}

function parseIntegerValue(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = parseInt(String(raw ?? ''), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function parseIntegerSetting(
  key: string,
  fallback: number,
  min: number,
  max: number,
  envKeys: string[] = [],
): number {
  const raw = firstConfiguredValue(key, envKeys);
  return parseIntegerValue(raw, fallback, min, max);
}

function parseBooleanValue(raw: string | null, fallback: boolean): boolean {
  if (!raw) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_VALUES.has(normalized)) {
    return false;
  }
  return fallback;
}

function parseBooleanSetting(key: string, fallback: boolean, envKeys: string[] = []): boolean {
  const raw = firstConfiguredValue(key, envKeys);
  return parseBooleanValue(raw, fallback);
}

function parseEnvBoolean(key: string, fallback: boolean): boolean {
  return parseBooleanValue(process.env[key] ?? null, fallback);
}

export function getChatReplyDelayMs(): number {
  return parseIntegerSetting('chat_reply_delay', config.minReplyDelay, 0, 120_000);
}

export function getCommentReplyDelayMs(): number {
  return parseIntegerSetting('comment_reply_delay', 5_000, 0, 120_000);
}

export function getBrowserHeadless(): boolean {
  return parseBooleanSetting('browser_headless', config.headless);
}

export function getMaxMemoryMessages(): number {
  return parseIntegerSetting('max_memory_messages', 25, 5, 200);
}

export function getVoiceToolBridgeTimeoutMs(): number {
  return parseIntegerSetting(
    'voice_tool_bridge_timeout_ms',
    90_000,
    5_000,
    300_000,
    ['LIVE_TOOL_BRIDGE_TIMEOUT_MS'],
  );
}

export function getVoiceToolBridgeOutputMaxChars(): number {
  return parseIntegerSetting(
    'voice_tool_bridge_output_max_chars',
    4_000,
    800,
    40_000,
    ['LIVE_TOOL_BRIDGE_OUTPUT_MAX_CHARS'],
  );
}

export function getWebVoiceAgentTimeoutMs(): number {
  return parseIntegerSetting(
    'web_voice_agent_timeout_ms',
    80_000,
    20_000,
    300_000,
    ['WEB_VOICE_AGENT_TIMEOUT_MS'],
  );
}

export function getWebVoiceMaxTurns(): number {
  return parseIntegerSetting('web_voice_max_turns', 8, 2, 25, ['WEB_VOICE_MAX_TURNS']);
}

export function getWebVoiceSkipReviewerGate(): boolean {
  return parseBooleanSetting(
    'web_voice_skip_reviewer_gate',
    parseEnvBoolean('WEB_VOICE_SKIP_REVIEWER_GATE', true),
    ['WEB_VOICE_SKIP_REVIEWER_GATE'],
  );
}

export function getWebVoiceSkipBackgroundEnrichment(): boolean {
  return parseBooleanSetting(
    'web_voice_skip_background_enrichment',
    parseEnvBoolean('WEB_VOICE_SKIP_BACKGROUND_ENRICHMENT', true),
    ['WEB_VOICE_SKIP_BACKGROUND_ENRICHMENT'],
  );
}

export function getSwarmSkipReviewerGate(): boolean {
  return parseBooleanSetting(
    'swarm_skip_reviewer_gate',
    parseEnvBoolean('SWARM_SKIP_REVIEWER_GATE', true),
    ['SWARM_SKIP_REVIEWER_GATE'],
  );
}

export function getSwarmSkipBackgroundEnrichment(): boolean {
  return parseBooleanSetting(
    'swarm_skip_background_enrichment',
    parseEnvBoolean('SWARM_SKIP_BACKGROUND_ENRICHMENT', true),
    ['SWARM_SKIP_BACKGROUND_ENRICHMENT'],
  );
}

export function getProviderRateLimitCooldownMs(): number {
  return parseIntegerSetting(
    'agent_provider_rate_limit_cooldown_ms',
    120_000,
    10_000,
    600_000,
    ['AGENT_RATE_LIMIT_COOLDOWN_MS', 'RATE_LIMIT_COOLDOWN_MS'],
  );
}

export function getAgentAllowOpenaiAutoFallback(): boolean {
  return parseBooleanSetting(
    'agent_allow_openai_auto_fallback',
    parseEnvBoolean('AGENT_ALLOW_OPENAI_AUTO_FALLBACK', false),
    ['AGENT_ALLOW_OPENAI_AUTO_FALLBACK'],
  );
}

export function getRuntimeControlSnapshot(): RuntimeControlSnapshotItem[] {
  return [
    {
      key: 'chat_reply_delay',
      value: getChatReplyDelayMs(),
      source: resolveRuntimeSettingSource('chat_reply_delay'),
    },
    {
      key: 'comment_reply_delay',
      value: getCommentReplyDelayMs(),
      source: resolveRuntimeSettingSource('comment_reply_delay'),
    },
    {
      key: 'browser_headless',
      value: getBrowserHeadless(),
      source: resolveRuntimeSettingSource('browser_headless'),
    },
    {
      key: 'max_memory_messages',
      value: getMaxMemoryMessages(),
      source: resolveRuntimeSettingSource('max_memory_messages'),
    },
    {
      key: 'voice_tool_bridge_timeout_ms',
      value: getVoiceToolBridgeTimeoutMs(),
      source: resolveRuntimeSettingSource('voice_tool_bridge_timeout_ms', ['LIVE_TOOL_BRIDGE_TIMEOUT_MS']),
    },
    {
      key: 'voice_tool_bridge_output_max_chars',
      value: getVoiceToolBridgeOutputMaxChars(),
      source: resolveRuntimeSettingSource('voice_tool_bridge_output_max_chars', ['LIVE_TOOL_BRIDGE_OUTPUT_MAX_CHARS']),
    },
    {
      key: 'web_voice_agent_timeout_ms',
      value: getWebVoiceAgentTimeoutMs(),
      source: resolveRuntimeSettingSource('web_voice_agent_timeout_ms', ['WEB_VOICE_AGENT_TIMEOUT_MS']),
    },
    {
      key: 'web_voice_max_turns',
      value: getWebVoiceMaxTurns(),
      source: resolveRuntimeSettingSource('web_voice_max_turns', ['WEB_VOICE_MAX_TURNS']),
    },
    {
      key: 'web_voice_skip_reviewer_gate',
      value: getWebVoiceSkipReviewerGate(),
      source: resolveRuntimeSettingSource('web_voice_skip_reviewer_gate', ['WEB_VOICE_SKIP_REVIEWER_GATE']),
    },
    {
      key: 'web_voice_skip_background_enrichment',
      value: getWebVoiceSkipBackgroundEnrichment(),
      source: resolveRuntimeSettingSource('web_voice_skip_background_enrichment', ['WEB_VOICE_SKIP_BACKGROUND_ENRICHMENT']),
    },
    {
      key: 'swarm_skip_reviewer_gate',
      value: getSwarmSkipReviewerGate(),
      source: resolveRuntimeSettingSource('swarm_skip_reviewer_gate', ['SWARM_SKIP_REVIEWER_GATE']),
    },
    {
      key: 'swarm_skip_background_enrichment',
      value: getSwarmSkipBackgroundEnrichment(),
      source: resolveRuntimeSettingSource('swarm_skip_background_enrichment', ['SWARM_SKIP_BACKGROUND_ENRICHMENT']),
    },
    {
      key: 'agent_provider_rate_limit_cooldown_ms',
      value: getProviderRateLimitCooldownMs(),
      source: resolveRuntimeSettingSource('agent_provider_rate_limit_cooldown_ms', ['AGENT_RATE_LIMIT_COOLDOWN_MS', 'RATE_LIMIT_COOLDOWN_MS']),
    },
    {
      key: 'agent_allow_openai_auto_fallback',
      value: getAgentAllowOpenaiAutoFallback(),
      source: resolveRuntimeSettingSource('agent_allow_openai_auto_fallback', ['AGENT_ALLOW_OPENAI_AUTO_FALLBACK']),
    },
  ];
}

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const settingsStore = new Map<string, string>();

vi.mock('../../database/db.js', () => ({
  getSetting: vi.fn((key: string) => settingsStore.get(key) ?? null),
}));

vi.mock('../../config.js', () => ({
  config: {
    headless: false,
    minReplyDelay: 3000,
  },
}));

import {
  getBrowserHeadless,
  getChatReplyDelayMs,
  getCommentReplyDelayMs,
  getMaxMemoryMessages,
  getProviderRateLimitCooldownMs,
  getRuntimeControlSnapshot,
  getSwarmSkipBackgroundEnrichment,
  getSwarmSkipReviewerGate,
  getVoiceToolBridgeOutputMaxChars,
  getVoiceToolBridgeTimeoutMs,
  getWebVoiceAgentTimeoutMs,
  getWebVoiceMaxTurns,
  getWebVoiceSkipBackgroundEnrichment,
  getWebVoiceSkipReviewerGate,
  resolveRuntimeSettingSource,
} from '../../config/runtimeSettings.js';

const RUNTIME_ENV_KEYS = [
  'LIVE_TOOL_BRIDGE_TIMEOUT_MS',
  'LIVE_TOOL_BRIDGE_OUTPUT_MAX_CHARS',
  'WEB_VOICE_AGENT_TIMEOUT_MS',
  'WEB_VOICE_MAX_TURNS',
  'WEB_VOICE_SKIP_REVIEWER_GATE',
  'WEB_VOICE_SKIP_BACKGROUND_ENRICHMENT',
  'SWARM_SKIP_REVIEWER_GATE',
  'SWARM_SKIP_BACKGROUND_ENRICHMENT',
  'AGENT_RATE_LIMIT_COOLDOWN_MS',
  'RATE_LIMIT_COOLDOWN_MS',
] as const;

const envBackup = new Map<string, string | undefined>();

describe('runtimeSettings', () => {
  for (const key of RUNTIME_ENV_KEYS) {
    envBackup.set(key, process.env[key]);
  }

  beforeEach(() => {
    settingsStore.clear();
    for (const key of RUNTIME_ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterAll(() => {
    for (const [key, value] of envBackup.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('uses defaults when dashboard settings are absent', () => {
    expect(getChatReplyDelayMs()).toBe(3000);
    expect(getCommentReplyDelayMs()).toBe(5000);
    expect(getBrowserHeadless()).toBe(false);
    expect(getMaxMemoryMessages()).toBe(25);
    expect(getVoiceToolBridgeTimeoutMs()).toBe(30000);
    expect(getVoiceToolBridgeOutputMaxChars()).toBe(8000);
    expect(getWebVoiceAgentTimeoutMs()).toBe(45000);
    expect(getWebVoiceMaxTurns()).toBe(6);
    expect(getWebVoiceSkipReviewerGate()).toBe(true);
    expect(getWebVoiceSkipBackgroundEnrichment()).toBe(true);
    expect(getSwarmSkipReviewerGate()).toBe(true);
    expect(getSwarmSkipBackgroundEnrichment()).toBe(true);
    expect(getProviderRateLimitCooldownMs()).toBe(120000);
  });

  it('parses and clamps numeric settings', () => {
    settingsStore.set('chat_reply_delay', '4500');
    settingsStore.set('comment_reply_delay', '-100');
    settingsStore.set('max_memory_messages', '999');

    expect(getChatReplyDelayMs()).toBe(4500);
    expect(getCommentReplyDelayMs()).toBe(0);
    expect(getMaxMemoryMessages()).toBe(200);
  });

  it('parses boolean headless setting safely', () => {
    settingsStore.set('browser_headless', 'true');
    expect(getBrowserHeadless()).toBe(true);

    settingsStore.set('browser_headless', 'off');
    expect(getBrowserHeadless()).toBe(false);

    settingsStore.set('browser_headless', 'maybe');
    expect(getBrowserHeadless()).toBe(false);
  });

  it('uses env fallback when runtime setting key is absent', () => {
    process.env.WEB_VOICE_MAX_TURNS = '9';
    process.env.LIVE_TOOL_BRIDGE_TIMEOUT_MS = '42000';
    process.env.AGENT_RATE_LIMIT_COOLDOWN_MS = '75000';

    expect(getWebVoiceMaxTurns()).toBe(9);
    expect(getVoiceToolBridgeTimeoutMs()).toBe(42000);
    expect(getProviderRateLimitCooldownMs()).toBe(75000);
  });

  it('prefers database runtime setting over env fallback', () => {
    process.env.WEB_VOICE_MAX_TURNS = '9';
    settingsStore.set('web_voice_max_turns', '4');

    expect(getWebVoiceMaxTurns()).toBe(4);
  });

  it('parses boolean runtime toggles from settings and env', () => {
    process.env.WEB_VOICE_SKIP_REVIEWER_GATE = '0';
    expect(getWebVoiceSkipReviewerGate()).toBe(false);

    settingsStore.set('web_voice_skip_reviewer_gate', 'true');
    expect(getWebVoiceSkipReviewerGate()).toBe(true);

    process.env.SWARM_SKIP_BACKGROUND_ENRICHMENT = '0';
    expect(getSwarmSkipBackgroundEnrichment()).toBe(false);
  });

  it('reports runtime setting source correctly', () => {
    expect(resolveRuntimeSettingSource('web_voice_max_turns', ['WEB_VOICE_MAX_TURNS'])).toBe('default');

    process.env.WEB_VOICE_MAX_TURNS = '8';
    expect(resolveRuntimeSettingSource('web_voice_max_turns', ['WEB_VOICE_MAX_TURNS'])).toBe('env');

    settingsStore.set('web_voice_max_turns', '3');
    expect(resolveRuntimeSettingSource('web_voice_max_turns', ['WEB_VOICE_MAX_TURNS'])).toBe('db');
  });

  it('includes new control keys in runtime snapshot', () => {
    const snapshotKeys = new Set(getRuntimeControlSnapshot().map((entry) => entry.key));
    expect(snapshotKeys.has('voice_tool_bridge_timeout_ms')).toBe(true);
    expect(snapshotKeys.has('web_voice_agent_timeout_ms')).toBe(true);
    expect(snapshotKeys.has('agent_provider_rate_limit_cooldown_ms')).toBe(true);
  });
});

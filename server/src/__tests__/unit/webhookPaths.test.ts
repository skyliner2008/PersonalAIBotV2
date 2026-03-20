import { describe, expect, it } from 'vitest';
import { requiresRawWebhookBody } from '../../utils/webhookPaths.js';

describe('requiresRawWebhookBody', () => {
  it('matches legacy webhook paths', () => {
    expect(requiresRawWebhookBody('/webhook')).toBe(true);
    expect(requiresRawWebhookBody('/webhook/line')).toBe(true);
  });

  it('matches per-bot LINE webhook paths', () => {
    expect(requiresRawWebhookBody('/webhook/line/env-line')).toBe(true);
    expect(requiresRawWebhookBody('/webhook/line/my-bot-id')).toBe(true);
  });

  it('does not match unrelated paths', () => {
    expect(requiresRawWebhookBody('/webhookline')).toBe(false);
    expect(requiresRawWebhookBody('/webhook/lineabc')).toBe(false);
    expect(requiresRawWebhookBody('/api/webhook/line')).toBe(false);
    expect(requiresRawWebhookBody('/health')).toBe(false);
    expect(requiresRawWebhookBody('')).toBe(false);
  });
});

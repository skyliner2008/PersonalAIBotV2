import type { AIProvider, AIMessage, AICompletionOptions, AIChatResponse } from '../types.js';
import { getSetting } from '../../database/db.js';
import { getProviderApiKey } from '../../config/settingsSecurity.js';

const BASE_URL = 'https://api.minimaxi.chat/v1';

export class MiniMaxProvider implements AIProvider {
  id = 'minimax' as const;
  name = 'MiniMax';

  private getKey(): string {
    return getProviderApiKey('minimax') || '';
  }
  private getModel(): string {
    return getSetting('ai_minimax_model') || 'MiniMax-M2.5';
  }

  async chat(messages: AIMessage[], options?: AICompletionOptions): Promise<AIChatResponse> {
    const key = this.getKey();
    if (!key) throw new Error('MiniMax API key not configured');

    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options?.model || this.getModel(),
        messages,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 500,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`MiniMax error ${res.status}: ${err.error?.message || res.statusText}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim() || '';
    const usage = data.usage ? {
      promptTokens: data.usage.prompt_tokens || 0,
      completionTokens: data.usage.completion_tokens || 0,
      totalTokens: data.usage.total_tokens || 0,
    } : undefined;
    return { text, usage };
  }

  async testConnection(): Promise<boolean> {
    try {
      const key = this.getKey();
      if (!key) return false;
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'MiniMax-M2.5',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
      });
      return res.ok;
    } catch (e) { console.debug('[Minimax] API validation failed:', String(e)); return false; }
  }

  async listModels(): Promise<string[]> {
    return ['MiniMax-M2.5', 'MiniMax-M2.5-Flash', 'MiniMax-M2', 'abab6.5s-chat'];
  }
}

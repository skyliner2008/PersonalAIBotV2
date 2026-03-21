import type { AIProvider, AIMessage, AICompletionOptions, AIChatResponse } from '../types.js';
import { getSetting } from '../../database/db.js';
import { getProviderApiKey } from '../../config/settingsSecurity.js';

const BASE_URL = 'https://openrouter.ai/api/v1';

export class OpenRouterProvider implements AIProvider {
  id = 'openrouter' as const;
  name = 'OpenRouter';
  private cachedKey: string | null = null;
  private cachedModels: string[] | null = null;
  private lastFetch = 0;

  private getKey(): string {
    if (this.cachedKey !== null) return this.cachedKey;
    const key = getProviderApiKey('openrouter') || '';

    // Basic validation: OpenRouter keys typically start with 'sk-or-v1-' and are long
    if (key && (!key.startsWith('sk-or-v1-') || key.length < 32)) {
      console.error('[OpenRouter] Invalid API Key format detected. Key should start with "sk-or-v1-"');
      this.cachedKey = '';
      return '';
    }

    this.cachedKey = key;
    return this.cachedKey;
  }
  private getModel(): string {
    return getSetting('ai_openrouter_model') || 'meta-llama/llama-3.1-8b-instruct:free';
  }

  async chat(messages: AIMessage[], options?: AICompletionOptions): Promise<AIChatResponse> {
    const key = this.getKey();
    if (!key) throw new Error('OpenRouter API key not configured');

    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options?.model || this.getModel(),
        messages,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 500,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`OpenRouter error ${res.status}: ${err.error?.message || res.statusText}`);
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

      const res = await fetch(`${BASE_URL}/models`, {
        headers: {
          'Authorization': `Bearer ${key}`,
        },
      });

      return res.ok;
    } catch (e) {
      console.debug('[OpenRouter] Connection test failed:', String(e));
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    const now = Date.now();
    // Cache results for 1 hour to improve efficiency
    if (this.cachedModels && (now - this.lastFetch < 3600000)) {
      return this.cachedModels;
    }

    const key = this.getKey();
    if (!key) throw new Error('OpenRouter API key not configured');

    const res = await fetch(`${BASE_URL}/models`, {
      headers: {
        'Authorization': `Bearer ${key}`,
      },
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`OpenRouter error ${res.status}: ${err.error?.message || res.statusText}`);
    }

    try {
      const data = await res.json();
      const models = data.data?.map((m: { id: string }) => m.id).slice(0, 100) || [];
      this.cachedModels = models;
      this.lastFetch = now;
      return models;
    } catch (e) {
      console.error('[OpenRouter] Failed to parse models response:', e);
      return this.cachedModels || [];
    }
  }
}

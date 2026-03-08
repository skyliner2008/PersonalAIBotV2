import type { AIProvider, AIMessage, AICompletionOptions, AIChatResponse } from '../types.js';
import { getSetting } from '../../database/db.js';

const BASE_URL = 'https://openrouter.ai/api/v1';

export class OpenRouterProvider implements AIProvider {
  id = 'openrouter' as const;
  name = 'OpenRouter';

  private getKey(): string {
    return getSetting('ai_openrouter_key') || '';
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
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'FB AI Agent',
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
        headers: { 'Authorization': `Bearer ${key}` },
      });
      return res.ok;
    } catch { return false; }
  }

  async listModels(): Promise<string[]> {
    const key = this.getKey();
    if (!key) return [];
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.data?.map((m: any) => m.id).slice(0, 100) || [];
  }
}

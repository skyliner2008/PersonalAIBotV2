import type { AIProvider, AIMessage, AICompletionOptions, AIChatResponse } from '../types.js';
import { getSetting } from '../../database/db.js';
import { getProviderApiKey } from '../../config/settingsSecurity.js';

export class OpenAIProvider implements AIProvider {
  id = 'openai' as const;
  name = 'OpenAI';

  private getKey(): string {
    return getProviderApiKey('openai') || '';
  }
  private getModel(): string {
    return getSetting('ai_openai_model') || 'gpt-4o-mini';
  }

  async chat(messages: AIMessage[], options?: AICompletionOptions): Promise<AIChatResponse> {
    const key = this.getKey();
    if (!key) throw new Error('OpenAI API key not configured');

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
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
      throw new Error(`OpenAI error ${res.status}: ${err.error?.message || res.statusText}`);
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
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${key}` },
      });
      return res.ok;
    } catch (e) { console.debug('[OpenAI] API validation failed:', String(e)); return false; }
  }

  async listModels(): Promise<string[]> {
    const key = this.getKey();
    if (!key) return [];
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.data?.map((m: any) => m.id).filter((id: string) => id.startsWith('gpt-')) || [];
  }
}

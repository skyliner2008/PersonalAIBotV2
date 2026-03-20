import type { AIProvider, AIMessage, AICompletionOptions, AIChatResponse } from '../types.js';
import { getSetting } from '../../database/db.js';
import { getProviderApiKey } from '../../config/settingsSecurity.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('GeminiProvider');

export class GeminiProvider implements AIProvider {
  id = 'gemini' as const;
  name = 'Google Gemini';

  private getKey(): string {
    return getProviderApiKey('gemini') || '';
  }
  private getModel(): string {
    return getSetting('ai_gemini_model') || 'gemini-2.0-flash';
  }

  async chat(messages: AIMessage[], options?: AICompletionOptions): Promise<AIChatResponse> {
    const key = this.getKey();
    if (!key) throw new Error('Gemini API key not configured');
    const model = options?.model || this.getModel();

    // Convert messages to Gemini format
    const systemInstruction = messages.find(m => m.role === 'system')?.content;
    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const body: any = {
      contents,
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens ?? 500,
      },
    };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    // Try v1beta first, then v1 if model not found (some newer models only work on v1)
    const apiVersions = ['v1beta', 'v1'];
    let res: Response | undefined;
    let lastError: string = '';
    for (const apiVer of apiVersions) {
      const url = `https://generativelanguage.googleapis.com/${apiVer}/models/${model}:generateContent?key=${key}`;
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) break;
      const err = await res.json().catch(() => ({}));
      lastError = err.error?.message || res.statusText;
      // Only retry on 404 NOT_FOUND (model not available on this version)
      if (res.status === 404 && apiVer !== apiVersions[apiVersions.length - 1]) {
        log.info(`Model "${model}" not found on ${apiVer}, trying next API version...`);
        continue;
      }
      throw new Error(`Gemini error ${res.status}: ${lastError}`);
    }
    if (!res || !res.ok) {
      throw new Error(`Gemini error: ${lastError}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const usage = data.usageMetadata ? {
      promptTokens: data.usageMetadata.promptTokenCount || 0,
      completionTokens: data.usageMetadata.candidatesTokenCount || 0,
      totalTokens: data.usageMetadata.totalTokenCount || 0,
    } : undefined;
    return { text, usage };
  }

  async testConnection(): Promise<boolean> {
    try {
      const key = this.getKey();
      if (!key) return false;
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
      return res.ok;
    } catch (e) { log.debug('API validation failed:', String(e)); return false; }
  }

  async listModels(): Promise<string[]> {
    const key = this.getKey();
    if (!key) return [];
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.models?.map((m: any) => m.name.replace('models/', '')) || [];
  }
}

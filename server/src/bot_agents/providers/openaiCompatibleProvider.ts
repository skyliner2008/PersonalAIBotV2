import OpenAI from 'openai';
import type { Content, FunctionDeclaration } from '@google/genai';
import type { AIProvider, AIResponse } from './baseProvider.js';
import type { ToolCall } from '../types.js';
import { withRetry } from '../../utils/retry.js';

/** Minimal OpenAI-format message shape */
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class OpenAICompatibleProvider implements AIProvider {
  private client: OpenAI;
  private providerId: string;

  constructor(apiKey: string, baseURL?: string, providerId?: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL
    });
    this.providerId = providerId || '';
  }

  async generateResponse(
    modelName: string,
    systemInstruction: string,
    contents: Content[],
    tools?: FunctionDeclaration[]
  ): Promise<AIResponse> {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: systemInstruction }
    ];

    for (const content of contents) {
      const role = content.role === 'model' ? 'assistant' : 'user';
      const text = content.parts?.map(p => p.text).join('\n') || '';
      messages.push({ role, content: text });
    }

    const openAiTools = tools?.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));

    return withRetry(async () => {
      const response = await this.client.chat.completions.create({
        model: modelName,
        messages: messages as any,
        tools: openAiTools as any,
        tool_choice: openAiTools ? 'auto' : undefined
      });

      const choice = response.choices[0];
      const toolCalls: ToolCall[] | undefined = choice.message.tool_calls
        ?.filter((tc: any) => tc.function?.name)
        .map((tc: any) => {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            // LLM emitted invalid JSON for tool args — fall back to empty object
            args = { _raw: tc.function.arguments };
          }
          return { name: tc.function.name as string, args };
        });

      return {
        text: choice.message.content || '',
        toolCalls,
        usage: response.usage ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens
        } : undefined
      };
    }, { context: `OpenAI:${this.providerId}` });
  }

  async listModels(): Promise<string[]> {
    try {
      // เรียก GET /models จาก API จริงของ provider (timeout 8 วินาที)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      try {
        const response = await this.client.models.list({
          signal: controller.signal as any,
        } as any);
        clearTimeout(timeout);
        const modelIds = response.data.map(m => m.id).filter(Boolean).sort();
        if (modelIds.length > 0) return modelIds;
        throw new Error('Empty model list');
      } catch (innerErr) {
        clearTimeout(timeout);
        throw innerErr;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // ไม่ต้อง warn ถ้าเป็น provider ที่รู้ว่าไม่รองรับ /models (เช่น MiniMax, Anthropic)
      const baseUrl = this.client.baseURL || '';
      const silentProviders = ['minimax', 'anthropic', 'perplexity'];
      const isSilent = silentProviders.some(p => baseUrl.includes(p));
      if (!isSilent) {
        console.warn(`[ListModels:${this.providerId || 'unknown'}] API call failed: ${msg}`);
      }
      // Return empty — providerRoutes will merge with registry fallback
      return [];
    }
  }
}

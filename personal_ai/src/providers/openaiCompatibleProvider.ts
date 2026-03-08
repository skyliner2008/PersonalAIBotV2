import OpenAI from 'openai';
import { Content } from '@google/genai';
import { AIProvider, AIResponse } from './baseProvider';

// Exponential backoff retry utility
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 1000): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const status = err?.status || err?.response?.status || 0;
      // ไม่ retry ถ้าเป็น client errors (4xx) ยกเว้น 429 (rate limit)
      if (status >= 400 && status < 500 && status !== 429) throw err;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        console.warn(`[OpenAIProvider] Attempt ${attempt} failed (${err.message}), retry in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

export class OpenAICompatibleProvider implements AIProvider {
  private client: OpenAI;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL });
  }

  async generateResponse(
    modelName: string,
    systemInstruction: string,
    contents: Content[],
    tools?: any[]
  ): Promise<AIResponse> {
    return withRetry(async () => {
      // แปลง Gemini Content format → OpenAI messages
      const messages: any[] = [{ role: 'system', content: systemInstruction }];

      for (const content of contents) {
        const role = content.role === 'model' ? 'assistant' : 'user';
        // รองรับ multimodal parts
        const textParts = content.parts
          ?.filter(p => p.text)
          .map(p => p.text || '')
          .join('\n') || '';
        if (textParts) messages.push({ role, content: textParts });
      }

      const openAiTools = tools && tools.length > 0
        ? tools.map(t => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters
            }
          }))
        : undefined;

      const response = await this.client.chat.completions.create({
        model: modelName,
        messages,
        tools: openAiTools as any,
        tool_choice: openAiTools ? 'auto' : undefined,
        temperature: 0.7,
        max_tokens: 8192,
      });

      const choice = response.choices[0];
      const toolCalls = choice.message.tool_calls?.map((tc: any) => {
        let args: any = {};
        try { args = JSON.parse(tc.function.arguments); } catch (_) {}
        return { name: tc.function.name, args };
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
    });
  }

  async listModels(): Promise<string[]> {
    const isMiniMax = (this.client as any).baseURL?.includes('minimax');

    try {
      const response = await this.client.models.list();
      return response.data.map(m => m.id).sort();
    } catch (_) {
      if (isMiniMax) {
        return [
          'MiniMax-M2.5',
          'MiniMax-M2.5-highspeed',
          'MiniMax-M2.1',
          'MiniMax-M2.1-highspeed',
          'abab7-chat-preview',
          'abab6.5s-chat',
        ];
      }
      return ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'];
    }
  }
}

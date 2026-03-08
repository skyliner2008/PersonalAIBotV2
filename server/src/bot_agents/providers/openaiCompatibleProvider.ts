import OpenAI from 'openai';
import type { Content, FunctionDeclaration } from '@google/genai';
import type { AIProvider, AIResponse } from './baseProvider.js';
import type { ToolCall } from '../types.js';

/** Minimal OpenAI-format message shape */
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class OpenAICompatibleProvider implements AIProvider {
  private client: OpenAI;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL
    });
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

    const response = await this.client.chat.completions.create({
      model: modelName,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: openAiTools as any,
      tool_choice: openAiTools ? 'auto' : undefined
    });

    const choice = response.choices[0];
    const toolCalls: ToolCall[] | undefined = choice.message.tool_calls
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ?.filter((tc: any) => tc.function?.name)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((tc: any) => ({
        name: tc.function.name as string,
        args: JSON.parse(tc.function.arguments) as Record<string, unknown>
      }));

    return {
      text: choice.message.content || '',
      toolCalls,
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens
      } : undefined
    };
  }

  async listModels(): Promise<string[]> {
    const isMiniMax = this.client.baseURL.includes('minimax');

    try {
      // พยายามดึงจาก API ก่อน
      const response = await this.client.models.list();
      return response.data.map(m => m.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // ถ้าเป็น MiniMax และเจอ 404 ไม่ต้องตกใจ (เป็นเรื่องปกติของเขา) ให้ข้าม Log ไปเลย
      if (!isMiniMax) {
        console.warn(`[ListModels] Could not fetch models from provider, using defaults. Error: ${msg}`);
      }

      if (isMiniMax) {
        // รายชื่อโมเดลล่าสุดของ MiniMax (อัปเดตตามเอกสารต้นปี 2025)
        return [
          'MiniMax-M2.5',
          'MiniMax-M2.5-highspeed',
          'MiniMax-M2.1',
          'MiniMax-M2.1-highspeed',
          'abab7-chat-preview',
          'abab6.5s-chat',
          'abab6.5g-chat',
          'abab6.5t-chat'
        ];
      }

      // ถ้าเป็น OpenAI ปกติ
      return [
        'gpt-4o',
        'gpt-4o-mini',
        'gpt-4-turbo',
        'gpt-3.5-turbo'
      ];
    }
  }
}

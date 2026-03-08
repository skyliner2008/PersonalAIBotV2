import { GoogleGenAI, Content, FunctionDeclaration } from '@google/genai';
import { AIProvider, AIResponse } from './baseProvider';

// Exponential backoff retry utility
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 1000): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      // ไม่ retry ถ้าเป็น auth error หรือ invalid argument
      const msg = err?.message?.toLowerCase() || '';
      if (msg.includes('api key') || msg.includes('permission') || msg.includes('invalid argument')) {
        throw err;
      }
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        console.warn(`[GeminiProvider] Attempt ${attempt} failed, retrying in ${delay}ms... (${err.message})`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

export class GeminiProvider implements AIProvider {
  private ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generateResponse(
    modelName: string,
    systemInstruction: string,
    contents: Content[],
    tools?: any[]
  ): Promise<AIResponse> {
    return withRetry(async () => {
      const response = await this.ai.models.generateContent({
        model: modelName,
        contents,
        config: {
          systemInstruction,
          tools: tools && tools.length > 0
            ? [{ functionDeclarations: tools as FunctionDeclaration[] }]
            : undefined,
          temperature: 0.7,
          maxOutputTokens: 16384,
        }
      });

      return {
        text: response.text || '',
        toolCalls: response.functionCalls,
        rawModelContent: response.candidates?.[0]?.content,
        usage: response.usageMetadata ? {
          promptTokens: response.usageMetadata.promptTokenCount || 0,
          completionTokens: response.usageMetadata.candidatesTokenCount || 0,
          totalTokens: response.usageMetadata.totalTokenCount || 0
        } : undefined
      };
    });
  }

  async listModels(): Promise<string[]> {
    try {
      const result = await this.ai.models.list();
      const models = (result as any).pageInternal || [];
      return models
        .filter((m: any) => m.supportedActions?.includes('generateContent'))
        .map((m: any) => m.name.replace('models/', ''))
        .sort();
    } catch (err) {
      console.error('[Gemini ListModels Error]:', err);
      return [
        'gemini-2.5-pro-exp-03-25',
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-1.5-pro',
        'gemini-1.5-flash'
      ];
    }
  }
}

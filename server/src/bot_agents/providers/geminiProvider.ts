import { GoogleGenAI, Content, FunctionDeclaration } from '@google/genai';
import type { AIProvider, AIResponse } from './baseProvider.js';
import type { ToolCall } from '../types.js';

// Exponential backoff retry utility
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 1000): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const msg = err?.message?.toLowerCase() || '';
      // Non-retryable errors
      if (msg.includes('api key') || msg.includes('permission') || msg.includes('invalid argument')
          || msg.includes('safety') || msg.includes('blocked')) {
        throw err;
      }
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500; // jitter
        console.warn(`[GeminiProvider] Attempt ${attempt} failed, retrying in ${Math.round(delay)}ms... (${err.message})`);
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
    tools?: FunctionDeclaration[],
    useGoogleSearch?: boolean
  ): Promise<AIResponse> {
    return withRetry(async () => {
      // Build tools config
      // IMPORTANT: Gemini API does NOT allow combining built-in tools (googleSearch)
      // with custom tools (Function Calling) in the same request.
      // When function calling tools exist → use them (web_search/read_webpage handle search)
      // When no function calling tools → use Google Search grounding
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolsConfig: any[] = [];
      if (tools && tools.length > 0) {
        toolsConfig.push({ functionDeclarations: tools });
      } else if (useGoogleSearch) {
        // Only use Google Search grounding when there are no function calling tools
        toolsConfig.push({ googleSearch: {} });
      }

      const response = await this.ai.models.generateContent({
        model: modelName,
        contents,
        config: {
          systemInstruction,
          tools: toolsConfig.length > 0 ? toolsConfig : undefined,
          temperature: 0.7,
          maxOutputTokens: 16384,  // เพิ่มจาก 8192 → รองรับคำตอบที่ยาวขึ้น
        }
      });

      // Extract grounding metadata (Google Search citations)
      let responseText = response.text || '';
      const grounding = (response.candidates?.[0] as any)?.groundingMetadata;
      if (grounding?.searchEntryPoint?.renderedContent) {
        // Append search sources summary
        const chunks = grounding.groundingChunks || [];
        if (chunks.length > 0) {
          const sources = chunks
            .filter((c: any) => c.web?.uri)
            .map((c: any, i: number) => `${i + 1}. ${c.web.title || 'Source'}: ${c.web.uri}`)
            .join('\n');
          if (sources) {
            responseText += `\n\n📚 แหล่งอ้างอิง:\n${sources}`;
          }
        }
      }

      // Map FunctionCall[] → ToolCall[] (filter out calls with undefined names)
      const toolCalls: ToolCall[] | undefined = response.functionCalls
        ?.filter((fc) => fc.name != null)
        .map((fc) => ({ name: fc.name as string, args: (fc.args ?? {}) as Record<string, unknown> }));

      return {
        text: responseText,
        toolCalls,
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
      return ((result as any).pageInternal || [])
        .filter((m: any) => m.supportedActions?.includes('generateContent'))
        .map((m: any) => m.name.replace('models/', ''))
        .sort();
    } catch (err) {
      console.error('[Gemini ListModels Error]:', err);
      return ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro', 'gemini-1.5-flash'];
    }
  }
}

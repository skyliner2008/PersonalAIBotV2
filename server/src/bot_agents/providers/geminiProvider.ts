import { GoogleGenAI, Content, FunctionDeclaration } from '@google/genai';
import type { AIProvider, AIResponse } from './baseProvider.js';
import type { ToolCall } from '../types.js';
import { withRetry } from '../../utils/retry.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('GeminiProvider');

interface GeminiProviderOptions {
  includeEmbeddingsInList?: boolean;
  includeTTSInList?: boolean;
  includeAqaInList?: boolean;
  providerId?: string;
  /** If true, use Vertex AI mode (OAuth Bearer token instead of API key) */
  vertexai?: boolean;
  /** Google Cloud project ID (for Vertex AI) */
  project?: string;
  /** Google Cloud location (for Vertex AI) */
  location?: string;
}

/** API versions to try, in order. v1beta is default but some newer models only work on v1. */
const API_VERSIONS = ['v1beta', 'v1'] as const;

/**
 * Alias map for common short names → actual API model names.
 * Users may configure "gemini-3.1-pro" in settings but the API
 * requires "gemini-3.1-pro-preview" (preview suffix).
 */
const MODEL_ALIAS_MAP: Record<string, string> = {
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  'gemini-3.1-flash': 'gemini-3.1-flash-lite-preview',
  'gemini-3-pro': 'gemini-3-pro-preview',
  'gemini-3-flash': 'gemini-3-flash-preview',
  'gemini-2.0-flash-lite': 'gemini-2.0-flash-lite',
  'gemini-2.0-flash': 'gemini-2.0-flash',
  'gemini-1.5-flash': 'gemini-2.0-flash',
  'gemini-1.5-pro': 'gemini-2.5-pro',
};

/** Resolve a model name — expand short aliases to full API names. */
function resolveModelName(model: string): string {
  const alias = MODEL_ALIAS_MAP[model];
  if (alias) {
    logger.info(`Resolving model alias "${model}" → "${alias}"`);
  }
  return alias || model;
}

export class GeminiProvider implements AIProvider {
  private ai: GoogleGenAI;
  /** Secondary client with fallback API version (lazily created) */
  private aiFallback: GoogleGenAI | null = null;
  private apiKey: string;
  private options: GeminiProviderOptions;
  /** Cache of models that need v1 API version */
  private v1Models = new Set<string>();
  private isVertexAI: boolean;

  constructor(apiKey: string, options: GeminiProviderOptions = {}) {
    this.apiKey = apiKey;
    this.options = options;
    this.isVertexAI = !!options.vertexai;

    if (this.isVertexAI) {
      // Vertex AI mode: use OAuth token via httpOptions headers
      const vertexAiOptions = {
        vertexai: true,
        project: options.project || '',
        location: options.location || 'us-central1',
        googleAuthOptions: {
          credentials: { client_email: '', private_key: '' },
          // Override with access token
        } as any,
        httpOptions: {
          headers: { 'Authorization': `Bearer ${apiKey}` },
        },
      };
      this.ai = new GoogleGenAI(vertexAiOptions);
    } else {
      this.ai = this.createGenAIClient(apiKey);
    }
  }

  /** Creates a GoogleGenAI client with common configuration. */
  private createGenAIClient(apiKey: string, httpOptions?: any): GoogleGenAI {
    return new GoogleGenAI({ apiKey, ...httpOptions });
  }

  /** Get the appropriate client for a model (v1beta or v1) */
  private getClientForModel(modelName: string): GoogleGenAI {
    if (this.isVertexAI) return this.ai; // Vertex AI handles versioning internally
    if (this.v1Models.has(modelName)) {
      return this.aiFallback!;
    }
    return this.ai;
  }

  /** Prepares the content array for v1 retry by adding the system instruction. */
  private prepareContentsForV1Retry(systemInstruction: string, contents: Content[]): Content[] {
    return systemInstruction
      ? [{ role: 'user' as const, parts: [{ text: `[System Instruction]\n${systemInstruction}` }] }, ...contents]
      : contents;
  }

  /** Merges tool calls from different sources, eliminating duplicates. */
  private mergeToolCalls(functionCallsFromApi: ToolCall[], functionCallsFromParts: ToolCall[]): ToolCall[] {
    const toolCallByKey = new Map<string, ToolCall>();
    for (const call of [...functionCallsFromApi, ...functionCallsFromParts]) {
      const key = `${call.name}:${JSON.stringify(call.args || {})}`;
      if (!toolCallByKey.has(key)) toolCallByKey.set(key, call);
    }
    return Array.from(toolCallByKey.values());
  }

  async generateResponse(
    modelName: string,
    systemInstruction: string,
    contents: Content[],
    tools?: FunctionDeclaration[],
    useGoogleSearch?: boolean
  ): Promise<AIResponse> {
    // Resolve model name upfront (map invalid names to valid fallbacks)
    modelName = resolveModelName(modelName);

    return withRetry(async () => {
      // Build tools config
      // IMPORTANT: Gemini API does NOT allow combining built-in tools (googleSearch)
      // with custom tools (Function Calling) in the same request.
      // When function calling tools exist → use them (web_search/read_webpage handle search)
      // When no function calling tools → use Google Search grounding
      const toolsConfig: any[] = [];
      if (tools && tools.length > 0) {
        toolsConfig.push({ functionDeclarations: tools });
      } else if (useGoogleSearch) {
        // Only use Google Search grounding when there are no function calling tools
        toolsConfig.push({ googleSearch: {} });
      }

      const requestPayload = {
        model: modelName,
        contents,
        config: {
          systemInstruction,
          tools: toolsConfig.length > 0 ? toolsConfig : undefined,
          temperature: 0.7,
          maxOutputTokens: 16384,
        }
      };

      let client = this.getClientForModel(modelName);
      let response: any;
      try {
        response = await client.models.generateContent(requestPayload);
      } catch (genErr: any) {
        const errMsg = JSON.stringify(genErr?.message || genErr || '');
        const modelNotFound = /404|NOT_FOUND|is not found/i.test(errMsg);
        const invalidArgs = /INVALID_ARGUMENT|Unknown name/i.test(errMsg);
        
        // If model not found or invalid args on current API version, try alternative version
        if (!this.isVertexAI && (modelNotFound || invalidArgs) && !this.v1Models.has(modelName)) {
          logger.warn(`Model "${modelName}" ${modelNotFound ? 'not found' : 'invalid args'} on v1beta, retrying with v1 API version...`);
          this.v1Models.add(modelName);
          if (!this.aiFallback) {
            this.aiFallback = new GoogleGenAI({ apiKey: this.apiKey, httpOptions: { apiVersion: 'v1' } });
          }
          
          // CRITICAL: For v1, strip systemInstruction and tools if WE DETECTED INVALID_ARGUMENT
          // OR if we suspect this model is in the restricted list for v1.
          const v1Payload = {
            ...requestPayload,
            config: {
              ...requestPayload.config,
              systemInstruction: undefined, // Standardize on stripping for v1 retry
              tools: undefined,
            },
            contents: this.prepareContentsForV1Retry(systemInstruction, contents),
          };
          
          try {
            response = await this.aiFallback.models.generateContent(v1Payload);
          } catch (v1Err: any) {
            // If v1 STILL fails with INVALID_ARGUMENT, it might be due to remaining fields
            logger.error(`v1 retry also failed for ${modelName}:`, v1Err);
            throw v1Err;
          }
        } else {
          throw genErr;
        }
      }

      const candidateParts: any[] = (response.candidates?.[0] as any)?.content?.parts || [];
      const textParts = candidateParts
        .map((part: any) => String(part?.text || '').trim())
        .filter(Boolean);

      // Avoid response.text getter warning when model returns functionCall-only parts.
      let responseText = textParts.join('\n').trim();

      const functionCallsFromParts: ToolCall[] = candidateParts
        .map((part: any) => part?.functionCall)
        .filter((fc: any) => fc?.name)
        .map((fc: any) => ({
          name: String(fc.name),
          args: (fc.args ?? {}) as Record<string, unknown>,
        }));

      const functionCallsFromApi: ToolCall[] = (response.functionCalls || [])
        .filter((fc: any) => fc.name != null)
        .map((fc: any) => ({
          name: fc.name as string,
          args: (fc.args ?? {}) as Record<string, unknown>,
        }));

      const toolCallByKey = new Map<string, ToolCall>();
      for (const call of [...functionCallsFromApi, ...functionCallsFromParts]) {
        const key = `${call.name}:${JSON.stringify(call.args || {})}`;
        if (!toolCallByKey.has(key)) toolCallByKey.set(key, call);
      }
      const mergedToolCalls = Array.from(toolCallByKey.values());

      // Fallback to response.text only when there are no tool calls.
      if (!responseText && mergedToolCalls.length === 0) {
        responseText = response.text || '';
      }

      // Extract grounding metadata (Google Search citations)
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

      const toolCalls: ToolCall[] | undefined = mergedToolCalls.length > 0 ? mergedToolCalls : undefined;

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
    }, { context: 'Gemini' });
  }

  async listModels(): Promise<string[]> {
    try {
      const allModels: string[] = [];
      const includeEmbeddings = this.options.includeEmbeddingsInList === true;
      const includeTTS = this.options.includeTTSInList === true;
      const includeAqa = this.options.includeAqaInList === true;

      const pager: any = await this.ai.models.list();
      let guard = 0;

      while (pager && guard < 20) {
        guard += 1;
        const modelsPage = pager.page || pager.pageInternal || [];
        for (const model of modelsPage) {
          const name: string = (model.name || '').replace('models/', '').trim();
          if (!name) continue;

          if (!includeEmbeddings && name.includes('embedding')) continue;
          if (!includeTTS && name.includes('tts')) continue;
          if (!includeAqa && name.includes('aqa')) continue;

          allModels.push(name);
        }

        const hasNext =
          typeof pager.hasNextPage === 'function'
            ? pager.hasNextPage()
            : Boolean(pager.nextPageToken);

        if (!hasNext || typeof pager.nextPage !== 'function') {
          break;
        }

        try {
          // NOTE: in @google/genai Pager, nextPage mutates the pager state
          // and returns the next page array, not a new pager instance.
          await pager.nextPage();
        } catch (pageErr: any) {
          const msg = String(pageErr?.message || pageErr || '');
          if (msg.includes('No more pages to fetch')) {
            break;
          }
          throw pageErr;
        }
      }

      const uniqueSorted = Array.from(new Set(allModels)).sort();
      if (uniqueSorted.length > 0) {
        return uniqueSorted;
      }

      throw new Error('No models returned from API');
    } catch (err) {
      logger.error('[Gemini ListModels Error]:', err);
      const errorMessage = (err as any)?.message || String(err);
      if (errorMessage.includes('authentication') || errorMessage.includes('permission')) {
        // Handle authentication/permission errors by returning an empty list to avoid misleading fallbacks
        return [];
      }
      if (this.options.includeEmbeddingsInList) {
        return [
          'gemini-embedding-001',
          'text-embedding-004',
          'gemini-embedding-002',
        ];
      }
      // Fallback list for LLM mode if the API call entirely fails
      return [
        'gemini-2.5-pro',
        'gemini-2.5-flash',
        'gemini-2.0-pro-exp-02-05',
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-1.5-pro',
        'gemini-1.5-flash'
      ];
    }
  }
}

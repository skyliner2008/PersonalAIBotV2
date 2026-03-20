import { GoogleGenAI } from '@google/genai';
import { withRetry } from '../../utils/retry.js';
import { createLogger } from '../../utils/logger.js';
const logger = createLogger('GeminiProvider');
/** API versions to try, in order. v1beta is default but some newer models only work on v1. */
const API_VERSIONS = ['v1beta', 'v1'];
/**
 * Alias map for common short names → actual API model names.
 * Users may configure "gemini-3.1-pro" in settings but the API
 * requires "gemini-3.1-pro-preview" (preview suffix).
 */
const MODEL_ALIAS_MAP = {
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
function resolveModelName(model) {
    const alias = MODEL_ALIAS_MAP[model];
    if (alias) {
        logger.info(`Resolving model alias "${model}" → "${alias}"`);
    }
    return alias || model;
}
export class GeminiProvider {
    ai;
    /** Secondary client with fallback API version (lazily created) */
    aiFallback = null;
    apiKey;
    options;
    /** Cache of models that need v1 API version */
    v1Models = new Set();
    isVertexAI;
    constructor(apiKey, options = {}) {
        this.apiKey = apiKey;
        this.options = options;
        this.isVertexAI = !!options.vertexai;
        if (this.isVertexAI) {
            // Vertex AI mode: use OAuth token via httpOptions headers
            this.ai = new GoogleGenAI({
                vertexai: true,
                project: options.project || '',
                location: options.location || 'us-central1',
                googleAuthOptions: {
                    credentials: { client_email: '', private_key: '' },
                    // Override with access token
                },
                httpOptions: {
                    headers: { 'Authorization': `Bearer ${apiKey}` },
                },
            });
        }
        else {
            this.ai = new GoogleGenAI({ apiKey });
        }
    }
    /** Get the appropriate client for a model (v1beta or v1) */
    getClientForModel(modelName) {
        if (this.isVertexAI)
            return this.ai; // Vertex AI handles versioning internally
        if (this.v1Models.has(modelName)) {
            if (!this.aiFallback) {
                this.aiFallback = new GoogleGenAI({ apiKey: this.apiKey, httpOptions: { apiVersion: 'v1' } });
            }
            return this.aiFallback;
        }
        return this.ai;
    }
    async generateResponse(modelName, systemInstruction, contents, tools, useGoogleSearch) {
        // Resolve model name upfront (map invalid names to valid fallbacks)
        modelName = resolveModelName(modelName);
        return withRetry(async () => {
            // Build tools config
            // IMPORTANT: Gemini API does NOT allow combining built-in tools (googleSearch)
            // with custom tools (Function Calling) in the same request.
            // When function calling tools exist → use them (web_search/read_webpage handle search)
            // When no function calling tools → use Google Search grounding
            const toolsConfig = [];
            if (tools && tools.length > 0) {
                toolsConfig.push({ functionDeclarations: tools });
            }
            else if (useGoogleSearch) {
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
            let response;
            try {
                response = await client.models.generateContent(requestPayload);
            }
            catch (genErr) {
                const errMsg = JSON.stringify(genErr?.message || genErr || '');
                const isModelNotFound = /404|NOT_FOUND|is not found/i.test(errMsg);
                const isInvalidArgs = /INVALID_ARGUMENT|Unknown name/i.test(errMsg);
                // If model not found or invalid args on current API version, try alternative version
                if ((isModelNotFound || isInvalidArgs) && !this.v1Models.has(modelName)) {
                    logger.warn(`Model "${modelName}" ${isModelNotFound ? 'not found' : 'invalid args'} on v1beta, retrying with v1 API version...`);
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
                        contents: systemInstruction
                            ? [{ role: 'user', parts: [{ text: `[System Instruction]\n${systemInstruction}` }] }, ...contents]
                            : contents,
                    };
                    try {
                        response = await this.aiFallback.models.generateContent(v1Payload);
                    }
                    catch (v1Err) {
                        // If v1 STILL fails with INVALID_ARGUMENT, it might be due to remaining fields
                        logger.error(`v1 retry also failed for ${modelName}:`, v1Err);
                        throw v1Err;
                    }
                }
                else {
                    throw genErr;
                }
            }
            const candidateParts = response.candidates?.[0]?.content?.parts || [];
            const textParts = candidateParts
                .map((part) => String(part?.text || '').trim())
                .filter(Boolean);
            // Avoid response.text getter warning when model returns functionCall-only parts.
            let responseText = textParts.join('\n').trim();
            const functionCallsFromParts = candidateParts
                .map((part) => part?.functionCall)
                .filter((fc) => fc?.name)
                .map((fc) => ({
                name: String(fc.name),
                args: (fc.args ?? {}),
            }));
            const functionCallsFromApi = (response.functionCalls || [])
                .filter((fc) => fc.name != null)
                .map((fc) => ({
                name: fc.name,
                args: (fc.args ?? {}),
            }));
            const toolCallByKey = new Map();
            for (const call of [...functionCallsFromApi, ...functionCallsFromParts]) {
                const key = `${call.name}:${JSON.stringify(call.args || {})}`;
                if (!toolCallByKey.has(key))
                    toolCallByKey.set(key, call);
            }
            const mergedToolCalls = Array.from(toolCallByKey.values());
            // Fallback to response.text only when there are no tool calls.
            if (!responseText && mergedToolCalls.length === 0) {
                responseText = response.text || '';
            }
            // Extract grounding metadata (Google Search citations)
            const grounding = response.candidates?.[0]?.groundingMetadata;
            if (grounding?.searchEntryPoint?.renderedContent) {
                // Append search sources summary
                const chunks = grounding.groundingChunks || [];
                if (chunks.length > 0) {
                    const sources = chunks
                        .filter((c) => c.web?.uri)
                        .map((c, i) => `${i + 1}. ${c.web.title || 'Source'}: ${c.web.uri}`)
                        .join('\n');
                    if (sources) {
                        responseText += `\n\n📚 แหล่งอ้างอิง:\n${sources}`;
                    }
                }
            }
            const toolCalls = mergedToolCalls.length > 0
                ? mergedToolCalls
                : undefined;
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
    async listModels() {
        try {
            const allModels = [];
            const includeEmbeddings = this.options.includeEmbeddingsInList === true;
            const includeTTS = this.options.includeTTSInList === true;
            const includeAqa = this.options.includeAqaInList === true;
            const pager = await this.ai.models.list();
            let guard = 0;
            while (pager && guard < 20) {
                guard += 1;
                const page = pager.page || pager.pageInternal || [];
                for (const m of page) {
                    const name = (m.name || '').replace('models/', '').trim();
                    if (!name)
                        continue;
                    if (!includeEmbeddings && name.includes('embedding'))
                        continue;
                    if (!includeTTS && name.includes('tts'))
                        continue;
                    if (!includeAqa && name.includes('aqa'))
                        continue;
                    allModels.push(name);
                }
                const hasNext = typeof pager.hasNextPage === 'function'
                    ? pager.hasNextPage()
                    : Boolean(pager.nextPageToken);
                if (!hasNext || typeof pager.nextPage !== 'function') {
                    break;
                }
                try {
                    // NOTE: in @google/genai Pager, nextPage mutates the pager state
                    // and returns the next page array, not a new pager instance.
                    await pager.nextPage();
                }
                catch (pageErr) {
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
        }
        catch (err) {
            console.error('[Gemini ListModels Error]:', err);
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
//# sourceMappingURL=geminiProvider.js.map
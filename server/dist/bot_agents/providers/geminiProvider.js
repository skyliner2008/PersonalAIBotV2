import { GoogleGenAI } from '@google/genai';
// Exponential backoff retry utility
async function withRetry(fn, maxRetries = 3, baseDelayMs = 1000) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            lastError = err;
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
export class GeminiProvider {
    ai;
    constructor(apiKey) {
        this.ai = new GoogleGenAI({ apiKey });
    }
    async generateResponse(modelName, systemInstruction, contents, tools, useGoogleSearch) {
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
            const response = await this.ai.models.generateContent({
                model: modelName,
                contents,
                config: {
                    systemInstruction,
                    tools: toolsConfig.length > 0 ? toolsConfig : undefined,
                    temperature: 0.7,
                    maxOutputTokens: 8192,
                }
            });
            // Extract grounding metadata (Google Search citations)
            let responseText = response.text || '';
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
            return {
                text: responseText,
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
    async listModels() {
        try {
            const result = await this.ai.models.list();
            return (result.pageInternal || [])
                .filter((m) => m.supportedActions?.includes('generateContent'))
                .map((m) => m.name.replace('models/', ''))
                .sort();
        }
        catch (err) {
            console.error('[Gemini ListModels Error]:', err);
            return ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro', 'gemini-1.5-flash'];
        }
    }
}
//# sourceMappingURL=geminiProvider.js.map
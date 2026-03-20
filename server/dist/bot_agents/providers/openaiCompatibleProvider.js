import OpenAI from 'openai';
import { withRetry } from '../../utils/retry.js';
export class OpenAICompatibleProvider {
    client;
    providerId;
    constructor(apiKey, baseURL, providerId) {
        this.client = new OpenAI({
            apiKey,
            baseURL
        });
        this.providerId = providerId || '';
    }
    async generateResponse(modelName, systemInstruction, contents, tools) {
        const messages = [
            { role: 'system', content: systemInstruction }
        ];
        for (const content of contents) {
            const role = content.role === 'model' ? 'assistant' : 'user';
            const text = content.parts?.map(p => p.text).join('\n') || '';
            messages.push({ role, content: text });
        }
        const openAiTools = tools?.map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters
            }
        }));
        return withRetry(async () => {
            const response = await this.client.chat.completions.create({
                model: modelName,
                messages: messages,
                tools: openAiTools,
                tool_choice: openAiTools ? 'auto' : undefined
            });
            const choice = response.choices[0];
            const toolCalls = choice.message.tool_calls
                ?.filter((tc) => tc.function?.name)
                .map((tc) => {
                let args = {};
                try {
                    args = JSON.parse(tc.function.arguments);
                }
                catch {
                    // LLM emitted invalid JSON for tool args — fall back to empty object
                    args = { _raw: tc.function.arguments };
                }
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
        }, { context: `OpenAI:${this.providerId}` });
    }
    async listModels() {
        try {
            // เรียก GET /models จาก API จริงของ provider (timeout 8 วินาที)
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            try {
                const response = await this.client.models.list({
                    signal: controller.signal,
                });
                clearTimeout(timeout);
                const modelIds = response.data.map(m => m.id).filter(Boolean).sort();
                if (modelIds.length > 0)
                    return modelIds;
                throw new Error('Empty model list');
            }
            catch (innerErr) {
                clearTimeout(timeout);
                throw innerErr;
            }
        }
        catch (err) {
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
//# sourceMappingURL=openaiCompatibleProvider.js.map
import OpenAI from 'openai';
export class OpenAICompatibleProvider {
    client;
    constructor(apiKey, baseURL) {
        this.client = new OpenAI({
            apiKey,
            baseURL
        });
    }
    async generateResponse(modelName, systemInstruction, contents, tools) {
        const messages = [
            { role: 'system', content: systemInstruction }
        ];
        for (const content of contents) {
            const role = content.role === 'model' ? 'assistant' : 'user';
            const text = content.parts?.map(p => p.text).join('\n') || "";
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
        const response = await this.client.chat.completions.create({
            model: modelName,
            messages,
            tools: openAiTools,
            tool_choice: openAiTools ? 'auto' : undefined
        });
        const choice = response.choices[0];
        const toolCalls = choice.message.tool_calls?.map((tc) => ({
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments)
        }));
        return {
            text: choice.message.content || "",
            toolCalls,
            usage: response.usage ? {
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
                totalTokens: response.usage.total_tokens
            } : undefined
        };
    }
    async listModels() {
        const isMiniMax = this.client.baseURL.includes('minimax');
        try {
            // พยายามดึงจาก API ก่อน
            const response = await this.client.models.list();
            return response.data.map(m => m.id);
        }
        catch (err) {
            // ถ้าเป็น MiniMax และเจอ 404 ไม่ต้องตกใจ (เป็นเรื่องปกติของเขา) ให้ข้าม Log ไปเลย
            if (!isMiniMax) {
                console.warn(`[ListModels] Could not fetch models from provider, using defaults. Error: ${err.message}`);
            }
            if (isMiniMax) {
                // รายชื่อโมเดลล่าสุดของ MiniMax (อัปเดตตามเอกสารต้นปี 2025)
                return [
                    "MiniMax-M2.5",
                    "MiniMax-M2.5-highspeed",
                    "MiniMax-M2.1",
                    "MiniMax-M2.1-highspeed",
                    "abab7-chat-preview",
                    "abab6.5s-chat",
                    "abab6.5g-chat",
                    "abab6.5t-chat"
                ];
            }
            // ถ้าเป็น OpenAI ปกติ
            return [
                "gpt-4o",
                "gpt-4o-mini",
                "gpt-4-turbo",
                "gpt-3.5-turbo"
            ];
        }
    }
}
//# sourceMappingURL=openaiCompatibleProvider.js.map
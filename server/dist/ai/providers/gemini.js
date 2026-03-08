import { getSetting } from '../../database/db.js';
export class GeminiProvider {
    id = 'gemini';
    name = 'Google Gemini';
    getKey() {
        return getSetting('ai_gemini_key') || '';
    }
    getModel() {
        return getSetting('ai_gemini_model') || 'gemini-2.0-flash';
    }
    async chat(messages, options) {
        const key = this.getKey();
        if (!key)
            throw new Error('Gemini API key not configured');
        const model = options?.model || this.getModel();
        // Convert messages to Gemini format
        const systemInstruction = messages.find(m => m.role === 'system')?.content;
        const contents = messages
            .filter(m => m.role !== 'system')
            .map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
        }));
        const body = {
            contents,
            generationConfig: {
                temperature: options?.temperature ?? 0.7,
                maxOutputTokens: options?.maxTokens ?? 500,
            },
        };
        if (systemInstruction) {
            body.systemInstruction = { parts: [{ text: systemInstruction }] };
        }
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`Gemini error ${res.status}: ${err.error?.message || res.statusText}`);
        }
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        const usage = data.usageMetadata ? {
            promptTokens: data.usageMetadata.promptTokenCount || 0,
            completionTokens: data.usageMetadata.candidatesTokenCount || 0,
            totalTokens: data.usageMetadata.totalTokenCount || 0,
        } : undefined;
        return { text, usage };
    }
    async testConnection() {
        try {
            const key = this.getKey();
            if (!key)
                return false;
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
            return res.ok;
        }
        catch {
            return false;
        }
    }
    async listModels() {
        const key = this.getKey();
        if (!key)
            return [];
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
        if (!res.ok)
            return [];
        const data = await res.json();
        return data.models?.map((m) => m.name.replace('models/', '')) || [];
    }
}
//# sourceMappingURL=gemini.js.map
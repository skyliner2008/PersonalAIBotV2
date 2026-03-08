import { getSetting } from '../../database/db.js';
const BASE_URL = 'https://api.minimaxi.chat/v1';
export class MiniMaxProvider {
    id = 'minimax';
    name = 'MiniMax';
    getKey() {
        return getSetting('ai_minimax_key') || '';
    }
    getModel() {
        return getSetting('ai_minimax_model') || 'MiniMax-M2.5';
    }
    async chat(messages, options) {
        const key = this.getKey();
        if (!key)
            throw new Error('MiniMax API key not configured');
        const res = await fetch(`${BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: options?.model || this.getModel(),
                messages,
                temperature: options?.temperature ?? 0.7,
                max_tokens: options?.maxTokens ?? 500,
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`MiniMax error ${res.status}: ${err.error?.message || res.statusText}`);
        }
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content?.trim() || '';
        const usage = data.usage ? {
            promptTokens: data.usage.prompt_tokens || 0,
            completionTokens: data.usage.completion_tokens || 0,
            totalTokens: data.usage.total_tokens || 0,
        } : undefined;
        return { text, usage };
    }
    async testConnection() {
        try {
            const key = this.getKey();
            if (!key)
                return false;
            const res = await fetch(`${BASE_URL}/chat/completions`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'MiniMax-M2.5',
                    messages: [{ role: 'user', content: 'hi' }],
                    max_tokens: 1,
                }),
            });
            return res.ok;
        }
        catch {
            return false;
        }
    }
    async listModels() {
        return ['MiniMax-M2.5', 'MiniMax-M2.5-Flash', 'MiniMax-M2', 'abab6.5s-chat'];
    }
}
//# sourceMappingURL=minimax.js.map
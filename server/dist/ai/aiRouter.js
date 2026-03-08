import { OpenAIProvider } from './providers/openai.js';
import { GeminiProvider } from './providers/gemini.js';
import { MiniMaxProvider } from './providers/minimax.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import { getSetting } from '../database/db.js';
const providers = {
    openai: new OpenAIProvider(),
    gemini: new GeminiProvider(),
    minimax: new MiniMaxProvider(),
    openrouter: new OpenRouterProvider(),
};
/**
 * Get the configured AI provider for a specific task.
 * Each task can use a different provider/model.
 */
export function getProviderForTask(task) {
    const providerKey = getSetting(`ai_task_${task}_provider`);
    return providers[providerKey || 'openai'] || providers.openai;
}
export function getProvider(id) {
    return providers[id] || providers.openai;
}
/**
 * Main AI chat function — used by chat bot, comment bot, content creator.
 * Returns { text, usage } for token tracking.
 */
export async function aiChat(task, messages, options) {
    const provider = getProviderForTask(task);
    const modelSetting = getSetting(`ai_task_${task}_model`);
    return provider.chat(messages, {
        ...options,
        model: options?.model || modelSetting || undefined,
    });
}
/**
 * Test all configured providers.
 */
export async function testAllProviders() {
    const results = {};
    for (const [id, provider] of Object.entries(providers)) {
        results[id] = await provider.testConnection();
    }
    return results;
}
export { providers };
//# sourceMappingURL=aiRouter.js.map
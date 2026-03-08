import type { AIProvider, AIProviderType, AIMessage, AICompletionOptions, AITask, AIChatResponse } from './types.js';
import { OpenAIProvider } from './providers/openai.js';
import { GeminiProvider } from './providers/gemini.js';
import { MiniMaxProvider } from './providers/minimax.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import { getSetting } from '../database/db.js';

const providers: Record<AIProviderType, AIProvider> = {
  openai: new OpenAIProvider(),
  gemini: new GeminiProvider(),
  minimax: new MiniMaxProvider(),
  openrouter: new OpenRouterProvider(),
};

/**
 * Get the configured AI provider for a specific task.
 * Each task can use a different provider/model.
 */
export function getProviderForTask(task: AITask): AIProvider {
  const providerKey = getSetting(`ai_task_${task}_provider`) as AIProviderType | null;
  return providers[providerKey || 'openai'] || providers.openai;
}

export function getProvider(id: AIProviderType): AIProvider {
  return providers[id] || providers.openai;
}

/**
 * Main AI chat function — used by chat bot, comment bot, content creator.
 * Returns { text, usage } for token tracking.
 * Includes automatic failover to backup providers on failure.
 */
export async function aiChat(
  task: AITask,
  messages: AIMessage[],
  options?: AICompletionOptions
): Promise<AIChatResponse> {
  const provider = getProviderForTask(task);
  const modelSetting = getSetting(`ai_task_${task}_model`);
  const chatOptions = {
    ...options,
    model: options?.model || modelSetting || undefined,
  };

  // Try primary provider
  try {
    return await provider.chat(messages, chatOptions);
  } catch (primaryErr: any) {
    console.error(`[AIRouter] Primary provider failed for task "${task}": ${primaryErr.message}`);
  }

  // Failover chain: gemini → openai → openrouter → minimax
  const fallbackOrder: AIProviderType[] = ['gemini', 'openai', 'openrouter', 'minimax'];
  for (const fbKey of fallbackOrder) {
    const fbProvider = providers[fbKey];
    if (fbProvider === provider) continue; // skip the one that already failed
    try {
      const connected = await fbProvider.testConnection();
      if (!connected) continue;
      console.warn(`[AIRouter] Failover: trying ${fbKey} for task "${task}"`);
      return await fbProvider.chat(messages, { ...chatOptions, model: undefined });
    } catch (fbErr: any) {
      console.error(`[AIRouter] Failover ${fbKey} also failed: ${fbErr.message}`);
    }
  }

  // All providers failed
  return { text: '❌ ระบบ AI ไม่สามารถตอบได้ในขณะนี้ กรุณาลองใหม่ภายหลัง', usage: undefined };
}

/**
 * Test all configured providers.
 */
export async function testAllProviders(): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};
  for (const [id, provider] of Object.entries(providers)) {
    results[id] = await provider.testConnection();
  }
  return results;
}

export { providers };

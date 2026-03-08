import type { AIProvider, AIProviderType, AIMessage, AICompletionOptions, AITask, AIChatResponse } from './types.js';
declare const providers: Record<AIProviderType, AIProvider>;
/**
 * Get the configured AI provider for a specific task.
 * Each task can use a different provider/model.
 */
export declare function getProviderForTask(task: AITask): AIProvider;
export declare function getProvider(id: AIProviderType): AIProvider;
/**
 * Main AI chat function — used by chat bot, comment bot, content creator.
 * Returns { text, usage } for token tracking.
 */
export declare function aiChat(task: AITask, messages: AIMessage[], options?: AICompletionOptions): Promise<AIChatResponse>;
/**
 * Test all configured providers.
 */
export declare function testAllProviders(): Promise<Record<string, boolean>>;
export { providers };

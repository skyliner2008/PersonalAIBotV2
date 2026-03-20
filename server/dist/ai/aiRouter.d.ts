import type { AIProvider, AIMessage, AICompletionOptions, AITask, AIChatResponse } from './types.js';
export declare function getProviderForTask(task: AITask): AIProvider;
export declare function getProvider(id: string): AIProvider;
export declare function aiChat(task: AITask, messages: AIMessage[], options?: AICompletionOptions): Promise<AIChatResponse>;
export declare function testAllProviders(): Promise<Record<string, boolean>>;
export declare const providers: Record<string, AIProvider>;

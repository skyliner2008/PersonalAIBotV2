import type { AIProvider, AIMessage, AICompletionOptions, AIChatResponse } from '../types.js';
export declare class OpenRouterProvider implements AIProvider {
    id: "openrouter";
    name: string;
    private getKey;
    private getModel;
    chat(messages: AIMessage[], options?: AICompletionOptions): Promise<AIChatResponse>;
    testConnection(): Promise<boolean>;
    listModels(): Promise<string[]>;
}

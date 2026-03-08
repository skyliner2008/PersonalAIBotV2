import type { AIProvider, AIMessage, AICompletionOptions, AIChatResponse } from '../types.js';
export declare class OpenAIProvider implements AIProvider {
    id: "openai";
    name: string;
    private getKey;
    private getModel;
    chat(messages: AIMessage[], options?: AICompletionOptions): Promise<AIChatResponse>;
    testConnection(): Promise<boolean>;
    listModels(): Promise<string[]>;
}

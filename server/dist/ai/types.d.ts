export type AIProviderType = 'openai' | 'gemini' | 'minimax' | 'openrouter';
export interface AIMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export interface AICompletionOptions {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    systemPrompt?: string;
}
export interface AIProvider {
    id: AIProviderType;
    name: string;
    chat(messages: AIMessage[], options?: AICompletionOptions): Promise<AIChatResponse>;
    testConnection(): Promise<boolean>;
    listModels(): Promise<string[]>;
}
export interface AITokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}
export interface AIChatResponse {
    text: string;
    usage?: AITokenUsage;
}
export interface AIConfig {
    provider: AIProviderType;
    apiKey: string;
    model: string;
    baseUrl?: string;
}
export type AITask = 'chat' | 'content' | 'comment' | 'summary';
export interface TaskAIConfig {
    chat: {
        provider: AIProviderType;
        model: string;
    };
    content: {
        provider: AIProviderType;
        model: string;
    };
    comment: {
        provider: AIProviderType;
        model: string;
    };
    summary: {
        provider: AIProviderType;
        model: string;
    };
}

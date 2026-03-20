export type AIProviderType = string;

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
  description?: string;
  chat(messages: AIMessage[], options?: AICompletionOptions): Promise<AIChatResponse>;
  testConnection(): Promise<boolean>;
  listModels(): Promise<string[]>;
}

// Token usage tracking
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

// Task-specific AI routing
export type AITask = 'chat' | 'content' | 'comment' | 'summary';

export type TaskAIConfig = Record<AITask, { provider: AIProviderType; model: string }>;

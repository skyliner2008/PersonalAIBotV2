import type { Content, FunctionDeclaration } from '@google/genai';
import type { AIProvider, AIResponse } from './baseProvider.js';
export declare class OpenAICompatibleProvider implements AIProvider {
    private client;
    private providerId;
    constructor(apiKey: string, baseURL?: string, providerId?: string);
    generateResponse(modelName: string, systemInstruction: string, contents: Content[], tools?: FunctionDeclaration[]): Promise<AIResponse>;
    listModels(): Promise<string[]>;
}

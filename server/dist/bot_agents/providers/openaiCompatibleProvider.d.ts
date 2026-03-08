import { Content } from '@google/genai';
import { AIProvider, AIResponse } from './baseProvider';
export declare class OpenAICompatibleProvider implements AIProvider {
    private client;
    constructor(apiKey: string, baseURL?: string);
    generateResponse(modelName: string, systemInstruction: string, contents: Content[], tools?: any[]): Promise<AIResponse>;
    listModels(): Promise<string[]>;
}

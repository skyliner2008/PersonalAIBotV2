import { Content } from '@google/genai';
import { AIProvider, AIResponse } from './baseProvider';
export declare class GeminiProvider implements AIProvider {
    private ai;
    constructor(apiKey: string);
    generateResponse(modelName: string, systemInstruction: string, contents: Content[], tools?: any[], useGoogleSearch?: boolean): Promise<AIResponse>;
    listModels(): Promise<string[]>;
}

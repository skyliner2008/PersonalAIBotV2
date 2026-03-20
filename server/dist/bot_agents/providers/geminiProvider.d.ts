import { Content, FunctionDeclaration } from '@google/genai';
import type { AIProvider, AIResponse } from './baseProvider.js';
interface GeminiProviderOptions {
    includeEmbeddingsInList?: boolean;
    includeTTSInList?: boolean;
    includeAqaInList?: boolean;
    providerId?: string;
    /** If true, use Vertex AI mode (OAuth Bearer token instead of API key) */
    vertexai?: boolean;
    /** Google Cloud project ID (for Vertex AI) */
    project?: string;
    /** Google Cloud location (for Vertex AI) */
    location?: string;
}
export declare class GeminiProvider implements AIProvider {
    private ai;
    /** Secondary client with fallback API version (lazily created) */
    private aiFallback;
    private apiKey;
    private options;
    /** Cache of models that need v1 API version */
    private v1Models;
    private isVertexAI;
    constructor(apiKey: string, options?: GeminiProviderOptions);
    /** Get the appropriate client for a model (v1beta or v1) */
    private getClientForModel;
    generateResponse(modelName: string, systemInstruction: string, contents: Content[], tools?: FunctionDeclaration[], useGoogleSearch?: boolean): Promise<AIResponse>;
    listModels(): Promise<string[]>;
}
export {};

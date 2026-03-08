import type { Content, FunctionDeclaration } from '@google/genai';
import type { ToolCall, TokenUsage } from '../types.js';

export interface AIResponse {
  text: string;
  toolCalls?: ToolCall[];
  /** Raw model Content object (with functionCall parts) — used by Gemini agentic loop */
  rawModelContent?: Content;
  usage?: TokenUsage;
}

export interface AIProvider {
  generateResponse(
    modelName: string,
    systemInstruction: string,
    contents: Content[],
    tools?: FunctionDeclaration[],
    useGoogleSearch?: boolean
  ): Promise<AIResponse>;

  listModels(): Promise<string[]>;
}

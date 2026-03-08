import { Content, Part } from '@google/genai';

export interface AIResponse {
  text: string;
  toolCalls?: any[];
  /** Raw model Content object (with functionCall parts) — used by Gemini agentic loop */
  rawModelContent?: Content;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface AIProvider {
  generateResponse(
    modelName: string,
    systemInstruction: string,
    contents: Content[],
    tools?: any[]
  ): Promise<AIResponse>;

  listModels(): Promise<string[]>; // เพิ่มฟังก์ชันดึงรายชื่อโมเดล
}

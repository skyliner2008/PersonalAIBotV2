// ============================================================
// Mock AI Providers — For testing agent flow
// ============================================================

import type { Content, Part } from '@google/genai';

export interface MockProviderConfig {
  responses?: string[];
  shouldFail?: boolean;
  failAfterAttempts?: number;
  delayMs?: number;
}

export class MockAIProvider {
  private responses: string[];
  private callCount: number = 0;
  private shouldFail: boolean;
  private failAfterAttempts: number;
  private delayMs: number;

  public lastPrompt: string = '';
  public lastMessages: Content[] = [];
  public lastTools: any[] = [];

  constructor(config: MockProviderConfig = {}) {
    this.responses = config.responses || [
      'Mock response 1',
      'Mock response 2',
      'Mock response 3',
    ];
    this.shouldFail = config.shouldFail ?? false;
    this.failAfterAttempts = config.failAfterAttempts ?? Infinity;
    this.delayMs = config.delayMs ?? 0;
  }

  /**
   * Simulate AI response generation
   */
  async generateResponse(
    model: string,
    systemPrompt: string,
    messages: Content[],
    tools?: any[],
    config?: any
  ): Promise<MockResponse> {
    this.lastPrompt = systemPrompt;
    this.lastMessages = messages;
    this.lastTools = tools || [];
    this.callCount++;

    // Simulate delay
    if (this.delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.delayMs));
    }

    // Simulate failure
    if (this.shouldFail || this.callCount >= this.failAfterAttempts) {
      throw new Error(`Mock provider simulated failure (call #${this.callCount})`);
    }

    // Return next response in queue
    const responseText = this.responses[
      (this.callCount - 1) % this.responses.length
    ];

    return {
      text: responseText,
      toolCalls: [],
      finishReason: 'stop',
      inputTokens: 100,
      outputTokens: 50,
    };
  }

  /**
   * Set new responses to return
   */
  setResponses(responses: string[]): void {
    this.responses = responses;
  }

  /**
   * Reset call counter
   */
  reset(): void {
    this.callCount = 0;
    this.lastPrompt = '';
    this.lastMessages = [];
    this.lastTools = [];
  }

  /**
   * Get call count
   */
  getCallCount(): number {
    return this.callCount;
  }

  /**
   * Enable failure mode
   */
  setShouldFail(should: boolean): void {
    this.shouldFail = should;
  }
}

export interface MockResponse {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

/**
 * Create a mock provider factory
 */
export function createMockProvider(config?: MockProviderConfig): MockAIProvider {
  return new MockAIProvider(config);
}

/**
 * Create mock provider map for different models
 */
export function createMockProviderMap(): Record<string, MockAIProvider> {
  return {
    gemini: createMockProvider({
      responses: ['Gemini mock response 1', 'Gemini mock response 2'],
    }),
    openai: createMockProvider({
      responses: ['OpenAI mock response 1', 'OpenAI mock response 2'],
    }),
    minimax: createMockProvider({
      responses: ['Minimax mock response 1', 'Minimax mock response 2'],
    }),
  };
}

/**
 * Mock tool handlers for testing
 */
export const mockToolHandlers = {
  'read_file': async (params: { path: string }) => {
    return `Mock content of ${params.path}`;
  },
  'write_file': async (params: { path: string; content: string }) => {
    return `Mock wrote ${params.content.length} bytes to ${params.path}`;
  },
  'web_search': async (params: { query: string }) => {
    return `Mock search results for: ${params.query}`;
  },
  'execute_code': async (params: { code: string }) => {
    return `Mock execution result: ${params.code.substring(0, 50)}...`;
  },
};

/**
 * Mock tool definitions
 */
export const mockTools = [
  {
    name: 'read_file',
    description: 'Mock: Read file contents',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Mock: Write content to file',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'web_search',
    description: 'Mock: Search the web',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'execute_code',
    description: 'Mock: Execute code',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Code to execute' },
      },
      required: ['code'],
    },
  },
];

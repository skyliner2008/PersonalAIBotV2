/**
 * Anthropic Claude Provider
 * Implements AIProvider interface for Claude models
 */

import type { AIProvider, AIResponse } from './baseProvider.js';
import type { ToolCall } from '../types.js';

export class AnthropicProvider implements AIProvider {
  private apiKey: string;
  private baseUrl: string = 'https://api.anthropic.com/v1';
  private apiVersion: string = '2024-06-01';

  constructor(apiKey: string, baseUrl?: string) {
    if (!apiKey) {
      throw new Error('Anthropic API key is required');
    }
    this.apiKey = apiKey;
    if (baseUrl) this.baseUrl = baseUrl;
  }

  getProviderId(): string {
    return 'anthropic';
  }

  getCategory(): string {
    return 'llm';
  }

  getCapabilities() {
    return {
      chat: true,
      embedding: false,
      imageGeneration: false,
      textToSpeech: false,
      search: false,
      streaming: true,
      functionCalling: true,
    };
  }

  /**
   * Generate response using Claude API
   */
  async generateResponse(
    model: string,
    systemPrompt: string,
    messages: any[],
    tools?: any[],
    config?: any
  ): Promise<AIResponse> {
    const anthropicMessages = messages.map((msg: any) => {
      if (Array.isArray(msg?.parts)) {
        const text = msg.parts
          .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
          .filter(Boolean)
          .join('\n');

        return {
          role: msg.role === 'model' ? 'assistant' : 'user',
          content: text,
        };
      }

      if (typeof msg.content === 'string') {
        return {
          role: msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content,
        };
      }

      return {
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: String(msg.content ?? ''),
      };
    });

    const payload: any = {
      model,
      max_tokens: config?.maxTokens || 8192,
      system: systemPrompt,
      messages: anthropicMessages,
    };

    // Add tools if provided (convert from Gemini FunctionDeclaration format to Anthropic format)
    if (tools && tools.length > 0) {
      payload.tools = tools.map((tool: any) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters || {
          type: 'object',
          properties: tool.properties || {},
          required: tool.required || [],
        },
      }));
    }

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': this.apiVersion,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${error}`);
    }

    const data = (await response.json()) as any;

    // Extract text content
    let text = '';
    const toolCalls: ToolCall[] = [];

    for (const block of data.content || []) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          name: block.name,
          args: block.input || {},
        });
      }
    }

    return {
      text,
      toolCalls,
      usage: {
        promptTokens: data.usage?.input_tokens || 0,
        completionTokens: data.usage?.output_tokens || 0,
        totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      },
    };
  }

  /**
   * List available Claude models
   */
  async listModels(): Promise<string[]> {
    return [
      'claude-opus-4-20250514',
      'claude-sonnet-4-20250514',
      'claude-haiku-4-20250414',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
    ];
  }

  /**
   * Test the API connection
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': this.apiVersion,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-20250414',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'test' }],
        }),
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}

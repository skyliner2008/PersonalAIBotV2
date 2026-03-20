/**
 * Stream Manager — SSE + Socket.IO Streaming for AI Responses
 *
 * Provides real-time token-by-token streaming and tool execution progress.
 * Supports both SSE (HTTP clients) and Socket.IO (dashboard).
 */

import type { Response } from 'express';
import { createLogger } from './logger.js';

const log = createLogger('Stream');

// ── SSE Stream Types ─────────────────────────────────────
export interface StreamEvent {
  type: 'token' | 'tool_start' | 'tool_result' | 'thinking' | 'done' | 'error' | 'status';
  data: unknown;
}

// ── SSE Helper for Express ────────────────────────────────
export class SSEWriter {
  private closed = false;

  constructor(private res: Response) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    });
    res.flushHeaders();

    // Keep connection alive
    const keepAlive = setInterval(() => {
      if (!this.closed) this.res.write(':keepalive\n\n');
    }, 15_000);

    res.on('close', () => {
      this.closed = true;
      clearInterval(keepAlive);
    });
  }

  send(event: StreamEvent): void {
    if (this.closed) return;
    try {
      this.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    } catch (err) {
      log.debug('SSE write failed', { eventType: event.type, error: String(err) });
      this.closed = true;
    }
  }

  sendToken(token: string): void {
    this.send({ type: 'token', data: { token } });
  }

  sendToolStart(toolName: string, args?: Record<string, unknown>): void {
    this.send({ type: 'tool_start', data: { tool: toolName, args } });
  }

  sendToolResult(toolName: string, result: string, success: boolean, durationMs: number): void {
    this.send({ type: 'tool_result', data: { tool: toolName, result: result.substring(0, 500), success, durationMs } });
  }

  sendThinking(thought: string): void {
    this.send({ type: 'thinking', data: { thought: thought.substring(0, 200) } });
  }

  sendStatus(message: string): void {
    this.send({ type: 'status', data: { message } });
  }

  sendDone(fullText: string, usage?: { promptTokens: number; completionTokens: number; totalTokens: number }): void {
    this.send({ type: 'done', data: { text: fullText, usage } });
    this.end();
  }

  sendError(error: string): void {
    this.send({ type: 'error', data: { error } });
    this.end();
  }

  end(): void {
    if (!this.closed) {
      this.closed = true;
      try { this.res.end(); } catch (err) { log.debug('SSE end failed', { error: String(err) }); }
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

// ── Streaming Gemini Response with Tool Loop ────────────
import { GoogleGenAI, Content, FunctionDeclaration } from '@google/genai';

export interface StreamOptions {
  ai: GoogleGenAI;
  modelName: string;
  systemInstruction: string;
  contents: Content[];
  tools?: FunctionDeclaration[];
  useGoogleSearch?: boolean;
  writer: SSEWriter;
}

/**
 * Stream a Gemini generateContent response token-by-token via SSE.
 * Returns the full accumulated text when done.
 */
export async function streamGeminiResponse(opts: StreamOptions): Promise<{
  text: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}> {
  const { ai, modelName, systemInstruction, contents, tools, useGoogleSearch, writer } = opts;

  // Build tools config (same logic as GeminiProvider)
  const toolsConfig: any[] = [];
  if (tools && tools.length > 0) {
    toolsConfig.push({ functionDeclarations: tools });
  } else if (useGoogleSearch) {
    toolsConfig.push({ googleSearch: {} });
  }

  try {
    const stream = await ai.models.generateContentStream({
      model: modelName,
      contents,
      config: {
        systemInstruction,
        tools: toolsConfig.length > 0 ? toolsConfig : undefined,
        temperature: 0.7,
        maxOutputTokens: 16384,
      }
    });

    let fullText = '';
    let toolCalls: Array<{ name: string; args: Record<string, unknown> }> | undefined;
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

    for await (const chunk of stream) {
      if (writer.isClosed) break;

      // Extract text tokens
      const text = chunk.text;
      if (text) {
        fullText += text;
        writer.sendToken(text);
      }

      // Extract tool calls from chunk
      const fcs = chunk.functionCalls;
      if (fcs && fcs.length > 0) {
        toolCalls = fcs
          .filter(fc => fc.name != null)
          .map(fc => ({ name: fc.name as string, args: (fc.args ?? {}) as Record<string, unknown> }));
      }

      // Extract usage from final chunk
      if (chunk.usageMetadata) {
        usage = {
          promptTokens: chunk.usageMetadata.promptTokenCount || 0,
          completionTokens: chunk.usageMetadata.candidatesTokenCount || 0,
          totalTokens: chunk.usageMetadata.totalTokenCount || 0,
        };
      }
    }

    return { text: fullText, toolCalls, usage };
  } catch (err: any) {
    log.error('Streaming error', { error: err.message });
    writer.sendError(err.message);
    throw err;
  }
}

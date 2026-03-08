// ============================================================
// Bot Agent Shared Types — replaces `any` across the codebase
// ============================================================

import type { FunctionDeclaration, Content } from '@google/genai';
export type { FunctionDeclaration, Content };

// ──────────────────────────────────────────────
// Tool Call — returned by AI provider
// ──────────────────────────────────────────────

/** A single tool/function call returned by the model */
export interface ToolCall {
    /** Tool name (e.g. "web_search") */
    name: string;
    /** Arguments passed by the model */
    args: Record<string, unknown>;
}

/** Result of executing a tool */
export interface ToolExecutionResult {
    name: string;
    result: string;
}

/** Record of one tool's telemetry for a run */
export interface ToolTelemetry {
    name: string;
    durationMs: number;
    success: boolean;
}

// ──────────────────────────────────────────────
// Tool Handler Types
// ──────────────────────────────────────────────

/**
 * Generic args passed to tool handlers at runtime.
 * Args come from the AI model as dynamic JSON, so `any` is appropriate
 * at the dispatch boundary — each tool implementation validates its own args.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolHandler = (args: any) => string | Promise<string>;

/** Map of tool names to their handlers */
export type ToolHandlerMap = Record<string, ToolHandler>;

// ──────────────────────────────────────────────
// Bot Context (platform-specific callback)
// ──────────────────────────────────────────────

/** Runtime context injected by the bot platform (Telegram / LINE / etc.) */
export interface BotContext {
    /** Bot instance ID from registry */
    botId: string;
    /** Bot display name */
    botName: string;
    /** Current messaging platform */
    platform: 'telegram' | 'line' | 'facebook' | 'discord' | 'custom';
    /** Platform-specific file reply callback */
    replyWithFile: (filePath: string, caption?: string) => Promise<string>;
}

// ──────────────────────────────────────────────
// AI Provider Response
// ──────────────────────────────────────────────

/** Usage statistics returned by the AI provider */
export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

/** Unified response from any AI provider */
export interface AIResponse {
    text: string;
    toolCalls?: ToolCall[];
    /** Raw model Content object — used by Gemini agentic loop */
    rawModelContent?: Content;
    usage?: TokenUsage;
}

// ──────────────────────────────────────────────
// Agent Run Telemetry
// ──────────────────────────────────────────────

/** Internal per-request stats tracked during the agentic loop */
export interface AgentStats {
    turns: number;
    toolCalls: ToolTelemetry[];
    totalTokens: number;
    startTime: number;
}

// ──────────────────────────────────────────────
// Circuit Breaker
// ──────────────────────────────────────────────

export interface CircuitState {
    failures: number;
    openUntil: number;
}

// ──────────────────────────────────────────────
// Ngrok API types (for file URL auto-detection)
// ──────────────────────────────────────────────

export interface NgrokTunnel {
    proto: string;
    public_url: string;
    name?: string;
}

export interface NgrokApiResponse {
    tunnels: NgrokTunnel[];
}

// ──────────────────────────────────────────────
// Keyword scoring (task classification)
// ──────────────────────────────────────────────

export interface KeywordRule {
    keywords: string[];
    score: number;
}

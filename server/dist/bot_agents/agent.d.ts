import { Part } from '@google/genai';
import type { BotContext } from './tools/index.js';
import type { ToolTelemetry } from './types.js';
export interface AgentRun {
    id: string;
    chatId: string;
    message: string;
    startTime: number;
    endTime?: number;
    durationMs?: number;
    turns: number;
    toolCalls: ToolTelemetry[];
    totalTokens: number;
    reply?: string;
    error?: string;
    taskType?: string;
}
export declare class Agent {
    private providers;
    constructor(apiKey: string);
    processMessage(chatId: string, message: string, ctx: BotContext, attachments?: Part[]): Promise<string>;
    private _processMessageCore;
    private resolveModelConfig;
    private resolveProvider;
    private getFallbackChainFromMd;
    private buildTimeoutResponse;
    private extractFact;
    private extractCoreProfile;
    getAvailableModels(providerName: string): Promise<string[]>;
}

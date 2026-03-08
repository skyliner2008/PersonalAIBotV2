import { Part } from '@google/genai';
import { BotContext } from './tools/index.js';
export declare class Agent {
    private providers;
    constructor(apiKey: string);
    processMessage(chatId: string, message: string, ctx: BotContext, attachments?: Part[]): Promise<string>;
    private extractFact;
    private extractCoreProfile;
    getAvailableModels(providerName: string): Promise<string[]>;
}

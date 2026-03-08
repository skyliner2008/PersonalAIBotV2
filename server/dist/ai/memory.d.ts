import type { AIMessage } from './types.js';
export interface ConversationMemory {
    recentMessages: AIMessage[];
    summaryMarkdown: string;
    userProfileMarkdown: string;
    tokenEstimate: number;
}
/**
 * Build memory context for a conversation.
 * Returns 3 layers optimized for minimal token usage.
 */
export declare function getConversationMemory(convId: string, userId: string, userName: string): Promise<ConversationMemory>;

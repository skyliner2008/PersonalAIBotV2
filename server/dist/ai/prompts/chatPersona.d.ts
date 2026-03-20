import type { AIMessage } from '../types.js';
export declare function buildChatMessages(systemInstruction: string, memory: {
    userProfileMarkdown: string;
    summaryMarkdown: string;
    recentMessages: AIMessage[];
}, newMessage: string): AIMessage[];
/**
 * Legacy fallback: Build messages without memory system.
 * Used when memory is not available (e.g., test replies).
 */
export declare function buildChatMessagesLegacy(persona: {
    system_prompt: string;
    speaking_style?: string | null;
    personality_traits?: string | null;
}, conversationHistory: AIMessage[], newMessage: string): AIMessage[];

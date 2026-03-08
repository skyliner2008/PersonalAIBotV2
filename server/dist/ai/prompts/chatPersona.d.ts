import type { AIMessage } from '../types.js';
/**
 * Build optimized message array using 3-Layer Memory Architecture.
 *
 * Token budget breakdown:
 *   System prompt (persona + rules):  ~200 tokens
 *   Layer 3 (user profile):           ~80 tokens
 *   Layer 2 (conversation summary):   ~120 tokens
 *   Layer 1 (last 5 messages):        ~250 tokens
 *   New user message:                 ~50 tokens
 *   = ~800-1000 per request (down from 2000-6000)
 */
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
    speaking_style: string;
    personality_traits: string;
}, conversationHistory: {
    role: string;
    content: string;
}[], newMessage: string): AIMessage[];

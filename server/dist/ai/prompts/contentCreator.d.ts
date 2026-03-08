import type { AIMessage } from '../types.js';
export declare function buildContentPrompt(topic: string, style?: string, language?: string, extraInstructions?: string): AIMessage[];
export declare function buildCommentReplyPrompt(postContent: string, commentText: string, commenterName: string, replyStyle?: string): AIMessage[];

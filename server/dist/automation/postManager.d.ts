import type { Server as SocketServer } from 'socket.io';
/**
 * Schedule a new post (either with pre-written content or AI-generated).
 */
export declare function schedulePost(data: {
    content?: string;
    aiTopic?: string;
    postType?: string;
    target?: string;
    targetId?: string;
    targetName?: string;
    scheduledAt: string;
    cronExpression?: string;
}): number;
/**
 * Process pending scheduled posts (called by scheduler).
 */
export declare function processPendingPosts(io: SocketServer): Promise<void>;
/**
 * Get all scheduled posts.
 */
export declare function getScheduledPosts(limit?: number): any[];
/**
 * Delete a scheduled post.
 */
export declare function deleteScheduledPost(id: number): void;

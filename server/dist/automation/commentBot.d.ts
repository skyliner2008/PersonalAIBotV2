import type { Server as SocketServer } from 'socket.io';
/**
 * Start comment monitoring on watched posts.
 */
export declare function startCommentMonitor(io: SocketServer): Promise<void>;
export declare function stopCommentMonitor(io: SocketServer): void;
export declare function isCommentMonitorActive(): boolean;

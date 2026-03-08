import type { Server as SocketServer } from 'socket.io';
/**
 * Start the main scheduler.
 */
export declare function startScheduler(io: SocketServer): void;
/**
 * Refresh cron jobs from database (for recurring posts).
 */
export declare function refreshCronJobs(io: SocketServer): void;
export declare function stopScheduler(): void;

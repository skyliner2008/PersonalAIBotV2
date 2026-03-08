import type { Server as SocketServer } from 'socket.io';
export declare function startChatMonitor(io: SocketServer): Promise<void>;
export declare function stopChatMonitor(io: SocketServer): void;
export declare function isChatMonitorActive(): boolean;

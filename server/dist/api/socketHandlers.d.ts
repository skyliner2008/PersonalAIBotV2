import type { Server as SocketServer, Socket } from 'socket.io';
export declare function handleBrowserStart(io: SocketServer, socket: Socket): Promise<void>;
export declare function handleBrowserStop(io: SocketServer): Promise<void>;
export declare function handleFbLogin(io: SocketServer, socket: Socket, data: {
    email: string;
    password: string;
}): Promise<void>;
export declare function handleFbCheckLogin(socket: Socket): Promise<void>;
export declare function handleChatbotStart(io: SocketServer, socket: Socket): Promise<void>;
export declare function handleChatbotStop(io: SocketServer): void;
export declare function handleCommentbotStart(io: SocketServer, socket: Socket): Promise<void>;
export declare function handleCommentbotStop(io: SocketServer): void;
export declare function handleSchedulerStart(io: SocketServer): void;
export declare function handleSchedulerStop(io: SocketServer): void;
export declare function attachSocketAuth(io: SocketServer): void;
export declare function setupSocketHandlers(io: SocketServer): void;

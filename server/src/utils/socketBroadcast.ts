/**
 * Socket.IO Global Broadcaster
 *
 * Allows any module to emit events to all connected Dashboard clients
 * without direct dependency on the Socket.IO server instance.
 */

import type { Server as SocketServer } from 'socket.io';

let io: SocketServer | null = null;

export function setSocketIO(server: SocketServer): void {
  io = server;
}

/**
 * Broadcast an event to all connected clients
 */
export function broadcast(event: string, data?: unknown): void {
  if (io) {
    io.emit(event, data);
  }
}

/**
 * Broadcast agent lifecycle events for real-time dashboard
 */
export const agentEvents = {
  /** Agent run started */
  runStarted(data: { runId: string; chatId: string; message: string; taskType: string }) {
    broadcast('agent:runStarted', data);
  },
  /** Tool execution started */
  toolStarted(data: { runId: string; toolName: string }) {
    broadcast('agent:toolStarted', data);
  },
  /** Tool execution finished */
  toolFinished(data: { runId: string; toolName: string; durationMs: number; success: boolean }) {
    broadcast('agent:toolFinished', data);
  },
  /** Agent turn completed (partial progress) */
  turnCompleted(data: { runId: string; turn: number; tokensUsed: number }) {
    broadcast('agent:turnCompleted', data);
  },
  /** Agent run completed */
  runCompleted(data: { runId: string; durationMs: number; turns: number; totalTokens: number; success: boolean }) {
    broadcast('agent:runCompleted', data);
  },
  /** Bot/System Model configuration updated */
  modelUpdated(data: { botId?: string; isGlobal?: boolean }) {
    broadcast('agent:modelUpdated', data);
  },
};

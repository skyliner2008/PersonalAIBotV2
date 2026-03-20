import type { Server as SocketServer, Socket } from 'socket.io';
import { launchBrowser, closeBrowser, isRunning } from '../automation/browser.js';
import { login, isLoggedIn } from '../automation/facebook.js';
import { startChatMonitor, stopChatMonitor, isChatMonitorActive } from '../automation/chatBot.js';
import { startCommentMonitor, stopCommentMonitor, isCommentMonitorActive } from '../automation/commentBot.js';
import { startScheduler, stopScheduler } from '../scheduler/scheduler.js';
import { addLog } from '../database/db.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SocketHandlers');

/**
 * Attach Socket.IO authentication middleware.
 * Requires `SOCKET_AUTH_TOKEN` env var in production.
 * In dev mode (no token set), allows all connections with a warning.
 */
export function attachSocketAuth(io: SocketServer): void {
  const expectedToken = process.env.SOCKET_AUTH_TOKEN;
  io.use((socket, next) => {
    if (!expectedToken) {
      // Dev mode: no auth required but warn once
      return next();
    }
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace('Bearer ', '');
    if (token === expectedToken) return next();
    addLog('socket', `Auth failed for ${socket.id}`, undefined, 'warn');
    return next(new Error('Authentication required'));
  });
}
// Helper function to handle browser related socket events
function handleBrowserEvents(socket: Socket, io: SocketServer): void {
  socket.on('browser:start', async () => {
    try {
      addLog('browser', 'Starting browser...', undefined, 'info');
      await launchBrowser();
      io.emit('browser:status', { running: true });
      addLog('browser', 'Browser started', undefined, 'success');
    } catch (e: any) {
      const msg = e?.message || String(e);
      logger.error(`[Browser] Launch error: ${msg}`);
      addLog('browser', 'Browser launch failed', msg, 'error');
      socket.emit('error', { message: `Browser launch failed: ${msg}` });
      io.emit('browser:status', { running: false });
    }
  });
  socket.on('browser:stop', async () => {
    try {
      await closeBrowser();
    } catch (e: any) {
      addLog('browser', 'Browser close error', String(e), 'error');
    }
    io.emit('browser:status', { running: false });
    io.emit('chatbot:status', { active: false });
    io.emit('commentbot:status', { active: false });
  });
}
// Helper function to handle Facebook login related socket events
function handleFacebookEvents(socket: Socket, io: SocketServer): void {
  socket.on('fb:login', async (data: { email: string; password: string }) => {
    try {
      addLog('facebook', 'Login attempt...', undefined, 'info');
      logger.info(`[FB] Login attempt`);
      // Auto-launch browser if not running
      if (!isRunning()) {
        addLog('facebook', 'Auto-launching browser for login', undefined, 'info');
        logger.info('[FB] Browser not running, launching...');
        await launchBrowser();
        io.emit('browser:status', { running: true });
      }
      const success = await login(data.email, data.password);
      logger.info(`[FB] Login result: ${success ? 'SUCCESS' : 'FAILED'}`);
      addLog('facebook', success ? 'Login successful' : 'Login failed', undefined, success ? 'success' : 'error');
      io.emit('fb:loginResult', { success, message: success ? 'Logged in!' : 'Login failed - check credentials or 2FA' });
    } catch (e: any) {
      const msg = e?.message || String(e);
      logger.error(`[FB] Login error: ${msg}`);
      addLog('facebook', 'Login error', msg, 'error');
      io.emit('fb:loginResult', { success: false, message: `Error: ${msg}` });
    }
  });
  socket.on('fb:checkLogin', async () => {
    try {
      const loggedIn = isRunning() ? await isLoggedIn() : false;
      socket.emit('fb:loginStatus', { loggedIn });
    } catch {
      socket.emit('fb:loginStatus', { loggedIn: false });
    }
  });
}
// Helper function to handle Chat Bot related socket events
function handleChatBotEvents(socket: Socket, io: SocketServer): void {
  socket.on('chatbot:start', async () => {
    try {
      if (!isRunning()) {
        await launchBrowser();
        io.emit('browser:status', { running: true });
      }
      await startChatMonitor(io);
      io.emit('chatbot:status', { active: true });
    } catch (e: any) {
      addLog('chatbot', 'Start failed', String(e), 'error');
      socket.emit('error', { message: `Chat bot start failed: ${e}` });
    }
  });
  socket.on('chatbot:stop', () => {
    stopChatMonitor(io);
    io.emit('chatbot:status', { active: false });
  });
}
// Helper function to handle Comment Bot related socket events
function handleCommentBotEvents(socket: Socket, io: SocketServer): void {
  socket.on('commentbot:start', async () => {
    try {
      if (!isRunning()) {
        await launchBrowser();
        io.emit('browser:status', { running: true });
      }
      await startCommentMonitor(io);
      io.emit('commentbot:status', { active: true });
    } catch (e: any) {
      addLog('commentbot', 'Start failed', String(e), 'error');
      socket.emit('error', { message: `Comment bot start failed: ${e}` });
    }
  });
  socket.on('commentbot:stop', () => {
    stopCommentMonitor(io);
    io.emit('commentbot:status', { active: false });
  });
}
// Helper function to handle Scheduler related socket events
function handleSchedulerEvents(socket: Socket, io: SocketServer): void {
  socket.on('scheduler:start', () => {
    try {
      startScheduler(io);
      io.emit('scheduler:status', { active: true });
    } catch (e: any) {
      addLog('scheduler', 'Start failed', String(e), 'error');
    }
  });
  socket.on('scheduler:stop', () => {
    stopScheduler();
    io.emit('scheduler:status', { active: false });
  });
}
// Helper function to handle the disconnect event
function handleDisconnectEvent(socket: Socket): void {
  socket.on('disconnect', () => {
    logger.info(`[Socket] Client disconnected: ${socket.id}`);
  });
}
export function setupSocketHandlers(io: SocketServer): void {
  io.on('connection', (socket: Socket) => {
    logger.info(`[Socket] Client connected: ${socket.id}`);
    // Send initial status
    socket.emit('status', {
      browser: isRunning(),
      chatBot: isChatMonitorActive(),
      commentBot: isCommentMonitorActive(),
    });
    // Attach all specific event handlers
    handleBrowserEvents(socket, io);
    handleFacebookEvents(socket, io);
    handleChatBotEvents(socket, io);
    handleCommentBotEvents(socket, io);
    handleSchedulerEvents(socket, io);
    handleDisconnectEvent(socket);
  });
}

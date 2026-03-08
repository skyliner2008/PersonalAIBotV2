import type { Server as SocketServer, Socket } from 'socket.io';
import { launchBrowser, closeBrowser, isRunning } from '../automation/browser.js';
import { login, isLoggedIn } from '../automation/facebook.js';
import { startChatMonitor, stopChatMonitor, isChatMonitorActive } from '../automation/chatBot.js';
import { startCommentMonitor, stopCommentMonitor, isCommentMonitorActive } from '../automation/commentBot.js';
import { startScheduler, stopScheduler } from '../scheduler/scheduler.js';
import { addLog } from '../database/db.js';

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
    console.warn(`[Socket] Auth failed for ${socket.id}`);
    return next(new Error('Authentication required'));
  });
}

export function setupSocketHandlers(io: SocketServer): void {
  io.on('connection', (socket: Socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);

    // Send initial status
    socket.emit('status', {
      browser: isRunning(),
      chatBot: isChatMonitorActive(),
      commentBot: isCommentMonitorActive(),
    });

    // ========== Browser Control ==========
    socket.on('browser:start', async () => {
      try {
        addLog('browser', 'Starting browser...', undefined, 'info');
        await launchBrowser();
        io.emit('browser:status', { running: true });
        addLog('browser', 'Browser started', undefined, 'success');
      } catch (e: any) {
        const msg = e?.message || String(e);
        console.error('[Browser] Launch error:', msg);
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

    // ========== Facebook Login ==========
    socket.on('fb:login', async (data: { email: string; password: string }) => {
      try {
        addLog('facebook', 'Login attempt...', undefined, 'info');
        console.log(`[FB] Login attempt`);

        // Auto-launch browser if not running
        if (!isRunning()) {
          addLog('facebook', 'Auto-launching browser for login', undefined, 'info');
          console.log('[FB] Browser not running, launching...');
          await launchBrowser();
          io.emit('browser:status', { running: true });
        }

        const success = await login(data.email, data.password);
        console.log(`[FB] Login result: ${success ? 'SUCCESS' : 'FAILED'}`);
        addLog('facebook', success ? 'Login successful' : 'Login failed', undefined, success ? 'success' : 'error');
        io.emit('fb:loginResult', { success, message: success ? 'Logged in!' : 'Login failed - check credentials or 2FA' });
      } catch (e: any) {
        const msg = e?.message || String(e);
        console.error('[FB] Login error:', msg);
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

    // ========== Chat Bot ==========
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

    // ========== Comment Bot ==========
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

    // ========== Scheduler ==========
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

    // ========== Disconnect ==========
    socket.on('disconnect', () => {
      console.log(`[Socket] Client disconnected: ${socket.id}`);
    });
  });
}

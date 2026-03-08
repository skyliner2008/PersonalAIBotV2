import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { config } from './config.js';
import { initDb, addLog } from './database/db.js';
import { router } from './api/routes.js';
import { fbRouter } from './facebook/routes.js';
import { setWebhookBroadcast } from './facebook/webhookHandler.js';
import { setupSocketHandlers } from './api/socketHandlers.js';
import { startBots, stopBots } from './bot_agents/botManager.js';
import { chatQueue, webhookQueue } from './queue.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// ============ Dashboard static path ============
// ค้นหา dashboard/dist โดยสัมพัทธ์จาก server/src/ → ../../dashboard/dist
const DASHBOARD_DIST = path.resolve(__dirname, '../../dashboard/dist');
const hasDashboard = fs.existsSync(path.join(DASHBOARD_DIST, 'index.html'));
// ============ Initialize ============
async function main() {
    const app = express();
    const httpServer = createServer(app);
    // --- Socket.io: รองรับทั้ง same-origin (port 3000) และ Vite dev (5173/5174) ---
    const io = new SocketServer(httpServer, {
        cors: {
            origin: [
                `http://localhost:${config.port}`,
                'http://localhost:5173',
                'http://localhost:5174'
            ],
            methods: ['GET', 'POST']
        },
    });
    // --- Global Error Handlers (prevent silent crashes) ---
    process.on('unhandledRejection', (reason, _promise) => {
        console.error('[Server] Unhandled Rejection:', reason);
        addLog('server', 'Unhandled Rejection', String(reason), 'error');
    });
    process.on('uncaughtException', (error) => {
        console.error('[Server] Uncaught Exception:', error);
        addLog('server', 'Uncaught Exception', error.message, 'error');
    });
    // --- Security: Rate Limiting ---
    const apiLimiter = rateLimit({
        windowMs: 1 * 60 * 1000,
        max: 120,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests, please try again later.' },
    });
    const aiLimiter = rateLimit({
        windowMs: 1 * 60 * 1000,
        max: 30,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'AI rate limit reached, please slow down.' },
    });
    // --- CORS (dev fallback: ยังคงอนุญาต Vite dev ports) ---
    app.use(cors({
        origin: [
            `http://localhost:${config.port}`,
            'http://localhost:5173',
            'http://localhost:5174',
        ],
        credentials: true,
    }));
    // --- Body parsing (skip raw body for LINE webhook signature check) ---
    app.use((req, res, next) => {
        if (req.path === '/webhook/line') {
            next();
        }
        else {
            express.json()(req, res, next);
        }
    });
    // --- Request logging ---
    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            const duration = Date.now() - start;
            if (duration > 5000) {
                console.warn(`[Slow Request] ${req.method} ${req.path} took ${duration}ms`);
            }
        });
        next();
    });
    // --- Request timeout ---
    app.use((req, res, next) => {
        res.setTimeout(60000, () => {
            res.status(408).json({ error: 'Request timeout' });
        });
        next();
    });
    // --- Rate limiters on API routes ---
    app.use('/api', apiLimiter);
    app.use('/api/chat', aiLimiter);
    app.use('/api/ai', aiLimiter);
    // --- Initialize DB ---
    await initDb();
    // ================================================================
    // API Routes (ต้องมาก่อน static files เสมอ)
    // ================================================================
    app.use('/api', router);
    app.use('/api/fb-graph', fbRouter);
    app.use('/webhook', fbRouter);
    // Media server for LINE file serving
    app.use('/media', express.static('/'));
    // Wire webhook events to Socket.io
    setWebhookBroadcast((event, data) => {
        io.emit(event, data);
    });
    // Health check
    app.get('/health', (_req, res) => res.json({
        status: 'ok',
        uptime: process.uptime(),
        memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
        timestamp: new Date().toISOString(),
        dashboard: hasDashboard ? 'built' : 'not-built',
    }));
    // ================================================================
    // 📦 Serve Dashboard (React SPA) จาก dashboard/dist
    //    - เปิดได้เลยที่ http://localhost:3000
    //    - ถ้ายังไม่ได้ build จะแสดงหน้าแนะนำวิธี build แทน
    // ================================================================
    if (hasDashboard) {
        // Serve built React app assets
        app.use(express.static(DASHBOARD_DIST));
        // SPA fallback: ทุก route ที่ไม่ใช่ /api, /webhook, /health, /media
        // ให้ serve index.html (React Router จะจัดการ routing ภายใน)
        app.get('*', (req, res, next) => {
            if (req.path.startsWith('/api') ||
                req.path.startsWith('/webhook') ||
                req.path.startsWith('/health') ||
                req.path.startsWith('/media') ||
                req.path.startsWith('/socket.io')) {
                return next();
            }
            res.sendFile(path.join(DASHBOARD_DIST, 'index.html'));
        });
        console.log(`[Dashboard] Serving built React app from ${DASHBOARD_DIST}`);
    }
    else {
        // แนะนำวิธี build ถ้ายังไม่มี dist
        app.get('/', (_req, res) => {
            res.send(`
        <!DOCTYPE html>
        <html lang="th">
        <head>
          <meta charset="UTF-8">
          <title>AI Bot Server</title>
          <style>
            body { font-family: sans-serif; max-width: 600px; margin: 80px auto; padding: 20px; }
            code { background: #f0f0f0; padding: 4px 8px; border-radius: 4px; display: block; margin: 8px 0; }
            .ok { color: green; }
          </style>
        </head>
        <body>
          <h1>🤖 AI Bot Server <span class="ok">กำลังทำงาน ✅</span></h1>
          <p>API พร้อมใช้งานแล้ว แต่ยังไม่มี Dashboard (ยังไม่ได้ build)</p>
          <h2>วิธี build Dashboard:</h2>
          <p>รัน <code>start.bat</code> แทน <code>start_unified.bat</code></p>
          <p>หรือรันคำสั่งเหล่านี้:</p>
          <code>cd dashboard && npm run build</code>
          <code>cd ../server && npm run dev</code>
          <hr>
          <p><a href="/health">Health Check →</a></p>
        </body>
        </html>
      `);
        });
    }
    // Socket.io handlers
    setupSocketHandlers(io);
    // Initialize bot agents
    try {
        startBots(app);
    }
    catch (err) {
        console.error('[BotManager] Failed to start agents:', err);
    }
    // ============ Start Server ============
    httpServer.listen(config.port, () => {
        addLog('server', 'Server started', `Port ${config.port}`, 'success');
        const dashboardUrl = hasDashboard
            ? `http://localhost:${config.port} (built)`
            : `http://localhost:5173 (dev, run separately)`;
        console.log(`
╔══════════════════════════════════════════════════╗
║     🤖 Unified AI Bot Server v2.1              ║
║                                                  ║
║  🌐 Server + Dashboard: http://localhost:${config.port}    ║
║  📡 Webhook:  http://localhost:${config.port}/webhook      ║
║  🩺 Health:   http://localhost:${config.port}/health       ║
║                                                  ║
║  Dashboard:  ${hasDashboard ? '✅ Built & Served (port ' + config.port + ')  ' : '⚠️  Not built — run start.bat'}  ║
║  Security:   ✅ Rate Limiting Active             ║
╚══════════════════════════════════════════════════╝
    `);
    });
    // ============ Graceful Shutdown ============
    async function gracefulShutdown(signal) {
        console.log(`\n[Server] ${signal} — starting graceful shutdown...`);
        addLog('server', 'Server shutdown', signal, 'info');
        httpServer.close(() => console.log('[Server] HTTP server closed'));
        try {
            stopBots();
            console.log('[Server] Bot agents stopped');
        }
        catch (err) {
            console.error('[Server] Error stopping bots:', err);
        }
        chatQueue.clear();
        webhookQueue.clear();
        console.log('[Server] Message queues cleared');
        try {
            const { closeBrowser } = await import('./automation/browser.js');
            await closeBrowser();
            console.log('[Server] Browser closed');
        }
        catch (_) { }
        io.disconnectSockets(true);
        console.log('[Server] Shutdown complete ✅');
        process.exit(0);
    }
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}
main().catch(console.error);
//# sourceMappingURL=index.js.map
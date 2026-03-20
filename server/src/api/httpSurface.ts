import express from 'express';
import path from 'path';
import type { Server as SocketServer } from 'socket.io';
import { config } from '../config.js';
import { router } from './routes.js';
import toolsRouter from './toolsRouter.js';
import botsRouter from './botsRouter.js';
import { fbRouter } from '../facebook/routes.js';
import swarmRoutes from './swarmRoutes.js';
import terminalRoutes from './terminalRoutes.js';
import providerRoutes from './providerRoutes.js';
import systemRouter from './systemRouter.js';
import upgradeRoutes from './upgradeRoutes.js';
import { chatQueue, webhookQueue } from '../queue.js';
import { setWebhookBroadcast } from '../facebook/webhookHandler.js';
import { requireReadWriteAuth } from '../utils/auth.js';
import healthRoutes from './healthRoutes.js';
import goalRoutes from './routes/goalRoutes.js';
import { requestTracingMiddleware } from '../utils/requestTracer.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('HttpSurface');
const STARTUP_COMPACT = process.env.STARTUP_COMPACT === '1';

interface RegisterHttpSurfaceOptions {
  app: express.Express;
  io: SocketServer;
  hasDashboard: boolean;
  dashboardDist: string;
}

export function registerHttpSurface({
  app,
  io,
  hasDashboard,
  dashboardDist,
}: RegisterHttpSurfaceOptions): void {
  const readWriteGuard = requireReadWriteAuth('viewer');

  // Request tracing — attach requestId to every request
  app.use(requestTracingMiddleware);

  // Health endpoints (no auth required, must be before API routes)
  app.use('/', healthRoutes);

  // Mount API and Webhook routes
  setupApiRoutes(app, readWriteGuard);

  // Static media host for LINE/Telegram file responses.
  app.use('/media', express.static(config.uploadsDir));

  // Webhook broadcasting via Socket.io
  setWebhookBroadcast((event, data) => {
    io.emit(event, data);
  });

  // Main Health Check Endpoint
  app.get('/health', async (req, res) => {
    await handleHealthCheck(req, res, hasDashboard);
  });

  // UI Dashboard serving
  setupDashboard(app, hasDashboard, dashboardDist);
}

/**
 * Mounts all API and webhook related routes.
 */
function setupApiRoutes(app: express.Express, readWriteGuard: express.RequestHandler): void {
  // Keep mounted order stable to avoid behavioral regressions.
  app.use('/api/system', systemRouter);
  app.use('/api', router);
  app.use('/api/tools', toolsRouter);
  app.use('/api/bots', botsRouter);
  app.use('/api/fb-graph', readWriteGuard, fbRouter);
  app.use('/api/swarm', swarmRoutes);
  app.use('/api/terminal', terminalRoutes);
  app.use('/api/providers', providerRoutes);
  app.use('/api', goalRoutes);
  app.use('/api/upgrade', readWriteGuard, upgradeRoutes);
  app.use('/webhook', fbRouter);
}

/**
 * Logic for the /health endpoint providing system status, memory and queue stats.
 */
async function handleHealthCheck(
  _req: express.Request,
  res: express.Response,
  hasDashboard: boolean
): Promise<void> {
  const mem = process.memoryUsage();
  let dbStats: Record<string, number> = {};
  try {
    const { getDbStats } = await import('../database/db.js');
    dbStats = getDbStats();
  } catch {
    dbStats = {};
  }

  let rateLimitInfo = {};
  try {
    const { getRateLimitStats } = await import('../utils/rateLimiter.js');
    rateLimitInfo = getRateLimitStats();
  } catch {
    rateLimitInfo = {};
  }

  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    uptimeHuman: `${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m`,
    memory: {
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
      rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
    },
    queues: {
      chat: chatQueue.getStats(),
      webhook: webhookQueue.getStats(),
    },
    database: dbStats,
    rateLimits: rateLimitInfo,
    timestamp: new Date().toISOString(),
    dashboard: hasDashboard ? 'built' : 'not-built',
    nodeVersion: process.version,
  });
}

/**
 * Configures dashboard serving or a fallback landing page.
 */
function setupDashboard(app: express.Express, hasDashboard: boolean, dashboardDist: string): void {
  if (hasDashboard) {
    app.use(express.static(dashboardDist));

    app.get('*', (req, res, next) => {
      // Skip dashboard routing for API/System paths
      if (
        req.path.startsWith('/api') ||
        req.path.startsWith('/webhook') ||
        req.path.startsWith('/health') ||
        req.path.startsWith('/healthz') ||
        req.path.startsWith('/readyz') ||
        req.path.startsWith('/metrics') ||
        req.path.startsWith('/media') ||
        req.path.startsWith('/socket.io')
      ) {
        return next();
      }
      res.sendFile(path.join(dashboardDist, 'index.html'));
    });

    if (!STARTUP_COMPACT) {
      logger.info(`Serving built React app from ${dashboardDist}`);
    }
  } else {
    app.get('/', (_req, res) => {
      res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <title>AI Bot Server</title>
          <style>
            body { font-family: sans-serif; max-width: 700px; margin: 80px auto; padding: 20px; }
            code { background: #f0f0f0; padding: 4px 8px; border-radius: 4px; display: block; margin: 8px 0; }
            .ok { color: green; }
          </style>
        </head>
        <body>
          <h1>AI Bot Server <span class="ok">Running</span></h1>
          <p>API is ready, but dashboard is not built yet.</p>
          <h2>Build Dashboard</h2>
          <code>cd dashboard && npm run build</code>
          <code>cd ../server && npm run dev</code>
          <hr>
          <p><a href="/health">Health Check</a></p>
        </body>
        </html>
      `);
    });
  }
}

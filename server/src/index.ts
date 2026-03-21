// Web CLI Restart Trigger
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { config } from './config.js';
import { initDb, addLog, upsertConversation } from './database/db.js';
import { ensureBotTables } from './bot_agents/registries/botRegistry.js';
import { setupSocketHandlers, attachSocketAuth } from './api/socketHandlers.js';
import { setSocketIO } from './utils/socketBroadcast.js';
import { startBots, stopBots } from './bot_agents/botManager.js';
import { Agent } from './bot_agents/agent.js';
import { startIdleLoop } from './evolution/idleLoop.js';
import { startSubconsciousSleepJob } from './scheduler/subconscious.js';
import { startSelfUpgrade } from './evolution/selfUpgrade.js';
import { initSelfReflection } from './evolution/selfReflection.js';
import { getSwarmCoordinator } from './swarm/swarmCoordinator.js';
import { chatQueue, webhookQueue } from './queue.js';
import { initRegistry } from './providers/registry.js';
import { ProviderFactory } from './providers/providerFactory.js';
import { globalErrorHandler, notFoundHandler } from './utils/errorHandler.js';
import logger, { httpLogger } from './utils/logger.js';
import { ensureUsageTable } from './utils/usageTracker.js';
import { startHealthChecker, stopHealthChecker } from './providers/healthChecker.js';
import { userRateLimitMiddleware } from './utils/rateLimiter.js';
import { ensureGoalTables } from './memory/goalTracker.js';
import { initUnifiedMemory } from './memory/unifiedMemory.js';
import { initEmbeddingProvider } from './memory/embeddingProvider.js';
import { metricsMiddleware, metricsHandler } from './utils/metrics.js';
import { swaggerUIHandler, specJsonHandler } from './api/openapi.js';
import { validateAndReport } from './configValidator.js';
import { ensureQueueTable } from './utils/persistentQueue.js';
import { sanitizeMiddleware } from './utils/sanitizer.js';
import { setupTerminalGateway, setAgentHandler, shutdownTerminalGateway } from './terminal/terminalGateway.js';
import { registerHttpSurface } from './api/httpSurface.js';
import { getRootAdminIdentity } from './system/rootAdmin.js';
import { requiresRawWebhookBody } from './utils/webhookPaths.js';
import { verifyToken } from './utils/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============ Dashboard static path ============
// Resolve dashboard/dist relative to server/src -> ../../dashboard/dist
const DASHBOARD_DIST = path.resolve(__dirname, '../../dashboard/dist');
const hasDashboard = fs.existsSync(path.join(DASHBOARD_DIST, 'index.html'));
const STARTUP_COMPACT = process.env.STARTUP_COMPACT === '1';
const SOCKET_TOKEN_ALLOW_REMOTE = process.env.SOCKET_TOKEN_ALLOW_REMOTE === '1';

interface PublishedVoiceFile {
  url: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: 'image' | 'file';
}

function stripSurroundingQuotes(value: string): string {
  let out = String(value || '').trim();
  while (
    (out.startsWith('"') && out.endsWith('"')) ||
    (out.startsWith('\'') && out.endsWith('\'')) ||
    (out.startsWith('`') && out.endsWith('`'))
  ) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

function decodeUriSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function mapMediaUrlPathToLocalFile(value: string): string | null {
  const normalized = String(value || '').replace(/\\/g, '/').trim();
  const mediaPrefix = '/media/';
  if (!normalized.toLowerCase().startsWith(mediaPrefix)) return null;

  const relative = decodeUriSafe(normalized.slice(mediaPrefix.length)).replace(/^\/+/, '');
  if (!relative || relative.includes('..')) return null;
  return path.join(config.uploadsDir, relative);
}

function tryResolveUrl(value: string): string | null {
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const parsed = new URL(value);
    const mapped = mapMediaUrlPathToLocalFile(parsed.pathname);
    return mapped ? path.resolve(mapped) : null;
  } catch {
    return null;
  }
}

function tryResolveFileUrl(value: string): string | null {
  if (!/^file:\/\//i.test(value)) return null;
  try {
    const parsed = new URL(value);
    let filePath = decodeUriSafe(parsed.pathname || '');
    if (/^\/[a-zA-Z]:\//.test(filePath)) {
      filePath = filePath.slice(1);
    }
    return filePath ? path.resolve(filePath) : null;
  } catch {
    return null;
  }
}

function tryResolveRelativePath(value: string): string | null {
  const normalizedDirect = path.resolve(value);
  if (fs.existsSync(normalizedDirect)) return normalizedDirect;

  const serverRoot = path.resolve(__dirname, '..');
  const projectRoot = path.resolve(__dirname, '../..');
  const relativeRoots = [process.cwd(), serverRoot, projectRoot];
  for (const root of relativeRoots) {
    const fromRoot = path.resolve(root, value);
    if (fs.existsSync(fromRoot)) return fromRoot;
  }
  return null;
}

function tryResolveUploadPath(value: string): string | null {
  const baseName = path.basename(value);
  if (!baseName || baseName === value) return null;
  const uploadCandidates = [
    path.join(config.uploadsDir, baseName),
    path.join(config.uploadsDir, 'jarvis-share', baseName),
  ];
  for (const uploadPath of uploadCandidates) {
    if (fs.existsSync(uploadPath)) return uploadPath;
  }
  return null;
}

function resolveVoiceSourcePath(rawFilePath: string): string {
  const trimmed = stripSurroundingQuotes(rawFilePath);
  if (!trimmed) throw new Error('Invalid file path');

  const markdownLinkMatch = trimmed.match(/\]\(([^)]+)\)\s*$/);
  const fromMarkdown = markdownLinkMatch?.[1] ? stripSurroundingQuotes(markdownLinkMatch[1]) : '';
  const directCandidate = fromMarkdown || trimmed;

  const candidates: string[] = [directCandidate];
  const firstLine = directCandidate.split(/\r?\n/)[0]?.trim();
  if (firstLine && firstLine !== directCandidate) {
    candidates.push(firstLine);
  }

  for (const source of candidates) {
    const value = decodeUriSafe(stripSurroundingQuotes(source));
    if (!value) continue;

    const urlRes = tryResolveUrl(value);
    if (urlRes) return urlRes;

    const fileUrlRes = tryResolveFileUrl(value);
    if (fileUrlRes) return fileUrlRes;

    const mappedMediaPath = mapMediaUrlPathToLocalFile(value);
    if (mappedMediaPath) return path.resolve(mappedMediaPath);

    const relativeRes = tryResolveRelativePath(value);
    if (relativeRes) return relativeRes;

    const uploadRes = tryResolveUploadPath(value);
    if (uploadRes) return uploadRes;
  }

  return path.resolve(directCandidate);
}

function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const table: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.tsv': 'text/tab-separated-values',
    '.xml': 'application/xml',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.zip': 'application/zip',
  };
  return table[ext] || 'application/octet-stream';
}

function publishFileForVoiceChat(filePath: string): PublishedVoiceFile {
  const resolved = resolveVoiceSourcePath(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${String(filePath || '').trim()} (resolved: ${resolved})`);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${resolved}`);
  }

  const safeBaseName = path.basename(resolved).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file.bin';
  const shareDir = path.join(config.uploadsDir, 'jarvis-share');
  fs.mkdirSync(shareDir, { recursive: true });

  const uniquePrefix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const targetName = `${uniquePrefix}_${safeBaseName}`;
  const targetPath = path.join(shareDir, targetName);
  fs.copyFileSync(resolved, targetPath);

  const mimeType = guessMimeType(targetName);
  const kind: 'image' | 'file' = mimeType.startsWith('image/') ? 'image' : 'file';
  return {
    url: `/media/jarvis-share/${encodeURIComponent(targetName)}`,
    name: safeBaseName,
    mimeType,
    sizeBytes: stat.size,
    kind,
  };
}

function extractVoiceSocketId(userId?: string): string | null {
  const raw = String(userId || '').trim();
  if (!raw.startsWith('voice_')) return null;
  const socketId = raw.slice('voice_'.length).trim();
  return socketId || null;
}

function resolveTrustProxySetting(): boolean | number | string {
  const raw = String(process.env.TRUST_PROXY || '').trim().toLowerCase();
  if (!raw) {
    // Development default for reverse-proxy tunnels (ngrok/cloudflared).
    return process.env.NODE_ENV === 'production' ? false : 1;
  }
  if (raw === 'true') return true;
  if (raw === 'false' || raw === '0' || raw === 'off') return false;
  const numeric = Number(raw);
  if (Number.isInteger(numeric) && numeric >= 0) return numeric;
  // Allow Express named modes such as "loopback", "uniquelocal", etc.
  return raw;
}

function startupInfo(message: string): void {
  if (!STARTUP_COMPACT) {
    logger.info(message);
  }
}

// ============ Startup Environment Validation ============
// Uses Zod-based config validator with multi-environment support
// In production: halts on missing required vars
// In development: prints warnings and continues
validateAndReport();

// ============ Initialize ============
async function main() {
  const app = express();
  const httpServer = createServer(app);
  const trustProxySetting = resolveTrustProxySetting();
  app.set('trust proxy', trustProxySetting);

  // --- Socket.io: allow same-origin (port 3000) and Vite dev ports (5173/5174) ---
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
    // Node.js best practice: exit after uncaughtException as state may be corrupted
    setTimeout(() => process.exit(1), 1000);
  });

  // --- Security: Rate Limiting ---
  const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 300, // Increased from 120 to support rapid Dashboard Batch Approvals
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

  // --- CORS (dev fallback includes Vite dev ports) ---
  app.use(cors({
    origin: [
      `http://localhost:${config.port}`,
      'http://localhost:5173',
      'http://localhost:5174',
    ],
    credentials: true,
  }));

  // --- Security Headers (comprehensive, helmet-equivalent) ---
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '0'); // modern browsers: disabled in favor of CSP
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.removeHeader('X-Powered-By');
    // HSTS — only on non-localhost
    if (config.security.hstsMaxAge > 0 && _req.hostname !== 'localhost') {
      res.setHeader('Strict-Transport-Security', `max-age=${config.security.hstsMaxAge}; includeSubDomains`);
    }
    // CSP — allow self + inline styles (Tailwind) + CDN scripts + WebSocket
    if (config.security.cspEnabled) {
      res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' https://cdnjs.cloudflare.com 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "connect-src 'self' ws: wss:",
        "font-src 'self'",
        "media-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '));
    }
    next();
  });

  // --- Prometheus Metrics Middleware ---
  app.use(metricsMiddleware);
  app.get('/metrics', metricsHandler);
  app.get('/api-docs', swaggerUIHandler);
  app.get('/api-docs/json', specJsonHandler);

  // --- HTTP Request Logger (Winston) ---
  app.use(httpLogger.log);

  // --- Body parsing with raw body capture for webhook verification ---
  app.use((req, res, next) => {
    // For webhook endpoints, capture raw body for signature verification
    if (requiresRawWebhookBody(req.path)) {
      let rawBody = '';
      req.on('data', chunk => {
        rawBody += chunk.toString('utf8');
      });
      req.on('end', () => {
        (req as any).rawBody = rawBody;
        // Parse JSON
        if (rawBody.length > 0) {
          try {
            (req as any).body = JSON.parse(rawBody);
          } catch {
            (req as any).body = {};
          }
        }
        next();
      });
    } else {
      // Limit body size to 10MB to prevent DoS via oversized payloads
      express.json({ limit: '10mb' })(req, res, next);
    }
  });

  // --- Input Sanitization (XSS, SQL injection, prototype pollution) ---
  app.use(sanitizeMiddleware({
    stripXSS: true,
    logInjection: true,
    excludePaths: ['/webhook', '/webhook/line', '/metrics'],
  }));

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
    res.setTimeout(600000, () => {
      if (!res.headersSent) {
        res.status(408).json({ error: 'Request timeout' });
      }
    });
    next();
  });

  // --- Rate limiters on API routes ---
  app.use('/api', apiLimiter);
  app.use('/api/chat', aiLimiter);
  app.use('/api/chat/reply', aiLimiter);
  app.use('/api/ai', aiLimiter);

  // --- Per-User Rate Limiting (on top of IP-based) ---
  app.use('/api/chat', userRateLimitMiddleware(10));          // 10 AI chats/min per user
  app.use('/api/chat/reply', userRateLimitMiddleware(10));
  app.use('/api/ai/generate-post', userRateLimitMiddleware(5)); // 5 content generations/min
  app.use('/api/memory', userRateLimitMiddleware(30));         // 30 memory ops/min
  app.use('/api/tools', userRateLimitMiddleware(20));          // 20 tool calls/min

  // --- Initialize DB ---
  await initDb();
  ensureBotTables();
  ensureUsageTable();
  ensureGoalTables();
  ensureQueueTable();
  await initSelfReflection();
  
  if (process.env.GEMINI_API_KEY) {
    initEmbeddingProvider(process.env.GEMINI_API_KEY);
  }
  
  await initUnifiedMemory();

  // --- Initialize Provider System ---
  try {
    initRegistry();
    await ProviderFactory.initializeAll();
    startupInfo('[Providers] Provider system initialized');
    startHealthChecker();
  } catch (err) {
    console.warn('[Providers] Warning during initialization:', err);
  }

  // ================================================================
  // Socket auth token must be registered before API router to avoid conflicts
  // ================================================================
  // Socket token endpoint is rate limited to prevent brute-force extraction
  const socketTokenLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many token requests' },
  });
  app.get('/api/auth/socket-token', socketTokenLimiter, (_req, res) => {
    const token = process.env.SOCKET_AUTH_TOKEN;
    if (!token) {
      return res.json({ token: null, message: 'No auth required' });
    }
    
    // Strict IP check: must be loopback (dashboard runs on same machine)
    const clientIp = _req.ip || _req.socket.remoteAddress;
    const isLocalhost = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1';
    const authHeader = String(_req.headers.authorization || '');
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const jwtUser = bearer ? verifyToken(bearer) : null;
    const hostHeader = String(_req.headers.host || '').toLowerCase();
    const isNgrokHost =
      hostHeader.includes('.ngrok-free.') ||
      hostHeader.includes('.ngrok.app') ||
      hostHeader.includes('.ngrok.io');
    const autoAllowRemoteInDev = process.env.NODE_ENV !== 'production' && isNgrokHost;

    // Allow remote dashboard access when explicitly enabled, authenticated, or dev+ngrok.
    if (!isLocalhost && (jwtUser || SOCKET_TOKEN_ALLOW_REMOTE || autoAllowRemoteInDev)) {
      return res.json({ token });
    }

    if (!isLocalhost) {
      addLog('security', 'Unauthorized socket token access attempt', `IP: ${clientIp}`, 'warning');
      return res.status(403).json({ error: 'Forbidden - Token access requires authenticated dashboard user' });
    }

    const origin = _req.headers.origin || _req.headers.referer || '';
    const allowedOrigins = [
      `http://localhost:${config.port}`,
      'http://localhost:5173',
      'http://localhost:5174',
    ];
    
    const hasAllowedOrigin = allowedOrigins.some(o => origin.startsWith(o));
    if (hasAllowedOrigin || (!origin && isLocalhost)) {
      return res.json({ token });
    }
    return res.status(403).json({ error: 'Forbidden - Invalid Origin' });
  });

  // ================================================================
  // API routes (must be mounted before static files)
  // ================================================================
  registerHttpSurface({
    app,
    io,
    hasDashboard,
    dashboardDist: DASHBOARD_DIST,
  });

  // Socket.io auth + handlers
  attachSocketAuth(io);
  setupSocketHandlers(io);
  setSocketIO(io);  // Enable global broadcast from any module

  // ============ Jarvis Terminal Gateway (xterm.js -> WebSocket) ============
  setupTerminalGateway(io, {
    maxSessions: 10,
    idleTimeoutMs: 3_600_000,
  });
  startupInfo('[Terminal] Jarvis Terminal Gateway initialized');

  // Initialize bot agents and swarm coordinator
  try {
    startBots(app);

    // Initialize Swarm Coordinator with Socket.IO notifications
    const swarmCoordinator = getSwarmCoordinator();
    const systemAgent = new Agent();
    await swarmCoordinator.init(systemAgent);

    // Wire AI Agent handler for terminal @agent commands
    setAgentHandler(async (message: string, platform: string, userId?: string) => {
      const rootAdmin = getRootAdminIdentity();
      const safeUserId = (userId || '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, 64);
      // Use dynamic chatId for voice sessions to prevent hallucination across sessions
      // If it's a voice session, userId is already a unique session ID
      const chatId = safeUserId || 'jarvis_root_admin';
      
      upsertConversation(chatId, safeUserId || 'admin', 'Jarvis Terminal Admin');
      addLog('security', 'Jarvis Admin Agent Used', `User: ${safeUserId || 'admin'}, Chat: ${chatId}, Platform: ${platform}`, 'info');
      
      return await systemAgent.processMessage(chatId, message, {
        botId: rootAdmin.botId,
        botName: rootAdmin.botName,
        platform: 'system' as any, 
        replyWithFile: async (filePath: string, caption?: string) => {
          try {
            const published = publishFileForVoiceChat(filePath);
            const voiceSocketId = extractVoiceSocketId(userId);
            if (voiceSocketId) {
              io.to(voiceSocketId).emit('voice:file', {
                ...published,
                caption: String(caption || '').trim() || undefined,
              });
              return `ส่งไฟล์ "${published.name}" ให้แล้ว คุณสามารถเปิดหรือดาวน์โหลดจากแชทได้`;
            }
            return `ส่งไฟล์ "${published.name}" แล้ว ลิงก์ดาวน์โหลด: ${published.url}`;
          } catch (err: any) {
            const message = String(err?.message || err || 'unknown error').trim();
            return `ส่งไฟล์ไม่สำเร็จ: ${message}`;
          }
        },
      });
    });
    startupInfo('[Terminal] Agent handler wired to Jarvis Terminal');

    // Broadcast swarm task events to dashboard via Socket.IO
    const taskQueue = swarmCoordinator.getTaskQueue();
    if (taskQueue) {
      taskQueue.onAnyQueued((task: any) => {
        io.emit('swarm:task:created', {
          taskId: task.id,
          taskType: task.taskType,
          specialist: task.toSpecialist || null,
          status: task.status,
          batchId: task.metadata?.batchId || null,
          createdAt: task.createdAt,
        });
      });
      taskQueue.onAnyStarted((task: any) => {
        io.emit('swarm:task:started', {
          taskId: task.id,
          taskType: task.taskType,
          specialist: task.toSpecialist || null,
          status: task.status,
          batchId: task.metadata?.batchId || null,
          startedAt: task.startedAt,
        });
      });
      taskQueue.onAnyComplete((task: any) => {
        io.emit('swarm:task:completed', {
          taskId: task.id, taskType: task.taskType,
          specialist: task.toSpecialist || null,
          result: task.result?.substring(0, 500),
          batchId: task.metadata?.batchId || null,
          durationMs: task.completedAt ? task.completedAt.getTime() - task.createdAt.getTime() : 0,
        });
      });
      taskQueue.onAnyFail((task: any) => {
        io.emit('swarm:task:failed', {
          taskId: task.id, taskType: task.taskType,
          specialist: task.toSpecialist || null,
          error: task.error, retryCount: task.retryCount || 0,
          batchId: task.metadata?.batchId || null,
        });
      });
    }

    swarmCoordinator.onBatchUpdate((batch) => {
      io.emit('swarm:batch:updated', {
        id: batch.id,
        objective: batch.objective,
        status: batch.status,
        progress: batch.progress,
        updatedAt: new Date().toISOString(),
      });
    });
    swarmCoordinator.onBatchComplete((batch) => {
      io.emit('swarm:batch:completed', {
        id: batch.id,
        objective: batch.objective,
        status: batch.status,
        progress: batch.progress,
        summary: batch.summary?.substring(0, 3000),
        completedAt: batch.completedAt,
      });
    });
    startupInfo('[Swarm] Coordinator initialized and ready for task delegation');

    // Start Proactive Idle Loop using a standalone System Agent instance
    startIdleLoop(systemAgent);
    startSubconsciousSleepJob();

    // Start Self-Upgrade System (scans codebase when idle 30min)
    startSelfUpgrade(path.resolve(process.cwd(), 'src'));
    startupInfo('[SelfUpgrade] Autonomous upgrade system initialized (30min idle threshold, dry-run mode)');

  } catch (err) {
    console.error('[BotManager] Failed to start agents:', err);
  }

  // --- Global Error Handling (must be after all routes, including dynamic bot webhooks) ---
  app.use(notFoundHandler);
  app.use(globalErrorHandler);

  // ============ Start Server ============
  httpServer.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      const message = `[Startup] Port ${config.port} is already in use. Stop the old process or choose another PORT.`;
      console.error(message);
      addLog('server', 'Startup failed', message, 'error');
      process.exit(1);
      return;
    }
    console.error('[Startup] HTTP server failed to start:', err);
    addLog('server', 'Startup failed', String(err), 'error');
    process.exit(1);
  });

  httpServer.listen(config.port, () => {
    addLog('server', 'Server started', `Port ${config.port}`, 'success');

    const dashboardUrl = hasDashboard
      ? `http://localhost:${config.port} (built)`
      : `http://localhost:5173 (dev, run separately)`;

    if (STARTUP_COMPACT) {
      console.log(`[Ready] Server: http://localhost:${config.port} | Webhook: /webhook | Health: /health | Dashboard: ${hasDashboard ? 'built' : 'not-built'}`);
    } else {
      console.log(`
+------------------------------------------------------------+
|     Unified AI Bot Server v2.1                             |
|                                                            |
|  Server + Dashboard: http://localhost:${config.port}       |
|  Webhook:  http://localhost:${config.port}/webhook         |
|  Health:   http://localhost:${config.port}/health          |
|                                                            |
|  Dashboard:  ${hasDashboard ? 'Built & Served (port ' + config.port + ')' : 'Not built - run start.bat'} |
|  Security:   Rate Limiting Active                          |
+------------------------------------------------------------+
      `);
    }
  });

  // ============ Graceful Shutdown ============
  async function gracefulShutdown(signal: string) {
    console.log(`\n[Server] ${signal} - starting graceful shutdown...`);
    addLog('server', 'Server shutdown', signal, 'info');

    httpServer.close(() => console.log('[Server] HTTP server closed'));

    try { shutdownTerminalGateway(); console.log('[Server] Terminal sessions closed'); } catch { /* ignore */ }
    try { stopHealthChecker(); } catch { /* ignore */ }
    try { stopBots(); console.log('[Server] Bot agents stopped'); }
    catch (err) { console.error('[Server] Error stopping bots:', err); }

    try {
      const swarmCoordinator = getSwarmCoordinator();
      await swarmCoordinator.shutdown();
      console.log('[Server] Swarm coordinator shut down');
    } catch (err) { console.error('[Server] Error stopping swarm:', err); }

    chatQueue.clear();
    webhookQueue.clear();
    console.log('[Server] Message queues cleared');

    try {
      const { closeBrowser } = await import('./automation/browser.js');
      await closeBrowser();
      console.log('[Server] Browser closed');
    } catch (e) { console.debug('[Server] shutdown browser close:', String(e)); }

    console.log('[Server] Shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

main().catch(console.error);


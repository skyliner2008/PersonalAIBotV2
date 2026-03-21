/**
 * Terminal REST API Routes
 *
 * Provides REST endpoints for terminal operations:
 *   GET  /api/terminal/sessions            -> List active sessions
 *   GET  /api/terminal/backends[?refresh=1] -> List available backends
 *   GET  /api/terminal/help                -> Get plain-text help
 *   POST /api/terminal/execute             -> Execute a one-shot routed command
 */

import { Router, type Request, type Response } from 'express';
import { getSessionManager, executeCommand } from '../terminal/terminalGateway.js';
import { getAvailableBackends, getHelpText, refreshAvailableBackends } from '../terminal/commandRouter.js';
import { requireAuth } from '../utils/auth.js';

const router = Router();
router.use(requireAuth('admin'));

/** List active terminal sessions */
router.get('/sessions', (_req: Request, res: Response) => {
  try {
    const mgr = getSessionManager();
    if (!mgr) {
      return res.json({ sessions: [], count: 0 });
    }

    const sessions = mgr.listSessions();
    res.json({ sessions, count: sessions.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** List available backends (with optional refresh) */
router.get('/backends', (req: Request, res: Response) => {
  try {
    const refresh = String(req.query.refresh || '').toLowerCase();
    const shouldRefresh = refresh === '1' || refresh === 'true' || refresh === 'yes';
    const backends = shouldRefresh ? refreshAvailableBackends() : getAvailableBackends();
    res.json({ backends, refreshed: shouldRefresh });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Get help text */
router.get('/help', (_req: Request, res: Response) => {
  const help = getHelpText().replace(/\x1b\[[^m]*m/g, '');
  res.json({ help });
});

/** Execute a one-shot command and return output */
router.post('/execute', async (req: Request, res: Response) => {
  try {
    const { command, platform } = req.body as { command?: string; platform?: string };
    const user = (req as any).user as { username?: string } | undefined;

    if (!command || typeof command !== 'string' || command.trim().length === 0) {
      return res.status(400).json({ error: 'A valid command string is required' });
    }

    // Sanitize input to mitigate command injection risks: remove null bytes and trim whitespace
    const sanitizedCommand = command.replace(/\0/g, '').trim();
    const sanitizedPlatform = (typeof platform === 'string' ? platform.trim() : 'api') || 'api';

    const result = await executeCommand(sanitizedCommand, sanitizedPlatform, user?.username);
    if (res.headersSent) return;
    res.json({ output: result, command: sanitizedCommand });
  } catch (err: any) {
    if (res.headersSent) return;
    res.status(500).json({ error: err.message });
  }
});

export default router;

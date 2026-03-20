import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import authRoutes from './routes/authRoutes.js';
import settingsRoutes from './routes/settingsRoutes.js';
import chatRoutes from './routes/chatRoutes.js';
import memoryRoutes from './routes/memoryRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import { dbAll, dbGet, dbRun, getRecentLogs, getAllPersonas, getDefaultPersona, addLog, findQAMatch } from '../database/db.js';
import { isRunning } from '../automation/browser.js';
import { isLoggedIn, login } from '../automation/facebook.js';
import { isChatMonitorActive } from '../automation/chatBot.js';
import { isCommentMonitorActive } from '../automation/commentBot.js';
import { getScheduledPosts, schedulePost, deleteScheduledPost } from '../automation/postManager.js';
import { testAllProviders, getProvider, aiChat } from '../ai/aiRouter.js';
import { buildContentPrompt } from '../ai/prompts/contentCreator.js';
import { personaManager, PLATFORMS } from '../ai/personaManager.js';
import type { PlatformType } from '../ai/personaManager.js';
import { getAgentCompatibleProvider } from '../providers/agentRuntime.js';
import { asyncHandler } from '../utils/errorHandler.js';
import { validateBody } from '../utils/validation.js';
import { z } from 'zod';
import { createToolSchema } from '../schemas/index.js';
import { requireAuth, requireReadWriteAuth } from '../utils/auth.js';
import multer from 'multer';
import { processFile, fileToGeminiPart, getSupportedExtensions } from '../utils/fileProcessor.js';
import { config } from '../config.js';
import { listDynamicTools, getDynamicTool, registerDynamicTool, unregisterDynamicTool, refreshDynamicTools } from '../bot_agents/tools/dynamicTools.js';
import { parseIntParam } from './routes/shared.js';
import { setManagedSetting } from '../config/settingsSecurity.js';
import { configManager } from '../bot_agents/config/configManager.js';
import { TaskType, getBestModelForTask } from '../bot_agents/config/aiConfig.js';
import { agentEvents } from '../utils/socketBroadcast.js';

// ============ Zod Schemas for Input Validation ============
const fbLoginSchema = z.object({
  email: z.string().min(1, 'email is required'),
  password: z.string().min(1, 'password is required'),
});

const generatePostSchema = z.object({
  topic: z.string().min(1, 'topic is required').max(1000),
  style: z.string().max(100).optional().default('engaging'),
});

const aiTestSchema = z.object({
  provider: z.string().min(1, 'provider is required'),
  apiKey: z.string().optional(),
});

const personaSchema = z.object({
  name: z.string().min(1, 'name is required').max(100),
  description: z.string().max(500).optional().default(''),
  system_prompt: z.string().min(1, 'system_prompt is required').max(10000),
  personality_traits: z.union([z.string(), z.array(z.string())]).optional(),
  speaking_style: z.string().max(200).optional().default(''),
  language: z.string().max(10).optional().default('th'),
  temperature: z.coerce.number().min(0).max(2).optional().default(0.7),
  max_tokens: z.coerce.number().int().min(1).max(8192).optional().default(500),
});

const qaCreateSchema = z.object({
  question_pattern: z.string().min(1).max(500),
  answer: z.string().min(1, 'Answer is required').max(5000),
  match_type: z.enum(['exact', 'contains', 'regex']).optional().default('contains'),
  category: z.string().max(100).optional().nullable(),
  priority: z.coerce.number().int().min(0).max(100).optional().default(0),
});

export const router = Router();

// ============ Authentication ============
router.use(authRoutes);

const readWriteGuard = requireReadWriteAuth('viewer');

function isPublicRoute(path: string, method: string): boolean {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === 'GET' && (path === '/status' || path === '/fb/status')) {
    return true;
  }
  if (normalizedMethod === 'POST' && (path === '/chat/reply' || path === '/chat/stream')) {
    return true;
  }
  return false;
}

router.use((req, res, next) => {
  if (isPublicRoute(req.path, req.method)) {
    return next();
  }
  return readWriteGuard(req, res, next);
});

// ============ Protected Admin Routes ============
// Apply auth to sensitive endpoints.
router.use('/fb/login', requireAuth('admin'));

// ============ Status ============
router.get('/status', asyncHandler(async (_req, res) => {
  const browser = isRunning();
  const loggedIn = browser ? await isLoggedIn() : false;
  res.json({
    browser,
    loggedIn,
    chatBot: isChatMonitorActive(),
    commentBot: isCommentMonitorActive(),
    uptime: process.uptime(),
  });
}));

// ============ Logs ============
router.get('/logs', (req, res) => {
  const limit = parseIntParam(req.query.limit, 100, 1, 500);
  res.json(getRecentLogs(limit));
});

// ============ Facebook Auth ============
router.post('/fb/login', validateBody(fbLoginSchema), asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const success = await login(email, password);
  res.json({ success });
}));

router.get('/fb/status', async (req, res) => {
  res.json({ loggedIn: isRunning() ? await isLoggedIn() : false });
});

// ============ Settings ============
router.use(settingsRoutes);

// ============ AI Providers ============
router.get('/ai/test', asyncHandler(async (_req, res) => {
  const results = await testAllProviders();
  res.json(results);
}));

router.post('/ai/test', validateBody(aiTestSchema), asyncHandler(async (req, res) => {
  const { provider: providerName, apiKey } = req.body;
  if (!getAgentCompatibleProvider(providerName)) {
    return res.status(400).json({ success: false, error: `Unsupported provider: ${providerName}` });
  }
  if (apiKey !== undefined) setManagedSetting(`ai_${providerName}_key`, apiKey);
  const provider = getProvider(providerName);
  const success = await provider.testConnection();
  res.json({ success });
}));

router.post('/ai/models', validateBody(aiTestSchema), asyncHandler(async (req, res) => {
  const { provider: providerName, apiKey } = req.body;
  if (!getAgentCompatibleProvider(providerName)) {
    return res.status(400).json({ success: false, error: `Unsupported provider: ${providerName}` });
  }
  if (apiKey !== undefined) setManagedSetting(`ai_${providerName}_key`, apiKey);
  const provider = getProvider(providerName);
  const models = await provider.listModels();
  res.json({ models });
}));

router.post('/ai/generate-post', validateBody(generatePostSchema), asyncHandler(async (req, res) => {
  const { topic, style } = req.body;
  const messages = buildContentPrompt(topic, style || 'engaging');
  const result = await aiChat('content', messages);
  res.json({ content: result.text, usage: result.usage });
}));

// ============ Personas ============
router.get('/personas', (req, res) => {
  res.json(getAllPersonas());
});

router.get('/personas/default', (req, res) => {
  res.json(getDefaultPersona());
});

router.post('/personas', validateBody(personaSchema), (req, res) => {
  const { name, description, system_prompt, personality_traits, speaking_style, language, temperature, max_tokens } = req.body;

  const id = uuid().slice(0, 8);
  dbRun(`
    INSERT INTO personas (id, name, description, system_prompt, personality_traits, speaking_style, language, temperature, max_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, name, description, system_prompt,
    typeof personality_traits === 'string' ? personality_traits : JSON.stringify(personality_traits),
    speaking_style, language, temperature, max_tokens
  ]);
  res.json({ success: true, id });
});

router.put('/personas/:id', validateBody(personaSchema), (req, res) => {
  const { name, description, system_prompt, personality_traits, speaking_style, language, temperature, max_tokens } = req.body;

  dbRun(`
    UPDATE personas SET name=?, description=?, system_prompt=?, personality_traits=?, speaking_style=?,
    language=?, temperature=?, max_tokens=?, updated_at=datetime('now')
    WHERE id=?
  `, [name, description, system_prompt,
    typeof personality_traits === 'string' ? personality_traits : JSON.stringify(personality_traits),
    speaking_style, language, temperature, max_tokens,
    req.params.id
  ]);
  res.json({ success: true });
});

router.post('/personas/:id/default', (req, res) => {
  dbRun('UPDATE personas SET is_default = 0', []);
  dbRun('UPDATE personas SET is_default = 1 WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

router.delete('/personas/:id', (req, res) => {
  dbRun('DELETE FROM personas WHERE id = ? AND is_default = 0', [req.params.id]);
  res.json({ success: true });
});

// ============================================================
// Bot personas - file-based (AGENTS.md / IDENTITY.md / SOUL.md / TOOLS.md)
// Used by all bot_agents channels (fb-extension, line, telegram)
// Editable from Dashboard and Extension UI
// ============================================================

/** GET /api/bot-personas - list all platforms */
router.get('/bot-personas', (_req, res) => {
  try {
    const result = PLATFORMS.map(platform => personaManager.readFiles(platform));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/bot-personas/:platform - read persona files for a platform */
router.get('/bot-personas/:platform', (req, res) => {
  const platform = req.params.platform as PlatformType;
  if (!PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: `Invalid platform. Use: ${PLATFORMS.join(', ')}` });
  }
  try {
    res.json(personaManager.readFiles(platform));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** PUT /api/bot-personas/:platform - write files and clear cache immediately */
router.put('/bot-personas/:platform', (req, res) => {
  const platform = req.params.platform as PlatformType;
  if (!PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: `Invalid platform. Use: ${PLATFORMS.join(', ')}` });
  }
  const { agents, identity, soul, tools } = req.body;
  try {
    personaManager.writeFiles(platform, { agents, identity, soul, tools });
    addLog('system', 'Bot Persona Updated', `Platform: ${platform}`, 'success');
    res.json({ success: true, platform });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============ Q&A Database ============

/**
 * Validate Q&A pattern to prevent:
 * 1. Empty/too-short patterns
 * 2. ReDoS (catastrophic backtracking) - check regex compiles in < 50ms
 * 3. Overly long patterns that could be expensive
 */
function validateQAPattern(pattern: string, matchType: string): { valid: boolean; error?: string } {
  if (!pattern || pattern.trim().length === 0) return { valid: false, error: 'Question pattern cannot be empty' };
  if (pattern.length > 500) return { valid: false, error: 'Pattern too long (max 500 chars)' };

  if (matchType === 'regex') {
    try {
      // Test regex compiles
      const re = new RegExp(pattern);
      // Test regex doesn't cause catastrophic backtracking with pathological input
      const testStr = 'a'.repeat(50) + '!';
      const start = Date.now();
      re.test(testStr);
      const elapsed = Date.now() - start;
      if (elapsed > 50) return { valid: false, error: 'Regex is too slow (possible ReDoS risk)' };
    } catch (e: any) {
      return { valid: false, error: `Regex syntax error: ${e.message}` };
    }
  }

  return { valid: true };
}

router.get('/qa', (_req, res) => {
  const rows = dbAll('SELECT * FROM qa_pairs ORDER BY priority DESC, id DESC');
  res.json(rows);
});

router.post('/qa', validateBody(qaCreateSchema), (req, res) => {
  const { question_pattern, answer, match_type, category, priority } = req.body;

  // Additional regex safety check
  const validation = validateQAPattern(question_pattern, match_type);
  if (!validation.valid) return res.status(400).json({ error: validation.error });

  dbRun(
    'INSERT INTO qa_pairs (question_pattern, answer, match_type, category, priority) VALUES (?, ?, ?, ?, ?)',
    [question_pattern.trim(), answer.trim(), match_type, category || null, priority]
  );
  const lastRow = dbGet('SELECT last_insert_rowid() as id');
  res.json({ success: true, id: lastRow?.id });
});

router.put('/qa/:id', (req, res) => {
  const fields = req.body;
  const current = dbGet<{ question_pattern: string; match_type: string; answer: string; category: string | null; priority: number; is_active: number }>('SELECT * FROM qa_pairs WHERE id = ?', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Not found' });

  // Validate pattern if being changed
  const newPattern = fields.question_pattern ?? current.question_pattern;
  const newMatchType = fields.match_type ?? current.match_type;
  const validation = validateQAPattern(newPattern, newMatchType);
  if (!validation.valid) return res.status(400).json({ error: validation.error });

  dbRun(`
    UPDATE qa_pairs SET question_pattern=?, answer=?, match_type=?, category=?, priority=?, is_active=?
    WHERE id=?
  `, [
    newPattern,
    fields.answer ?? current.answer,
    newMatchType,
    fields.category ?? current.category,
    fields.priority ?? current.priority,
    fields.is_active !== undefined ? (fields.is_active ? 1 : 0) : current.is_active,
    req.params.id
  ]);
  res.json({ success: true });
});

router.delete('/qa/:id', (req, res) => {
  dbRun('DELETE FROM qa_pairs WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

router.post('/qa/test', (req, res) => {
  const { question } = req.body;
  const match = findQAMatch(question);
  if (match) {
    res.json({ match: true, ...match });
  } else {
    res.json({ match: false });
  }
});

// ============ Scheduled Posts ============
router.get('/posts', (req, res) => {
  const limit = parseIntParam(req.query.limit, 50, 1, 200);
  res.json(getScheduledPosts(limit));
});

router.post('/posts', (req, res) => {
  try {
    const { content, scheduledTime } = req.body;
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({ error: 'content is required' });
    }
    const id = schedulePost(req.body);
    res.json({ success: true, id });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Failed to schedule post: ${msg}` });
  }
});

router.delete('/posts/:id', (req, res) => {
  const id = parseIntParam(req.params.id, 0, 1);
  if (!id) return res.status(400).json({ error: 'Invalid post id' });
  deleteScheduledPost(id);
  res.json({ success: true });
});

// ============ Comment Watches ============
router.get('/comments/watches', (req, res) => {
  const rows = dbAll('SELECT * FROM comment_watches ORDER BY created_at DESC');
  res.json(rows);
});

router.post('/comments/watches', (req, res) => {
  const { fb_post_url, reply_style, max_replies } = req.body;
  // Validate required URL using proper URL parsing
  if (!fb_post_url || typeof fb_post_url !== 'string') {
    return res.status(400).json({ success: false, error: 'fb_post_url is required and must be a string' });
  }

  try {
    const urlObj = new URL(fb_post_url);
    if (!urlObj.hostname.includes('facebook.com')) {
      return res.status(400).json({ success: false, error: 'fb_post_url must be a valid Facebook URL' });
    }
  } catch {
    return res.status(400).json({ success: false, error: 'fb_post_url must be a valid URL' });
  }

  // Validate optional max_replies
  const safeMaxReplies = Math.max(1, Math.min(parseInt(String(max_replies ?? '50'), 10) || 50, 1000));
  const safeStyle = ['friendly', 'formal', 'casual', 'auto'].includes(reply_style) ? reply_style : 'friendly';
  dbRun(
    'INSERT INTO comment_watches (fb_post_url, reply_style, max_replies) VALUES (?, ?, ?)',
    [fb_post_url.substring(0, 500), safeStyle, safeMaxReplies]
  );
  const lastRow = dbGet('SELECT last_insert_rowid() as id');
  res.json({ success: true, id: lastRow?.id });
});

router.delete('/comments/watches/:id', (req, res) => {
  dbRun('DELETE FROM comment_watches WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// ============ Chat Reply (Extension API) - 3-Layer Memory ============
// ============ Chat ============
router.use(chatRoutes);

// ============ Memory & Conversations ============
router.use(memoryRoutes);

// ============ Admin & Ops ============
router.use(adminRoutes);

// ============ Dynamic Tools ============

// GET /api/dynamic-tools - list all dynamic tools
router.get('/dynamic-tools', (req, res) => {
  try {
    const tools = listDynamicTools();
    res.json({
      success: true,
      count: tools.length,
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/dynamic-tools/:name - get a specific dynamic tool
router.get('/dynamic-tools/:name', (req, res) => {
  try {
    const { name } = req.params;
    const tool = getDynamicTool(name);
    if (!tool) {
      return res.status(404).json({ success: false, error: 'Tool not found' });
    }
    res.json({
      success: true,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/dynamic-tools - create a new dynamic tool
router.post('/dynamic-tools', validateBody(createToolSchema), asyncHandler(async (req, res) => {
  const { name, description, code, parameters } = req.body;

  const result = await registerDynamicTool(name, description, code, parameters);

  if (!result.valid) {
    return res.status(400).json({
      success: false,
      errors: result.errors,
      warnings: result.warnings,
    });
  }

  res.json({
    success: true,
    message: `Tool '${name}' created successfully`,
    warnings: result.warnings,
  });
}));

// DELETE /api/dynamic-tools/:name - delete a dynamic tool
router.delete('/dynamic-tools/:name', async (req, res) => {
  try {
    const { name } = req.params;

    // Check if tool exists
    const tool = getDynamicTool(name);
    if (!tool) {
      return res.status(404).json({ success: false, error: 'Tool not found' });
    }

    const result = await unregisterDynamicTool(name);
    if (!result.success) {
      return res.status(500).json({ success: false, error: result.error });
    }

    res.json({ success: true, message: `Tool '${name}' deleted` });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/dynamic-tools/:name/test - test-run a dynamic tool
router.post('/dynamic-tools/:name/test', async (req, res) => {
  try {
    const { name } = req.params;
    const { args } = req.body;

    const tool = getDynamicTool(name);
    if (!tool) {
      return res.status(404).json({ success: false, error: 'Tool not found' });
    }

    // Execute the tool with provided arguments
    const result = await tool.handler(args || {});

    res.json({
      success: true,
      name,
      result,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/dynamic-tools/refresh - hot-reload dynamic tools from disk
router.post('/dynamic-tools/refresh', async (req, res) => {
  try {
    await refreshDynamicTools();
    const tools = listDynamicTools();
    res.json({
      success: true,
      message: 'Dynamic tools refreshed',
      count: tools.length,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ Agent Routing Config ============

/** GET /api/config - get global routing config */
router.get('/config', (req, res) => {
  try {
    const cfg = configManager.getConfig();
    const resolvedRoutes: Record<string, any> = {};
    
    // If autoRouting is on, include what the system WOULD choose right now
    for (const tt of Object.values(TaskType)) {
      const base = cfg.routes[tt];
      if (cfg.autoRouting) {
        const resolved = getBestModelForTask(tt as TaskType);
        resolvedRoutes[tt] = {
          ...base,
          resolvedProvider: resolved?.provider || base.active.provider,
          resolvedModel: resolved?.modelName || base.active.modelName
        };
      } else {
        resolvedRoutes[tt] = base;
      }
    }

    res.json({
      autoRouting: cfg.autoRouting,
      routes: resolvedRoutes
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/config - update global routing config */
router.post('/config', (req, res) => {
  try {
    configManager.updateConfig(req.body);
    agentEvents.modelUpdated({ isGlobal: true });
    res.json({ success: true, config: configManager.getConfig() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============ File Upload & Processing ============
const upload = multer({
  dest: config.uploadsDir,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
  fileFilter: (_req, file, cb) => {
    const ext = '.' + (file.originalname.split('.').pop()?.toLowerCase() || '');
    const supported = getSupportedExtensions();
    if (supported.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}. Supported: ${supported.join(', ')}`));
    }
  },
});

// POST /api/files/upload - upload and process file for AI consumption
router.post('/files/upload', upload.single('file'), asyncHandler(async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'No file provided' });
  }

  // Rename to preserve extension (multer strips it)
  const ext = '.' + (file.originalname.split('.').pop()?.toLowerCase() || 'bin');
  const newPath = file.path + ext;
  const fs = await import('fs');
  fs.renameSync(file.path, newPath);

  const processed = await processFile(newPath);
  const geminiPart = fileToGeminiPart(processed);

  res.json({
    success: true,
    file: {
      originalName: processed.originalName,
      type: processed.type,
      mimeType: processed.mimeType,
      sizeKB: processed.sizeKB,
      hasBase64: !!processed.base64,
      contentPreview: processed.content.substring(0, 500),
    },
    geminiPart: 'inlineData' in geminiPart
      ? { type: 'inlineData', mimeType: (geminiPart as any).inlineData.mimeType, dataLength: (geminiPart as any).inlineData.data.length }
      : { type: 'text', textLength: (geminiPart as any).text.length },
  });
}));

// POST /api/files/upload-multi - upload multiple files
router.post('/files/upload-multi', upload.array('files', 10), asyncHandler(async (req, res) => {
  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'No files provided' });
  }

  const fs = await import('fs');
  const results = [];

  for (const file of files) {
    const ext = '.' + (file.originalname.split('.').pop()?.toLowerCase() || 'bin');
    const newPath = file.path + ext;
    fs.renameSync(file.path, newPath);

    const processed = await processFile(newPath);
    results.push({
      originalName: processed.originalName,
      type: processed.type,
      mimeType: processed.mimeType,
      sizeKB: processed.sizeKB,
      hasBase64: !!processed.base64,
      contentPreview: processed.content.substring(0, 200),
    });
  }

  res.json({ success: true, files: results, count: results.length });
}));

// GET /api/files/supported - list supported file types
router.get('/files/supported', (_req, res) => {
  res.json({
    extensions: getSupportedExtensions(),
    maxSizeMB: 25,
    maxFiles: 10,
  });
});

// ============================================================
// Bots API Router - /api/bots/*
// ============================================================

import { Router, type Response } from 'express';
import {
  listBots,
  getBot,
  createBot,
  updateBot,
  deleteBot,
  getBotToolNames,
  setBotTools,
  getPlatformCredentialFields,
  type BotPlatform,
} from '../bot_agents/registries/botRegistry.js';
import { startBotInstance, stopBotInstance } from '../bot_agents/botManager.js';
import { configManager } from '../bot_agents/config/configManager.js';
import { TaskType, getBestModelForTask, type ModelConfig, type MultiModelConfig } from '../bot_agents/config/aiConfig.js';
import { getAgentCompatibleProvider } from '../providers/agentRuntime.js';
import { requireReadWriteAuth } from '../utils/auth.js';
import { agentEvents } from '../utils/socketBroadcast.js';
import rateLimit from 'express-rate-limit';

export interface BotConfig {
  autoRouting?: boolean;
  modelOverrides?: Record<string, any>;
  [key: string]: any;
}

const router = Router();

// General API rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this IP, please try again after 15 minutes' },
});

// Stricter rate limiting for bot toggle (resource intensive)
const toggleLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // limit each IP to 10 toggle requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many bot toggle requests, please wait a minute' },
});

router.use(apiLimiter);
router.use(requireReadWriteAuth('viewer'));

/**
 * Helper to remove sensitive credential values from bot objects.
 * Handles both single bot objects and arrays of bots.
 */
function maskBot<T>(data: T): T {
  const mask = (bot: any) => {
    if (!bot || typeof bot !== 'object') return bot;
    const safe = { ...bot };
    if (safe.credentials && typeof safe.credentials === 'object') {
      safe.credentials = Object.fromEntries(
        Object.entries(safe.credentials).map(([k, v]) => [k, v ? '********' : ''])
      );
    }
    return safe;
  };

  return Array.isArray(data) ? (data as any).map(mask) : mask(data);
}

function syncBotConfig(botId: string, config: BotConfig | null | undefined) {
  try {
    if (config && typeof config === 'object') {
      const { autoRouting, modelOverrides } = config;
      if (autoRouting !== undefined || modelOverrides !== undefined) {
        // Create a clean payload object to avoid side effects or reference sharing with the original config
        const updatePayload: { autoRouting?: boolean; routes?: Record<string, any> } = {};
        if (autoRouting !== undefined) updatePayload.autoRouting = autoRouting;
        if (modelOverrides !== undefined) {
          updatePayload.routes = { ...modelOverrides };
        }

        configManager.updateBotConfig(botId, updatePayload);
        agentEvents.modelUpdated({ botId });
      }
    }
  } catch (error) {
    console.error(`Error updating bot config for botId ${botId}:`, error);
    // Potentially re-throw or handle the error in another way,
    // depending on the desired error handling strategy.
  }
}

/**
 * Helper to get merged model config from runtime configManager and bot DB config.
 */
function getMergedModelConfig(botId: string, botConfig: BotConfig | null | undefined) {
  const botRouteCfg = configManager.getBotConfig(botId);
  const autoRouting = botRouteCfg?.autoRouting ?? botConfig?.autoRouting ?? true;
  const modelOverrides = botRouteCfg?.routes ?? botConfig?.modelOverrides ?? {};
  return { autoRouting, modelOverrides };
}

/**
 * Helper to get the effective config for a bot, merging DB stored config 
 * with runtime config from configManager.
 */
function getBotEffectiveConfig(bot: any) {
  const { autoRouting, modelOverrides } = getMergedModelConfig(bot.id, bot.config as BotConfig);
  return { autoRouting, modelOverrides };
}

/**
 * Unified error response handler.
 */
function handleError(res: Response, err: unknown, context?: string) {
  let message = 'An unexpected error occurred.';
  if (err instanceof Error) {
    message = err.message;
  }

  // Sanitize the error message to prevent XSS
  const sanitizedMessage = message.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  if (context) {
    console.error(`[BotsRouter] ${context}:`, message);
  }
  res.status(500).json({ error: sanitizedMessage });
}

/**
 * Validates if the bot ID is alphanumeric, underscore, or hyphen and within length limits.
 */
function isValidBotId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id) && id.length <= 64;
}

/**
 * GET /api/bots
 * List all bot instances. Optional filter: ?platform=telegram
 */
router.get('/', (req, res) => {
  try {
    const platform = req.query.platform as BotPlatform | undefined;
    const bots = listBots(platform);
    res.json(bots.map(maskBot));
  } catch (err: unknown) {
    handleError(res, err, 'Error listing bots');
  }
});

const platforms: BotPlatform[] = ['telegram', 'line', 'facebook', 'discord', 'custom'];
const platformCredentialFields = platforms.map(p => ({
  platform: p,
  credentialFields: getPlatformCredentialFields(p),
}));

/**
 * GET /api/bots/platforms
 * List supported platforms with their credential fields.
 */
router.get('/platforms', (_req, res) => {
  res.json(platformCredentialFields);
});

/**
 * GET /api/bots/:id
 * Get a single bot (credentials masked).
 */
router.get('/:id', (req, res) => {
  try {
    const bot = getBot(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    res.json(maskBot(bot));
  } catch (err: unknown) {
    handleError(res, err, `Error getting bot ${req.params.id}`);
  }
});

/**
 * POST /api/bots
 * Create a new bot instance.
 * Body: { id, name, platform, credentials?, persona_id?, enabled_tools?, config? }
 */
router.post('/', (req, res) => {
  try {
    const { id, name, platform, credentials, persona_id, enabled_tools, config } = req.body;
    if (!id || !name || !platform) {
      return res.status(400).json({ error: 'id, name, and platform are required' });
    }
    const existing = getBot(id);
    if (existing) {
      return res.status(409).json({ error: 'Bot with this ID already exists' });
    }
    const bot = createBot({ id, name, platform, credentials, persona_id, enabled_tools, config });
    res.status(201).json(bot);
  } catch (err: unknown) {
    handleError(res, err);
  }
});

/**
 * PUT /api/bots/:id
 * Update a bot instance (partial update).
 */
router.put('/:id', (req, res) => {
  try {
    const updates = req.body;
    const bot = updateBot(req.params.id, updates);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    syncBotConfig(bot.id, updates.config);

    res.json(bot);
  } catch (err: unknown) {
    handleError(res, err);
  }
});

/**
 * DELETE /api/bots/:id
 * Delete a bot instance (stops the running bot first).
 */
router.delete('/:id', (req, res) => {
  try {
    // Stop the running bot process before deleting from DB
    stopBotInstance(req.params.id);
    const ok = deleteBot(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Bot not found' });
    res.json({ success: true });
  } catch (err: unknown) {
    handleError(res, err);
  }
});

/**
 * POST /api/bots/:id/toggle
 * Toggle bot: if active -> stop, if stopped -> start.
 * Actually starts/stops the bot process, not just DB status.
 */
router.post('/:id/toggle', toggleLimiter, (req, res) => {
  try {
    const bot = getBot(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    if (bot.status === 'active') {
      // Stop the running bot
      const updated = stopBotInstance(bot.id);
      res.json(updated);
    } else {
      // Start the bot (uses Express app reference from request)
      const updated = startBotInstance(req.app, bot.id);
      if (!updated) {
        return res.status(500).json({ error: 'Failed to start bot - check server logs' });
      }
      res.json(updated);
    }
  } catch (err: unknown) {
    handleError(res, err);
  }
});

/**
 * GET /api/bots/:id/tools
 * Get enabled tools for a bot.
 */
router.get('/:id/tools', (req, res) => {
  try {
    const tools = getBotToolNames(req.params.id);
    res.json(tools);
  } catch (err: unknown) {
    handleError(res, err);
  }
});

/**
 * PUT /api/bots/:id/tools
 * Set enabled tools for a bot.
 * Body: { tools: ["tool_name_1", "tool_name_2"] }
 */
router.put('/:id/tools', (req, res) => {
  try {
    const { tools } = req.body;
    if (!Array.isArray(tools)) return res.status(400).json({ error: 'tools must be an array' });
    setBotTools(req.params.id, tools);
    res.json({ success: true, tools });
  } catch (err: unknown) {
    handleError(res, err);
  }
});

/**
 * GET /api/bots/:id/models
 * Get current model config for a bot (per-bot overrides + global defaults).
 */
router.get('/:id/models', (req, res) => {
  try {
    const bot = getBot(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const globalConfig = configManager.getConfig();
    const { autoRouting, modelOverrides } = getMergedModelConfig(bot.id, bot.config as BotConfig);

    // Build merged config showing source
    const modelConfig: Record<string, { active: ModelConfig; fallbacks?: ModelConfig[]; source: string; resolvedProvider?: string; resolvedModel?: string }> = {};
    for (const tt of Object.values(TaskType)) {
      let entry: { active: ModelConfig; fallbacks?: ModelConfig[]; source: string };
      if (modelOverrides[tt]?.active) {
        entry = { ...modelOverrides[tt], source: 'bot-override' };
      } else if (globalConfig.routes[tt]) {
        entry = { ...globalConfig.routes[tt], source: 'global' };
      } else {
        continue;
      }

      if (autoRouting) {
        // Resolve what the system would pick
        const resolved = getBestModelForTask(tt as TaskType);
        modelConfig[tt] = {
          ...entry,
          resolvedProvider: resolved?.provider || entry.active.provider,
          resolvedModel: resolved?.modelName || entry.active.modelName
        };
      } else {
        modelConfig[tt] = entry;
      }
    }

    res.json({
      botId: bot.id,
      botName: bot.name,
      autoRouting,
      modelConfig,
    });
  } catch (err: unknown) {
    handleError(res, err);
  }
});

/**
 * PUT /api/bots/:id/models
 * Set per-bot model override for a specific task type or toggle autoRouting.
 */
router.put('/:id/models', (req, res) => {
  try {
    const { id } = req.params;
    const { taskType, provider, modelName, autoRouting } = req.body;

    const config: BotConfig = {};
    if (autoRouting !== undefined) config.autoRouting = !!autoRouting;

    if (taskType) {
      if (!Object.values(TaskType).includes(taskType as TaskType)) {
        return res.status(400).json({ error: `Invalid taskType: ${taskType}` });
      }

      const overrides: Record<string, any> = {};
      if (provider) {
        const pDef = getAgentCompatibleProvider(provider);
        if (!pDef) return res.status(400).json({ error: `Unsupported provider: ${provider}` });
        
        const resolvedModelName = (modelName || pDef.defaultModel || '').trim();
        if (!resolvedModelName) {
          return res.status(400).json({ error: 'modelName is required (no default found for provider)' });
        }
        overrides[taskType] = { provider: pDef.id, modelName: resolvedModelName };
      } else {
        // Signal removal of override
        overrides[taskType] = null;
      }
      config.modelOverrides = overrides;
    }

    const updated = updateBot(id, { config });
    if (!updated) return res.status(404).json({ error: 'Bot not found' });

    syncBotConfig(id, config);
    res.json({ success: true, bot: updated });
  } catch (err: unknown) {
    handleError(res, err);
  }
});

export default router;

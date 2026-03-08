// ============================================================
// Bots API Router — /api/bots/*
// ============================================================

import { Router } from 'express';
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
import { TaskType } from '../bot_agents/config/aiConfig.js';

const router = Router();

/**
 * GET /api/bots
 * List all bot instances. Optional filter: ?platform=telegram
 */
router.get('/', (req, res) => {
  try {
    const platform = req.query.platform as BotPlatform | undefined;
    const bots = listBots(platform);
    // Mask credentials in response
    const safe = bots.map(b => ({
      ...b,
      credentials: Object.fromEntries(
        Object.entries(b.credentials).map(([k, v]) => [k, v ? '••••' + v.slice(-4) : ''])
      ),
    }));
    res.json(safe);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/bots/platforms
 * List supported platforms with their credential fields.
 */
router.get('/platforms', (_req, res) => {
  const platforms: BotPlatform[] = ['telegram', 'line', 'facebook', 'discord', 'custom'];
  const result = platforms.map(p => ({
    platform: p,
    credentialFields: getPlatformCredentialFields(p),
  }));
  res.json(result);
});

/**
 * GET /api/bots/:id
 * Get a single bot (credentials masked).
 */
router.get('/:id', (req, res) => {
  try {
    const bot = getBot(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    const safe = {
      ...bot,
      credentials: Object.fromEntries(
        Object.entries(bot.credentials).map(([k, v]) => [k, v ? '••••' + v.slice(-4) : ''])
      ),
    };
    res.json(safe);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/bots/:id
 * Update a bot instance (partial update).
 */
router.put('/:id', (req, res) => {
  try {
    const bot = updateBot(req.params.id, req.body);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    res.json(bot);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/bots/:id/toggle
 * Toggle bot: if active → stop, if stopped → start.
 * Actually starts/stops the bot process, not just DB status.
 */
router.post('/:id/toggle', (req, res) => {
  try {
    const bot = getBot(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    if (bot.status === 'active') {
      // Stop the running bot
      stopBotInstance(bot.id);
      const updated = getBot(bot.id);
      res.json(updated);
    } else {
      // Start the bot (uses stored Express app reference)
      const started = startBotInstance(null, bot.id);
      if (!started) {
        return res.status(500).json({ error: 'Failed to start bot — check server logs' });
      }
      const updated = getBot(bot.id);
      res.json(updated);
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
    const botOverrides = (bot.config as any)?.modelOverrides ?? {};

    // Build merged config showing source
    const modelConfig: Record<string, { provider: string; modelName: string; source: string }> = {};
    for (const tt of Object.values(TaskType)) {
      if (botOverrides[tt]?.provider && botOverrides[tt]?.modelName) {
        modelConfig[tt] = { ...botOverrides[tt], source: 'bot-override' };
      } else if (globalConfig[tt]) {
        modelConfig[tt] = { ...globalConfig[tt], source: 'global' };
      }
    }

    res.json({
      botId: bot.id,
      botName: bot.name,
      modelConfig,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/bots/:id/models
 * Set per-bot model override for a specific task type.
 * Body: { taskType: string, provider: string, modelName: string }
 * Send { taskType, provider: null } to remove override (revert to global).
 */
router.put('/:id/models', (req, res) => {
  try {
    const bot = getBot(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const { taskType, provider, modelName } = req.body;
    if (!taskType) return res.status(400).json({ error: 'taskType is required' });

    // Validate task type
    if (!Object.values(TaskType).includes(taskType as TaskType)) {
      return res.status(400).json({ error: `Invalid taskType. Must be one of: ${Object.values(TaskType).join(', ')}` });
    }

    const currentConfig = (bot.config ?? {}) as Record<string, unknown>;
    const modelOverrides = (currentConfig.modelOverrides ?? {}) as Record<string, any>;

    if (provider === null || provider === undefined) {
      // Remove override — revert to global
      delete modelOverrides[taskType];
    } else {
      if (!modelName) return res.status(400).json({ error: 'modelName is required when setting a provider' });
      if (!['gemini', 'openai', 'minimax'].includes(provider)) {
        return res.status(400).json({ error: 'provider must be: gemini, openai, or minimax' });
      }
      modelOverrides[taskType] = { provider, modelName };
    }

    currentConfig.modelOverrides = modelOverrides;
    const updated = updateBot(req.params.id, { config: currentConfig });
    res.json({ success: true, bot: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

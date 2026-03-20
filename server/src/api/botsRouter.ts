// ============================================================
// Bots API Router - /api/bots/*
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
import { TaskType, getBestModelForTask, type ModelConfig, type MultiModelConfig } from '../bot_agents/config/aiConfig.js';
import { getAgentCompatibleProvider } from '../providers/agentRuntime.js';
import { requireReadWriteAuth } from '../utils/auth.js';
import { agentEvents } from '../utils/socketBroadcast.js';

export interface BotConfig {
  autoRouting?: boolean;
  modelOverrides?: Record<string, any>;
  [key: string]: any;
}

const router = Router();
router.use(requireReadWriteAuth('viewer'));

function syncBotConfig(botId: string, config: any) {
  if (config && typeof config === 'object') {
    if (config.modelOverrides || config.autoRouting !== undefined) {
      configManager.updateBotConfig(botId, {
        autoRouting: config.autoRouting,
        routes: config.modelOverrides
      });
      agentEvents.modelUpdated({ botId });
    }
  }
}

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
        Object.entries(b.credentials).map(([k, v]) => [k, v ? '********' : ''])
      ),
    }));
    res.json(safe);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
    res.status(500).json({ error: message });
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
        Object.entries(bot.credentials).map(([k, v]) => [k, v ? '********' : ''])
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
    const updates = req.body;
    const bot = updateBot(req.params.id, updates);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    syncBotConfig(bot.id, updates.config);

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
 * Toggle bot: if active -> stop, if stopped -> start.
 * Actually starts/stops the bot process, not just DB status.
 */
router.post('/:id/toggle', (req, res) => {
  try {
    const bot = getBot(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    if (bot.status === 'active') {
      // Stop the running bot
      const updated = stopBotInstance(bot.id);
      res.json(updated);
    } else {
      // Start the bot (uses stored Express app reference)
      const updated = startBotInstance(null, bot.id);
      if (!updated) {
        return res.status(500).json({ error: 'Failed to start bot - check server logs' });
      }
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
    const botRouteCfg = configManager.getBotConfig(req.params.id);
    const botOverrides = botRouteCfg?.routes ?? (bot.config as any)?.modelOverrides ?? {};
    const autoRouting = botRouteCfg?.autoRouting ?? (bot.config as any)?.autoRouting ?? true;

    // Build merged config showing source
    const modelConfig: Record<string, { active: ModelConfig; fallbacks?: ModelConfig[]; source: string; resolvedProvider?: string; resolvedModel?: string }> = {};
    for (const tt of Object.values(TaskType)) {
      let entry: { active: ModelConfig; fallbacks?: ModelConfig[]; source: string };
      if (botOverrides[tt]?.active) {
        entry = { ...botOverrides[tt], source: 'bot-override' };
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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/bots/:id/models
 * Set per-bot model override for a specific task type or toggle autoRouting.
 * Body: { taskType?: string, provider?: string, modelName?: string, autoRouting?: boolean }
 */
router.put('/:id/models', (req, res) => {
  try {
    const bot = getBot(req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const { taskType, provider, modelName, autoRouting } = req.body;
    const currentConfig = (bot.config ?? {}) as Record<string, any>;

    if (autoRouting !== undefined) {
      currentConfig.autoRouting = !!autoRouting;
    }

    if (taskType) {
      // Validate task type
      if (!Object.values(TaskType).includes(taskType as TaskType)) {
        return res.status(400).json({ error: `Invalid taskType. Must be one of: ${Object.values(TaskType).join(', ')}` });
      }

      const modelOverrides = (currentConfig.modelOverrides ?? {}) as Record<string, any>;

      if (provider === null || provider === '') {
        // Remove override - revert to global
        delete modelOverrides[taskType];
      } else if (provider) {
        const providerDef = getAgentCompatibleProvider(provider);
        if (!providerDef) {
          return res.status(400).json({ error: `provider "${provider}" is not supported for AI agent routing` });
        }

        const resolvedModelName = (modelName || providerDef.defaultModel || '').trim();
        if (!resolvedModelName) {
          return res.status(400).json({ error: 'modelName is required when setting a provider without a default model' });
        }

        modelOverrides[taskType] = { provider: providerDef.id, modelName: resolvedModelName };
      }
      currentConfig.modelOverrides = modelOverrides;
    }

    const updates: Record<string, any> = { config: currentConfig };

    const updated = updateBot(req.params.id, updates);
    syncBotConfig(bot.id, updates.config);
    res.json({ success: true, bot: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

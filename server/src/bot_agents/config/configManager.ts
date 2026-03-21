import * as fs from 'fs';
import * as path from 'path';
import { TaskType, ModelConfig, MultiModelConfig, modelRouting as defaultMultiConfig } from './aiConfig.js';
import { getAgentCompatibleProvider, getAgentProviderDefaultModel } from '../../providers/agentRuntime.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('ConfigManager');
const CONFIG_PATH = path.join(process.cwd(), 'ai_routing_config.json');

// Cost-optimized model routing:
// flash-lite: ถูกสุด เร็วสุด — ทักทาย, system commands, งานง่าย
// flash:      ปานกลาง — ค้นหาเว็บ, วิเคราะห์ภาพ
// 2.5-flash:  ฉลาดสุด — โค้ด, วิเคราะห์ลึก, คิดเชิงตรรกะ
const defaultConfig: Record<TaskType, ModelConfig> = {
  [TaskType.GENERAL]:     { provider: 'gemini', modelName: 'gemini-2.0-flash-lite' },
  [TaskType.COMPLEX]:     { provider: 'gemini', modelName: 'gemini-2.5-flash' },
  [TaskType.VISION]:      { provider: 'gemini', modelName: 'gemini-2.0-flash' },
  [TaskType.WEB_BROWSER]: { provider: 'gemini', modelName: 'gemini-2.0-flash' },
  [TaskType.THINKING]:    { provider: 'gemini', modelName: 'gemini-2.5-flash' },
  [TaskType.CODE]:        { provider: 'gemini', modelName: 'gemini-2.5-flash' },
  [TaskType.DATA]:        { provider: 'gemini', modelName: 'gemini-2.5-flash' },
  [TaskType.SYSTEM]:      { provider: 'gemini', modelName: 'gemini-2.0-flash-lite' },
};

export interface BotRoutingConfig {
  autoRouting: boolean;
  routes: Record<TaskType, MultiModelConfig>;
}

export interface SystemRoutingConfig {
  autoRouting: boolean;
  routes: Record<TaskType, MultiModelConfig>;
  botOverrides: Record<string, BotRoutingConfig>;
}

export class ConfigManager {
  private currentConfig: SystemRoutingConfig;

  constructor() {
    this.currentConfig = this.loadConfig();
  }

  private loadConfig(): SystemRoutingConfig {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        const isNewFormat = raw && typeof raw === 'object' && 'routes' in raw;
        const configRoutes = isNewFormat ? raw.routes : raw;
        const autoRouting = isNewFormat ? !!raw.autoRouting : true;
        const botOverrides: Record<string, BotRoutingConfig> = {};

        if (isNewFormat && raw.botOverrides && typeof raw.botOverrides === 'object') {
          for (const [botId, botCfg] of Object.entries(raw.botOverrides)) {
            if (botCfg && typeof botCfg === 'object') {
              const bCfg = botCfg as any;
              const validatedBotRoutes = { ...defaultMultiConfig };
              const inputBotRoutes = bCfg.routes || {};
              
              for (const key of Object.values(TaskType)) {
                const normalized = this.normalizeMultiModelConfig(inputBotRoutes[key]);
                if (normalized) {
                  validatedBotRoutes[key] = normalized;
                }
              }

              botOverrides[botId] = {
                autoRouting: !!bCfg.autoRouting,
                routes: validatedBotRoutes
              };
            }
          }
        }

        // Validate global: ensure all required task types are present
        const validated = { ...defaultMultiConfig };
        for (const key of Object.values(TaskType)) {
          const normalized = this.normalizeMultiModelConfig(configRoutes[key]);
          if (normalized) {
            validated[key] = normalized;
          }
        }
        return { autoRouting, routes: validated, botOverrides };
      }
    } catch (err) {
      logger.error('Failed to load config, using defaults:', err);
    }
    // Save defaults if config doesn't exist or is invalid
    const def: SystemRoutingConfig = { 
      autoRouting: true, 
      routes: { ...defaultMultiConfig },
      botOverrides: {}
    };
    this.saveConfig(def);
    return def;
  }

  public getConfig(): SystemRoutingConfig {
    return this.currentConfig;
  }

  public updateConfig(newConfig: Partial<SystemRoutingConfig> | Record<TaskType, MultiModelConfig>) {
    // Determine if input is v1 (just routes) or v2 (SystemRoutingConfig)
    const isNewFormat = newConfig && typeof newConfig === 'object' && ('routes' in newConfig || 'autoRouting' in newConfig || 'botOverrides' in newConfig);
    const inputRoutes = isNewFormat ? (newConfig as SystemRoutingConfig).routes : (newConfig as Record<TaskType, MultiModelConfig>);
    const inputAuto = isNewFormat && 'autoRouting' in newConfig ? !!(newConfig as SystemRoutingConfig).autoRouting : this.currentConfig.autoRouting;
    const inputBotOverrides = isNewFormat && 'botOverrides' in newConfig ? (newConfig as SystemRoutingConfig).botOverrides : this.currentConfig.botOverrides;

    // Validate global routes before saving
    const validatedRoutes = { ...this.currentConfig.routes };
    if (inputRoutes) {
      for (const key of Object.values(TaskType)) {
        const normalized = this.normalizeMultiModelConfig(inputRoutes[key]);
        if (normalized) {
          validatedRoutes[key] = normalized;
        }
      }
    }

    const nextConfig: SystemRoutingConfig = {
      autoRouting: inputAuto,
      routes: validatedRoutes,
      botOverrides: inputBotOverrides || {}
    };

    this.currentConfig = nextConfig;
    this.saveConfig(nextConfig);
  }

  public getBotConfig(botId: string): BotRoutingConfig | null {
    return this.currentConfig.botOverrides?.[botId] || null;
  }

  public updateBotConfig(botId: string, updates: Partial<BotRoutingConfig>) {
    const existing = this.currentConfig.botOverrides?.[botId] || {
      autoRouting: true,
      routes: { ...defaultMultiConfig }
    };

    const nextRoutes = { ...existing.routes };
    if (updates.routes) {
      for (const key of Object.values(TaskType)) {
        const normalized = this.normalizeMultiModelConfig(updates.routes[key]);
        if (normalized) {
          nextRoutes[key as TaskType] = normalized;
        }
      }
    }

    const nextBotConfig: BotRoutingConfig = {
      autoRouting: updates.autoRouting !== undefined ? updates.autoRouting : existing.autoRouting,
      routes: nextRoutes
    };

    const nextOverrides = { ...this.currentConfig.botOverrides };
    nextOverrides[botId] = nextBotConfig;

    this.updateConfig({ botOverrides: nextOverrides });
  }

  /**
   * Promotes a fallback model to 'active' if it succeeded while the old active failed.
   * Swaps the successful fallback with the current active.
   */
  public updateActiveModel(taskType: TaskType, successfulModel: ModelConfig, botId?: string) {
    const isBot = !!botId && this.currentConfig.botOverrides?.[botId];
    const baseRoutes = isBot 
      ? this.currentConfig.botOverrides[botId!].routes 
      : this.currentConfig.routes;
    
    const route = baseRoutes[taskType];
    if (!route || (route.active.provider === successfulModel.provider && route.active.modelName === successfulModel.modelName)) {
      return; // Already active or route missing
    }

    // New fallbacks: Remove the successful one, add the old active to the list
    const fallbacks = route.fallbacks || [];
    const oldActive = { ...route.active };
    const newFallbacks = fallbacks.filter(f => 
      !(f.provider === successfulModel.provider && f.modelName === successfulModel.modelName)
    );
    newFallbacks.unshift(oldActive);

    const newMultiConfig: MultiModelConfig = {
      active: successfulModel,
      fallbacks: newFallbacks
    };

    if (isBot) {
      this.updateBotConfig(botId!, {
        routes: { ...baseRoutes, [taskType]: newMultiConfig }
      });
    } else {
      const nextRoutes = { ...this.currentConfig.routes, [taskType]: newMultiConfig };
      this.updateConfig({ routes: nextRoutes });
    }
    
    logger.info(`Promoted ${successfulModel.provider}/${successfulModel.modelName} to active for ${taskType}${botId ? ` (Bot: ${botId})` : ''}`);
  }

  public removeBotConfig(botId: string) {
    if (!this.currentConfig.botOverrides?.[botId]) return;
    const nextOverrides = { ...this.currentConfig.botOverrides };
    delete nextOverrides[botId];
    this.updateConfig({ botOverrides: nextOverrides });
  }

  private normalizeMultiModelConfig(value: unknown): MultiModelConfig | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as any;

    let active: ModelConfig | null = null;
    let fallbacks: ModelConfig[] = [];

    // Support migration from single ModelConfig to MultiModelConfig
    if (v.provider && v.modelName) {
      active = this.normalizeConfigEntry(v);
    } else if (v.active) {
      active = this.normalizeConfigEntry(v.active);
      if (Array.isArray(v.fallbacks)) {
        fallbacks = v.fallbacks
          .map((f: any) => this.normalizeConfigEntry(f))
          .filter((f: any): f is ModelConfig => !!f);
      }
    }

    if (!active) return null;
    return { active, fallbacks };
  }

  private normalizeConfigEntry(value: unknown): ModelConfig | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const provider = String((value as any).provider || '').trim();
    const modelName = String((value as any).modelName || '').trim();

    if (!provider || !getAgentCompatibleProvider(provider)) {
      return null;
    }

    const resolvedModel = modelName || getAgentProviderDefaultModel(provider);
    if (!resolvedModel) {
      return null;
    }

    return { provider, modelName: resolvedModel };
  }

  private saveConfig(config: SystemRoutingConfig) {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (err) {
      logger.error('Failed to save config:', err);
    }
  }
}

export const configManager = new ConfigManager();

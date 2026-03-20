import * as fs from 'fs';
import * as path from 'path';
import { TaskType, modelRouting as defaultMultiConfig } from './aiConfig.js';
import { getAgentCompatibleProvider, getAgentProviderDefaultModel } from '../../providers/agentRuntime.js';
const CONFIG_PATH = path.join(process.cwd(), 'ai_routing_config.json');
// Cost-optimized model routing:
// flash-lite: ถูกสุด เร็วสุด — ทักทาย, system commands, งานง่าย
// flash:      ปานกลาง — ค้นหาเว็บ, วิเคราะห์ภาพ
// 2.5-flash:  ฉลาดสุด — โค้ด, วิเคราะห์ลึก, คิดเชิงตรรกะ
const defaultConfig = {
    [TaskType.GENERAL]: { provider: 'gemini', modelName: 'gemini-2.0-flash-lite' },
    [TaskType.COMPLEX]: { provider: 'gemini', modelName: 'gemini-2.5-flash' },
    [TaskType.VISION]: { provider: 'gemini', modelName: 'gemini-2.0-flash' },
    [TaskType.WEB_BROWSER]: { provider: 'gemini', modelName: 'gemini-2.0-flash' },
    [TaskType.THINKING]: { provider: 'gemini', modelName: 'gemini-2.5-flash' },
    [TaskType.CODE]: { provider: 'gemini', modelName: 'gemini-2.5-flash' },
    [TaskType.DATA]: { provider: 'gemini', modelName: 'gemini-2.5-flash' },
    [TaskType.SYSTEM]: { provider: 'gemini', modelName: 'gemini-2.0-flash-lite' },
};
export class ConfigManager {
    currentConfig;
    constructor() {
        this.currentConfig = this.loadConfig();
    }
    loadConfig() {
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
                const isNewFormat = raw && typeof raw === 'object' && 'routes' in raw;
                const configRoutes = isNewFormat ? raw.routes : raw;
                const autoRouting = isNewFormat ? !!raw.autoRouting : true;
                const botOverrides = {};
                if (isNewFormat && raw.botOverrides && typeof raw.botOverrides === 'object') {
                    for (const [botId, botCfg] of Object.entries(raw.botOverrides)) {
                        if (botCfg && typeof botCfg === 'object') {
                            const bCfg = botCfg;
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
        }
        catch (err) {
            console.error('[ConfigManager] Failed to load config, using defaults:', err);
        }
        // Save defaults if config doesn't exist or is invalid
        const def = {
            autoRouting: true,
            routes: { ...defaultMultiConfig },
            botOverrides: {}
        };
        this.saveConfig(def);
        return def;
    }
    getConfig() {
        return this.currentConfig;
    }
    updateConfig(newConfig) {
        // Determine if input is v1 (just routes) or v2 (SystemRoutingConfig)
        const isNewFormat = newConfig && typeof newConfig === 'object' && ('routes' in newConfig || 'autoRouting' in newConfig || 'botOverrides' in newConfig);
        const inputRoutes = isNewFormat ? newConfig.routes : newConfig;
        const inputAuto = isNewFormat && 'autoRouting' in newConfig ? !!newConfig.autoRouting : this.currentConfig.autoRouting;
        const inputBotOverrides = isNewFormat && 'botOverrides' in newConfig ? newConfig.botOverrides : this.currentConfig.botOverrides;
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
        const nextConfig = {
            autoRouting: inputAuto,
            routes: validatedRoutes,
            botOverrides: inputBotOverrides || {}
        };
        this.currentConfig = nextConfig;
        this.saveConfig(nextConfig);
    }
    getBotConfig(botId) {
        return this.currentConfig.botOverrides?.[botId] || null;
    }
    updateBotConfig(botId, updates) {
        const existing = this.currentConfig.botOverrides?.[botId] || {
            autoRouting: true,
            routes: { ...defaultMultiConfig }
        };
        const nextRoutes = { ...existing.routes };
        if (updates.routes) {
            for (const key of Object.values(TaskType)) {
                const normalized = this.normalizeMultiModelConfig(updates.routes[key]);
                if (normalized) {
                    nextRoutes[key] = normalized;
                }
            }
        }
        const nextBotConfig = {
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
    updateActiveModel(taskType, successfulModel, botId) {
        const isBot = !!botId && this.currentConfig.botOverrides?.[botId];
        const baseRoutes = isBot
            ? this.currentConfig.botOverrides[botId].routes
            : this.currentConfig.routes;
        const route = baseRoutes[taskType];
        if (!route || (route.active.provider === successfulModel.provider && route.active.modelName === successfulModel.modelName)) {
            return; // Already active or route missing
        }
        // New fallbacks: Remove the successful one, add the old active to the list
        const fallbacks = route.fallbacks || [];
        const oldActive = { ...route.active };
        const newFallbacks = fallbacks.filter(f => !(f.provider === successfulModel.provider && f.modelName === successfulModel.modelName));
        newFallbacks.unshift(oldActive);
        const newMultiConfig = {
            active: successfulModel,
            fallbacks: newFallbacks
        };
        if (isBot) {
            this.updateBotConfig(botId, {
                routes: { ...baseRoutes, [taskType]: newMultiConfig }
            });
        }
        else {
            const nextRoutes = { ...this.currentConfig.routes, [taskType]: newMultiConfig };
            this.updateConfig({ routes: nextRoutes });
        }
        console.log(`[ConfigManager] Promoted ${successfulModel.provider}/${successfulModel.modelName} to active for ${taskType}${botId ? ` (Bot: ${botId})` : ''}`);
    }
    removeBotConfig(botId) {
        if (!this.currentConfig.botOverrides?.[botId])
            return;
        const nextOverrides = { ...this.currentConfig.botOverrides };
        delete nextOverrides[botId];
        this.updateConfig({ botOverrides: nextOverrides });
    }
    normalizeMultiModelConfig(value) {
        if (!value || typeof value !== 'object')
            return null;
        const v = value;
        let active = null;
        let fallbacks = [];
        // Support migration from single ModelConfig to MultiModelConfig
        if (v.provider && v.modelName) {
            active = this.normalizeConfigEntry(v);
        }
        else if (v.active) {
            active = this.normalizeConfigEntry(v.active);
            if (Array.isArray(v.fallbacks)) {
                fallbacks = v.fallbacks
                    .map((f) => this.normalizeConfigEntry(f))
                    .filter((f) => !!f);
            }
        }
        if (!active)
            return null;
        return { active, fallbacks };
    }
    normalizeConfigEntry(value) {
        if (!value || typeof value !== 'object') {
            return null;
        }
        const provider = String(value.provider || '').trim();
        const modelName = String(value.modelName || '').trim();
        if (!provider || !getAgentCompatibleProvider(provider)) {
            return null;
        }
        const resolvedModel = modelName || getAgentProviderDefaultModel(provider);
        if (!resolvedModel) {
            return null;
        }
        return { provider, modelName: resolvedModel };
    }
    saveConfig(config) {
        try {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
        }
        catch (err) {
            console.error('[ConfigManager] Failed to save config:', err);
        }
    }
}
export const configManager = new ConfigManager();
//# sourceMappingURL=configManager.js.map
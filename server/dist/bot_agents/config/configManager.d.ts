import { TaskType, ModelConfig, MultiModelConfig } from './aiConfig.js';
export interface BotRoutingConfig {
    autoRouting: boolean;
    routes: Record<TaskType, MultiModelConfig>;
}
export interface SystemRoutingConfig {
    autoRouting: boolean;
    routes: Record<TaskType, MultiModelConfig>;
    botOverrides: Record<string, BotRoutingConfig>;
}
export declare class ConfigManager {
    private currentConfig;
    constructor();
    private loadConfig;
    getConfig(): SystemRoutingConfig;
    updateConfig(newConfig: Partial<SystemRoutingConfig> | Record<TaskType, MultiModelConfig>): void;
    getBotConfig(botId: string): BotRoutingConfig | null;
    updateBotConfig(botId: string, updates: Partial<BotRoutingConfig>): void;
    /**
     * Promotes a fallback model to 'active' if it succeeded while the old active failed.
     * Swaps the successful fallback with the current active.
     */
    updateActiveModel(taskType: TaskType, successfulModel: ModelConfig, botId?: string): void;
    removeBotConfig(botId: string): void;
    private normalizeMultiModelConfig;
    private normalizeConfigEntry;
    private saveConfig;
}
export declare const configManager: ConfigManager;

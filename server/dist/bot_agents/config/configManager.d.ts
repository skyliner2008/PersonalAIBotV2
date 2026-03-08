import { TaskType, ModelConfig } from './aiConfig';
export declare class ConfigManager {
    private currentConfig;
    constructor();
    private loadConfig;
    getConfig(): Record<TaskType, ModelConfig>;
    updateConfig(newConfig: Record<TaskType, ModelConfig>): void;
    private saveConfig;
}
export declare const configManager: ConfigManager;

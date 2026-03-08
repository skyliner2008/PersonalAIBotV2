import * as fs from 'fs';
import * as path from 'path';
import { TaskType } from './aiConfig';
const CONFIG_PATH = path.join(process.cwd(), 'ai_routing_config.json');
// ค่าเริ่มต้น
const defaultConfig = {
    [TaskType.GENERAL]: { provider: 'gemini', modelName: 'gemini-2.0-flash' },
    [TaskType.COMPLEX]: { provider: 'gemini', modelName: 'gemini-2.5-flash' },
    [TaskType.VISION]: { provider: 'gemini', modelName: 'gemini-2.0-flash' },
    [TaskType.WEB_BROWSER]: { provider: 'gemini', modelName: 'gemini-2.0-flash' },
    [TaskType.THINKING]: { provider: 'gemini', modelName: 'gemini-2.5-flash' }
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
                // Validate: ensure all required task types are present
                const validated = { ...defaultConfig };
                for (const key of Object.values(TaskType)) {
                    if (raw[key] && raw[key].provider && raw[key].modelName) {
                        validated[key] = raw[key];
                    }
                }
                return validated;
            }
        }
        catch (err) {
            console.error('[ConfigManager] Failed to load config, using defaults:', err);
        }
        // Save defaults if config doesn't exist or is invalid
        this.saveConfig(defaultConfig);
        return { ...defaultConfig };
    }
    getConfig() {
        return this.currentConfig;
    }
    updateConfig(newConfig) {
        // Validate before saving
        const validated = { ...this.currentConfig };
        for (const key of Object.values(TaskType)) {
            if (newConfig[key] && newConfig[key].provider && newConfig[key].modelName) {
                validated[key] = newConfig[key];
            }
        }
        this.currentConfig = validated;
        this.saveConfig(validated);
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
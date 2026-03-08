import * as fs from 'fs';
import * as path from 'path';
import { TaskType, ModelConfig } from './aiConfig';

const CONFIG_PATH = path.join(process.cwd(), 'ai_routing_config.json');

// ค่าเริ่มต้น — ครอบคลุม TaskType ทั้งหมดที่มีอยู่
const defaultConfig: Record<string, ModelConfig> = {
  [TaskType.GENERAL]:  { provider: 'gemini',  modelName: 'gemini-2.0-flash-lite' },
  [TaskType.COMPLEX]:  { provider: 'minimax', modelName: 'MiniMax-M2.5' },
  [TaskType.VISION]:   { provider: 'gemini',  modelName: 'gemini-2.0-flash' },
  [TaskType.WEB]:      { provider: 'gemini',  modelName: 'gemini-2.0-flash' },
  [TaskType.THINKING]: { provider: 'gemini',  modelName: 'gemini-2.5-pro-exp-03-25' },
  [TaskType.CODE]:     { provider: 'gemini',  modelName: 'gemini-2.0-flash' },
  [TaskType.DATA]:     { provider: 'gemini',  modelName: 'gemini-2.0-flash' },
};

export class ConfigManager {
  private currentConfig: Record<string, ModelConfig>;

  constructor() {
    if (fs.existsSync(CONFIG_PATH)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Record<string, ModelConfig>;
        // Merge loaded config กับ default (เพิ่ม keys ใหม่ที่ยังไม่มีในไฟล์เก่า)
        this.currentConfig = { ...defaultConfig, ...loaded };
      } catch (_) {
        this.currentConfig = { ...defaultConfig };
      }
    } else {
      this.currentConfig = { ...defaultConfig };
      this.save();
    }
  }

  public getConfig(): Record<string, ModelConfig> {
    return this.currentConfig;
  }

  public updateConfig(newConfig: Record<string, ModelConfig>) {
    this.currentConfig = { ...defaultConfig, ...newConfig };
    this.save();
  }

  private save() {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.currentConfig, null, 2));
    } catch (err) {
      console.error('[ConfigManager] Failed to save config:', err);
    }
  }
}

export const configManager = new ConfigManager();

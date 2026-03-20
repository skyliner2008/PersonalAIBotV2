import fs from 'fs';
const TOOL_REGEX = /^(?!#|\/\/)\s*([\w-]+)/gm;
import path from 'path';

export type PlatformType = 'fb-extension' | 'line' | 'telegram' | 'facebook' | 'discord' | 'custom' | 'system';

export const PLATFORMS: PlatformType[] = ['fb-extension', 'line', 'telegram', 'facebook', 'discord', 'custom', 'system'];

export interface PersonaConfig {
  systemInstruction: string;
  enabledTools: string[];
}

/** Raw file content for each platform — used by the API/Dashboard */
export interface BotPersonaFiles {
  platform: PlatformType;
  agents: string;
  identity: string;
  soul: string;
  tools: string;
}

// Default content per file
const DEFAULTS: Record<string, string> = {
  'AGENTS.md': `# Role\nคุณคือผู้ช่วย AI ส่วนตัว (Personal AI Assistant)\n\n# Goal\nเป้าหมายของคุณคือการช่วยเหลือผู้ใช้งานอย่างเต็มที่และถูกต้องที่สุด\n`,
  'IDENTITY.md': `# Speaking Style\n- ตอบสั้นๆ กระชับ ได้ใจความ\n- ห้ามใช้อีโมจิเด็ดขาด\n- ใช้ภาษาไทยแบบเป็นกันเอง สุภาพ\n`,
  'SOUL.md': `# Personality Traits\n- ใจเย็น, มีเหตุผล, ยินดีช่วยเหลือเสมอ\n`,
  'TOOLS.md': `# Enabled Tools\n# ลบ '#' หน้าชื่อ tool เพื่อเปิดใช้งาน\nget_current_time\n# echo_message\n# run_command\n# web_search\n# browser_navigate\n`,
};

class PersonaManager {
  private personasDir: string;
  private cache: Map<string, { config: PersonaConfig; lastLoaded: number }> = new Map();
  private TTL_MS = 60000; // 1 minute fallback, primarily invalidated by fs.watch
  private pendingWrites: Map<string, string> = new Map();
  private writeTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private DEBOUNCE_MS = 1000;

  constructor() {
    this.personasDir = path.join(process.cwd(), 'personas');
    this.ensureDirExists(this.personasDir);
    // Ensure directories for all platforms exist on startup
    for (const platform of PLATFORMS) {
      this.ensureDirExists(path.join(this.personasDir, platform));
    }
  }

  private ensureDirExists(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private validateInputs(platform: string, filename: string) {
    if (!PLATFORMS.includes(platform as PlatformType)) {
      throw new Error(`Security Violation: Invalid platform '${platform}'`);
    }
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      throw new Error(`Security Violation: Invalid filename '${filename}'`);
    }
  }

  private getFilePath(platform: string, filename: string): string {
    const platformDir = path.join(this.personasDir, platform);
    this.ensureDirExists(platformDir);
    return path.join(platformDir, filename);
  }

  private loadFile(platform: string, filename: string): string {
    const platformDir = path.join(this.personasDir, platform);
    this.ensureDirExists(platformDir);
    const filePath = path.join(platformDir, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, DEFAULTS[filename] ?? '', 'utf-8');
      return DEFAULTS[filename] ?? '';
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  private saveFile(platform: string, filename: string, content: string) {
    const platformDir = path.join(this.personasDir, platform);
    this.ensureDirExists(platformDir);
    fs.writeFileSync(path.join(platformDir, filename), content, 'utf-8');
  }

  /** Force-clear cache so next loadPersona() re-reads from disk */
  public clearCache(platform?: PlatformType) {
    if (platform) {
      this.cache.delete(platform);
    } else {
      this.cache.clear();
    }
  }

  /** Read all 4 files for a platform — used by API */
  public readFiles(platform: PlatformType): BotPersonaFiles {
    return {
      platform,
      agents:   this.loadFile(platform, 'AGENTS.md'),
      identity: this.loadFile(platform, 'IDENTITY.md'),
      soul:     this.loadFile(platform, 'SOUL.md'),
      tools:    this.loadFile(platform, 'TOOLS.md'),
    };
  }

  /** Write all 4 files for a platform — used by API (clears cache automatically) */
  public writeFiles(platform: PlatformType, files: Partial<Omit<BotPersonaFiles, 'platform'>>) {
    if (files.agents   !== undefined) this.saveFile(platform, 'AGENTS.md',   files.agents);
    if (files.identity !== undefined) this.saveFile(platform, 'IDENTITY.md', files.identity);
    if (files.soul     !== undefined) this.saveFile(platform, 'SOUL.md',     files.soul);
    if (files.tools    !== undefined) this.saveFile(platform, 'TOOLS.md',    files.tools);
    this.clearCache(platform);
  }

  /** Load combined persona config for bot agent use */
  public loadPersona(platform: PlatformType): PersonaConfig {
    const now = Date.now();
    const cached = this.cache.get(platform);
    if (cached && now - cached.lastLoaded < this.TTL_MS) return cached.config;

    const agents   = this.loadFile(platform, 'AGENTS.md');
    const identity = this.loadFile(platform, 'IDENTITY.md');
    const soul     = this.loadFile(platform, 'SOUL.md');
    const toolsText = this.loadFile(platform, 'TOOLS.md');

    const systemInstruction =
      `[AGENTS - Role & Goals]\n${agents}\n\n[IDENTITY - Style & Rules]\n${identity}\n\n[SOUL - Personality]\n${soul}`;

    const enabledTools = toolsText
      .split('\n')
      .map(line => line.trim())
      .map(line => line.match(/^(?!#|\/\/)\s*([\w-]+)/)?.[1])
      .filter(Boolean) as string[];

    // Security: Restrict 'run_command' to 'system' platform only
    const finalEnabledTools = platform === 'system' 
      ? enabledTools 
      : enabledTools.filter(tool => tool !== 'run_command');

    const config: PersonaConfig = { systemInstruction, enabledTools: finalEnabledTools };
    this.cache.set(platform, { config, lastLoaded: now });
    return config;
  }
}

export const personaManager = new PersonaManager();

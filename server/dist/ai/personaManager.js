import fs from 'fs';
import path from 'path';
export const PLATFORMS = ['fb-extension', 'line', 'telegram'];
// Default content per file
const DEFAULTS = {
    'AGENTS.md': `# Role\nคุณคือผู้ช่วย AI ส่วนตัว (Personal AI Assistant)\n\n# Goal\nเป้าหมายของคุณคือการช่วยเหลือผู้ใช้งานอย่างเต็มที่และถูกต้องที่สุด\n`,
    'IDENTITY.md': `# Speaking Style\n- ตอบสั้นๆ กระชับ ได้ใจความ\n- ห้ามใช้อีโมจิเด็ดขาด\n- ใช้ภาษาไทยแบบเป็นกันเอง สุภาพ\n`,
    'SOUL.md': `# Personality Traits\n- ใจเย็น, มีเหตุผล, ยินดีช่วยเหลือเสมอ\n`,
    'TOOLS.md': `# Enabled Tools\n# ลบ '#' หน้าชื่อ tool เพื่อเปิดใช้งาน\nget_current_time\n# echo_message\n# run_command\n# web_search\n# browser_navigate\n`,
};
class PersonaManager {
    personasDir;
    cache = new Map();
    TTL_MS = 5000;
    constructor() {
        this.personasDir = path.join(process.cwd(), 'personas');
        this.ensureDirExists(this.personasDir);
    }
    ensureDirExists(dir) {
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
    }
    loadFile(platform, filename) {
        const platformDir = path.join(this.personasDir, platform);
        this.ensureDirExists(platformDir);
        const filePath = path.join(platformDir, filename);
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, DEFAULTS[filename] ?? '', 'utf-8');
            return DEFAULTS[filename] ?? '';
        }
        return fs.readFileSync(filePath, 'utf-8');
    }
    saveFile(platform, filename, content) {
        const platformDir = path.join(this.personasDir, platform);
        this.ensureDirExists(platformDir);
        fs.writeFileSync(path.join(platformDir, filename), content, 'utf-8');
    }
    /** Force-clear cache so next loadPersona() re-reads from disk */
    clearCache(platform) {
        if (platform) {
            this.cache.delete(platform);
        }
        else {
            this.cache.clear();
        }
    }
    /** Read all 4 files for a platform — used by API */
    readFiles(platform) {
        return {
            platform,
            agents: this.loadFile(platform, 'AGENTS.md'),
            identity: this.loadFile(platform, 'IDENTITY.md'),
            soul: this.loadFile(platform, 'SOUL.md'),
            tools: this.loadFile(platform, 'TOOLS.md'),
        };
    }
    /** Write all 4 files for a platform — used by API (clears cache automatically) */
    writeFiles(platform, files) {
        if (files.agents !== undefined)
            this.saveFile(platform, 'AGENTS.md', files.agents);
        if (files.identity !== undefined)
            this.saveFile(platform, 'IDENTITY.md', files.identity);
        if (files.soul !== undefined)
            this.saveFile(platform, 'SOUL.md', files.soul);
        if (files.tools !== undefined)
            this.saveFile(platform, 'TOOLS.md', files.tools);
        this.clearCache(platform);
    }
    /** Load combined persona config for bot agent use */
    loadPersona(platform) {
        const now = Date.now();
        const cached = this.cache.get(platform);
        if (cached && now - cached.lastLoaded < this.TTL_MS)
            return cached.config;
        const agents = this.loadFile(platform, 'AGENTS.md');
        const identity = this.loadFile(platform, 'IDENTITY.md');
        const soul = this.loadFile(platform, 'SOUL.md');
        const toolsText = this.loadFile(platform, 'TOOLS.md');
        const systemInstruction = `[AGENTS - Role & Goals]\n${agents}\n\n[IDENTITY - Style & Rules]\n${identity}\n\n[SOUL - Personality]\n${soul}`;
        const enabledTools = toolsText
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith('#') && !line.startsWith('//'))
            .map(line => line.replace(/[`*\-]/g, '').trim())
            .filter(Boolean);
        const config = { systemInstruction, enabledTools };
        this.cache.set(platform, { config, lastLoaded: now });
        return config;
    }
}
export const personaManager = new PersonaManager();
//# sourceMappingURL=personaManager.js.map
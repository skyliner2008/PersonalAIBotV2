export type PlatformType = 'fb-extension' | 'line' | 'telegram' | 'facebook' | 'discord' | 'custom' | 'system';
export declare const PLATFORMS: PlatformType[];
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
declare class PersonaManager {
    private personasDir;
    private cache;
    private TTL_MS;
    constructor();
    private ensureDirExists;
    private loadFile;
    private saveFile;
    /** Force-clear cache so next loadPersona() re-reads from disk */
    clearCache(platform?: PlatformType): void;
    /** Read all 4 files for a platform — used by API */
    readFiles(platform: PlatformType): BotPersonaFiles;
    /** Write all 4 files for a platform — used by API (clears cache automatically) */
    writeFiles(platform: PlatformType, files: Partial<Omit<BotPersonaFiles, 'platform'>>): void;
    /** Load combined persona config for bot agent use */
    loadPersona(platform: PlatformType): PersonaConfig;
}
export declare const personaManager: PersonaManager;
export {};

import { Router } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { requireAuth } from '../utils/auth.js';
import { getActiveBotIds } from '../bot_agents/botManager.js';
import { listBots, type BotInstance } from '../bot_agents/registries/botRegistry.js';
import type { BackendType } from '../terminal/commandRouter.js';
import { 
  FACEBOOK_AUTOMATION_PLUGIN_ID, 
  getCoreAgent, 
  listBotsForPlatform, 
  listCoreAgents, 
  selectPrimaryBotForPlatform 
} from '../system/agentTopology.js';
import { getPluginRuntimeSnapshots } from '../system/pluginRegistry.js';
import { getCLIConfig, getCliRuntimeStatus } from '../terminal/commandRouter.js';
import { getProviderApiKey } from '../config/settingsSecurity.js';
import { getRuntimeControlSnapshot } from '../config/runtimeSettings.js';

const router = Router();
router.use(requireAuth('viewer'));

function getGeminiOAuthPath() {
    const home = process.env.USERPROFILE || os.homedir();
    return path.join(home, '.gemini', 'oauth_creds.json');
}

function pluginStatusToRuntime(status: string) {
    if (status === 'active') return 'active';
    if (status === 'degraded') return 'degraded';
    return 'offline';
}

interface AgentDefinition {
    id: string;
    name: string;
    kind: string;
    description: string;
    channels: string[];
    summonTargets: string[];
    platform?: string;
}

interface PluginSnapshot {
    id: string;
    status: string;
    details: any;
}


function buildMessagingBotSnapshot(definition: AgentDefinition, bots: BotInstance[], activeBotIds: Set<string>) {
    const platform = definition.platform === 'line' ? 'line' : 'telegram';
    const platformBots = listBotsForPlatform(bots, platform);
    const runningBotIds = platformBots
        .map((bot: BotInstance) => bot.id)
        .filter((botId: string) => activeBotIds.has(botId));
    const primaryBot = selectPrimaryBotForPlatform(bots, platform);
    
    let status = 'offline';
    if (runningBotIds.length > 0) {
        status = 'active';
    }
    else if (platformBots.length === 0 || platformBots.some((bot: BotInstance) => bot.status === 'error')) {
        status = 'degraded';
    }
    
    return {
        id: definition.id,
        name: definition.name,
        kind: definition.kind,
        description: definition.description,
        channels: [...definition.channels],
        summonTargets: [...definition.summonTargets],
        status,
        details: {
            configuredBotCount: platformBots.length,
            runningBotIds,
            primaryBotId: primaryBot?.id ?? null,
            botStatuses: platformBots.map((bot: BotInstance) => ({
                id: bot.id,
                status: bot.status,
                lastError: bot.last_error,
            })),
        },
    };
}

function buildFacebookAgentSnapshot(definition: AgentDefinition, pluginById: Map<string, PluginSnapshot>) {
    const plugin = pluginById.get(FACEBOOK_AUTOMATION_PLUGIN_ID);
    return {
        id: definition.id,
        name: definition.name,
        kind: definition.kind,
        description: definition.description,
        channels: [...definition.channels],
        summonTargets: [...definition.summonTargets],
        status: plugin ? pluginStatusToRuntime(plugin.status) : 'offline',
        details: plugin?.details ?? { available: false },
    };
}

function buildJarvisAgentSnapshot(definition: AgentDefinition) {
    const hasGeminiApiKey = Boolean(getProviderApiKey('gemini') || process.env.GEMINI_API_KEY);
    return {
        id: definition.id,
        name: definition.name,
        kind: definition.kind,
        description: definition.description,
        channels: [...definition.channels],
        summonTargets: [...definition.summonTargets],
        status: hasGeminiApiKey ? 'active' : 'degraded',
        details: {
            hasGeminiApiKey,
            canSummonTo: definition.summonTargets,
        },
    };
}

function buildCliBridgeAgentSnapshot(definition: AgentDefinition) {
    const backendId = definition.id as BackendType;
    const cliConfig = getCLIConfig(backendId);
    const cliAvailable = Boolean(cliConfig);
    const runtimeStatus = getCliRuntimeStatus(backendId);
    
    const details: any = {
        cliAvailable,
        cliCommand: cliConfig?.command ?? null,
        canSummonTo: definition.summonTargets,
    };
    
    if (definition.id === 'gemini-cli') {
        const oauthPath = getGeminiOAuthPath();
        const hasOAuthCredentials = fs.existsSync(oauthPath);
        details.hasOAuthCredentials = hasOAuthCredentials;
        details.oauthCredentialsPath = hasOAuthCredentials ? '~/.gemini/oauth_creds.json' : null;
    }
    
    let platformStatus = cliAvailable ? 'active' : 'degraded';
    if (runtimeStatus.lastError) {
        platformStatus = 'degraded';
        details.lastRuntimeError = runtimeStatus.lastError;
        details.errorTimestamp = runtimeStatus.errorTimestamp;
    }
    
    return {
        id: definition.id,
        name: definition.name,
        kind: definition.kind,
        description: definition.description,
        channels: [...definition.channels],
        summonTargets: [...definition.summonTargets],
        status: platformStatus,
        details,
    };
}

function buildGenericAgentSnapshot(definition: AgentDefinition) {
    return {
        id: definition.id,
        name: definition.name,
        kind: definition.kind,
        description: definition.description,
        channels: [...definition.channels],
        summonTargets: [...definition.summonTargets],
        status: 'active',
        details: { canSummonTo: definition.summonTargets },
    };
}

function buildAgentSnapshots() {
    const bots = listBots();
    const activeBotIds = new Set(getActiveBotIds());
    const pluginById = new Map<string, PluginSnapshot>(getPluginRuntimeSnapshots().map((plugin: PluginSnapshot) => [plugin.id, plugin]));
    
    return listCoreAgents().map((definition: AgentDefinition) => {
        if (definition.id === 'line-bot' || definition.id === 'telegram-bot') {
            return buildMessagingBotSnapshot(definition, bots, activeBotIds);
        }
        if (definition.id === 'fb-extension') {
            return buildFacebookAgentSnapshot(definition, pluginById);
        }
        if (definition.id === 'jarvis-root-admin') {
            return buildJarvisAgentSnapshot(definition);
        }
        if (definition.kind === 'cli-bridge') {
            return buildCliBridgeAgentSnapshot(definition);
        }
        return buildGenericAgentSnapshot(definition);
    });
}

router.get('/agents', (_req, res) => {
    res.json({
        generatedAt: new Date().toISOString(),
        agents: buildAgentSnapshots(),
    });
});

router.get('/plugins', (_req, res) => {
    res.json({
        generatedAt: new Date().toISOString(),
        plugins: getPluginRuntimeSnapshots(),
    });
});

router.get('/topology', (_req, res) => {
    const fbDefinition = getCoreAgent('fb-extension') || { name: 'FB Extension (Offline)' };
    res.json({
        generatedAt: new Date().toISOString(),
        architecture: {
            mode: 'unified-bot-v2',
            coreAgents: 7,
            pattern: '4 main agents + dynamic CLI bridges',
            facebookAutomationBoundary: {
                role: fbDefinition.name,
                pluginId: FACEBOOK_AUTOMATION_PLUGIN_ID,
                note: 'Facebook automation is treated as a plugin controlled by the FB Extension agent.',
            },
        },
        agents: buildAgentSnapshots(),
        plugins: getPluginRuntimeSnapshots(),
    });
});

router.get('/runtime-controls', (_req, res) => {
    const controls = getRuntimeControlSnapshot();
    const enriched = controls.map((ctrl: any) => {
        const valueType = typeof ctrl.value;
        const isOverridden = ctrl.source !== 'default';
        let category = 'general';
        if (ctrl.key.startsWith('swarm_')) category = 'swarm';
        else if (ctrl.key.startsWith('web_voice_')) category = 'web_voice';
        else if (ctrl.key.startsWith('agent_')) category = 'agent';
        else if (ctrl.key.startsWith('self_')) category = 'self_evolve';
        
        return {
            ...ctrl,
            valueType,
            isOverridden,
            category,
        };
    });
    res.json({
        generatedAt: new Date().toISOString(),
        controls: enriched,
        summary: {
            total: enriched.length,
            overridden: enriched.filter((c: any) => c.isOverridden).length,
            bySource: enriched.reduce((acc: any, c: any) => {
                acc[c.source] = (acc[c.source] || 0) + 1;
                return acc;
            }, {}),
            byCategory: enriched.reduce((acc: any, c: any) => {
                acc[c.category] = (acc[c.category] || 0) + 1;
                return acc;
            }, {}),
        },
    });
});

export default router;

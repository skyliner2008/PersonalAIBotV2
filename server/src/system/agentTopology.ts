import type { BotInstance } from '../bot_agents/registries/botRegistry.js';
import { getRootAdminIdentity } from './rootAdmin.js';
import { getAvailableBackends } from '../terminal/commandRouter.js';

export type CoreAgentId =
  | 'fb-extension'
  | 'line-bot'
  | 'telegram-bot'
  | 'jarvis-root-admin'
  | `${string}-cli`;

export type CoreAgentKind =
  | 'plugin-controller'
  | 'messaging-bot'
  | 'admin-orchestrator'
  | 'cli-bridge';

export interface CoreAgentDefinition {
  id: CoreAgentId;
  name: string;
  kind: CoreAgentKind;
  description: string;
  channels: string[];
  summonTargets: CoreAgentId[];
  platform?: 'line' | 'telegram' | 'custom';
}

export const JARVIS_ROOT_ADMIN = {
  botId: getRootAdminIdentity().botId,
  name: getRootAdminIdentity().botName,
} as const;

export const GEMINI_CLI_AGENT = {
  botId: 'gemini-cli',
  name: 'Agent Gemini CLI',
} as const;

export const CODEX_CLI_AGENT = {
  botId: 'codex-cli',
  name: 'Agent Codex CLI',
} as const;

export const CLAUDE_CLI_AGENT = {
  botId: 'claude-cli',
  name: 'Agent Claude CLI',
} as const;

export const FACEBOOK_AUTOMATION_PLUGIN_ID = 'facebook-automation-extension' as const;

const CORE_AGENT_DEFINITIONS: Record<CoreAgentId, CoreAgentDefinition> = {
  'fb-extension': {
    id: 'fb-extension',
    name: 'FB Extension',
    kind: 'plugin-controller',
    description: 'Controls the Facebook automation extension as a plugin module.',
    channels: ['facebook-extension', 'dashboard'],
    summonTargets: [],
    platform: 'custom',
  },
  'line-bot': {
    id: 'line-bot',
    name: 'LINE Bot',
    kind: 'messaging-bot',
    description: 'Handles end-user communication over the LINE channel.',
    channels: ['line'],
    summonTargets: [],
    platform: 'line',
  },
  'telegram-bot': {
    id: 'telegram-bot',
    name: 'Telegram Bot',
    kind: 'messaging-bot',
    description: 'Handles end-user communication over the Telegram channel.',
    channels: ['telegram'],
    summonTargets: [],
    platform: 'telegram',
  },
  'jarvis-root-admin': {
    id: 'jarvis-root-admin',
    name: JARVIS_ROOT_ADMIN.name,
    kind: 'admin-orchestrator',
    description: 'Root-level system agent that can summon into LINE and Telegram.',
    channels: ['terminal', 'web-admin'],
    summonTargets: ['line-bot', 'telegram-bot'],
    platform: 'custom',
  },
};

function cloneAgent(definition: CoreAgentDefinition): CoreAgentDefinition {
  const cloned: CoreAgentDefinition = {
    ...definition,
    channels: [...definition.channels],
    summonTargets: [...definition.summonTargets],
  };

  if (cloned.id === 'jarvis-root-admin') {
    cloned.name = getRootAdminIdentity().botName;
  }

  return cloned;
}

export function listCoreAgents(): CoreAgentDefinition[] {
  const staticAgents = Object.values(CORE_AGENT_DEFINITIONS).map(cloneAgent);
  
  // Dynamically resolve installed CLIs
  const backends = getAvailableBackends().filter(b => b.kind === 'cli');
  const cliAgents: CoreAgentDefinition[] = backends.map(b => ({
    id: b.id as `${string}-cli`,
    name: b.name,
    kind: 'cli-bridge',
    description: b.description || `${b.name} bridge agent.`,
    channels: ['terminal', b.id],
    summonTargets: ['line-bot', 'telegram-bot'],
    platform: 'custom',
  }));

  // Ensure Jarvis can summon all CLIs
  const jarvis = staticAgents.find(a => a.id === 'jarvis-root-admin');
  if (jarvis) {
    jarvis.summonTargets = Array.from(new Set([...jarvis.summonTargets, ...cliAgents.map(a => a.id)]));
  }

  return [...staticAgents, ...cliAgents];
}

export function getCoreAgent(agentId: CoreAgentId): CoreAgentDefinition | null {
  if (CORE_AGENT_DEFINITIONS[agentId]) {
    return cloneAgent(CORE_AGENT_DEFINITIONS[agentId]);
  }
  
  if (agentId.endsWith('-cli')) {
    const backends = getAvailableBackends();
    const match = backends.find(b => b.id === agentId);
    if (match) {
      return {
        id: match.id as `${string}-cli`,
        name: match.name,
        kind: 'cli-bridge',
        description: match.description || `${match.name} bridge agent.`,
        channels: ['terminal', match.id],
        summonTargets: ['line-bot', 'telegram-bot'],
        platform: 'custom',
      };
    }
  }
  
  return null;
}

function statusScore(status: BotInstance['status']): number {
  switch (status) {
    case 'active':
      return 3;
    case 'error':
      return 2;
    case 'stopped':
    default:
      return 1;
  }
}

export function listBotsForPlatform(
  bots: BotInstance[],
  platform: 'line' | 'telegram',
): BotInstance[] {
  return bots
    .filter((bot) => bot.platform === platform)
    .sort((a, b) => {
      const scoreDelta = statusScore(b.status) - statusScore(a.status);
      if (scoreDelta !== 0) return scoreDelta;
      return Date.parse(b.updated_at) - Date.parse(a.updated_at);
    });
}

export function selectPrimaryBotForPlatform(
  bots: BotInstance[],
  platform: 'line' | 'telegram',
): BotInstance | null {
  const [primary] = listBotsForPlatform(bots, platform);
  return primary ?? null;
}

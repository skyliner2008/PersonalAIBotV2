import { useState, useEffect, useCallback } from 'react';
import { useSocket } from '../hooks/useSocket';
import { api } from '../services/api';
import {
  Bot, Plus, Trash2, Power, PowerOff, Edit3, Save, X,
  ChevronDown, ChevronRight, Wrench, Shield, AlertTriangle, Brain
} from 'lucide-react';
import { AgentRoutingOverview } from './settings/AgentRoutingOverview';
import { AgentRouteConfig, BotRouteSummary, AgentBotSummary, RegistryProvider as SettingsRegistryProvider, GlobalRoutingConfig } from './settings/types';

interface BotInstance {
  id: string;
  name: string;
  platform: string;
  credentials: Record<string, string>;
  persona_id: string | null;
  enabled_tools: string[];
  config: Record<string, unknown>;
  status: 'active' | 'stopped' | 'error';
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface RegistryProvider {
  id: string;
  name: string;
  category: string;
  type: string;
  defaultModel?: string;
  models?: string[];
  enabled: boolean;
  configured: boolean;
}

// Shared types are imported from ./settings/types

interface PlatformInfo {
  platform: string;
  credentialFields: { key: string; label: string; secret: boolean }[];
}

interface ToolMeta {
  name: string;
  displayName: string;
  description: string;
  category: string;
  riskLevel: string;
  platforms: string[];
  tags: string[];
  enabledByDefault: boolean;
}

interface Persona {
  id: string;
  name: string;
}

type PersonaPlatform = 'fb-extension' | 'line' | 'telegram' | 'system';
type PersonaEditableField = 'agents' | 'identity' | 'soul';

interface BotPersonaFiles {
  platform: PersonaPlatform;
  agents: string;
  identity: string;
  soul: string;
  tools: string;
}

const platformColors: Record<string, string> = {
  telegram: 'bg-blue-500',
  line: 'bg-green-500',
  facebook: 'bg-indigo-500',
  discord: 'bg-purple-500',
  custom: 'bg-gray-500',
};

const platformLabels: Record<string, string> = {
  telegram: 'Telegram',
  line: 'LINE',
  facebook: 'Facebook',
  discord: 'Discord',
  custom: 'Custom',
};

const statusColors: Record<string, string> = {
  active: 'text-green-400',
  stopped: 'text-gray-500',
  error: 'text-red-400',
};

const AGENT_TASKS = [
  { id: 'general', name: 'General' },
  { id: 'complex', name: 'Complex' },
  { id: 'thinking', name: 'Thinking' },
  { id: 'code', name: 'Code' },
  { id: 'data', name: 'Data' },
  { id: 'web', name: 'Web' },
  { id: 'vision', name: 'Vision' },
  { id: 'system', name: 'System' },
];

const PERSONA_PLATFORMS: Array<{ id: PersonaPlatform; label: string }> = [
  { id: 'fb-extension', label: 'FB Extension' },
  { id: 'line', label: 'LINE' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'system', label: 'Jarvis System' },
];

const ROOT_RUNTIME_KEYS = [
  'jarvis_root_bot_id',
  'jarvis_root_bot_name',
  'jarvis_root_persona_platform',
  'jarvis_root_specialist_name',
  'jarvis_supervisor_bot_ids',
  'swarm_jarvis_provider',
  'swarm_jarvis_model',
] as const;

type RootRuntimeKey = (typeof ROOT_RUNTIME_KEYS)[number];

export function AgentManager() {
  const [bots, setBots] = useState<BotInstance[]>([]);
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [tools, setTools] = useState<ToolMeta[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [providers, setProviders] = useState<SettingsRegistryProvider[]>([]);
  const [botModelConfigs, setBotModelConfigs] = useState<Record<string, BotRouteSummary>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingBotModelKey, setSavingBotModelKey] = useState<string | null>(null);
  const { on } = useSocket();

  useEffect(() => {
    const unsub = on('agent:modelUpdated', (data: { botId?: string; isGlobal?: boolean }) => {
      if (data.isGlobal) {
        api.getAgentConfig().then(setAgentConfig);
      }
      if (data.botId) {
        refreshBotModelConfig(data.botId);
      } else {
        // If it's a general update without specific ID, refresh all visible ones
        loadAgentRouting();
      }
    });
    return unsub;
  }, [on]);

  // Boss Mode Admin IDs state
  const [adminIds, setAdminIds] = useState<Record<string, string[]>>({
    telegram: [],
    line: [],
    facebook: [],
    discord: [],
    web: [],
  });
  const [adminIdInput, setAdminIdInput] = useState<Record<string, string>>({
    telegram: '',
    line: '',
    facebook: '',
    discord: '',
    web: '',
  });
  const [savingAdminIds, setSavingAdminIds] = useState(false);
  const [adminRoutingExpanded, setAdminRoutingExpanded] = useState(true);

  // Agent routing overview state
  const [agentConfig, setAgentConfig] = useState<GlobalRoutingConfig>({ autoRouting: false, routes: {} });
  const [agentBots, setAgentBots] = useState<AgentBotSummary[]>([]);
  const [agentBotModels, setAgentBotModels] = useState<Record<string, BotRouteSummary>>({});

  // Jarvis Root Admin state
  const [jarvisEnabled, setJarvisEnabled] = useState(true);
  const [jarvisExpanded, setJarvisExpanded] = useState(false);
  const [jarvisEnabledTools, setJarvisEnabledTools] = useState<string[]>([]);
  const [jarvisToolsRaw, setJarvisToolsRaw] = useState('');
  const [personaFiles, setPersonaFiles] = useState<Record<PersonaPlatform, BotPersonaFiles | null>>({
    'fb-extension': null,
    line: null,
    telegram: null,
    system: null,
  });
  const [expandedPersona, setExpandedPersona] = useState<PersonaPlatform | null>('system');
  const [savingPersonaPlatform, setSavingPersonaPlatform] = useState<PersonaPlatform | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<Record<RootRuntimeKey, string>>({
    jarvis_root_bot_id: '',
    jarvis_root_bot_name: '',
    jarvis_root_persona_platform: 'system',
    jarvis_root_specialist_name: '',
    jarvis_supervisor_bot_ids: '',
    swarm_jarvis_provider: '',
    swarm_jarvis_model: '',
  });
  const [savingRuntime, setSavingRuntime] = useState(false);

  const loadJarvisTools = async () => {
    try {
      const data = await api.getBotPersona('system');
      const raw: string = data.tools || '';
      setJarvisToolsRaw(raw);
      const enabled = raw.split('\n').map((l: string) => l.trim()).filter((l: string) => l && !l.startsWith('#') && !l.startsWith('//'));
      setJarvisEnabledTools(enabled);
    } catch { /* ignore */ }
  };

  const handleJarvisToolToggle = async (toolName: string) => {
    const isEnabled = jarvisEnabledTools.includes(toolName);
    let newRaw: string;
    if (isEnabled) {
      // Comment out the tool
      newRaw = jarvisToolsRaw.split('\n').map(l => l.trim() === toolName ? `# ${toolName}` : l).join('\n');
    } else {
      // Uncomment or add the tool
      const line = `# ${toolName}`;
      if (jarvisToolsRaw.includes(line)) {
        newRaw = jarvisToolsRaw.split('\n').map(l => l.trim() === `# ${toolName}` ? toolName : l).join('\n');
      } else {
        newRaw = jarvisToolsRaw + '\n' + toolName;
      }
    }
    setJarvisToolsRaw(newRaw);
    const newEnabled = newRaw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
    setJarvisEnabledTools(newEnabled);
    try {
      await api.saveBotPersona('system', { tools: newRaw });
    } catch { /* ignore */ }
  };

  const loadPersonaFiles = async () => {
    try {
      const all = await api.getAllBotPersonas() as BotPersonaFiles[];
      const next: Record<PersonaPlatform, BotPersonaFiles | null> = {
        'fb-extension': null,
        line: null,
        telegram: null,
        system: null,
      };
      for (const item of all) {
        if (item && next[item.platform as PersonaPlatform] !== undefined) {
          next[item.platform as PersonaPlatform] = item;
        }
      }
      setPersonaFiles(next);
    } catch (err) {
      console.error('Failed to load persona files:', err);
    }
  };

  const loadRuntimeSettings = async () => {
    try {
      const rows = await api.getSettings();
      const map: Record<string, string> = {};
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row?.key) map[String(row.key)] = String(row.value ?? '');
        }
      } else if (rows && typeof rows === 'object') {
        Object.assign(map, rows as Record<string, string>);
      }
      setRuntimeSettings({
        jarvis_root_bot_id: map.jarvis_root_bot_id || '',
        jarvis_root_bot_name: map.jarvis_root_bot_name || '',
        jarvis_root_persona_platform: map.jarvis_root_persona_platform || 'system',
        jarvis_root_specialist_name: map.jarvis_root_specialist_name || '',
        jarvis_supervisor_bot_ids: map.jarvis_supervisor_bot_ids || '',
        swarm_jarvis_provider: map.swarm_jarvis_provider || '',
        swarm_jarvis_model: map.swarm_jarvis_model || '',
      });

      // Load admin IDs
      const adminIdsData: Record<string, string[]> = {
        telegram: (map.admin_telegram_ids || '').split(',').map(s => s.trim()).filter(Boolean),
        line: (map.admin_line_ids || '').split(',').map(s => s.trim()).filter(Boolean),
        facebook: (map.admin_facebook_ids || '').split(',').map(s => s.trim()).filter(Boolean),
        discord: (map.admin_discord_ids || '').split(',').map(s => s.trim()).filter(Boolean),
        web: (map.admin_web_ids || '').split(',').map(s => s.trim()).filter(Boolean),
      };
      setAdminIds(adminIdsData);
    } catch (err) {
      console.error('Failed to load runtime settings:', err);
    }
  };

  const loadAgentRouting = async () => {
    try {
      const [configResult, botsResult] = await Promise.all([
        api.getAgentConfig(),
        api.getBots(),
      ]);

      setAgentConfig((configResult || { autoRouting: false, routes: {} }) as GlobalRoutingConfig);

      const bots = Array.isArray(botsResult) ? botsResult as AgentBotSummary[] : [];
      setAgentBots(bots);

      const botModelEntries = await Promise.all(
        bots.map(async (bot) => {
          try {
            const modelConfig = await api.getBotModels(bot.id) as BotRouteSummary;
            return [bot.id, modelConfig] as [string, BotRouteSummary];
          } catch {
            return [bot.id, {
              botId: bot.id,
              botName: bot.name,
              autoRouting: false,
              modelConfig: {},
            }] as [string, BotRouteSummary];
          }
        })
      );

      setAgentBotModels(Object.fromEntries(botModelEntries));
    } catch (e) {
      console.warn('Failed to load agent routing overview', e);
    }
  };

  const handleAddAdminId = (platform: string) => {
    const id = adminIdInput[platform]?.trim();
    if (!id) return;
    setAdminIds(prev => ({
      ...prev,
      [platform]: [...(prev[platform] || []), id],
    }));
    setAdminIdInput(prev => ({ ...prev, [platform]: '' }));
  };

  const handleRemoveAdminId = (platform: string, index: number) => {
    setAdminIds(prev => ({
      ...prev,
      [platform]: prev[platform].filter((_, i) => i !== index),
    }));
  };

  const handleSaveAdminIds = async () => {
    setSavingAdminIds(true);
    try {
      const payload: Record<string, string> = {
        admin_telegram_ids: adminIds.telegram.join(','),
        admin_line_ids: adminIds.line.join(','),
        admin_facebook_ids: adminIds.facebook.join(','),
        admin_discord_ids: adminIds.discord.join(','),
        admin_web_ids: adminIds.web.join(','),
      };
      await api.setSettingsBulk(payload);
    } catch (err) {
      console.error('Failed to save admin IDs:', err);
      alert('Failed to save admin IDs');
    }
    setSavingAdminIds(false);
  };

  const updatePersonaField = (platform: PersonaPlatform, field: PersonaEditableField, value: string) => {
    setPersonaFiles((prev) => {
      const current = prev[platform];
      if (!current) return prev;
      return {
        ...prev,
        [platform]: {
          ...current,
          [field]: value,
        },
      };
    });
  };

  const savePersonaIdentity = async (platform: PersonaPlatform) => {
    const current = personaFiles[platform];
    if (!current) return;
    setSavingPersonaPlatform(platform);
    try {
      await api.saveBotPersona(platform, {
        agents: current.agents,
        identity: current.identity,
        soul: current.soul,
      });
    } catch (err) {
      console.error(`Failed to save persona identity (${platform}):`, err);
      alert(`Failed to save ${platform} identity`);
    }
    setSavingPersonaPlatform(null);
  };

  const saveRuntimeConfig = async () => {
    setSavingRuntime(true);
    try {
      const payload: Record<string, string> = {};
      for (const key of ROOT_RUNTIME_KEYS) payload[key] = runtimeSettings[key] || '';
      await api.setSettingsBulk(payload);
      await loadRuntimeSettings();
    } catch (err) {
      console.error('Failed to save runtime settings:', err);
      alert('Failed to save Root Runtime settings');
    }
    setSavingRuntime(false);
  };

  // Create form
  const [newBot, setNewBot] = useState({
    id: '', name: '', platform: 'telegram',
    credentials: {} as Record<string, string>,
    persona_id: '',
    enabled_tools: [] as string[],
  });

  const loadData = async () => {
    setLoading(true);
    try {
      const [b, p, t, personaList, providerResult] = await Promise.all([
        api.getBots(),
        api.getBotPlatforms(),
        api.getTools(),
        api.getPersonas(),
        api.getProviders(),
      ]);
      setBots(b);
      setPlatforms(p);
      setTools(t);
      setPersonas(personaList);
      setProviders(providerResult?.providers || []);

      const botModelEntries = await Promise.all(
        (b || []).map(async (bot: BotInstance) => {
          try {
            const modelSummary = await api.getBotModels(bot.id) as BotRouteSummary;
            return [bot.id, modelSummary] as [string, BotRouteSummary];
          } catch {
            return [bot.id, {
              botId: bot.id,
              botName: bot.name,
              autoRouting: false,
              modelConfig: {},
            }] as [string, BotRouteSummary];
          }
        })
      );
      setBotModelConfigs(Object.fromEntries(botModelEntries));
    } catch (err) {
      console.error('Failed to load agent data:', err);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadData();
    loadJarvisTools();
    loadPersonaFiles();
    loadRuntimeSettings();
    loadAgentRouting();
  }, []);

  const llmProviders = providers.filter(provider =>
    provider.category === 'llm'
    && provider.enabled
    && provider.configured
  );
  const jarvisUnknownTools = jarvisEnabledTools.filter((toolName) => !tools.some((tool) => tool.name === toolName));

  function getModelOptions(providerId: string, currentModel?: string): string[] {
    const provider = llmProviders.find(item => item.id === providerId);
    return Array.from(new Set([
      ...(provider?.models || []),
      provider?.defaultModel || '',
      currentModel || '',
    ].filter(Boolean)));
  }

  async function refreshBotModelConfig(botId: string) {
    try {
      const modelSummary = await api.getBotModels(botId) as BotRouteSummary;
      setBotModelConfigs(prev => ({ ...prev, [botId]: modelSummary }));
    } catch (err) {
      console.error('Failed to refresh bot model config:', err);
    }
  }

   const handleBotAutoRoutingChange = async (botId: string, enabled: boolean) => {
    const actionKey = `${botId}:auto`;
    setSavingBotModelKey(actionKey);
    try {
      await api.setBotModel(botId, { autoRouting: enabled });
      await refreshBotModelConfig(botId);
    } catch (err: any) {
      console.error('Failed to update bot auto routing:', err);
      alert(err?.message || 'Failed to update auto routing');
    }
    setSavingBotModelKey(null);
  }

  const handleGlobalAutoRoutingChange = async (enabled: boolean) => {
    setSavingBotModelKey('global:auto');
    try {
      await api.setAgentConfig({ autoRouting: enabled });
      const config = await api.getAgentConfig() as GlobalRoutingConfig;
      setAgentConfig(config);
    } catch (err) {
      console.error('Failed to update global auto routing:', err);
    }
    setSavingBotModelKey(null);
  };

  const handleGlobalRouteUpdate = async (taskType: string, provider: string, modelName: string) => {
    setSavingBotModelKey(`global:${taskType}`);
    try {
      const routes: Record<string, any> = { 
        ...(agentConfig.routes || {}), 
        [taskType]: { active: { provider, modelName } } 
      };
      await api.setAgentConfig({ routes });
      const config = await api.getAgentConfig() as GlobalRoutingConfig;
      setAgentConfig(config);
    } catch (err) {
      console.error('Failed to update global route:', err);
    }
    setSavingBotModelKey(null);
  };

  const handleBotModelChange = async (botId: string, taskType: string, provider: string | null, modelName?: string) => {
    const actionKey = `${botId}:${taskType}`;
    setSavingBotModelKey(actionKey);
    try {
      await api.setBotModel(botId, { taskType, provider, modelName });
      await refreshBotModelConfig(botId);
    } catch (err: any) {
      console.error('Failed to update bot model routing:', err);
      alert(err?.message || 'Failed to update bot routing');
    }
    setSavingBotModelKey(null);
  }

  const selectedPlatformFields = platforms.find(p => p.platform === newBot.platform)?.credentialFields ?? [];

  const handleCreate = async () => {
    if (!newBot.id || !newBot.name) return;
    try {
      await api.createBot({
        id: newBot.id,
        name: newBot.name,
        platform: newBot.platform,
        credentials: newBot.credentials,
        persona_id: newBot.persona_id || undefined,
        enabled_tools: newBot.enabled_tools.length > 0 ? newBot.enabled_tools : undefined,
      });
      setShowCreate(false);
      setNewBot({ id: '', name: '', platform: 'telegram', credentials: {}, persona_id: '', enabled_tools: [] });
      loadData();
    } catch (err: any) {
      console.error('Failed to create bot:', err);
      alert(err.message);
    }
  };

  const handleToggle = async (id: string) => {
    try {
      await api.toggleBot(id);
      loadData();
    } catch (err) {
      console.error('Failed to toggle bot:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`ลบ Agent "${id}" จริงหรือ?`)) return;
    try {
      await api.deleteBot(id);
      loadData();
    } catch (err) {
      console.error('Failed to delete bot:', err);
    }
  };

  const handleUpdateTools = async (botId: string, toolNames: string[]) => {
    try {
      await api.updateBot(botId, { enabled_tools: toolNames });
      loadData();
    } catch (err) {
      console.error('Failed to update bot tools:', err);
    }
  };

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <div className="text-gray-400 animate-pulse">Loading agents...</div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Bot className="w-6 h-6 text-blue-400" />
            Agent Manager
          </h1>
          <p className="text-sm text-gray-500 mt-1">Single control center: Identity + Tools + Model + Supervisor IDs for all agents</p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm transition-colors"
        >
          <Plus className="w-4 h-4" />
          เพิ่ม Agent
        </button>
      </div>

      {/* Agent Routing & Administration Section */}
      <div className="bg-gray-900 border border-cyan-500/30 rounded-xl overflow-hidden">
        <button
          onClick={() => setAdminRoutingExpanded(!adminRoutingExpanded)}
          className="w-full flex items-center justify-between px-5 py-4 bg-gradient-to-r from-cyan-500/10 to-transparent hover:from-cyan-500/20 transition-colors border-b border-cyan-500/20"
        >
          <div className="flex items-center gap-3">
            <Brain className="w-5 h-5 text-cyan-400" />
            <div className="text-left">
              <h3 className="text-sm font-semibold text-white">Boss Mode Administration</h3>
              <p className="text-xs text-gray-400 mt-0.5">Admin IDs for all platforms</p>
            </div>
          </div>
          {adminRoutingExpanded ? <ChevronDown className="w-5 h-5 text-gray-400" /> : <ChevronRight className="w-5 h-5 text-gray-400" />}
        </button>

        {adminRoutingExpanded && (
          <div className="p-5 space-y-6">
            {/* Boss Mode Admin IDs */}
            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-medium text-gray-200 mb-3">Boss Mode Admin IDs</h4>
                <p className="text-xs text-gray-400 mb-4">Add admin user IDs by platform. Press Enter or comma to add.</p>
              </div>

              {Object.entries({
                telegram: 'Telegram',
                line: 'LINE',
                facebook: 'Facebook',
                discord: 'Discord',
                web: 'Web/App',
              }).map(([platform, label]) => (
                <div key={platform} className="space-y-2">
                  <label className="text-xs font-medium text-gray-300">{label} Admin IDs</label>
                  <div className="flex flex-wrap gap-2 p-3 bg-gray-800/50 rounded-lg border border-gray-700 min-h-[44px] items-center">
                    {adminIds[platform]?.map((id, idx) => (
                      <div
                        key={`${platform}-${idx}`}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 bg-cyan-600/30 text-cyan-200 rounded-lg text-xs border border-cyan-500/50"
                      >
                        <span className="font-mono">{id}</span>
                        <button
                          onClick={() => handleRemoveAdminId(platform, idx)}
                          className="hover:text-cyan-100 transition-colors"
                          title="Remove"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                    <input
                      type="text"
                      value={adminIdInput[platform] || ''}
                      onChange={e => setAdminIdInput(prev => ({ ...prev, [platform]: e.target.value }))}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault();
                          handleAddAdminId(platform);
                        }
                      }}
                      placeholder="Paste ID and press Enter..."
                      className="flex-1 min-w-[200px] bg-transparent text-gray-200 text-xs outline-none placeholder-gray-500 font-mono"
                    />
                  </div>
                </div>
              ))}

              <div className="flex justify-end pt-2">
                <button
                  onClick={handleSaveAdminIds}
                  disabled={savingAdminIds}
                  className="flex items-center gap-2 px-4 py-2 bg-cyan-600/30 text-cyan-300 rounded-lg hover:bg-cyan-600/40 disabled:opacity-50 text-xs font-medium border border-cyan-500/30"
                >
                  <Save className="w-3.5 h-3.5" />
                  {savingAdminIds ? 'Saving...' : 'Save Admin IDs'}
                </button>
              </div>
            </div>

          </div>
        )}
      </div>



      {/* Create Form */}
      {showCreate && (
        <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 space-y-4">
          <h3 className="text-white font-medium">สร้าง Agent ใหม่</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Agent ID</label>
              <input
                className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-sm border border-gray-700 focus:border-blue-500 outline-none"
                placeholder="my-telegram-bot"
                value={newBot.id}
                onChange={e => setNewBot({ ...newBot, id: e.target.value.replace(/[^a-z0-9_-]/g, '') })}
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">ชื่อ Agent</label>
              <input
                className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-sm border border-gray-700 focus:border-blue-500 outline-none"
                placeholder="My Telegram Bot"
                value={newBot.name}
                onChange={e => setNewBot({ ...newBot, name: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Platform</label>
              <select
                className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-sm border border-gray-700 outline-none"
                value={newBot.platform}
                onChange={e => setNewBot({ ...newBot, platform: e.target.value, credentials: {} })}
              >
                {platforms.map(p => (
                  <option key={p.platform} value={p.platform}>{platformLabels[p.platform] || p.platform}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Persona</label>
              <select
                className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-sm border border-gray-700 outline-none"
                value={newBot.persona_id}
                onChange={e => setNewBot({ ...newBot, persona_id: e.target.value })}
              >
                <option value="">-- Default --</option>
                {personas.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Credential Fields */}
          {selectedPlatformFields.length > 0 && (
            <div className="space-y-2">
              <label className="text-xs text-gray-400 mb-1 block">Credentials</label>
              {selectedPlatformFields.map(f => (
                <div key={f.key} className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 w-40">{f.label}</span>
                  <input
                    type={f.secret ? 'password' : 'text'}
                    className="flex-1 bg-gray-800 text-white px-3 py-1.5 rounded-lg text-sm border border-gray-700 focus:border-blue-500 outline-none"
                    value={newBot.credentials[f.key] || ''}
                    onChange={e => setNewBot({
                      ...newBot,
                      credentials: { ...newBot.credentials, [f.key]: e.target.value }
                    })}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Tool Selection */}
          <div>
            <label className="text-xs text-gray-400 mb-2 block">Enabled Tools</label>
            <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto">
              {tools.map(t => (
                <button
                  key={t.name}
                  onClick={() => {
                    const has = newBot.enabled_tools.includes(t.name);
                    setNewBot({
                      ...newBot,
                      enabled_tools: has
                        ? newBot.enabled_tools.filter(n => n !== t.name)
                        : [...newBot.enabled_tools, t.name],
                    });
                  }}
                  className={`px-2 py-1 rounded text-xs transition-colors ${
                    newBot.enabled_tools.includes(t.name)
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}
                >
                  {t.displayName}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-gray-400 hover:text-white text-sm">
              ยกเลิก
            </button>
            <button onClick={handleCreate} className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm">
              <Save className="w-4 h-4 inline mr-1" />
              บันทึก
            </button>
          </div>
        </div>
      )}

      {/* Root Runtime Config (single source) */}
      <div className="bg-gray-900 border border-blue-500/30 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-white font-medium">Root Admin Runtime Config</h3>
            <p className="text-xs text-gray-500 mt-1">Single source for Jarvis identity, supervisor routing, and Jarvis model baseline.</p>
          </div>
          <button
            onClick={saveRuntimeConfig}
            disabled={savingRuntime}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm"
          >
            <Save className="w-4 h-4 inline mr-1" />
            {savingRuntime ? 'Saving...' : 'Save Runtime Config'}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Root Bot ID</label>
            <input
              className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-sm border border-gray-700"
              value={runtimeSettings.jarvis_root_bot_id}
              onChange={(e) => setRuntimeSettings((prev) => ({ ...prev, jarvis_root_bot_id: e.target.value.trim().toLowerCase() }))}
              placeholder="jarvis-root-admin"
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Root Bot Name</label>
            <input
              className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-sm border border-gray-700"
              value={runtimeSettings.jarvis_root_bot_name}
              onChange={(e) => setRuntimeSettings((prev) => ({ ...prev, jarvis_root_bot_name: e.target.value }))}
              placeholder="Jarvis Root Admin"
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Root Persona Platform</label>
            <input
              className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-sm border border-gray-700"
              value={runtimeSettings.jarvis_root_persona_platform}
              onChange={(e) => setRuntimeSettings((prev) => ({ ...prev, jarvis_root_persona_platform: e.target.value }))}
              placeholder="system"
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Root Specialist Name</label>
            <input
              className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-sm border border-gray-700"
              value={runtimeSettings.jarvis_root_specialist_name}
              onChange={(e) => setRuntimeSettings((prev) => ({ ...prev, jarvis_root_specialist_name: e.target.value.trim().toLowerCase() }))}
              placeholder="jarvis-root-admin"
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Jarvis Provider</label>
            <select
              className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-sm border border-gray-700"
              value={runtimeSettings.swarm_jarvis_provider}
              onChange={(e) => setRuntimeSettings((prev) => ({ ...prev, swarm_jarvis_provider: e.target.value }))}
            >
              <option value="">Auto</option>
              {llmProviders.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Jarvis Model</label>
            <input
              className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-sm border border-gray-700 font-mono"
              value={runtimeSettings.swarm_jarvis_model}
              onChange={(e) => setRuntimeSettings((prev) => ({ ...prev, swarm_jarvis_model: e.target.value }))}
              placeholder="gpt-5.4 / claude-sonnet / gemini-2.5-pro"
            />
          </div>
        </div>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Supervisor Bot IDs (comma-separated)</label>
          <textarea
            rows={2}
            className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-sm border border-gray-700 font-mono"
            value={runtimeSettings.jarvis_supervisor_bot_ids}
            onChange={(e) => setRuntimeSettings((prev) => ({ ...prev, jarvis_supervisor_bot_ids: e.target.value }))}
            placeholder="jarvis-root-admin,jarvis-admin,specialist_jarvis-root-admin"
          />
        </div>
      </div>

      {/* Platform Identity (single source for AGENTS/IDENTITY/SOUL) */}
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 space-y-3">
        <div>
          <h3 className="text-white font-medium">Agent Identity (All Platforms)</h3>
          <p className="text-xs text-gray-500 mt-1">
            Single page for AGENTS / IDENTITY / SOUL across all agents.
            Tools are managed only in this page's tool sections (Jarvis + each bot card) to avoid mismatch.
          </p>
        </div>

        {PERSONA_PLATFORMS.map((platform) => {
          const current = personaFiles[platform.id];
          const isExpanded = expandedPersona === platform.id;
          const isSaving = savingPersonaPlatform === platform.id;

          return (
            <div key={platform.id} className="border border-gray-800 rounded-lg overflow-hidden">
              <button
                onClick={() => setExpandedPersona((prev) => (prev === platform.id ? null : platform.id))}
                className="w-full flex items-center justify-between px-4 py-3 bg-gray-800/50 hover:bg-gray-800/80 transition-colors"
              >
                <div className="text-left">
                  <p className="text-sm text-gray-200 font-medium">{platform.label}</p>
                  <p className="text-[10px] text-gray-500">{platform.id}</p>
                </div>
                {isExpanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
              </button>

              {isExpanded && current && (
                <div className="p-4 space-y-3">
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">AGENTS.md</label>
                    <textarea
                      rows={5}
                      spellCheck={false}
                      className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-xs border border-gray-700 font-mono"
                      value={current.agents}
                      onChange={(e) => updatePersonaField(platform.id, 'agents', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">IDENTITY.md</label>
                    <textarea
                      rows={5}
                      spellCheck={false}
                      className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-xs border border-gray-700 font-mono"
                      value={current.identity}
                      onChange={(e) => updatePersonaField(platform.id, 'identity', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">SOUL.md</label>
                    <textarea
                      rows={4}
                      spellCheck={false}
                      className="w-full bg-gray-800 text-white px-3 py-2 rounded-lg text-xs border border-gray-700 font-mono"
                      value={current.soul}
                      onChange={(e) => updatePersonaField(platform.id, 'soul', e.target.value)}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <p className="text-[11px] text-gray-500">
                      {platform.id === 'system'
                        ? 'Tools source: Jarvis Root Admin tools section below.'
                        : 'Tools source: each bot card Enabled Tools section below.'}
                    </p>
                    <button
                      onClick={() => savePersonaIdentity(platform.id)}
                      disabled={isSaving}
                      className="px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg text-xs"
                    >
                      <Save className="w-3.5 h-3.5 inline mr-1" />
                      {isSaving ? 'Saving...' : 'Save Identity'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Jarvis Root Admin — system agent */}
      <div className="bg-gray-900 border border-violet-500/30 rounded-xl overflow-hidden">
        <div className="flex items-center gap-3 p-4">
          <div className={`w-3 h-3 rounded-full ${jarvisEnabled ? 'bg-violet-400 animate-pulse' : 'bg-gray-600'}`} />
          <div className="px-2 py-0.5 rounded text-[10px] font-bold uppercase text-white bg-violet-600">SYSTEM</div>
          <div className="flex-1">
            <span className="text-white font-medium text-sm">Jarvis Root Admin</span>
            <span className="text-gray-600 text-xs ml-2">(system)</span>
          </div>
          <span className={`text-xs font-medium ${jarvisEnabled ? 'text-violet-400' : 'text-gray-500'}`}>
            {jarvisEnabled ? 'ACTIVE' : 'STOPPED'}
          </span>
          <button
            onClick={() => setJarvisEnabled(v => !v)}
            className="p-1.5 rounded-lg hover:bg-gray-800 transition-colors"
            title="Toggle Jarvis"
          >
            {jarvisEnabled
              ? <PowerOff className="w-4 h-4 text-yellow-400" />
              : <Power className="w-4 h-4 text-green-400" />}
          </button>
          <button
            onClick={() => setJarvisExpanded(v => !v)}
            className="p-1.5 rounded-lg hover:bg-gray-800 transition-colors"
          >
            {jarvisExpanded
              ? <ChevronDown className="w-4 h-4 text-gray-400" />
              : <ChevronRight className="w-4 h-4 text-gray-400" />}
          </button>
        </div>

        {jarvisExpanded && (
          <div className="border-t border-gray-800 p-4 space-y-4">
            <div>
              <h4 className="text-xs text-gray-400 font-medium mb-2 flex items-center gap-1">
                <Wrench className="w-3.5 h-3.5" /> Enabled Tools ({jarvisEnabledTools.length})
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {tools.map(t => {
                  const enabled = jarvisEnabledTools.includes(t.name);
                  return (
                    <button
                      key={t.name}
                      onClick={() => handleJarvisToolToggle(t.name)}
                      className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                        enabled
                          ? t.riskLevel === 'high' ? 'bg-red-600/30 text-red-300 border border-red-700' : 'bg-violet-600/30 text-violet-300 border border-violet-700'
                          : 'bg-gray-800 text-gray-500 hover:bg-gray-700'
                      }`}
                      title={`${t.description} [${t.riskLevel} risk]`}
                    >
                      {t.riskLevel === 'high' && enabled && <Shield className="w-3 h-3 inline mr-0.5" />}
                      {t.displayName}
                    </button>
                  );
                })}
                {jarvisUnknownTools.map((toolName) => (
                  <span
                    key={`jarvis-unknown-${toolName}`}
                    className="px-2 py-0.5 rounded text-[11px] bg-amber-600/20 text-amber-300 border border-amber-700"
                    title="Tool is enabled in TOOLS.md but not found in current tool registry"
                  >
                    {toolName} (unknown)
                  </span>
                ))}
              </div>
            </div>

            <div className="pt-4 border-t border-gray-800">
              <AgentRoutingOverview
                agentConfig={agentConfig}
                llmProviders={providers.filter(p => p.category === 'llm')}
                onToggleGlobalAuto={handleGlobalAutoRoutingChange}
                onUpdateGlobalRoute={handleGlobalRouteUpdate}
                savingKey={savingBotModelKey}
              />
            </div>
          </div>
        )}
      </div>

      {/* Bot List */}
      {bots.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <Bot className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p>ยังไม่มี Agent — คลิก "เพิ่ม Agent" เพื่อเริ่มต้น</p>
        </div>
      ) : (
        <div className="space-y-3">
          {bots.map(bot => {
            const modelSummary = botModelConfigs[bot.id];
            return (
            <div key={bot.id} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              {/* Bot header */}
              <div className="flex items-center gap-3 p-4">
                <div className={`w-3 h-3 rounded-full ${bot.status === 'active' ? 'bg-green-400 animate-pulse' : bot.status === 'error' ? 'bg-red-400' : 'bg-gray-600'}`} />
                <div className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase text-white ${platformColors[bot.platform] || 'bg-gray-600'}`}>
                  {platformLabels[bot.platform] || bot.platform}
                </div>
                <div className="flex-1">
                  <span className="text-white font-medium text-sm">{bot.name}</span>
                  <span className="text-gray-600 text-xs ml-2">({bot.id})</span>
                </div>
                <span className={`text-xs font-medium ${statusColors[bot.status]}`}>
                  {bot.status.toUpperCase()}
                </span>
                <button onClick={() => handleToggle(bot.id)} className="p-1.5 rounded-lg hover:bg-gray-800 transition-colors" title="Toggle">
                  {bot.status === 'active' ? <PowerOff className="w-4 h-4 text-yellow-400" /> : <Power className="w-4 h-4 text-green-400" />}
                </button>
                <button onClick={() => setExpandedId(expandedId === bot.id ? null : bot.id)} className="p-1.5 rounded-lg hover:bg-gray-800 transition-colors">
                  {expandedId === bot.id ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
                </button>
                <button onClick={() => handleDelete(bot.id)} className="p-1.5 rounded-lg hover:bg-red-900/50 transition-colors" title="Delete">
                  <Trash2 className="w-4 h-4 text-red-400" />
                </button>
              </div>

              {/* Error message */}
              {bot.last_error && (
                <div className="mx-4 mb-3 px-3 py-2 bg-red-900/30 border border-red-800 rounded-lg text-xs text-red-300 flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {bot.last_error}
                </div>
              )}

              {/* Expanded details */}
              {expandedId === bot.id && (
                <div className="border-t border-gray-800 p-4 space-y-4">
                  {/* Tools */}
                  <div>
                    <h4 className="text-xs text-gray-400 font-medium mb-2 flex items-center gap-1">
                      <Wrench className="w-3.5 h-3.5" /> Enabled Tools ({bot.enabled_tools.length})
                    </h4>
                    <div className="flex flex-wrap gap-1.5">
                      {tools.map(t => {
                        const enabled = bot.enabled_tools.includes(t.name);
                        return (
                          <button
                            key={t.name}
                            onClick={() => {
                              const updated = enabled
                                ? bot.enabled_tools.filter(n => n !== t.name)
                                : [...bot.enabled_tools, t.name];
                              handleUpdateTools(bot.id, updated);
                            }}
                            className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                              enabled
                                ? t.riskLevel === 'high' ? 'bg-red-600/30 text-red-300 border border-red-700' : 'bg-blue-600/30 text-blue-300 border border-blue-700'
                                : 'bg-gray-800 text-gray-500 hover:bg-gray-700'
                            }`}
                            title={`${t.description} [${t.riskLevel} risk]`}
                          >
                            {t.riskLevel === 'high' && enabled && <Shield className="w-3 h-3 inline mr-0.5" />}
                            {t.displayName}
                          </button>
                        );
                      })}
                      {bot.enabled_tools
                        .filter((toolName) => !tools.some((tool) => tool.name === toolName))
                        .map((toolName) => (
                          <span
                            key={`${bot.id}-unknown-${toolName}`}
                            className="px-2 py-0.5 rounded text-[11px] bg-amber-600/20 text-amber-300 border border-amber-700"
                            title="Tool is enabled on this agent but not found in current tool registry"
                          >
                            {toolName} (unknown)
                          </span>
                        ))}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-xs text-gray-400 font-medium flex items-center gap-1.5">
                        <Brain className="w-3.5 h-3.5 text-blue-400" />
                        Bot Model Overrides
                        <span className="text-[10px] text-gray-600 font-normal ml-1">(override global routing for this bot)</span>
                      </h4>
                      <label className="flex items-center gap-2 cursor-pointer group">
                        <span className="text-[10px] font-medium text-gray-500 group-hover:text-gray-400 transition-colors uppercase">
                          {modelSummary?.autoRouting ? 'Adaptive (Auto)' : 'Manual Selection'}
                        </span>
                        <div 
                          onClick={() => handleBotAutoRoutingChange(bot.id, !modelSummary?.autoRouting)}
                          className={`relative w-8 h-4 rounded-full transition-colors ${modelSummary?.autoRouting ? 'bg-blue-600' : 'bg-gray-700'}`}
                        >
                          <div className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform ${modelSummary?.autoRouting ? 'translate-x-4' : ''}`} />
                        </div>
                      </label>
                    </div>
                    <div className="space-y-2">
                      {AGENT_TASKS.map(task => {
                        const route = modelSummary?.modelConfig?.[task.id];
                        const active = (route as any)?.active ?? (route as any);
                        const provider = llmProviders.find(item => item.id === active?.provider);
                        const modelOptions = getModelOptions(active?.provider || provider?.id || '', active?.modelName);
                        const selectValue = route?.source === 'bot-override' ? active?.provider : '';
                        const saveKey = `${bot.id}:${task.id}`;

                        return (
                          <div key={`${bot.id}-${task.id}`} className="grid grid-cols-1 lg:grid-cols-[120px_1fr_1fr_auto] gap-2 items-center rounded-lg border border-gray-800 bg-gray-800/40 p-3">
                            <div>
                              <p className="text-xs text-gray-200">{task.name}</p>
                              <p className={`text-[10px] ${route?.source === 'bot-override' ? 'text-blue-300' : 'text-gray-500'}`}>
                                {route?.source || 'global'}
                              </p>
                            </div>

                            <div>
                              <label className="text-[10px] text-gray-500 uppercase block mb-1">
                                Provider {modelSummary?.autoRouting && <span className="text-blue-400 font-bold ml-1">ADAPTIVE</span>}
                              </label>
                              <select
                                value={modelSummary?.autoRouting ? (route?.resolvedProvider || active?.provider || '') : selectValue}
                                onChange={e => {
                                  const nextProviderId = e.target.value;
                                  if (!nextProviderId) {
                                    handleBotModelChange(bot.id, task.id, null);
                                    return;
                                  }
                                  const nextProvider = llmProviders.find(item => item.id === nextProviderId);
                                  const nextModel = nextProvider?.defaultModel || nextProvider?.models?.[0] || active?.modelName || '';
                                  handleBotModelChange(bot.id, task.id, nextProviderId, nextModel);
                                }}
                                disabled={modelSummary?.autoRouting || savingBotModelKey === saveKey}
                                className="w-full bg-gray-900 text-gray-200 px-3 py-2 rounded-lg text-xs border border-gray-700 disabled:opacity-70 disabled:grayscale-[0.5]"
                              >
                                {modelSummary?.autoRouting ? (
                                  <option value={route?.resolvedProvider || ''}>
                                    {llmProviders.find(p => p.id === route?.resolvedProvider)?.name || route?.resolvedProvider || 'Adaptive Choice'}
                                  </option>
                                ) : (
                                  <>
                                    <option value="">
                                      Use Global ({active?.provider || 'not set'})
                                    </option>
                                    {/* Union of unique providers from configured fallbacks and registry for manual choice */}
                                    {Array.from(new Set([
                                      ...(route?.fallbacks?.map((f: any) => f.provider) || []),
                                      ...llmProviders.map(p => p.id)
                                    ])).map(pId => {
                                      const p = llmProviders.find(item => item.id === pId);
                                      return (
                                        <option key={pId} value={pId}>
                                          {p?.name || pId}{p?.configured ? '' : ' (no key)'}
                                        </option>
                                      );
                                    })}
                                  </>
                                )}
                              </select>
                            </div>

                            <div>
                              <label className="text-[10px] text-gray-500 uppercase block mb-1">
                                Model {modelSummary?.autoRouting && <span className="text-blue-400 font-bold ml-1">ADAPTIVE</span>}
                              </label>
                              <select
                                value={modelSummary?.autoRouting ? (route?.resolvedModel || active?.modelName || '') : (active?.modelName || '')}
                                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => handleBotModelChange(bot.id, task.id, active?.provider || provider?.id || null, e.target.value)}
                                disabled={modelSummary?.autoRouting || !active?.provider || savingBotModelKey === saveKey}
                                className="w-full bg-gray-900 text-gray-200 px-3 py-2 rounded-lg text-xs border border-gray-700 font-mono disabled:opacity-70 disabled:grayscale-[0.5]"
                              >
                                {modelSummary?.autoRouting ? (
                                  <option value={route?.resolvedModel || ''}>{route?.resolvedModel || 'Adaptive Choice'}</option>
                                ) : (
                                  <>
                                    <option value="">Select Model</option>
                                    {/* Show models from the selected provider, privileging those in fallbacks list if defined */}
                                    {(() => {
                                      const providerId = active?.provider || provider?.id;
                                      const registryModels = llmProviders.find(p => p.id === providerId)?.models || [];
                                      const fallbackModels = (route?.fallbacks || [])
                                        .filter((f: any) => f.provider === providerId)
                                        .map((f: any) => f.modelName);
                                      
                                      return Array.from(new Set([...fallbackModels, ...registryModels])).map(m => (
                                        <option key={m} value={m}>{m}</option>
                                      ));
                                    })()}
                                  </>
                                )}
                              </select>
                            </div>

                            <div className="flex items-center justify-end gap-2">
                              <span className="text-[10px] text-gray-500 font-mono min-w-[140px] text-right">
                                {active?.provider || 'not set'} / {active?.modelName || 'not set'}
                              </span>
                              {savingBotModelKey === saveKey && <Save className="w-3.5 h-3.5 text-blue-400 animate-pulse" />}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Info */}
                  <div className="grid grid-cols-3 gap-4 text-xs">
                    <div>
                      <span className="text-gray-500">Persona:</span>
                      <span className="text-gray-300 ml-1">{bot.persona_id || 'Default'}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Created:</span>
                      <span className="text-gray-300 ml-1">{new Date(bot.created_at).toLocaleDateString('th-TH')}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Updated:</span>
                      <span className="text-gray-300 ml-1">{new Date(bot.updated_at).toLocaleDateString('th-TH')}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

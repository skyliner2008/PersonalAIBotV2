import { useState, useEffect, useCallback, useMemo } from 'react';
import { Save, Loader2 } from 'lucide-react';
import { api } from '../services/api';
import { useToast } from '../components/Toast';
import { FacebookSettings } from './settings/FacebookSettings';
import { APIProviders } from './settings/APIProviders';
import { AgentRoutingOverview } from './settings/AgentRoutingOverview';
import { AITaskRouting } from './settings/AITaskRouting';
import { GeneralSettings } from './settings/GeneralSettings';
import { RegistryProvider, AgentRouteConfig, BotRouteSummary, AgentBotSummary, GlobalRoutingConfig } from './settings/types';

interface Props {
  status: { browser: boolean; loggedIn: boolean; chatBot: boolean; commentBot: boolean };
  emit: (event: string, data?: any) => void;
  on: (event: string, handler: (...args: any[]) => void) => () => void;
}

export function Settings({ status, emit, on }: Props) {
  const { addToast } = useToast();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [registryProviders, setRegistryProviders] = useState<RegistryProvider[]>([]);
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [agentConfig, setAgentConfig] = useState<GlobalRoutingConfig>({ autoRouting: false, routes: {} });
  const [agentBots, setAgentBots] = useState<AgentBotSummary[]>([]);
  const [agentBotModels, setAgentBotModels] = useState<Record<string, BotRouteSummary>>({});

  // Load initial data
  useEffect(() => {
    loadSettings();
    loadProviders();
    loadAgentRouting();
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const data = await api.getSettings();
      const map: Record<string, string> = {};
      if (Array.isArray(data)) {
        data.forEach((s: any) => { map[s.key] = s.value; });
      } else {
        Object.assign(map, data);
      }
      setSettings(map);
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  }, []);

  const loadProviders = useCallback(async () => {
    try {
      const result = await api.getProviders();
      if (result.providers) {
        setRegistryProviders(result.providers);
      }
    } catch (e) {
      console.warn('Failed to load providers from registry');
    }
  }, []);

  const loadAgentRouting = useCallback(async () => {
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
  }, []);

  const handleToggleGlobalAuto = useCallback(async (enabled: boolean) => {
    try {
      await api.setAgentConfig({ autoRouting: enabled });
      loadAgentRouting();
    } catch (err) {
      console.error('Failed to toggle global auto routing:', err);
    }
  }, [loadAgentRouting]);

  const handleUpdateGlobalRoute = useCallback(async (taskType: string, provider: string, model: string) => {
    try {
      const routes: Record<string, any> = { ...agentConfig.routes, [taskType]: { active: { provider, modelName: model } } };
      await api.setAgentConfig({ routes });
      loadAgentRouting();
    } catch (err) {
      console.error('Failed to update global route:', err);
    }
  }, [agentConfig, loadAgentRouting]);

  const handleToggleBotAuto = useCallback(async (botId: string, enabled: boolean) => {
    try {
      await api.setBotModel(botId, { autoRouting: enabled });
      loadAgentRouting();
    } catch (err) {
      console.error('Failed to toggle bot auto routing:', err);
    }
  }, [loadAgentRouting]);

  const handleUpdateBotRoute = useCallback(async (botId: string, taskType: string, provider: string, model: string) => {
    try {
      await api.setBotModel(botId, { 
        taskType, 
        provider, 
        modelName: model 
      });
      loadAgentRouting();
    } catch (err) {
      console.error('Failed to update bot route:', err);
    }
  }, [loadAgentRouting]);

  const updateSetting = useCallback((key: string, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await api.setSettingsBulk(settings);
      addToast('success', 'Settings saved successfully');
    } catch (e) {
      console.error('Failed to save settings:', e);
      addToast('error', e instanceof Error ? e.message : 'Failed to save settings');
    }
    setSaving(false);
  }, [settings, addToast]);

  const llmProviders = useMemo(() => {
    return registryProviders.filter(p => p.category === 'llm');
  }, [registryProviders]);

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <h2 className="text-2xl font-bold text-white">Settings</h2>

      {/* Facebook Settings */}
      <FacebookSettings status={status} emit={emit} on={on} />

      {/* API Providers */}
      <APIProviders
        registryProviders={registryProviders}
        onProvidersUpdate={setRegistryProviders}
      />

      {/* Agent Routing Overview */}
      <AgentRoutingOverview
        agentConfig={agentConfig}
        llmProviders={llmProviders}
        onToggleGlobalAuto={handleToggleGlobalAuto}
        onUpdateGlobalRoute={handleUpdateGlobalRoute}
      />

      {/* AI Task Routing */}
      <AITaskRouting
        settings={settings}
        llmProviders={llmProviders}
        models={models}
        onSettingChange={updateSetting}
      />

      {/* General Settings */}
      <GeneralSettings
        settings={settings}
        onSettingChange={updateSetting}
      />

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-6 py-2.5 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 text-sm font-medium border border-blue-500/30 disabled:opacity-50"
        >
          <Save className="w-4 h-4" /> {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  );
}

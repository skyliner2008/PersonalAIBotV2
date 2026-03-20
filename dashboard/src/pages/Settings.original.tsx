import { useState, useEffect, useRef } from 'react';
import { api } from '../services/api';
import { useToast } from '../components/Toast';
import {
  Settings as SettingsIcon, Key, Brain, Globe, Save, CheckCircle,
  XCircle, Loader2, RefreshCw, AlertTriangle, Plus, Trash2, Eye, EyeOff,
  Search, Mic, Image, MessageSquare, ChevronDown, ChevronRight, Power,
  Cpu, Database, Edit3,
} from 'lucide-react';

interface Props {
  status: { browser: boolean; loggedIn: boolean; chatBot: boolean; commentBot: boolean };
  emit: (event: string, data?: any) => void;
  on: (event: string, handler: (...args: any[]) => void) => () => void;
}

interface RegistryProvider {
  id: string;
  name: string;
  category: string;
  type: string;
  baseUrl?: string;
  defaultModel?: string;
  models?: string[];
  capabilities: Record<string, boolean>;
  apiKeyEnvVar: string;
  enabled: boolean;
  configured: boolean;
  requiresAuth?: boolean;
  customHeaders?: Record<string, string>;
  extraConfig?: Record<string, string>;
  endpointTemplate?: string;
  notes?: string;
}

interface AgentRouteConfig {
  provider: string;
  modelName: string;
  source?: string;
}

interface BotRouteSummary {
  botId: string;
  botName: string;
  modelConfig: Record<string, AgentRouteConfig>;
}

interface AgentBotSummary {
  id: string;
  name: string;
  platform: string;
  status: string;
}

// Category display configuration
const CATEGORY_CONFIG: Record<string, { label: string; labelTh: string; icon: any; color: string; description: string }> = {
  llm:       { label: 'LLM / Chat AI',      labelTh: 'AI สนทนา',         icon: Cpu,           color: 'text-blue-400',   description: 'ผู้ให้บริการ AI สำหรับสนทนาและสร้างข้อความ' },
  embedding: { label: 'Embedding',           labelTh: 'Embedding',        icon: Database,       color: 'text-green-400',  description: 'แปลงข้อความเป็น Vector สำหรับ Memory System' },
  search:    { label: 'Web Search',          labelTh: 'ค้นหาเว็บ',       icon: Search,         color: 'text-cyan-400',   description: 'ค้นหาข้อมูลจากอินเทอร์เน็ต' },
  tts:       { label: 'Text-to-Speech',      labelTh: 'แปลงเสียง',       icon: Mic,            color: 'text-orange-400', description: 'แปลงข้อความเป็นเสียงพูด' },
  image:     { label: 'Image Generation',    labelTh: 'สร้างภาพ',        icon: Image,          color: 'text-pink-400',   description: 'สร้างภาพจากข้อความ (AI Art)' },
  platform:  { label: 'Messaging Platforms', labelTh: 'แพลตฟอร์มแชท',   icon: MessageSquare,  color: 'text-purple-400', description: 'เชื่อมต่อแพลตฟอร์มแชทต่างๆ' },
};

const AGENT_TASKS = [
  { id: 'general', name: 'General', desc: 'General chat and lightweight tasks' },
  { id: 'complex', name: 'Complex', desc: 'Long-form and multi-step work' },
  { id: 'thinking', name: 'Thinking', desc: 'Reasoning and decision tasks' },
  { id: 'code', name: 'Code', desc: 'Coding and refactoring tasks' },
  { id: 'data', name: 'Data', desc: 'Data analysis and structured outputs' },
  { id: 'web', name: 'Web', desc: 'Web lookup and browsing tasks' },
  { id: 'vision', name: 'Vision', desc: 'Images and multimodal tasks' },
  { id: 'system', name: 'System', desc: 'Internal/system tasks' },
];

export function Settings({ status, emit, on }: Props) {
  const { addToast } = useToast();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, boolean>>({});
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [fbEmail, setFbEmail] = useState('');
  const [fbPassword, setFbPassword] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [fbMessage, setFbMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const loginTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Provider management state
  const [registryProviders, setRegistryProviders] = useState<RegistryProvider[]>([]);
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({
    llm: true, embedding: false, search: false, tts: false, image: false, platform: false,
  });
  const [showKeyFor, setShowKeyFor] = useState<Record<string, boolean>>({});
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savingModel, setSavingModel] = useState<string | null>(null);
  const [agentConfig, setAgentConfig] = useState<Record<string, AgentRouteConfig>>({});
  const [agentBots, setAgentBots] = useState<AgentBotSummary[]>([]);
  const [agentBotModels, setAgentBotModels] = useState<Record<string, BotRouteSummary>>({});

  // Add Provider modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [addCategory, setAddCategory] = useState('llm');
  const [newProvider, setNewProvider] = useState({
    id: '', name: '', type: 'openai-compatible', baseUrl: '', defaultModel: '', apiKeyEnvVar: '',
    models: '' as string, endpointTemplate: '', notes: '',
    customHeaders: '' as string, // JSON string for custom headers
    extraConfig: '' as string,   // JSON string for extra config (e.g. groupId)
  });

  // Edit Provider modal
  const [showEditModal, setShowEditModal] = useState(false);
  const [editProvider, setEditProvider] = useState<{
    id: string; name: string; type: string; baseUrl: string; defaultModel: string;
    apiKeyEnvVar: string; models: string; endpointTemplate: string; notes: string;
    customHeaders: string; extraConfig: string; category: string;
  } | null>(null);

  useEffect(() => { loadSettings(); loadProviders(); loadAgentRouting(); }, []);

  async function loadProviders() {
    try {
      const result = await api.getProviders();
      if (result.providers) {
        setRegistryProviders(result.providers);
        // Pre-fetch models for all configured providers
        for (const provider of result.providers) {
          if (provider.configured) {
            handleLoadModels(provider.id);
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load providers from registry');
    }
  }

  async function loadAgentRouting() {
    try {
      const [configResult, botsResult] = await Promise.all([
        api.getAgentConfig(),
        api.getBots(),
      ]);

      setAgentConfig((configResult || {}) as Record<string, AgentRouteConfig>);

      const bots = Array.isArray(botsResult) ? botsResult as AgentBotSummary[] : [];
      setAgentBots(bots);

      const botModelEntries = await Promise.all(
        bots.map(async (bot) => {
          try {
            const modelConfig = await api.getBotModels(bot.id) as BotRouteSummary;
            return [bot.id, modelConfig] as const;
          } catch {
            return [bot.id, {
              botId: bot.id,
              botName: bot.name,
              modelConfig: {},
            }] as const;
          }
        })
      );

      setAgentBotModels(Object.fromEntries(botModelEntries));
    } catch (e) {
      console.warn('Failed to load agent routing overview', e);
    }
  }

  useEffect(() => {
    const unsub1 = on('fb:loginResult', (data: { success: boolean; message?: string }) => {
      setLoggingIn(false);
      if (loginTimeoutRef.current) clearTimeout(loginTimeoutRef.current);
      if (data.success) {
        setFbMessage({ type: 'success', text: data.message || 'Login successful!' });
      } else {
        setFbMessage({ type: 'error', text: data.message || 'Login failed' });
      }
    });
    const unsub2 = on('error', (data: { message: string }) => {
      setLoggingIn(false);
      if (loginTimeoutRef.current) clearTimeout(loginTimeoutRef.current);
      setFbMessage({ type: 'error', text: data.message });
    });
    return () => {
      unsub1();
      unsub2();
      if (loginTimeoutRef.current) clearTimeout(loginTimeoutRef.current);
    };
  }, [on]);

  async function loadSettings() {
    try {
      const data = await api.getSettings();
      const map: Record<string, string> = {};
      if (Array.isArray(data)) {
        data.forEach((s: any) => { map[s.key] = s.value; });
      } else {
        Object.assign(map, data);
      }
      setSettings(map);
      setFbEmail(map['fb_email'] || '');
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  }

  function updateSetting(key: string, value: string) {
    setSettings(prev => ({ ...prev, [key]: value }));
  }

  function removeSetting(key: string) {
    setSettings(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      // Batch save all settings in a single request
      await api.setSettingsBulk(settings);
      addToast('success', 'Settings saved successfully');
    } catch (e) {
      console.error('Failed to save settings:', e);
      addToast('error', e instanceof Error ? e.message : 'Failed to save settings');
    }
    setSaving(false);
  }

  async function handleTestProvider(providerId: string) {
    setTesting(providerId);
    try {
      const result = await api.testProvider(providerId);
      setTestResults(prev => ({ ...prev, [providerId]: result.success }));
      addToast(result.success ? 'success' : 'warning', result.success
        ? `Provider "${providerId}" connection successful`
        : `Provider "${providerId}" connection failed`);
    } catch {
      try {
        const keyField = `ai_${providerId}_key`;
        const result = await api.testAI(providerId, settings[keyField] || '');
        setTestResults(prev => ({ ...prev, [providerId]: result.success }));
        addToast(result.success ? 'success' : 'warning', result.success
          ? `Provider "${providerId}" connection successful`
          : `Provider "${providerId}" connection failed`);
      } catch {
        setTestResults(prev => ({ ...prev, [providerId]: false }));
        addToast('error', `Provider "${providerId}" connection failed`);
      }
    }
    setTesting(null);
  }

  const [loadingModels, setLoadingModels] = useState<string | null>(null);

  const [modelSource, setModelSource] = useState<Record<string, string>>({});

  async function handleLoadModels(providerId: string) {
    setLoadingModels(providerId);
    try {
      const result = await api.getProviderModels(providerId);
      if (result.models && result.models.length > 0) {
        setModels(prev => ({ ...prev, [providerId]: result.models }));
        setModelSource(prev => ({ ...prev, [providerId]: result.source || 'registry' }));
        addToast('success', `Loaded ${result.models.length} models for "${providerId}"`);
      } else {
        setModels(prev => ({ ...prev, [providerId]: [] }));
        setModelSource(prev => ({ ...prev, [providerId]: 'none' }));
        addToast('warning', `No models found for "${providerId}"`);
      }
    } catch (e) {
      setModels(prev => ({ ...prev, [providerId]: [] }));
      setModelSource(prev => ({ ...prev, [providerId]: 'error' }));
      addToast('error', e instanceof Error ? e.message : `Failed to load models for "${providerId}"`);
    }
    setLoadingModels(null);
  }

  async function handleSaveKey(providerId: string) {
    const key = providerKeys[providerId];
    if (!key) return;
    setSavingKey(providerId);
    try {
      await api.setProviderKey(providerId, key);
      setProviderKeys(prev => {
        const next = { ...prev };
        delete next[providerId];
        return next;
      });
      removeSetting(`ai_${providerId}_key`);
      await loadProviders();
      setTestResults(prev => { const n = { ...prev }; delete n[providerId]; return n; });
      addToast('success', `Saved key for "${providerId}"`);
    } catch (e) {
      console.error('Failed to save key:', e);
      addToast('error', e instanceof Error ? e.message : 'Failed to save provider key');
    }
    setSavingKey(null);
  }

  async function handleDeleteKey(providerId: string) {
    try {
      await api.deleteProviderKey(providerId);
      setProviderKeys(prev => { const n = { ...prev }; delete n[providerId]; return n; });
      removeSetting(`ai_${providerId}_key`);
      await loadProviders();
      setTestResults(prev => { const n = { ...prev }; delete n[providerId]; return n; });
      addToast('success', `Deleted key for "${providerId}"`);
    } catch (e) {
      console.error('Failed to delete key:', e);
      addToast('error', e instanceof Error ? e.message : 'Failed to delete provider key');
    }
  }

  async function handleToggleProvider(providerId: string) {
    try {
      const result = await api.toggleProvider(providerId);
      await loadProviders();
      addToast('info', `Provider "${providerId}" ${result?.enabled ? 'enabled' : 'disabled'}`);
    } catch (e) {
      console.error('Failed to toggle provider:', e);
      addToast('error', e instanceof Error ? e.message : 'Failed to toggle provider');
    }
  }

  function getProviderModelSettingKey(providerId: string): string {
    return `ai_${providerId}_model`;
  }

  function getSelectedProviderModel(provider: RegistryProvider): string {
    if (provider.category === 'llm') {
      return settings[getProviderModelSettingKey(provider.id)] || provider.defaultModel || '';
    }
    return provider.defaultModel || '';
  }

  function getAvailableModels(provider: RegistryProvider): string[] {
    const selectedModel = getSelectedProviderModel(provider);
    return Array.from(new Set([
      ...(provider.models || []),
      ...(models[provider.id] || []),
      provider.defaultModel || '',
      selectedModel || '',
    ].map(model => model.trim()).filter(Boolean)));
  }

  async function handleProviderModelChange(provider: RegistryProvider, model: string) {
    const nextModel = model.trim();
    const settingKey = getProviderModelSettingKey(provider.id);
    const previousModel = settings[settingKey] || '';

    setSavingModel(provider.id);
    try {
      if (provider.category === 'llm') {
        updateSetting(settingKey, nextModel);
        await api.setSetting(settingKey, nextModel);
      } else {
        await api.updateProvider(provider.id, { defaultModel: nextModel });
        setRegistryProviders(prev => prev.map(item => (
          item.id === provider.id
            ? {
                ...item,
                defaultModel: nextModel,
                models: Array.from(new Set([...(item.models || []), nextModel].filter(Boolean))),
              }
            : item
        )));
      }

      addToast('success', `Updated model for "${provider.id}"`);
    } catch (e) {
      if (provider.category === 'llm') {
        updateSetting(settingKey, previousModel);
      }
      addToast('error', e instanceof Error ? e.message : `Failed to update model for "${provider.id}"`);
    }
    setSavingModel(null);
  }

  function parseOptionalJsonObject(raw: string, fieldLabel: string): Record<string, string> | undefined {
    if (!raw.trim()) return undefined;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error(`${fieldLabel} must be a JSON object`);
      }
      return parsed as Record<string, string>;
    } catch {
      throw new Error(`${fieldLabel} must be valid JSON object syntax`);
    }
  }

  async function handleAddProvider() {
    if (!newProvider.id || !newProvider.name) return;
    try {
      const customHeaders = parseOptionalJsonObject(newProvider.customHeaders, 'Custom Headers');
      const extraConfig = parseOptionalJsonObject(newProvider.extraConfig, 'Extra Config');

      await api.addProvider({
        id: newProvider.id,
        name: newProvider.name,
        type: newProvider.type,
        baseUrl: newProvider.baseUrl,
        defaultModel: newProvider.defaultModel,
        apiKeyEnvVar: newProvider.apiKeyEnvVar || `${newProvider.id.toUpperCase().replace(/-/g, '_')}_API_KEY`,
        models: newProvider.models ? newProvider.models.split(',').map(m => m.trim()).filter(Boolean) : [],
        endpointTemplate: newProvider.endpointTemplate || undefined,
        notes: newProvider.notes || undefined,
        customHeaders,
        extraConfig,
        category: addCategory,
        capabilities: {},
        requiresAuth: true,
        enabled: true,
      });
      setShowAddModal(false);
      setNewProvider({ id: '', name: '', type: 'openai-compatible', baseUrl: '', defaultModel: '', apiKeyEnvVar: '', models: '', endpointTemplate: '', notes: '', customHeaders: '', extraConfig: '' });
      await loadProviders();
      addToast('success', `Added provider "${newProvider.name}"`);
    } catch (e: any) {
      addToast('error', e.message || 'Failed to add provider');
    }
  }

  function openEditModal(provider: RegistryProvider) {
    setEditProvider({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      baseUrl: provider.baseUrl || '',
      defaultModel: provider.defaultModel || '',
      apiKeyEnvVar: provider.apiKeyEnvVar || '',
      models: (provider.models || []).join(', '),
      endpointTemplate: provider.endpointTemplate || '',
      notes: provider.notes || '',
      customHeaders: provider.customHeaders ? JSON.stringify(provider.customHeaders, null, 2) : '',
      extraConfig: provider.extraConfig ? JSON.stringify(provider.extraConfig, null, 2) : '',
      category: provider.category,
    });
    setShowEditModal(true);
  }

  async function handleSaveEdit() {
    if (!editProvider) return;
    try {
      const customHeaders = parseOptionalJsonObject(editProvider.customHeaders, 'Custom Headers');
      const extraConfig = parseOptionalJsonObject(editProvider.extraConfig, 'Extra Config');

      await api.updateProvider(editProvider.id, {
        name: editProvider.name,
        type: editProvider.type,
        baseUrl: editProvider.baseUrl,
        defaultModel: editProvider.defaultModel,
        apiKeyEnvVar: editProvider.apiKeyEnvVar,
        models: editProvider.models ? editProvider.models.split(',').map(m => m.trim()).filter(Boolean) : [],
        endpointTemplate: editProvider.endpointTemplate || undefined,
        notes: editProvider.notes || undefined,
        customHeaders,
        extraConfig,
      });
      setShowEditModal(false);
      setEditProvider(null);
      await loadProviders();
      addToast('success', `Updated provider "${editProvider.name}"`);
    } catch (e: any) {
      addToast('error', e.message || 'Failed to update provider');
    }
  }

  async function handleRemoveProvider(providerId: string) {
    if (!confirm(`ลบ provider "${providerId}" ออกจากระบบ?`)) return;
    try {
      await api.removeProvider(providerId);
      await loadProviders();
      addToast('success', `Removed provider "${providerId}"`);
    } catch (e) {
      console.error('Failed to remove provider:', e);
      addToast('error', e instanceof Error ? e.message : 'Failed to remove provider');
    }
  }

  async function handleFbLogin() {
    if (!fbEmail || !fbPassword) return;
    setLoggingIn(true);
    setFbMessage({ type: 'info', text: 'Launching browser and logging in...' });
    try {
      await api.setSetting('fb_email', fbEmail);
      emit('fb:login', { email: fbEmail, password: fbPassword });
      if (loginTimeoutRef.current) clearTimeout(loginTimeoutRef.current);
      loginTimeoutRef.current = setTimeout(() => {
        setLoggingIn(prev => {
          if (prev) setFbMessage({ type: 'error', text: 'Login timed out - check server terminal for errors' });
          return false;
        });
      }, 60000);
    } catch (e: any) {
      setLoggingIn(false);
      setFbMessage({ type: 'error', text: `Error: ${e.message}` });
    }
  }

  function toggleCategory(cat: string) {
    setExpandedCategories(prev => ({ ...prev, [cat]: !prev[cat] }));
  }

  // Group providers by category
  const providersByCategory: Record<string, RegistryProvider[]> = {};
  for (const p of registryProviders) {
    if (!providersByCategory[p.category]) providersByCategory[p.category] = [];
    providersByCategory[p.category].push(p);
  }

  const categories = Object.keys(CATEGORY_CONFIG);
  const llmProviders = providersByCategory['llm'] || [];
  const taskRoutingProviders = llmProviders.filter(provider =>
    ['gemini', 'openai-compatible', 'anthropic'].includes(provider.type)
  );

  const taskTypes = [
    { id: 'chat', name: 'Chat Bot', desc: 'Messenger replies' },
    { id: 'content', name: 'Content Creator', desc: 'Auto-post content' },
    { id: 'comment', name: 'Comment Reply', desc: 'Comment responses' },
    { id: 'summary', name: 'Summarizer', desc: 'Conversation summary' },
  ];

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <h2 className="text-2xl font-bold text-white">Settings</h2>

      {/* Facebook Account */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
          <Globe className="w-4 h-4 text-blue-400" /> Facebook Account
        </h3>
        <div className="flex items-center gap-2 mb-2">
          <span className={`w-2 h-2 rounded-full ${status.loggedIn ? 'bg-green-400' : 'bg-gray-600'}`} />
          <span className="text-xs text-gray-400">
            {status.loggedIn ? 'Logged in' : status.browser ? 'Browser running, not logged in' : 'Browser not started'}
          </span>
        </div>
        {fbMessage && (
          <div className={`p-3 rounded-lg text-xs flex items-center gap-2 ${
            fbMessage.type === 'success' ? 'bg-green-500/10 text-green-400 border border-green-500/20' :
            fbMessage.type === 'error' ? 'bg-red-500/10 text-red-400 border border-red-500/20' :
            'bg-blue-500/10 text-blue-400 border border-blue-500/20'
          }`}>
            {fbMessage.type === 'success' && <CheckCircle className="w-4 h-4 shrink-0" />}
            {fbMessage.type === 'error' && <AlertTriangle className="w-4 h-4 shrink-0" />}
            {fbMessage.type === 'info' && <Loader2 className="w-4 h-4 shrink-0 animate-spin" />}
            {fbMessage.text}
          </div>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Email / Phone</label>
            <input
              value={fbEmail}
              onChange={e => setFbEmail(e.target.value)}
              placeholder="your@email.com"
              className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Password</label>
            <input
              type="password"
              value={fbPassword}
              onChange={e => setFbPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleFbLogin}
            disabled={loggingIn || !fbEmail || !fbPassword}
            className="px-4 py-2 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 text-xs font-medium border border-blue-500/30 disabled:opacity-50 flex items-center gap-2"
          >
            {loggingIn && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {loggingIn ? 'Logging in...' : 'Login to Facebook'}
          </button>
          <span className="text-[10px] text-gray-600">
            Browser will open automatically. First login may require 2FA.
          </span>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════
          API Providers - ALL CATEGORIES
          ═══════════════════════════════════════════════════════ */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
            <Key className="w-4 h-4 text-yellow-400" /> API Providers
            <span className="text-[10px] text-gray-600 ml-2">
              ({registryProviders.length} providers, {registryProviders.filter(p => p.configured).length} configured)
            </span>
          </h3>
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] bg-green-500/15 text-green-400 rounded-lg hover:bg-green-500/25 border border-green-500/30 font-medium"
          >
            <Plus className="w-3.5 h-3.5" /> เพิ่ม Provider ใหม่
          </button>
        </div>
        <p className="text-xs text-gray-500">
          จัดการ API Key สำหรับทุก provider — คลิกที่หมวดเพื่อดูรายละเอียด
        </p>

        {/* Category Sections */}
        {categories.map(cat => {
          const config = CATEGORY_CONFIG[cat];
          const providers = providersByCategory[cat] || [];
          const configuredCount = providers.filter(p => p.configured).length;
          const IconComp = config.icon;
          const isExpanded = expandedCategories[cat];

          return (
            <div key={cat} className="border border-gray-800 rounded-lg overflow-hidden">
              {/* Category Header */}
              <button
                onClick={() => toggleCategory(cat)}
                className="w-full flex items-center justify-between px-4 py-3 bg-gray-800/50 hover:bg-gray-800/80 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <IconComp className={`w-4 h-4 ${config.color}`} />
                  <div className="text-left">
                    <span className="text-xs font-semibold text-gray-200">{config.label}</span>
                    <span className="text-[10px] text-gray-500 ml-2">{config.labelTh}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] text-gray-500">
                    {configuredCount}/{providers.length} configured
                  </span>
                  {configuredCount > 0 && (
                    <span className="w-2 h-2 rounded-full bg-green-400" />
                  )}
                  {isExpanded
                    ? <ChevronDown className="w-4 h-4 text-gray-500" />
                    : <ChevronRight className="w-4 h-4 text-gray-500" />
                  }
                </div>
              </button>

              {/* Provider List */}
              {isExpanded && (
                <div className="p-3 space-y-2">
                  <p className="text-[10px] text-gray-600 px-1">{config.description}</p>

                  {providers.length === 0 ? (
                    <p className="text-xs text-gray-600 text-center py-4">
                      ยังไม่มี provider ในหมวดนี้ — กด "เพิ่ม Provider ใหม่" เพื่อเพิ่ม
                    </p>
                  ) : (
                    providers.map(provider => {
                      const availableModels = getAvailableModels(provider);
                      const selectedModel = getSelectedProviderModel(provider);
                      const shouldShowModels =
                        availableModels.length > 0
                        || loadingModels === provider.id
                        || modelSource[provider.id] !== undefined;

                      return (
                      <ProviderCard
                        key={provider.id}
                        provider={provider}
                        providerKey={providerKeys[provider.id] || ''}
                        showKey={showKeyFor[provider.id] || false}
                        testResult={testResults[provider.id]}
                        isTesting={testing === provider.id}
                        isSavingKey={savingKey === provider.id}
                        isSavingModel={savingModel === provider.id}
                        isLoadingModels={loadingModels === provider.id}
                        modelList={shouldShowModels ? availableModels : undefined}
                        modelSource={modelSource[provider.id]}
                        selectedModel={selectedModel}
                        onKeyChange={(v) => setProviderKeys(prev => ({ ...prev, [provider.id]: v }))}
                        onToggleShowKey={() => setShowKeyFor(prev => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                        onSaveKey={() => handleSaveKey(provider.id)}
                        onDeleteKey={() => handleDeleteKey(provider.id)}
                        onTest={() => handleTestProvider(provider.id)}
                        onLoadModels={() => handleLoadModels(provider.id)}
                        onModelChange={(value) => handleProviderModelChange(provider, value)}
                        onToggleEnabled={() => handleToggleProvider(provider.id)}
                        onRemove={() => handleRemoveProvider(provider.id)}
                        onEdit={() => openEditModal(provider)}
                      />
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Agent Routing Overview */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
          <Brain className="w-4 h-4 text-cyan-400" /> Agent Routing Overview
        </h3>
        <p className="text-xs text-gray-500">
          This shows the provider/model baseline the agent runtime will start from. Each bot can still override per task in Agent Manager, and the runtime can still fail over when needed.
        </p>

        <div className="bg-gray-800/30 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-gray-300">Global Agent Defaults</p>
            <span className="text-[10px] text-gray-500">Source: /api/config</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {AGENT_TASKS.map(task => {
              const route = agentConfig[task.id];
              const provider = llmProviders.find(item => item.id === route?.provider);
              return (
                <div key={task.id} className="rounded-lg border border-gray-800 bg-gray-900/60 p-3 space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium text-gray-200">{task.name}</p>
                      <p className="text-[10px] text-gray-600">{task.desc}</p>
                    </div>
                    <span className={`text-[10px] px-2 py-1 rounded border ${
                      provider?.configured && provider?.enabled
                        ? 'border-green-500/30 text-green-400 bg-green-500/10'
                        : 'border-yellow-500/30 text-yellow-400 bg-yellow-500/10'
                    }`}>
                      {route?.provider || 'not set'}
                    </span>
                  </div>
                  <p className="text-[11px] text-gray-400 font-mono">{route?.modelName || 'No model selected'}</p>
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-gray-300">Per-Agent Baselines</p>
            <span className="text-[10px] text-gray-500">Configure overrides in Agent Manager</span>
          </div>

          {agentBots.length === 0 ? (
            <p className="text-xs text-gray-600 text-center py-4">No AI agents registered yet.</p>
          ) : (
            agentBots.map(bot => {
              const summary = agentBotModels[bot.id];

              return (
                <div key={bot.id} className="rounded-lg border border-gray-800 bg-gray-800/30 p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium text-gray-200">{bot.name}</p>
                      <p className="text-[10px] text-gray-600">{bot.id} | {bot.platform} | {bot.status}</p>
                    </div>
                    <span className="text-[10px] text-gray-500">
                      {Object.values(summary?.modelConfig || {}).filter(route => route.source === 'bot-override').length} overrides
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {AGENT_TASKS.map(task => {
                      const route = summary?.modelConfig?.[task.id];
                      return (
                        <div key={`${bot.id}-${task.id}`} className="rounded-lg border border-gray-800 bg-gray-900/50 p-3">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] text-gray-300">{task.name}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                              route?.source === 'bot-override'
                                ? 'bg-blue-500/15 text-blue-300'
                                : 'bg-gray-800 text-gray-500'
                            }`}>
                              {route?.source || 'global'}
                            </span>
                          </div>
                          <p className="text-[11px] text-gray-400 mt-1">{route?.provider || 'not set'}</p>
                          <p className="text-[10px] text-gray-600 font-mono">{route?.modelName || 'No model selected'}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* AI Task Routing */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
          <Brain className="w-4 h-4 text-purple-400" /> AI Task Routing
        </h3>
        <p className="text-xs text-gray-500">Choose the provider and model used by the legacy auto-reply/content pipeline. Any configured LLM provider can be selected here, and the router will fall back automatically when a provider is unavailable.</p>
        <div className="space-y-3">
          {taskTypes.map(task => {
            const selectedProviderId = settings[`ai_task_${task.id}_provider`] || '';
            const selectedProvider = taskRoutingProviders.find(p => p.id === selectedProviderId)
              || llmProviders.find(p => p.id === selectedProviderId);
            const selectedProviderDefaultModel = selectedProvider ? getSelectedProviderModel(selectedProvider) : '';
            const selectedProviderUnsupported = !!selectedProviderId && !taskRoutingProviders.some(p => p.id === selectedProviderId);
            // Models from registry + any dynamically loaded models
            const providerModels = [
              ...(selectedProvider?.models || []),
              ...(models[selectedProviderId] || []),
              selectedProviderDefaultModel,
            ].filter((m, i, arr) => m && arr.indexOf(m) === i); // unique, non-empty

            return (
              <div key={task.id} className="bg-gray-800/30 rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-3">
                  <div className="w-36">
                    <p className="text-xs text-gray-300 font-medium">{task.name}</p>
                    <p className="text-[10px] text-gray-600">{task.desc}</p>
                  </div>
                  {/* Provider selector */}
                  <div className="flex-1">
                    <label className="text-[9px] text-gray-600 uppercase block mb-0.5">Provider</label>
                    <select
                      value={selectedProviderId}
                      onChange={e => {
                        updateSetting(`ai_task_${task.id}_provider`, e.target.value);
                        // Auto-set default model when switching provider
                        const prov = taskRoutingProviders.find(p => p.id === e.target.value);
                        const defaultModel = prov ? getSelectedProviderModel(prov) : '';
                        if (defaultModel) {
                          updateSetting(`ai_task_${task.id}_model`, defaultModel);
                        }
                      }}
                      className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200"
                    >
                      <option value="">Default (first available)</option>
                      {taskRoutingProviders.map(p => (
                        <option key={p.id} value={p.id} disabled={!p.enabled || !p.configured}>
                          {p.name}{p.configured ? ' configured' : ' (set API key first)'}{p.enabled ? '' : ' [disabled]'}
                        </option>
                      ))}
                    </select>
                    {selectedProviderUnsupported && (
                      <p className="mt-1 text-[10px] text-yellow-500">
                        The saved provider "{selectedProviderId}" is not available in the current LLM registry. Choose one of the configured providers above.
                      </p>
                    )}
                  </div>
                  {/* Model selector */}
                  <div className="flex-1">
                    <label className="text-[9px] text-gray-600 uppercase block mb-0.5">Model</label>
                    {providerModels.length > 0 ? (
                      <select
                        value={settings[`ai_task_${task.id}_model`] || ''}
                        onChange={e => updateSetting(`ai_task_${task.id}_model`, e.target.value)}
                        className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200"
                      >
                        <option value="">
                          {selectedProviderDefaultModel ? `Default (${selectedProviderDefaultModel})` : 'Select model...'}
                        </option>
                        {providerModels.map(m => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={settings[`ai_task_${task.id}_model`] || ''}
                        onChange={e => updateSetting(`ai_task_${task.id}_model`, e.target.value)}
                        placeholder={selectedProviderId ? 'พิมพ์ชื่อโมเดล...' : 'เลือก provider ก่อน'}
                        className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                      />
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* General Settings */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
          <SettingsIcon className="w-4 h-4 text-gray-400" /> General
        </h3>
        <p className="text-xs text-gray-500">
          Runtime settings below now affect the server behavior directly. `Browser Headless` applies on the next browser launch.
        </p>
        
        {/* Boss Mode Admins */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 pb-3 border-b border-gray-800">
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Boss Mode: Telegram Admin IDs</label>
            <input
              type="text"
              value={settings['admin_telegram_ids'] || ''}
              onChange={e => updateSetting('admin_telegram_ids', e.target.value)}
              placeholder="e.g. 1234567,8901234"
              className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
            />
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Boss Mode: LINE Admin IDs</label>
            <input
              type="text"
              value={settings['admin_line_ids'] || ''}
              onChange={e => updateSetting('admin_line_ids', e.target.value)}
              placeholder="e.g. U123...456,U789...012"
              className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Chat Reply Delay (ms)</label>
            <input
              type="number"
              value={settings['chat_reply_delay'] || '3000'}
              onChange={e => updateSetting('chat_reply_delay', e.target.value)}
              className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Comment Reply Delay (ms)</label>
            <input
              type="number"
              value={settings['comment_reply_delay'] || '5000'}
              onChange={e => updateSetting('comment_reply_delay', e.target.value)}
              className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Browser Headless</label>
            <select
              value={settings['browser_headless'] || 'false'}
              onChange={e => updateSetting('browser_headless', e.target.value)}
              className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200"
            >
              <option value="false">No (show browser)</option>
              <option value="true">Yes (hidden)</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Max Conversation Memory</label>
            <input
              type="number"
              value={settings['max_memory_messages'] || '25'}
              onChange={e => updateSetting('max_memory_messages', e.target.value)}
              className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>
      </div>

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

      {/* ═══════════════════════════════════════════════════════
          Add Provider Modal
          ═══════════════════════════════════════════════════════ */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowAddModal(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-lg space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-white">เพิ่ม Provider ใหม่</h3>
            <p className="text-[10px] text-gray-500">เพิ่ม API provider ใหม่เข้าระบบ (รองรับ OpenAI-compatible API)</p>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Provider ID *</label>
                <input
                  value={newProvider.id}
                  onChange={e => setNewProvider(p => ({ ...p, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))}
                  placeholder="e.g. my-provider"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">ชื่อแสดง *</label>
                <input
                  value={newProvider.name}
                  onChange={e => setNewProvider(p => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. My Custom AI"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">หมวดหมู่</label>
                <select
                  value={addCategory}
                  onChange={e => setAddCategory(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200"
                >
                  {categories.map(c => (
                    <option key={c} value={c}>{CATEGORY_CONFIG[c].label} — {CATEGORY_CONFIG[c].labelTh}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Type</label>
                <select
                  value={newProvider.type}
                  onChange={e => setNewProvider(p => ({ ...p, type: e.target.value }))}
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200"
                >
                  <option value="openai-compatible">OpenAI-Compatible</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="rest-api">REST API</option>
                  <option value="platform">Platform</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Base URL (Endpoint)</label>
                <input
                  value={newProvider.baseUrl}
                  onChange={e => setNewProvider(p => ({ ...p, baseUrl: e.target.value }))}
                  placeholder="https://api.example.com/v1"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Default Model</label>
                <input
                  value={newProvider.defaultModel}
                  onChange={e => setNewProvider(p => ({ ...p, defaultModel: e.target.value }))}
                  placeholder="e.g. gpt-4o"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Models (คั่นด้วย comma)</label>
                <input
                  value={newProvider.models}
                  onChange={e => setNewProvider(p => ({ ...p, models: e.target.value }))}
                  placeholder="model-1, model-2, model-3"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">
                  Endpoint Template <span className="text-gray-600">(สำหรับ endpoint แปลกๆ เช่น MiniMax)</span>
                </label>
                <input
                  value={newProvider.endpointTemplate}
                  onChange={e => setNewProvider(p => ({ ...p, endpointTemplate: e.target.value }))}
                  placeholder="{baseUrl}/text/chatcompletion_v2?GroupId={groupId}"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Env Variable Name</label>
                <input
                  value={newProvider.apiKeyEnvVar}
                  onChange={e => setNewProvider(p => ({ ...p, apiKeyEnvVar: e.target.value }))}
                  placeholder="auto-generated if empty"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">หมายเหตุ</label>
                <input
                  value={newProvider.notes}
                  onChange={e => setNewProvider(p => ({ ...p, notes: e.target.value }))}
                  placeholder="e.g. ต้องใช้ GroupId"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">
                  Custom Headers <span className="text-gray-600">(JSON)</span>
                </label>
                <textarea
                  value={newProvider.customHeaders}
                  onChange={e => setNewProvider(p => ({ ...p, customHeaders: e.target.value }))}
                  placeholder='{"X-Group-Id": "123456", "X-Custom": "value"}'
                  rows={2}
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono resize-none"
                />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">
                  Extra Config <span className="text-gray-600">(JSON — ค่าเฉพาะทาง เช่น groupId, projectId)</span>
                </label>
                <textarea
                  value={newProvider.extraConfig}
                  onChange={e => setNewProvider(p => ({ ...p, extraConfig: e.target.value }))}
                  placeholder='{"groupId": "your-group-id", "projectId": "..."}'
                  rows={2}
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono resize-none"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setShowAddModal(false)}
                className="px-4 py-2 text-xs text-gray-400 bg-gray-800 rounded-lg hover:bg-gray-700 border border-gray-700"
              >
                ยกเลิก
              </button>
              <button
                onClick={handleAddProvider}
                disabled={!newProvider.id || !newProvider.name}
                className="px-4 py-2 text-xs text-green-400 bg-green-500/15 rounded-lg hover:bg-green-500/25 border border-green-500/30 font-medium disabled:opacity-50"
              >
                <Plus className="w-3.5 h-3.5 inline mr-1" /> เพิ่ม Provider
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════
          Edit Provider Modal
          ═══════════════════════════════════════════════════════ */}
      {showEditModal && editProvider && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowEditModal(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-lg space-y-4 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Edit3 className="w-4 h-4 text-yellow-400" />
              แก้ไข Provider: {editProvider.name}
            </h3>
            <p className="text-[10px] text-gray-500 font-mono">ID: {editProvider.id} | Category: {editProvider.category}</p>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">ชื่อแสดง</label>
                <input
                  value={editProvider.name}
                  onChange={e => setEditProvider(p => p ? { ...p, name: e.target.value } : p)}
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Type</label>
                <select
                  value={editProvider.type}
                  onChange={e => setEditProvider(p => p ? { ...p, type: e.target.value } : p)}
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200"
                >
                  <option value="openai-compatible">OpenAI-Compatible</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="rest-api">REST API</option>
                  <option value="platform">Platform</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Base URL (Endpoint)</label>
                <input
                  value={editProvider.baseUrl}
                  onChange={e => setEditProvider(p => p ? { ...p, baseUrl: e.target.value } : p)}
                  placeholder="https://api.example.com/v1"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Default Model</label>
                <input
                  value={editProvider.defaultModel}
                  onChange={e => setEditProvider(p => p ? { ...p, defaultModel: e.target.value } : p)}
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Models (คั่นด้วย comma)</label>
                <input
                  value={editProvider.models}
                  onChange={e => setEditProvider(p => p ? { ...p, models: e.target.value } : p)}
                  placeholder="model-1, model-2"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">
                  Endpoint Template <span className="text-gray-600">(สำหรับ endpoint แบบกำหนดเอง)</span>
                </label>
                <input
                  value={editProvider.endpointTemplate}
                  onChange={e => setEditProvider(p => p ? { ...p, endpointTemplate: e.target.value } : p)}
                  placeholder="{baseUrl}/text/chatcompletion_v2?GroupId={groupId}"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">Env Variable</label>
                <input
                  value={editProvider.apiKeyEnvVar}
                  onChange={e => setEditProvider(p => p ? { ...p, apiKeyEnvVar: e.target.value } : p)}
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">หมายเหตุ</label>
                <input
                  value={editProvider.notes}
                  onChange={e => setEditProvider(p => p ? { ...p, notes: e.target.value } : p)}
                  placeholder="e.g. ต้องใส่ GroupId ใน extraConfig"
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">
                  Custom Headers <span className="text-gray-600">(JSON)</span>
                </label>
                <textarea
                  value={editProvider.customHeaders}
                  onChange={e => setEditProvider(p => p ? { ...p, customHeaders: e.target.value } : p)}
                  placeholder='{"X-Group-Id": "123456"}'
                  rows={2}
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono resize-none"
                />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-gray-500 uppercase mb-1 block">
                  Extra Config <span className="text-gray-600">(JSON — ค่าเฉพาะทาง เช่น groupId, projectId, region)</span>
                </label>
                <textarea
                  value={editProvider.extraConfig}
                  onChange={e => setEditProvider(p => p ? { ...p, extraConfig: e.target.value } : p)}
                  placeholder='{"groupId": "...", "projectId": "..."}'
                  rows={2}
                  className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono resize-none"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => { setShowEditModal(false); setEditProvider(null); }}
                className="px-4 py-2 text-xs text-gray-400 bg-gray-800 rounded-lg hover:bg-gray-700 border border-gray-700"
              >
                ยกเลิก
              </button>
              <button
                onClick={handleSaveEdit}
                className="px-4 py-2 text-xs text-yellow-400 bg-yellow-500/15 rounded-lg hover:bg-yellow-500/25 border border-yellow-500/30 font-medium"
              >
                <Save className="w-3.5 h-3.5 inline mr-1" /> บันทึกการแก้ไข
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   Provider Card Component
   ═══════════════════════════════════════════════════════ */
interface ProviderCardProps {
  provider: RegistryProvider;
  providerKey: string;
  showKey: boolean;
  testResult?: boolean;
  isTesting: boolean;
  isSavingKey: boolean;
  isSavingModel: boolean;
  isLoadingModels: boolean;
  modelList?: string[];
  modelSource?: string;
  selectedModel: string;
  onKeyChange: (v: string) => void;
  onToggleShowKey: () => void;
  onSaveKey: () => void;
  onDeleteKey: () => void;
  onTest: () => void;
  onLoadModels: () => void;
  onModelChange: (v: string) => void;
  onToggleEnabled: () => void;
  onRemove: () => void;
  onEdit: () => void;
}

function ProviderCard({
  provider, providerKey, showKey, testResult, isTesting, isSavingKey, isSavingModel, isLoadingModels,
  modelList, modelSource, selectedModel,
  onKeyChange, onToggleShowKey, onSaveKey, onDeleteKey, onTest,
  onLoadModels, onModelChange, onToggleEnabled, onRemove, onEdit,
}: ProviderCardProps) {
  return (
    <div className={`bg-gray-800/40 rounded-lg p-3 space-y-2 border ${
      provider.configured ? 'border-green-500/20' : 'border-gray-800'
    } ${!provider.enabled ? 'opacity-50' : ''}`}>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-xs font-medium text-gray-200">{provider.name}</p>
          <span className="text-[9px] font-mono text-gray-600 bg-gray-900 px-1.5 py-0.5 rounded">{provider.id}</span>
          {provider.configured && (
            <span className="text-[9px] text-green-400 bg-green-500/10 px-1.5 py-0.5 rounded border border-green-500/20">
              configured
            </span>
          )}
          {provider.type && (
            <span className="text-[9px] text-gray-500 bg-gray-900 px-1.5 py-0.5 rounded">{provider.type}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {testResult !== undefined && (
            testResult
              ? <CheckCircle className="w-3.5 h-3.5 text-green-400" />
              : <XCircle className="w-3.5 h-3.5 text-red-400" />
          )}
          <button
            onClick={onTest}
            disabled={isTesting || !provider.configured}
            className="px-2 py-1 text-[10px] bg-gray-700 text-gray-300 rounded hover:bg-gray-600 disabled:opacity-40"
            title="Test connection"
          >
            {isTesting ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Test'}
          </button>
          <button
            onClick={onLoadModels}
            disabled={!provider.configured || isLoadingModels}
            className="px-2 py-1 text-[10px] bg-gray-700 text-gray-300 rounded hover:bg-gray-600 disabled:opacity-40"
            title="โหลดรายชื่อ Models จาก API"
          >
            {isLoadingModels
              ? <Loader2 className="w-3 h-3 animate-spin inline" />
              : <RefreshCw className="w-3 h-3 inline" />
            }
          </button>
          <button
            onClick={onEdit}
            className="px-2 py-1 text-[10px] bg-gray-700 text-yellow-400 rounded hover:bg-yellow-500/20"
            title="Edit provider settings"
          >
            <Edit3 className="w-3 h-3" />
          </button>
          <button
            onClick={onToggleEnabled}
            className={`px-2 py-1 text-[10px] rounded ${
              provider.enabled
                ? 'bg-green-500/15 text-green-400 hover:bg-green-500/25'
                : 'bg-gray-700 text-gray-500 hover:bg-gray-600'
            }`}
            title={provider.enabled ? 'Disable' : 'Enable'}
          >
            <Power className="w-3 h-3" />
          </button>
          <button
            onClick={onRemove}
            className="px-2 py-1 text-[10px] bg-gray-700 text-red-400 rounded hover:bg-red-500/20"
            title="Remove provider"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Notes / Endpoint info */}
      {(provider.notes || provider.endpointTemplate || provider.baseUrl) && (
        <div className="text-[9px] text-gray-600 font-mono truncate">
          {provider.baseUrl && <span>{provider.baseUrl}</span>}
          {provider.endpointTemplate && <span className="text-yellow-600 ml-2">template: {provider.endpointTemplate}</span>}
          {provider.notes && <span className="text-gray-500 ml-2">— {provider.notes}</span>}
        </div>
      )}

      {/* API Key Input */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            value={providerKey}
            onChange={e => onKeyChange(e.target.value)}
            type={showKey ? 'text' : 'password'}
            placeholder={provider.configured ? '••••••••  (key saved — enter new to replace)' : `${provider.apiKeyEnvVar}...`}
            className="w-full px-3 py-1.5 text-xs bg-gray-900 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono pr-8"
          />
          <button
            onClick={onToggleShowKey}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
          >
            {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
        <button
          onClick={onSaveKey}
          disabled={!providerKey || isSavingKey}
          className="px-3 py-1.5 text-[10px] bg-blue-500/15 text-blue-400 rounded-lg hover:bg-blue-500/25 border border-blue-500/30 disabled:opacity-40 font-medium whitespace-nowrap"
        >
          {isSavingKey ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Save Key'}
        </button>
        {provider.configured && (
          <button
            onClick={onDeleteKey}
            className="px-2 py-1.5 text-[10px] bg-red-500/10 text-red-400 rounded-lg hover:bg-red-500/20 border border-red-500/20"
            title="Delete saved key"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Model Selector */}
      {modelList !== undefined && (
        <div className="space-y-1">
          {modelList.length > 0 ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-gray-600">
                  Models ({modelList.length} รายการ)
                  {modelSource === 'api' && (
                    <span className="text-green-500 ml-1">— จาก API</span>
                  )}
                  {modelSource === 'registry' && (
                    <span className="text-yellow-600 ml-1">— จาก Registry (provider ไม่รองรับ list models)</span>
                  )}
                </span>
                <span className="text-[9px] font-mono text-gray-500">
                  active: {selectedModel || provider.defaultModel || 'not set'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={selectedModel || ''}
                  onChange={e => onModelChange(e.target.value)}
                  disabled={isSavingModel}
                  className="flex-1 px-3 py-1.5 text-xs bg-gray-900 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono disabled:opacity-60"
                >
                  <option value="">
                    {provider.defaultModel ? `Default (${provider.defaultModel})` : 'Select model...'}
                  </option>
                  {modelList.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                {isSavingModel && <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />}
              </div>
              <p className="text-[10px] text-gray-600">
                Select a model here to set the provider default. `AI Task Routing` can still override it per task.
              </p>
            </>
          ) : (
            <p className="text-[10px] text-gray-600 italic">
              ไม่พบ models — ตรวจสอบว่า API Key ถูกต้อง หรือ provider รองรับ list models
            </p>
          )}
        </div>
      )}
    </div>
  );
}





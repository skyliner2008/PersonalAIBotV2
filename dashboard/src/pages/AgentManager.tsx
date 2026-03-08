import { useState, useEffect } from 'react';
import { api } from '../services/api';
import {
  Bot, Plus, Trash2, Power, PowerOff, Edit3, Save, X,
  ChevronDown, ChevronRight, Wrench, Shield, AlertTriangle
} from 'lucide-react';

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

export function AgentManager() {
  const [bots, setBots] = useState<BotInstance[]>([]);
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [tools, setTools] = useState<ToolMeta[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
      const [b, p, t, per] = await Promise.all([
        api.getBots(),
        api.getBotPlatforms(),
        api.getTools(),
        api.getPersonas(),
      ]);
      setBots(b);
      setPlatforms(p);
      setTools(t);
      setPersonas(per);
    } catch (err) {
      console.error('Failed to load agent data:', err);
    }
    setLoading(false);
  };

  useEffect(() => { loadData(); }, []);

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
      alert(err.message);
    }
  };

  const handleToggle = async (id: string) => {
    await api.toggleBot(id);
    loadData();
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`ลบ Agent "${id}" จริงหรือ?`)) return;
    await api.deleteBot(id);
    loadData();
  };

  const handleUpdateTools = async (botId: string, toolNames: string[]) => {
    await api.updateBot(botId, { enabled_tools: toolNames });
    loadData();
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
          <p className="text-sm text-gray-500 mt-1">จัดการ Agent/Bot instances สำหรับแต่ละ Platform</p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm transition-colors"
        >
          <Plus className="w-4 h-4" />
          เพิ่ม Agent
        </button>
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

      {/* Bot List */}
      {bots.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <Bot className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p>ยังไม่มี Agent — คลิก "เพิ่ม Agent" เพื่อเริ่มต้น</p>
        </div>
      ) : (
        <div className="space-y-3">
          {bots.map(bot => (
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
          ))}
        </div>
      )}
    </div>
  );
}

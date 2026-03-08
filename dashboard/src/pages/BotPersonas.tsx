import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import { Save, RefreshCw, Eye, EyeOff, Bot, MessageSquare, Send } from 'lucide-react';

type Platform = 'fb-extension' | 'line' | 'telegram';

interface BotPersonaFiles {
  platform: Platform;
  agents: string;
  identity: string;
  soul: string;
  tools: string;
}

const PLATFORMS: { id: Platform; label: string; icon: any; color: string; desc: string }[] = [
  {
    id: 'fb-extension',
    label: 'FB Extension',
    icon: MessageSquare,
    color: 'blue',
    desc: 'บอทที่ทำงานผ่าน Chrome Extension บน Facebook Messenger',
  },
  {
    id: 'line',
    label: 'LINE Bot',
    icon: Send,
    color: 'green',
    desc: 'บอทที่ตอบข้อความผ่าน LINE Official Account',
  },
  {
    id: 'telegram',
    label: 'Telegram Bot',
    icon: Bot,
    color: 'sky',
    desc: 'บอทที่ตอบข้อความผ่าน Telegram',
  },
];

const SECTIONS = [
  {
    key: 'agents' as const,
    title: '🎯 AGENTS.md — Role & Goals',
    desc: 'กำหนดบทบาท วัตถุประสงค์ และ background ของบอท',
    rows: 8,
  },
  {
    key: 'identity' as const,
    title: '🗣️ IDENTITY.md — Speaking Style',
    desc: 'กำหนดลักษณะการพูด รูปแบบการตอบ และกฎการ format ข้อความ',
    rows: 8,
  },
  {
    key: 'soul' as const,
    title: '✨ SOUL.md — Personality',
    desc: 'กำหนดบุคลิกและนิสัยหลักของบอท',
    rows: 6,
  },
  {
    key: 'tools' as const,
    title: '🔧 TOOLS.md — Enabled Tools',
    desc: 'รายชื่อ tool ที่บอทสามารถใช้ได้ (บรรทัดที่ขึ้นต้น # คือ comment / disabled)',
    rows: 10,
  },
];

export function BotPersonas() {
  const [activePlatform, setActivePlatform] = useState<Platform>('fb-extension');
  const [data, setData] = useState<Record<Platform, BotPersonaFiles | null>>({
    'fb-extension': null,
    line: null,
    telegram: null,
  });
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [dirty, setDirty] = useState(false);

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all: BotPersonaFiles[] = await api.getAllBotPersonas();
      const map = { 'fb-extension': null, line: null, telegram: null } as any;
      for (const p of all) map[p.platform] = p;
      setData(map);
      setDirty(false);
    } catch (e: any) {
      showToast('โหลดข้อมูลไม่ได้: ' + e.message, false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const current = data[activePlatform];

  function updateField(field: keyof Omit<BotPersonaFiles, 'platform'>, value: string) {
    setData(prev => ({
      ...prev,
      [activePlatform]: { ...prev[activePlatform]!, [field]: value },
    }));
    setDirty(true);
  }

  async function handleSave() {
    if (!current) return;
    setSaving(true);
    try {
      await api.saveBotPersona(activePlatform, {
        agents: current.agents,
        identity: current.identity,
        soul: current.soul,
        tools: current.tools,
      });
      showToast(`✅ บันทึก ${activePlatform} สำเร็จ — Cache cleared แล้ว`);
      setDirty(false);
    } catch (e: any) {
      showToast('❌ บันทึกไม่สำเร็จ: ' + e.message, false);
    } finally {
      setSaving(false);
    }
  }

  // Preview combined system instruction
  const preview = current
    ? `[AGENTS - Role & Goals]\n${current.agents}\n\n[IDENTITY - Style & Rules]\n${current.identity}\n\n[SOUL - Personality]\n${current.soul}`
    : '';

  // Count enabled tools
  const enabledToolsCount = current
    ? current.tools.split('\n').filter(l => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('//')).length
    : 0;

  const platformInfo = PLATFORMS.find(p => p.id === activePlatform)!;
  const colorMap: Record<string, string> = {
    blue: 'border-blue-500 text-blue-400 bg-blue-500/10',
    green: 'border-green-500 text-green-400 bg-green-500/10',
    sky: 'border-sky-500 text-sky-400 bg-sky-500/10',
  };

  return (
    <div className="h-full flex flex-col bg-gray-950">
      {/* Header */}
      <div className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">Bot Personas</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            แก้ไข Persona ของบอทแต่ละช่องทาง (file-based: AGENTS / IDENTITY / SOUL / TOOLS)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowPreview(v => !v)}
            className="px-3 py-1.5 text-xs rounded-lg border border-gray-700 text-gray-400 hover:bg-gray-800 flex items-center gap-1.5"
          >
            {showPreview ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
            {showPreview ? 'ซ่อน Preview' : 'แสดง Preview'}
          </button>
          <button
            onClick={load}
            className="px-3 py-1.5 text-xs rounded-lg border border-gray-700 text-gray-400 hover:bg-gray-800 flex items-center gap-1.5"
          >
            <RefreshCw className="w-3 h-3" />
            Reload
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            className={`px-4 py-1.5 text-xs rounded-lg font-medium flex items-center gap-1.5 transition-all ${
              dirty
                ? 'bg-blue-600 hover:bg-blue-500 text-white'
                : 'bg-gray-800 text-gray-600 cursor-not-allowed'
            }`}
          >
            <Save className="w-3 h-3" />
            {saving ? 'กำลังบันทึก...' : 'บันทึก'}
            {dirty && <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 ml-1" />}
          </button>
        </div>
      </div>

      {/* Platform Tabs */}
      <div className="flex gap-2 px-6 py-3 border-b border-gray-800 bg-gray-900/50">
        {PLATFORMS.map(p => {
          const Icon = p.icon;
          const isActive = activePlatform === p.id;
          return (
            <button
              key={p.id}
              onClick={() => { setActivePlatform(p.id); setShowPreview(false); }}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-all ${
                isActive ? colorMap[p.color] : 'border-transparent text-gray-500 hover:text-gray-300 hover:bg-gray-800'
              }`}
            >
              <Icon className="w-4 h-4" />
              {p.label}
              {data[p.id] !== null && isActive && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full bg-gray-700 text-gray-400`}>
                  {enabledToolsCount} tools
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
            <RefreshCw className="w-4 h-4 animate-spin mr-2" /> กำลังโหลด...
          </div>
        ) : !current ? (
          <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
            ไม่พบข้อมูล
          </div>
        ) : (
          <div className={`flex h-full ${showPreview ? 'divide-x divide-gray-800' : ''}`}>
            {/* Editors */}
            <div className={`${showPreview ? 'w-1/2' : 'w-full'} p-6 space-y-5 overflow-auto`}>
              {/* Platform description */}
              <div className={`rounded-lg border px-4 py-3 ${colorMap[platformInfo.color]} text-xs`}>
                <strong>{platformInfo.label}</strong>: {platformInfo.desc}
              </div>

              {SECTIONS.map(sec => (
                <div key={sec.key} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-gray-200">{sec.title}</label>
                    <span className="text-[10px] text-gray-500">
                      {current[sec.key].split('\n').length} บรรทัด
                    </span>
                  </div>
                  <p className="text-[11px] text-gray-500">{sec.desc}</p>
                  <textarea
                    value={current[sec.key]}
                    onChange={e => updateField(sec.key, e.target.value)}
                    rows={sec.rows}
                    spellCheck={false}
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-gray-200 font-mono resize-y focus:outline-none focus:border-blue-500 transition-colors"
                  />
                </div>
              ))}
            </div>

            {/* Preview Panel */}
            {showPreview && (
              <div className="w-1/2 p-6 overflow-auto">
                <div className="mb-3 flex items-center gap-2">
                  <Eye className="w-4 h-4 text-gray-400" />
                  <span className="text-sm font-medium text-gray-300">System Instruction Preview</span>
                  <span className="text-[10px] text-gray-500 ml-auto">
                    {preview.length} chars · {enabledToolsCount} tools enabled
                  </span>
                </div>

                {/* System prompt preview */}
                <pre className="text-xs text-gray-400 bg-gray-900 border border-gray-700 rounded-lg p-4 whitespace-pre-wrap overflow-auto leading-relaxed font-mono">
                  {preview}
                </pre>

                {/* Tools preview */}
                <div className="mt-4">
                  <div className="text-xs font-medium text-gray-400 mb-2">🔧 Enabled Tools</div>
                  <div className="flex flex-wrap gap-1.5">
                    {current.tools
                      .split('\n')
                      .map(l => l.trim())
                      .filter(l => l && !l.startsWith('#') && !l.startsWith('//'))
                      .map(tool => (
                        <span key={tool} className="px-2 py-0.5 bg-blue-500/15 text-blue-400 border border-blue-500/30 rounded text-[11px] font-mono">
                          {tool}
                        </span>
                      ))}
                    {enabledToolsCount === 0 && (
                      <span className="text-xs text-gray-600">ไม่มี tool ที่เปิดใช้งาน</span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Toast notification */}
      {toast && (
        <div className={`fixed bottom-6 right-6 px-4 py-3 rounded-lg text-sm font-medium shadow-lg transition-all ${
          toast.ok ? 'bg-green-900 text-green-200 border border-green-700' : 'bg-red-900 text-red-200 border border-red-700'
        }`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

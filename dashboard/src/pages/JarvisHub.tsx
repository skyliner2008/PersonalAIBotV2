/**
 * Jarvis Hub — Unified control center for all Jarvis interaction modes.
 *
 * Combines:
 * 1. Voice Call (Live Call) — real-time voice conversation with Jarvis via Gemini Live API
 * 2. Terminal — text-based CLI interaction with Jarvis & all discovered CLI agents
 * 3. Meeting Room — multi-agent roundtable discussions
 *
 * All modes share the core concept: user interacts with Jarvis,
 * Jarvis orchestrates work across available CLI tools and agents.
 */

import { useState, useCallback, useEffect } from 'react';
import { PhoneCall, Terminal, Users, Zap, Settings2, ExternalLink, ArrowLeft } from 'lucide-react';
import { JarvisCall } from './JarvisCall';
import { JarvisTerminal } from './JarvisTerminal';
import { MultiAgent } from './MultiAgent';
import { useSocket } from '../hooks/useSocket';
import { api } from '../services/api';

type JarvisMode = 'call' | 'terminal' | 'meeting';

const MODE_STORAGE_KEY = 'jarvis_hub_mode';

const MODES: Array<{
  id: JarvisMode;
  label: string;
  shortLabel: string;
  description: string;
  icon: typeof PhoneCall;
  color: string;
  bgColor: string;
  borderColor: string;
}> = [
  {
    id: 'call',
    label: 'Voice Call',
    shortLabel: 'Call',
    description: 'สนทนาด้วยเสียงกับ Jarvis แบบ real-time',
    icon: PhoneCall,
    color: 'text-emerald-300',
    bgColor: 'bg-emerald-500/10',
    borderColor: 'border-emerald-400/40',
  },
  {
    id: 'terminal',
    label: 'Terminal',
    shortLabel: 'Terminal',
    description: 'สั่งงาน CLI agents ผ่านข้อความ (@gemini, @claude, @codex)',
    icon: Terminal,
    color: 'text-cyan-300',
    bgColor: 'bg-cyan-500/10',
    borderColor: 'border-cyan-400/40',
  },
  {
    id: 'meeting',
    label: 'Meeting Room',
    shortLabel: 'Meeting',
    description: 'ห้องประชุม Multi-Agent — Jarvis นำ agents ประชุมร่วมกัน',
    icon: Users,
    color: 'text-violet-300',
    bgColor: 'bg-violet-500/10',
    borderColor: 'border-violet-400/40',
  },
];

interface CliBackendStatus {
  id: string;
  name: string;
  available: boolean;
  kind: string;
}

function getSavedMode(): JarvisMode {
  try {
    const saved = localStorage.getItem(MODE_STORAGE_KEY);
    if (saved === 'call' || saved === 'terminal' || saved === 'meeting') return saved;
  } catch { /* ignore */ }
  return 'call';
}

export function JarvisHub() {
  const [mode, setMode] = useState<JarvisMode>(getSavedMode);
  const [cliBackends, setCliBackends] = useState<CliBackendStatus[]>([]);
  const { on, connected } = useSocket();

  // Save mode preference
  const handleSetMode = useCallback((newMode: JarvisMode) => {
    setMode(newMode);
    try { localStorage.setItem(MODE_STORAGE_KEY, newMode); } catch { /* ignore */ }
  }, []);

  // Fetch available CLI backends
  useEffect(() => {
    (async () => {
      try {
        const res = await api.getTerminalBackends();
        if (res?.backends) {
          setCliBackends(res.backends.filter((b: CliBackendStatus) => b.kind === 'cli' && b.available));
        }
      } catch { /* ignore */ }
    })();
  }, []);

  // Handle ngrok/external access
  const isExternalAccess = typeof window !== 'undefined' && !window.location.hostname.match(/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/);

  return (
    <div className="h-full flex flex-col">
      {/* ─── Header Bar ─── */}
      <div className="shrink-0 px-4 pt-4 pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => { window.location.href = '/'; }}
              className="w-8 h-8 rounded-lg border border-slate-600 bg-slate-800/60 flex items-center justify-center hover:border-slate-400 transition-colors"
              title="Back to Dashboard"
            >
              <ArrowLeft className="w-4 h-4 text-slate-300" />
            </button>
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500/20 to-cyan-500/20 border border-violet-400/30 flex items-center justify-center">
              <Zap className="w-5 h-5 text-violet-300" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-white tracking-tight">Jarvis Hub</h1>
              <p className="text-xs text-slate-400">
                ศูนย์ควบคุม Jarvis — เสียง, ข้อความ, ประชุม Multi-Agent
              </p>
            </div>
          </div>

          {/* Connection & access info */}
          <div className="flex items-center gap-2">
            {isExternalAccess && (
              <span className="flex items-center gap-1 px-2 py-1 rounded-lg border border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-300">
                <ExternalLink className="w-3 h-3" />
                External
              </span>
            )}
            <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs ${
              connected
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-rose-400'}`} />
              {connected ? 'Connected' : 'Disconnected'}
            </span>

            {/* CLI agent count */}
            {cliBackends.length > 0 && (
              <span className="flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-600 bg-slate-800/60 text-[11px] text-slate-300">
                <Settings2 className="w-3 h-3 text-slate-400" />
                {cliBackends.length} CLI agents
              </span>
            )}
          </div>
        </div>

        {/* ─── Mode Tabs ─── */}
        <div className="flex gap-2 mt-3">
          {MODES.map((m) => {
            const Icon = m.icon;
            const active = mode === m.id;
            return (
              <button
                key={m.id}
                onClick={() => handleSetMode(m.id)}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl border transition-all text-sm font-medium ${
                  active
                    ? `${m.borderColor} ${m.bgColor} ${m.color}`
                    : 'border-slate-700 bg-slate-800/40 text-slate-400 hover:border-slate-500 hover:text-slate-200'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span className="hidden sm:inline">{m.label}</span>
                <span className="sm:hidden">{m.shortLabel}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── Active Mode Content ─── */}
      <div className="flex-1 min-h-0 overflow-auto">
        {mode === 'call' && <JarvisCall />}
        {mode === 'terminal' && <JarvisTerminal />}
        {mode === 'meeting' && <MultiAgent on={on} />}
      </div>
    </div>
  );
}

export default JarvisHub;

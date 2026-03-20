import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Bot, Zap, Send, Trash2, MonitorUp, Loader2, RefreshCw, Mic, MicOff, Cpu, Activity } from 'lucide-react';
import { XTerminal, type XTerminalRef } from '../components/XTerminal';
import { GenerativeUI, type UIData } from '../components/GenerativeUI';
import { useSocket } from '../hooks/useSocket';
import { api } from '../services/api';

interface LaneMetric {
  specialist: string;
  state: 'idle' | 'healthy' | 'degraded' | 'unavailable';
  totalTasks: number;
  rates: { success: number; failure: number };
}

interface ChatMessage {
  id: string;
  sender: 'user' | 'bot';
  text: string;
  timestamp: string;
  backend: string;
  ui?: UIData;
}

interface BackendTheme {
  chipActive: string;
  bubble: string;
  border: string;
  text: string;
  accent: string;
}

interface BackendOption {
  id: string;
  label: string;
  senderLabel: string;
  icon: LucideIcon;
  isTerminal: boolean;
  theme: BackendTheme;
}

const JWT_TOKEN_KEY = 'auth_jwt_token';
const ADMIN_USER_KEY = 'admin_user';
const ADMIN_PASSWORD_KEY = 'admin_password';
const TARGET_VOICE_SAMPLE_RATE = 16000;
const VOICE_MODE_STORAGE_KEY = 'jarvis_voice_mode';
const SHOW_AGENT_VOICE_TRANSCRIPT_IN_CHAT = false;

type VoiceMode = 'live-direct' | 'agent-tools';

function normalizeVoiceMode(mode: string | null | undefined): VoiceMode {
  return String(mode || '').trim().toLowerCase() === 'agent-tools' ? 'agent-tools' : 'live-direct';
}

type BrowserSpeechRecognitionEvent = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0?: { transcript?: string };
  }>;
};

type BrowserSpeechRecognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type BrowserSpeechRecognitionCtor = new () => BrowserSpeechRecognition;

function getSpeechRecognitionCtor(): BrowserSpeechRecognitionCtor | null {
  const w = window as any;
  return (w.SpeechRecognition || w.webkitSpeechRecognition || null) as BrowserSpeechRecognitionCtor | null;
}

function downsampleToPcm16(input: Float32Array, inputRate: number, outputRate: number): Int16Array {
  if (!input.length) return new Int16Array(0);
  if (!Number.isFinite(inputRate) || inputRate <= 0 || inputRate === outputRate) {
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
    return pcm;
  }

  const ratio = inputRate / outputRate;
  const newLength = Math.max(1, Math.round(input.length / ratio));
  const result = new Int16Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.min(input.length, Math.round((offsetResult + 1) * ratio));
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer; i++) {
      accum += input[i];
      count += 1;
    }
    const sample = count > 0 ? accum / count : 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    result[offsetResult] = clamped < 0
      ? Math.round(clamped * 0x8000)
      : Math.round(clamped * 0x7fff);
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function pcm16ToBase64(pcm16: Int16Array): string {
  const bytes = new Uint8Array(pcm16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function isLocalRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const host = (window.location.hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

const AGENT_THEME: BackendTheme = {
  chipActive: 'bg-violet-500/20 border-violet-500/40 text-violet-300',
  bubble: 'bg-violet-500/10',
  border: 'border-violet-500/30',
  text: 'text-violet-100',
  accent: 'text-violet-300',
};

const GEMINI_THEME: BackendTheme = {
  chipActive: 'bg-blue-500/20 border-blue-500/40 text-blue-300',
  bubble: 'bg-blue-500/10',
  border: 'border-blue-500/30',
  text: 'text-blue-100',
  accent: 'text-blue-300',
};

const CODEX_THEME: BackendTheme = {
  chipActive: 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300',
  bubble: 'bg-emerald-500/10',
  border: 'border-emerald-500/30',
  text: 'text-emerald-100',
  accent: 'text-emerald-300',
};

const CLAUDE_THEME: BackendTheme = {
  chipActive: 'bg-amber-500/20 border-amber-500/40 text-amber-300',
  bubble: 'bg-amber-500/10',
  border: 'border-amber-500/30',
  text: 'text-amber-100',
  accent: 'text-amber-300',
};

const TERMINAL_BACKEND_IDS = new Set(['gemini-cli', 'codex-cli', 'claude-cli']);

function isTerminalBackendId(id: string): boolean {
  return TERMINAL_BACKEND_IDS.has(id);
}

const BACKEND_OPTIONS: BackendOption[] = [
  {
    id: 'agent',
    label: 'AI Agent (Jarvis)',
    senderLabel: 'jarvis@agent',
    icon: Bot,
    isTerminal: false,
    theme: AGENT_THEME,
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    senderLabel: 'gemini@cli',
    icon: Zap,
    isTerminal: true,
    theme: GEMINI_THEME,
  },
  {
    id: 'codex-cli',
    label: 'Codex CLI',
    senderLabel: 'codex@cli',
    icon: Cpu,
    isTerminal: true,
    theme: CODEX_THEME,
  },
  {
    id: 'claude-cli',
    label: 'Claude CLI',
    senderLabel: 'claude@cli',
    icon: Bot,
    isTerminal: true,
    theme: CLAUDE_THEME,
  },
];

// Use sessionStorage for sensitive data (token, password); localStorage for username only
function getStoredToken(): string | null {
  try { return sessionStorage.getItem(JWT_TOKEN_KEY) || localStorage.getItem(JWT_TOKEN_KEY) || null; } catch { return null; }
}
function setStoredToken(token: string): void {
  try {
    sessionStorage.setItem(JWT_TOKEN_KEY, token);
    try { localStorage.removeItem(JWT_TOKEN_KEY); } catch { /* ok */ }
  } catch { /* ignore */ }
}
function setStoredCredentials(username: string, password: string): void {
  try {
    localStorage.setItem(ADMIN_USER_KEY, username);
    sessionStorage.setItem(ADMIN_PASSWORD_KEY, password);
    try { localStorage.removeItem(ADMIN_PASSWORD_KEY); } catch { /* ok */ }
  } catch {
    /* ignore */
  }
}
function getAdminCredentials() {
  const envUser = (import.meta as any).env?.VITE_ADMIN_USER;
  const envPass = (import.meta as any).env?.VITE_ADMIN_PASSWORD;
  const savedUser = localStorage.getItem(ADMIN_USER_KEY);
  const savedPass = sessionStorage.getItem(ADMIN_PASSWORD_KEY) || localStorage.getItem(ADMIN_PASSWORD_KEY);
  const creds = [
    { username: String(savedUser || '').trim(), password: String(savedPass || '').trim() },
    { username: String(envUser || '').trim(), password: String(envPass || '').trim() },
  ];
  if ((import.meta as any).env?.DEV || isLocalRuntime()) {
    creds.push({ username: 'admin', password: 'admin' });
  }
  return creds.filter(c => c.username && c.password);
}
async function acquireAuthToken(forceRefresh = false): Promise<string | null> {
  if (!forceRefresh) {
    const existing = getStoredToken();
    if (existing) return existing;
  }
  for (const cred of getAdminCredentials()) {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: cred.username, password: cred.password }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.token) {
        setStoredToken(data.token);
        setStoredCredentials(cred.username, cred.password);
        return data.token;
      }
    } catch { /* try next */ }
  }
  return null;
}
async function buildAuthHeaders(forceRefresh = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = await acquireAuthToken(forceRefresh);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function JarvisTerminal() {
  const { connected, emit, on } = useSocket();

  const [activeBackendId, setActiveBackendId] = useState('agent');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  
  // Voice Call State
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [isVoiceLoading, setIsVoiceLoading] = useState(false);
  const [isVoiceAgentBusy, setIsVoiceAgentBusy] = useState(false);
  const [voiceMode, setVoiceMode] = useState<VoiceMode>(() => {
    try {
      return normalizeVoiceMode(localStorage.getItem(VOICE_MODE_STORAGE_KEY));
    } catch {
      return 'live-direct';
    }
  });
  const isVoiceActiveRef = useRef(false);
  const voiceModeRef = useRef<VoiceMode>(voiceMode);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const speechQueueRef = useRef<string[]>([]);
  const speechIsSpeakingRef = useRef(false);
  const speechVoiceRef = useRef<SpeechSynthesisVoice | null>(null);

  // Lane health state
  const [laneMetrics, setLaneMetrics] = useState<LaneMetric[]>([]);

  const messageListRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const xtermRef = useRef<XTerminalRef>(null);

  // Per-backend chat message cache (in-memory only, clears on page reload)
  const messagesCacheRef = useRef<Record<string, ChatMessage[]>>({});

  // Terminal session state (one session per CLI backend)
  const terminalSessionIds = useRef<Record<string, string | null>>({
    'gemini-cli': null,
    'codex-cli': null,
    'claude-cli': null,
  });
  const pendingTerminalCreate = useRef<Record<string, boolean>>({
    'gemini-cli': false,
    'codex-cli': false,
    'claude-cli': false,
  });
  const sessionToBackend = useRef<Record<string, string>>({});
  const activeBackendIdRef = useRef(activeBackendId);

  useEffect(() => { activeBackendIdRef.current = activeBackendId; }, [activeBackendId]);
  useEffect(() => { isVoiceActiveRef.current = isVoiceActive; }, [isVoiceActive]);
  useEffect(() => {
    voiceModeRef.current = voiceMode;
    try {
      localStorage.setItem(VOICE_MODE_STORAGE_KEY, voiceMode);
    } catch {
      // ignore storage errors
    }
  }, [voiceMode]);

  // Fetch lane health every 15s
  useEffect(() => {
    const fetchLaneHealth = () => {
      api.getSwarmLaneMetrics?.()?.then((res: any) => {
        if (res?.metrics) setLaneMetrics(res.metrics);
      }).catch(() => {});
    };
    fetchLaneHealth();
    const interval = setInterval(fetchLaneHealth, 15000);
    return () => clearInterval(interval);
  }, []);

  const backendById = useMemo(() => {
    const map = new Map<string, BackendOption>();
    for (const b of BACKEND_OPTIONS) map.set(b.id, b);
    return map;
  }, []);

  const activeBackend = backendById.get(activeBackendId) || BACKEND_OPTIONS[0];

  const isNearBottom = useCallback((el: HTMLDivElement): boolean => {
    const thresholdPx = 48;
    return (el.scrollHeight - el.scrollTop - el.clientHeight) <= thresholdPx;
  }, []);

  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = messageListRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const handleMessageListScroll = useCallback(() => {
    const el = messageListRef.current;
    if (!el) return;
    shouldAutoScrollRef.current = isNearBottom(el);
  }, [isNearBottom]);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    scrollMessagesToBottom(messages.length <= 1 ? 'auto' : 'smooth');
  }, [messages, isTyping, isVoiceAgentBusy, scrollMessagesToBottom]);

  const fetchWithAuth = useCallback(async (url: string, init?: RequestInit): Promise<Response> => {
    const run = async (forceRefresh: boolean) => {
      const authHeaders = await buildAuthHeaders(forceRefresh);
      return fetch(url, { ...init, headers: new Headers({ ...authHeaders, ...init?.headers }) });
    };
    let response = await run(false);
    if (response.status === 401) response = await run(true);
    return response;
  }, []);

  const sanitizeSpeechText = useCallback((rawText: string): string => {
    return String(rawText || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000);
  }, []);

  const splitSpeechChunks = useCallback((text: string): string[] => {
    if (!text) return [];
    const chunks: string[] = [];
    const sentences = text.split(/(?<=[.!?。！？]|[।ฺ])\s+/g).filter(Boolean);
    let current = '';
    const MAX_CHUNK = 180;
    for (const sentence of sentences) {
      const part = sentence.trim();
      if (!part) continue;
      if (part.length > MAX_CHUNK) {
        if (current) {
          chunks.push(current);
          current = '';
        }
        for (let i = 0; i < part.length; i += MAX_CHUNK) {
          chunks.push(part.slice(i, i + MAX_CHUNK));
        }
        continue;
      }
      const candidate = current ? `${current} ${part}` : part;
      if (candidate.length <= MAX_CHUNK) {
        current = candidate;
      } else {
        if (current) chunks.push(current);
        current = part;
      }
    }
    if (current) chunks.push(current);
    return chunks.length > 0 ? chunks : [text.slice(0, MAX_CHUNK)];
  }, []);

  const resolveThaiVoice = useCallback((): SpeechSynthesisVoice | null => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
    if (speechVoiceRef.current) return speechVoiceRef.current;
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return null;

    const thaiVoice = voices.find((v) => /(^th[-_]|thai)/i.test(`${v.lang} ${v.name}`));
    speechVoiceRef.current = thaiVoice || null;
    return speechVoiceRef.current;
  }, []);

  const drainSpeechQueue = useCallback(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    if (!isVoiceActiveRef.current) return;
    if (speechIsSpeakingRef.current) return;
    const next = speechQueueRef.current.shift();
    if (!next) return;

    const utterance = new SpeechSynthesisUtterance(next);
    const selectedVoice = resolveThaiVoice();
    if (selectedVoice) {
      utterance.voice = selectedVoice;
      utterance.lang = selectedVoice.lang || 'th-TH';
    } else {
      utterance.lang = 'th-TH';
    }
    utterance.rate = 1.02;
    utterance.pitch = 1;

    speechIsSpeakingRef.current = true;
    utterance.onend = () => {
      speechIsSpeakingRef.current = false;
      drainSpeechQueue();
    };
    utterance.onerror = () => {
      speechIsSpeakingRef.current = false;
      drainSpeechQueue();
    };

    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      speechIsSpeakingRef.current = false;
      drainSpeechQueue();
    }
  }, [resolveThaiVoice]);

  const enqueueSpeechReply = useCallback((rawText: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    if (!isVoiceActiveRef.current) return;
    const clean = sanitizeSpeechText(rawText);
    if (!clean) return;

    const chunks = splitSpeechChunks(clean);
    if (!chunks.length) return;
    speechQueueRef.current.push(...chunks);

    // Voice list can be empty until browser finishes loading voices.
    if (window.speechSynthesis.getVoices().length === 0) {
      setTimeout(() => {
        speechVoiceRef.current = null;
        drainSpeechQueue();
      }, 300);
    }

    drainSpeechQueue();
  }, [drainSpeechQueue, sanitizeSpeechText, splitSpeechChunks]);

  const stopSpeechRecognition = useCallback(() => {
    const recognition = speechRecognitionRef.current;
    if (recognition) {
      try { recognition.onresult = null; } catch { /* ignore */ }
      try { recognition.onerror = null; } catch { /* ignore */ }
      try { recognition.onend = null; } catch { /* ignore */ }
      try { recognition.stop(); } catch { /* ignore */ }
      speechRecognitionRef.current = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      speechQueueRef.current = [];
      speechIsSpeakingRef.current = false;
      speechVoiceRef.current = null;
      window.speechSynthesis.cancel();
    }
  }, []);

  const startSpeechRecognition = useCallback((): boolean => {
    if (typeof window === 'undefined') return false;
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return false;
    if (speechRecognitionRef.current) return true;

    try {
      const recognition = new Ctor();
      recognition.lang = 'th-TH';
      recognition.interimResults = true;
      recognition.continuous = true;

      recognition.onresult = (event: BrowserSpeechRecognitionEvent) => {
        if (!isVoiceActiveRef.current) return;
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const transcript = String(result?.[0]?.transcript || '').trim();
          if (!transcript) continue;
          if (result.isFinal) {
            finalTranscript += `${finalTranscript ? ' ' : ''}${transcript}`;
          }
        }
        const text = finalTranscript.trim();
        if (!text) return;

        if (SHOW_AGENT_VOICE_TRANSCRIPT_IN_CHAT) {
          setMessages((prev) => [...prev, {
            id: `${Date.now()}_voice_user`,
            sender: 'user',
            text,
            timestamp: new Date().toISOString(),
            backend: 'agent',
          }]);
        }
        emit('voice:text_input', { text });
      };

      recognition.onerror = (event: { error?: string }) => {
        console.warn('Speech recognition error:', event?.error || 'unknown');
      };

      recognition.onend = () => {
        speechRecognitionRef.current = null;
        if (!isVoiceActiveRef.current) return;
        // Auto-restart while live call is active
        startSpeechRecognition();
      };

      recognition.start();
      speechRecognitionRef.current = recognition;
      return true;
    } catch (err) {
      console.warn('Failed to start speech recognition:', err);
      speechRecognitionRef.current = null;
      return false;
    }
  }, [emit]);

  // ─── Terminal session management (Gemini/Codex/Claude) ─────────────────────
  const ensureTerminalSession = useCallback((backendId: string) => {
    if (!connected || !isTerminalBackendId(backendId)) return;
    if (terminalSessionIds.current[backendId] || pendingTerminalCreate.current[backendId]) return;
    pendingTerminalCreate.current[backendId] = true;
    emit('terminal:create', { type: backendId, label: `UI_${backendId}`, platform: 'web' });
  }, [connected, emit]);

  useEffect(() => {
    if (!connected) return;

    const offOutput = on('terminal:output', (data: { sessionId: string; data: string }) => {
      const activeSessionId = terminalSessionIds.current[activeBackendIdRef.current];
      if (data.sessionId === activeSessionId) {
        xtermRef.current?.write(data.data);
      }
    });

    const offCreated = on('terminal:created', (data: { sessionId: string; label?: string }) => {
      const backendId = data.label?.startsWith('UI_') ? data.label.slice(3) : '';
      if (backendId && isTerminalBackendId(backendId)) {
        terminalSessionIds.current[backendId] = data.sessionId;
        pendingTerminalCreate.current[backendId] = false;
        sessionToBackend.current[data.sessionId] = backendId;
        // Focus xterm if this backend tab is active
        if (activeBackendIdRef.current === backendId) {
          setTimeout(() => xtermRef.current?.focus(), 100);
        }
      }
    });

    const offExit = on('terminal:exit', (data: { sessionId: string }) => {
      const backendId = sessionToBackend.current[data.sessionId];
      if (backendId && isTerminalBackendId(backendId)) {
        terminalSessionIds.current[backendId] = null;
        pendingTerminalCreate.current[backendId] = false;
        delete sessionToBackend.current[data.sessionId];
        if (activeBackendIdRef.current === backendId) {
          xtermRef.current?.write('\r\n\x1b[2m[Process exited. Auto-reconnecting in 2s...]\x1b[0m\r\n');
          // Auto-reconnect after 2 seconds
          setTimeout(() => {
            if (activeBackendIdRef.current === backendId) {
              ensureTerminalSession(backendId);
            }
          }, 2000);
        }
      }
    });

    const offUi = on('agent:ui', (data: any) => {
      if (activeBackendIdRef.current === 'agent') {
        const uiData: UIData = {
          componentType: data.componentType,
          title: data.title,
          data: data.data
        };
        setMessages(prev => [...prev, {
          id: `${Date.now()}_bot_ui`, sender: 'bot',
          text: `[Rendered UI Component: ${data.componentType}]`,
          timestamp: data.timestamp || new Date().toISOString(),
          backend: 'agent',
          ui: uiData
        }]);
      }
    });

    // ─── Voice Handlers ───
    const offVoiceReady = on('voice:ready', (data?: { mode?: string }) => {
        isVoiceActiveRef.current = true;
        setIsVoiceLoading(false);
        setIsVoiceActive(true);
        const mode = String(data?.mode || '');
        if (normalizeVoiceMode(mode) === 'agent-tools') {
          const startedRecognition = startSpeechRecognition();
          if (!startedRecognition) {
            // Fallback to original live-direct mode when browser does not support SpeechRecognition.
            emit('voice:stop');
            setVoiceMode('live-direct');
            setIsVoiceLoading(true);
            emit('voice:start', { mode: 'live-direct' });
          }
          return;
        }
        if (normalizeVoiceMode(mode) !== 'agent-tools') {
          startMic();
        }
    });

    const offVoiceRecv = on('voice:audio_recv', async (data: { data: string }) => {
        if (!audioContextRef.current) return;
        
        try {
            // Decode base64 to binary
            const binaryString = window.atob(data.data);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            // Convert PCM16 to Float32
            const pcm16 = new Int16Array(bytes.buffer);
            const float32 = new Float32Array(pcm16.length);
            for (let i = 0; i < pcm16.length; i++) {
                float32[i] = pcm16[i] / 32768.0;
            }

            // Create AudioBuffer (Gemini outputs 24kHz usually, but let's assume 16kHz to 24kHz)
            const sampleRate = 24000;
            const audioBuffer = audioContextRef.current.createBuffer(1, float32.length, sampleRate);
            audioBuffer.copyToChannel(float32, 0);

            // Play the buffer
            const source = audioContextRef.current.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(audioContextRef.current.destination);
            
            const currentTime = audioContextRef.current.currentTime;
            const playTime = Math.max(currentTime, nextPlayTimeRef.current);
            source.start(playTime);
            nextPlayTimeRef.current = playTime + audioBuffer.duration;

        } catch (err) {
            console.error('Failed to play audio chunk', err);
        }
    });

    const offVoiceText = on('voice:text_recv', (data: { text: string; source?: string }) => {
        const source = String(data.source || 'voice');
        if (source === 'agent') return;
        const label = source === 'agent' ? 'Jarvis Agent' : 'Voice';
        setMessages(prev => [...prev, {
            id: `${Date.now()}_voice`, sender: 'bot',
            text: `[${label}] ${data.text}`,
            timestamp: new Date().toISOString(),
            backend: 'agent'
        }]);
    });

    const offVoiceAgentReply = on('voice:agent_reply', (data: { input?: string; reply: string }) => {
        setMessages(prev => [...prev, {
            id: `${Date.now()}_voice_agent`, sender: 'bot',
            text: data.reply,
            timestamp: new Date().toISOString(),
            backend: 'agent'
        }]);
        enqueueSpeechReply(data.reply);
    });

    const offVoiceAgentStatus = on('voice:agent_status', (data: { status?: string }) => {
        setIsVoiceAgentBusy(String(data?.status || '').toLowerCase() === 'processing');
    });

    const offVoiceError = on('voice:error', (data: { message: string }) => {
        isVoiceActiveRef.current = false;
        setIsVoiceActive(false);
        setIsVoiceLoading(false);
        setIsVoiceAgentBusy(false);
        stopSpeechRecognition();
        stopMic();
        alert(`Voice Error: ${data.message}`);
    });

    const offVoiceDisconnected = on('voice:disconnected', () => {
        isVoiceActiveRef.current = false;
        setIsVoiceActive(false);
        setIsVoiceLoading(false);
        setIsVoiceAgentBusy(false);
        stopSpeechRecognition();
        stopMic();
    });

    // Try to create session immediately when socket connects
    emit('terminal:list');

    return () => { 
        offOutput(); offCreated(); offExit(); offUi(); 
        offVoiceReady(); offVoiceRecv(); offVoiceText(); offVoiceAgentReply(); offVoiceAgentStatus(); offVoiceError(); offVoiceDisconnected();
    };
  }, [connected, on, emit, enqueueSpeechReply, startSpeechRecognition, stopSpeechRecognition]);

  // When switching to a CLI tab, ensure session exists
  useEffect(() => {
    if (connected && isTerminalBackendId(activeBackendId) && !terminalSessionIds.current[activeBackendId]) {
      ensureTerminalSession(activeBackendId);
    }
  }, [activeBackendId, connected, ensureTerminalSession]);

  const handleTerminalData = useCallback((data: string) => {
    const sessionId = terminalSessionIds.current[activeBackendIdRef.current];
    if (!sessionId) return;
    emit('terminal:input', { sessionId, data });
  }, [emit]);

  const handleTerminalResize = useCallback((cols: number, rows: number) => {
    const sessionId = terminalSessionIds.current[activeBackendIdRef.current];
    if (!sessionId) return;
    emit('terminal:resize', { sessionId, cols, rows });
  }, [emit]);

  // ─── Voice Loop (Mic Capture) ────────────────────────────────────────────────
  const startMic = async () => {
    if (mediaRecorderRef.current) return;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        // Initialize Audio Context for playback
        if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
            audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        }
        if (audioContextRef.current.state === 'suspended') {
            await audioContextRef.current.resume();
        }
        nextPlayTimeRef.current = audioContextRef.current.currentTime;

        // Capture mic frames and resample to 16k PCM for Live API input.
        const micSource = audioContextRef.current.createMediaStreamSource(stream);
        const processor = audioContextRef.current.createScriptProcessor(4096, 1, 1);
        
        processor.onaudioprocess = (e) => {
            if (!isVoiceActiveRef.current) return;

            const sourceRate = e.inputBuffer.sampleRate || audioContextRef.current?.sampleRate || TARGET_VOICE_SAMPLE_RATE;
            const inputData = e.inputBuffer.getChannelData(0);
            const pcm16 = downsampleToPcm16(inputData, sourceRate, TARGET_VOICE_SAMPLE_RATE);
            if (!pcm16.length) return;

            emit('voice:audio_send', { audio: pcm16ToBase64(pcm16) });
        };

        micSource.connect(processor);
        processor.connect(audioContextRef.current.destination);

        // Save reference to stop later
        (processor as any).__micStream = stream;
        (processor as any).__micSource = micSource;
        mediaRecorderRef.current = processor as any;

    } catch (err) {
        console.error('Mic access denied:', err);
        alert('Microphone permission denied. Please allow microphone access and try again.');
        isVoiceActiveRef.current = false;
        setIsVoiceActive(false);
        setIsVoiceLoading(false);
        emit('voice:stop');
    }
  };

  const stopMic = () => {
      if (mediaRecorderRef.current) {
          const stream = (mediaRecorderRef.current as any).__micStream as MediaStream;
          const source = (mediaRecorderRef.current as any).__micSource as MediaStreamAudioSourceNode | undefined;
          if (stream) {
              stream.getTracks().forEach(t => t.stop());
          }
          if (source) {
              source.disconnect();
          }
          (mediaRecorderRef.current as any).disconnect();
          mediaRecorderRef.current = null;
      }
      if (audioContextRef.current) {
          audioContextRef.current.close().catch(console.error);
          audioContextRef.current = null;
      }
  };

  const toggleVoice = () => {
      if (isVoiceActive) {
          isVoiceActiveRef.current = false;
          setIsVoiceActive(false);
          setIsVoiceLoading(false);
          setIsVoiceAgentBusy(false);
          stopSpeechRecognition();
          stopMic();
          emit('voice:stop');
      } else {
          setIsVoiceLoading(true);
          emit('voice:start', { mode: voiceModeRef.current });
      }
  };

  // ─── Chat (Agent) ────────────────────────────────────────────────────────────
  const switchBackend = useCallback((id: string) => {
    if (!backendById.has(id)) return;
    // Save current messages to cache
    messagesCacheRef.current[activeBackendId] = messages;
    const cached = messagesCacheRef.current[id] || [];
    setMessages(cached);
    setActiveBackendId(id);
    shouldAutoScrollRef.current = true;
    setTimeout(() => {
      if (isTerminalBackendId(id)) {
        // fit() MUST be called after the panel becomes visible (unhidden)
        xtermRef.current?.clear();
        xtermRef.current?.fit();
        xtermRef.current?.focus();
        ensureTerminalSession(id);
      } else {
        scrollMessagesToBottom('auto');
        inputRef.current?.focus();
      }
    }, 50);
  }, [backendById, activeBackendId, messages, ensureTerminalSession, scrollMessagesToBottom]);

  const sendAgentMessage = async (userText: string) => {
    try {
      const prefix = activeBackend.id === 'gemini-cli' ? '@gemini' : '@agent';
      const response = await fetchWithAuth('/api/terminal/execute', {
        method: 'POST',
        body: JSON.stringify({ command: `${prefix} ${userText}`, platform: 'web' }),
      });
      const data = await response.json();
      const replyText = response.ok ? (data.output || '(no response)') : (data.error || `HTTP ${response.status}`);
      setMessages(prev => [...prev, {
        id: `${Date.now()}_bot`, sender: 'bot',
        text: String(replyText), timestamp: new Date().toISOString(), backend: activeBackend.id,
      }]);
    } catch (err: any) {
      setMessages(prev => [...prev, {
        id: `${Date.now()}_error`, sender: 'bot',
        text: `Network Error: ${err.message || 'Could not reach server'}`,
        timestamp: new Date().toISOString(), backend: activeBackend.id,
      }]);
    } finally {
      setIsTyping(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const handleChatSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isTyping || activeBackend.isTerminal) return;
    const userText = input.trim();
    setInput('');
    setMessages(prev => [...prev, {
      id: `${Date.now()}_user`, sender: 'user', text: userText,
      timestamp: new Date().toISOString(), backend: 'agent',
    }]);
    setIsTyping(true);
    sendAgentMessage(userText);
  };

  const handleClear = () => {
    if (activeBackend.isTerminal) {
      // Restart the terminal session
      const sessionId = terminalSessionIds.current[activeBackend.id];
      if (sessionId && confirm(`Restart ${activeBackend.label} session?`)) {
        emit('terminal:close', { sessionId });
        terminalSessionIds.current[activeBackend.id] = null;
        pendingTerminalCreate.current[activeBackend.id] = false;
        delete sessionToBackend.current[sessionId];
        xtermRef.current?.clear();
        setTimeout(() => ensureTerminalSession(activeBackend.id), 200);
      }
    } else {
      if (confirm('Clear chat history?')) {
        setMessages([]);
        messagesCacheRef.current['agent'] = [];
      }
    }
  };

  const formatTime = (iso: string) => {
    try { return new Date(iso).toLocaleTimeString('th-TH'); } catch { return ''; }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-64px)] bg-gray-950 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <MonitorUp className="w-6 h-6 text-violet-400" /> Jarvis Root Admin Terminal
          </h2>
          <p className="text-sm text-gray-400">Manage system config & agent swarm from the browser</p>
        </div>
        <div className="flex items-center gap-2">
          {activeBackendId === 'agent' && (
            <>
              <select
                value={voiceMode}
                onChange={(event) => setVoiceMode(normalizeVoiceMode(event.target.value))}
                disabled={isVoiceActive || isVoiceLoading}
                className="px-2 py-1.5 text-xs rounded-lg border border-gray-700 bg-gray-900 text-gray-200 disabled:opacity-50"
                title="Voice mode"
              >
                <option value="live-direct">Live Thai (Natural)</option>
                <option value="agent-tools">Agent Tools (Command)</option>
              </select>
              <button
                onClick={toggleVoice}
                disabled={isVoiceLoading || !connected}
                className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                  isVoiceActive
                      ? 'bg-red-500/20 text-red-400 border-red-500/30 hover:bg-red-500/30'
                      : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/30'
                } disabled:opacity-50`}
              >
                {isVoiceLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                ) : isVoiceActive ? (
                    <MicOff className="w-4 h-4" />
                ) : (
                    <Mic className="w-4 h-4" />
                )}
                {isVoiceLoading ? 'Connecting...' : isVoiceActive ? 'Stop Live Call' : 'Start Live Call'}
              </button>
            </>
          )}

          <button
            onClick={handleClear}
            className="flex items-center gap-2 px-3 py-1.5 text-sm bg-gray-900 text-red-400 hover:bg-red-500/10 hover:text-red-300 rounded-lg border border-gray-800 transition-colors"
          >
            {activeBackend.isTerminal ? <RefreshCw className="w-4 h-4" /> : <Trash2 className="w-4 h-4" />}
            {activeBackend.isTerminal ? 'Restart CLI' : 'Clear Chat'}
          </button>
        </div>
      </div>

      {/* Backend selector */}
      <div className="flex gap-2 mb-4">
        {BACKEND_OPTIONS.map((backend) => {
          const Icon = backend.icon;
          const isActive = backend.id === activeBackendId;
          return (
            <button
              key={backend.id}
              onClick={() => switchBackend(backend.id)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium border transition-all ${
                isActive ? backend.theme.chipActive : 'bg-gray-900 border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-gray-300'
              }`}
            >
              <Icon className="w-4 h-4" />
              {backend.label}
            </button>
          );
        })}
      </div>

      {/* Lane Health Status */}
      {laneMetrics.length > 0 && (
        <div className="flex items-center gap-3 mb-3 px-1">
          <Activity className="w-3.5 h-3.5 text-gray-500" />
          {laneMetrics.map((lane) => {
            const stateColor =
              lane.state === 'healthy' ? 'bg-green-500' :
              lane.state === 'degraded' ? 'bg-yellow-500' :
              lane.state === 'unavailable' ? 'bg-red-500' :
              'bg-gray-600';
            return (
              <div key={lane.specialist} className="flex items-center gap-1.5 text-[10px] text-gray-400" title={`${lane.specialist}: ${lane.state} (${lane.rates.success}% success, ${lane.totalTasks} tasks)`}>
                <span className={`w-2 h-2 rounded-full ${stateColor}`} />
                <span className="font-mono">{lane.specialist}</span>
                {lane.totalTasks > 0 && <span className="text-gray-600">{lane.rates.success}%</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* Main window */}
      <div className="flex-1 min-h-0 bg-[#1e1e1e] rounded-xl border border-gray-800 flex flex-col shadow-2xl overflow-hidden">
        {/* Window chrome */}
        <div className="h-8 bg-black/40 border-b border-gray-800 flex items-center px-4 gap-2 flex-shrink-0">
          <div className="w-3 h-3 rounded-full bg-red-500/80" />
          <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
          <div className="w-3 h-3 rounded-full bg-green-500/80" />
          <span className="ml-2 text-xs text-gray-500">{activeBackend.senderLabel}</span>
          {!connected && (
            <span className="ml-auto text-xs text-red-400 flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" /> Offline
            </span>
          )}
        </div>

        {/* Chat panel — shown only for non-terminal backends (Agent) */}
        <div className={`flex-col flex-1 min-h-0 bg-[#1e1e1e] ${activeBackend.isTerminal ? 'hidden' : 'flex'}`}>
          <div
            ref={messageListRef}
            onScroll={handleMessageListScroll}
            onWheelCapture={(event) => event.stopPropagation()}
            className="flex-1 min-h-0 p-4 overflow-y-auto overscroll-contain space-y-4"
          >
            {messages.length === 0 && (
              <div className="text-center py-12">
                <Bot className="w-12 h-12 text-violet-300 mx-auto mb-3 opacity-40" />
                <p className="text-gray-500 text-sm">Welcome back, Sir. What would you like me to do?</p>
              </div>
            )}
            {messages.map((msg) => (
              <div key={msg.id} className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[10px] uppercase font-bold ${msg.sender === 'user' ? 'text-blue-400' : activeBackend.theme.accent}`}>
                    {msg.sender === 'user' ? 'root@admin' : activeBackend.senderLabel}
                  </span>
                  <span className="text-[10px] text-gray-600">{formatTime(msg.timestamp)}</span>
                </div>
                <div className={`max-w-[85%] px-4 py-3 rounded-lg text-sm whitespace-pre-wrap ${
                  msg.sender === 'user'
                    ? 'bg-blue-600/20 border border-blue-500/30 text-blue-100 rounded-tr-none'
                    : `${activeBackend.theme.bubble} border ${activeBackend.theme.border} ${activeBackend.theme.text} rounded-tl-none`
                }`}>
                  {msg.text}
                  {msg.ui && (
                    <div className="mt-2 w-full max-w-full">
                      <GenerativeUI ui={msg.ui} />
                    </div>
                  )}
                </div>
              </div>
            ))}
            {(isTyping || isVoiceAgentBusy) && (
              <div className="flex flex-col items-start">
                <div className={`px-4 py-3 ${activeBackend.theme.bubble} rounded-lg border ${activeBackend.theme.border} flex items-center gap-2`}>
                  <Loader2 className={`w-4 h-4 ${activeBackend.theme.accent} animate-spin`} />
                  <span className="text-gray-400 text-xs">
                    {isVoiceAgentBusy ? 'Jarvis is processing voice command...' : (activeBackend.id === 'gemini-cli' ? 'Gemini is thinking...' : 'Jarvis is thinking...')}
                  </span>
                </div>
              </div>
            )}
          </div>
          <form onSubmit={handleChatSend} className="relative flex-shrink-0 m-2">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-violet-400 font-mono font-bold">{'>'}</span>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask Jarvis to modify code, config, or interact with Swarm..."
              className="w-full bg-[#1e1e1e] border border-gray-800 rounded-xl py-4 pl-10 pr-16 text-gray-300 font-mono focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500 transition-colors"
              disabled={isTyping}
              autoComplete="off"
            />
            <button
              type="submit"
              disabled={!input.trim() || isTyping}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-lg bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 disabled:opacity-50 transition-colors"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>

        {/* CLI Terminal panel */}
        <div className={`flex-1 p-2 ${activeBackend.isTerminal ? 'flex' : 'hidden'}`}>
          <XTerminal
            ref={xtermRef}
            onData={handleTerminalData}
            onResize={handleTerminalResize}
          />
        </div>
      </div>
    </div>
  );
}

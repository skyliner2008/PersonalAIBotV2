import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Mic, Paperclip, PhoneCall, PhoneOff, Send, Volume2, Wand2 } from 'lucide-react';
import { useSocket } from '../hooks/useSocket';
import { api, type UploadFileResult } from '../services/api';

const TARGET_VOICE_SAMPLE_RATE = 16000;
const VOICE_MODE_STORAGE_KEY = 'jarvis_call_voice_mode';

// Unified mode: always 'agent-tools' with 'live' transport for natural Thai + tool support
type VoiceMode = 'agent-tools';
type VoiceTransport = 'stt' | 'live';

interface CallAttachment {
  url: string;
  name: string;
  kind: 'image' | 'file';
  mimeType?: string;
  sizeBytes?: number;
  caption?: string;
}

interface CallLog {
  id: string;
  role: 'system' | 'user' | 'assistant';
  text: string;
  timestamp: string;
  attachment?: CallAttachment;
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

function normalizeVoiceMode(_mode?: string | null): VoiceMode {
  // Unified mode: always agent-tools (Live Thai removed)
  return 'agent-tools';
}

function downsampleToPcm16(input: Float32Array, inputRate: number, outputRate: number): Int16Array {
  if (!input.length) return new Int16Array(0);

  if (!Number.isFinite(inputRate) || inputRate <= 0 || inputRate === outputRate) {
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
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
    for (let i = offsetBuffer; i < nextOffsetBuffer; i += 1) {
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
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function formatClock(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString('th-TH');
  } catch {
    return '';
  }
}

function buildAttachmentCommand(uploaded: UploadFileResult['file']): string {
  const name = String(uploaded?.originalName || 'unknown-file');
  const type = String(uploaded?.type || 'unknown');
  const mimeType = String(uploaded?.mimeType || 'application/octet-stream');
  const sizeKB = Number.isFinite(uploaded?.sizeKB) ? uploaded.sizeKB : 0;
  const preview = String(uploaded?.contentPreview || '').trim();
  const previewText = preview || '[ไม่มีตัวอย่างข้อความจากไฟล์นี้]';

  return [
    `ผู้ใช้แนบไฟล์ "${name}"`,
    `ชนิดไฟล์: ${type} | MIME: ${mimeType} | ขนาดประมาณ: ${sizeKB} KB`,
    'โปรดวิเคราะห์ข้อมูลจากไฟล์นี้และตอบเป็นภาษาไทยแบบเข้าใจง่าย',
    'ถ้าเป็นตัวเลขหรือรายการ ให้แสดงผลลัพธ์สำคัญเป็นข้อความในแชทอย่างชัดเจน',
    '',
    'ข้อมูลเบื้องต้นจากไฟล์:',
    previewText,
  ].join('\n');
}

export function JarvisCall() {
  const { socket, connected, emit, on } = useSocket();
  const isMobileBrowser = useMemo(() => {
    const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '';
    return /android|iphone|ipad|ipod/i.test(ua);
  }, []);
  const [voiceMode, setVoiceMode] = useState<VoiceMode>('agent-tools');

  const [isVoiceLoading, setIsVoiceLoading] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [isVoiceAgentBusy, setIsVoiceAgentBusy] = useState(false);
  const [voiceTransport, setVoiceTransport] = useState<VoiceTransport>('stt');
  const [logs, setLogs] = useState<CallLog[]>([]);
  const [linkCopied, setLinkCopied] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  const [meetingSteps, setMeetingSteps] = useState<Array<{ step: string; status: string; ts: number }>>([]);

  const isVoiceActiveRef = useRef(false);
  const voiceModeRef = useRef<VoiceMode>(voiceMode);
  const voiceTransportRef = useRef<VoiceTransport>('stt');
  const mediaProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef(0);
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const isTtsSpeakingRef = useRef(false);
  const suppressSttUntilRef = useRef(0);
  const lastSentTranscriptRef = useRef('');
  const lastSentAtRef = useRef(0);
  const ttsRecoveryTimerRef = useRef<number | null>(null);
  const inputCooldownUntilRef = useRef(0);
  const awaitingAgentReplyRef = useRef(false);
  const agentReplyWatchdogRef = useRef<number | null>(null);
  const autoStartDoneRef = useRef(false);
  const logListRef = useRef<HTMLDivElement>(null);
  const startCallTimeoutRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastVoiceActivityAtRef = useRef<number>(Date.now());
  const lastVoicePongAtRef = useRef<number>(Date.now());
  const recoveryInProgressRef = useRef(false);
  const userStoppedRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const startCallRef = useRef<(() => void) | null>(null);
  const [reconnectCountdown, setReconnectCountdown] = useState(0);
  const [connectionState, setConnectionState] = useState<'idle' | 'connecting' | 'connected' | 'reconnecting'>('idle');

  const pushLog = useCallback((role: CallLog['role'], text: string, attachment?: CallAttachment) => {
    const clean = String(text || '').trim();
    if (!clean && !attachment) return;
    setLogs((prev) => [
      ...prev,
      {
        id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        role,
        text: clean || (attachment ? `ส่งไฟล์: ${attachment.name}` : ''),
        timestamp: new Date().toISOString(),
        attachment,
      },
    ]);
  }, []);

  const markVoiceActivity = useCallback(() => {
    lastVoiceActivityAtRef.current = Date.now();
  }, []);

  useEffect(() => {
    isVoiceActiveRef.current = isVoiceActive;
  }, [isVoiceActive]);

  useEffect(() => {
    voiceModeRef.current = voiceMode;
    // Always use 'live' transport for natural Thai + tool support
    const nextTransport: VoiceTransport = 'live';
    voiceTransportRef.current = nextTransport;
    setVoiceTransport(nextTransport);
  }, [voiceMode]);

  useEffect(() => {
    const el = logListRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [logs, isVoiceAgentBusy]);

  const clearStartCallTimeout = useCallback(() => {
    if (startCallTimeoutRef.current != null) {
      window.clearTimeout(startCallTimeoutRef.current);
      startCallTimeoutRef.current = null;
    }
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current != null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setReconnectCountdown(0);
  }, []);

  const clearAgentReplyWatchdog = useCallback(() => {
    if (agentReplyWatchdogRef.current != null) {
      window.clearTimeout(agentReplyWatchdogRef.current);
      agentReplyWatchdogRef.current = null;
    }
  }, []);

  const stopSpeechRecognition = useCallback(() => {
    const recognition = speechRecognitionRef.current;
    if (recognition) {
      try { recognition.onresult = null; } catch { /* ignore */ }
      try { recognition.onerror = null; } catch { /* ignore */ }
      try { recognition.onend = null; } catch { /* ignore */ }
      try { recognition.stop(); } catch { /* ignore */ }
      speechRecognitionRef.current = null;
    }
  }, []);

  const releaseTtsGateIfNeeded = useCallback(() => {
    if (!isTtsSpeakingRef.current) return;
    const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
    const speakingNow = !!synth?.speaking;
    if (speakingNow) return;
    if (Date.now() >= suppressSttUntilRef.current) {
      isTtsSpeakingRef.current = false;
    }
  }, []);

  const startSpeechRecognition = useCallback((): boolean => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return false;
    if (speechRecognitionRef.current) return true;

    try {
      const recognition = new Ctor();
      recognition.lang = 'th-TH';
      // Mobile browsers are more stable with non-continuous sessions + hard resume.
      recognition.interimResults = !isMobileBrowser;
      recognition.continuous = !isMobileBrowser;

      recognition.onresult = (event: BrowserSpeechRecognitionEvent) => {
        if (!isVoiceActiveRef.current) return;
        releaseTtsGateIfNeeded();

        // Block input while TTS is speaking (prevent echo)
        if (isTtsSpeakingRef.current) return;
        if ('speechSynthesis' in window && window.speechSynthesis.speaking) return;
        if (Date.now() < suppressSttUntilRef.current) return;

        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const transcript = String(result?.[0]?.transcript || '').trim();
          if (!transcript) continue;
          if (result.isFinal) {
            finalTranscript += `${finalTranscript ? ' ' : ''}${transcript}`;
          }
        }

        const text = finalTranscript.replace(/\s+/g, ' ').trim();
        if (!text) return;

        // Deduplicate: same text within 4s
        const now = Date.now();
        if (text === lastSentTranscriptRef.current && now - lastSentAtRef.current < 4000) {
          return;
        }

        // Cooldown between sends (prevent rapid-fire)
        if (now < inputCooldownUntilRef.current) return;

        lastSentTranscriptRef.current = text;
        lastSentAtRef.current = now;
        inputCooldownUntilRef.current = now + 1800;

        // Show user's speech in chat immediately (always visible)
        pushLog('user', text);

        // If agent is still processing previous request, queue but don't block display
        if (awaitingAgentReplyRef.current) {
          // Still send — server will queue it; user sees their text in chat
          emit('voice:text_input', { text });
          return;
        }

        awaitingAgentReplyRef.current = true;
        clearAgentReplyWatchdog();
        agentReplyWatchdogRef.current = window.setTimeout(() => {
          awaitingAgentReplyRef.current = false;
        }, 65000);

        emit('voice:text_input', { text });
      };

      recognition.onerror = (event: { error?: string }) => {
        const code = String(event?.error || 'unknown');
        console.warn('Speech recognition error:', code);
        if (!isVoiceActiveRef.current) return;
        if (voiceModeRef.current !== 'agent-tools') return;
        if (voiceTransportRef.current !== 'stt') return;
        releaseTtsGateIfNeeded();
        if (isTtsSpeakingRef.current) return;
        if (code === 'aborted') return;
        if (speechRecognitionRef.current === recognition) {
          speechRecognitionRef.current = null;
        }
        window.setTimeout(() => {
          if (!isVoiceActiveRef.current) return;
          if (voiceModeRef.current !== 'agent-tools') return;
          if (isTtsSpeakingRef.current) return;
          if (speechRecognitionRef.current) return;
          startSpeechRecognition();
        }, 350);
      };

      recognition.onend = () => {
        speechRecognitionRef.current = null;
        if (!isVoiceActiveRef.current) return;
        if (voiceModeRef.current !== 'agent-tools') return;
        if (voiceTransportRef.current !== 'stt') return;
        releaseTtsGateIfNeeded();
        if (isTtsSpeakingRef.current) return;

        const waitMs = Math.max(0, suppressSttUntilRef.current - Date.now());
        if (waitMs > 0) {
          window.setTimeout(() => {
            if (!isVoiceActiveRef.current) return;
            if (voiceModeRef.current !== 'agent-tools') return;
            if (isTtsSpeakingRef.current) return;
            if (speechRecognitionRef.current) return;
            startSpeechRecognition();
          }, waitMs);
          return;
        }

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
  }, [clearAgentReplyWatchdog, emit, isMobileBrowser, pushLog, releaseTtsGateIfNeeded]);

  const ensureSpeechRecognitionListening = useCallback((forceRestart: boolean = false) => {
    if (!isVoiceActiveRef.current) return;
    if (voiceModeRef.current !== 'agent-tools') return;

    if (forceRestart) {
      stopSpeechRecognition();
    } else if (speechRecognitionRef.current) {
      return;
    }

    window.setTimeout(() => {
      if (!isVoiceActiveRef.current) return;
      if (voiceModeRef.current !== 'agent-tools') return;
      if (speechRecognitionRef.current) return;
      startSpeechRecognition();
    }, 180);
  }, [startSpeechRecognition, stopSpeechRecognition]);

  const startMic = useCallback(async () => {
    if (mediaProcessorRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }
      nextPlayTimeRef.current = audioContextRef.current.currentTime;

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

      (processor as any).__micStream = stream;
      (processor as any).__micSource = micSource;
      mediaProcessorRef.current = processor;
    } catch (err) {
      console.error('Mic access denied:', err);
      const reason = String((err as any)?.name || (err as any)?.message || err || 'unknown').trim();
      pushLog('system', `ไม่สามารถเข้าถึงไมโครโฟนได้ (${reason}) กรุณาอนุญาตไมค์แล้วลองใหม่`);
      setIsVoiceLoading(false);
      setIsVoiceActive(false);
      isVoiceActiveRef.current = false;
      emit('voice:stop', { reason: 'mic-start-failed' });
    }
  }, [emit, pushLog]);

  const stopMic = useCallback(() => {
    if (mediaProcessorRef.current) {
      const stream = (mediaProcessorRef.current as any).__micStream as MediaStream | undefined;
      const source = (mediaProcessorRef.current as any).__micSource as MediaStreamAudioSourceNode | undefined;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (source) source.disconnect();
      mediaProcessorRef.current.disconnect();
      mediaProcessorRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(console.error);
      audioContextRef.current = null;
    }
  }, []);

  const speakAssistantReply = useCallback((rawReply: string) => {
    const raw = String(rawReply || '').trim();
    if (!raw) return;
    if (!('speechSynthesis' in window)) return;

    // Strip markdown formatting for natural TTS
    const reply = raw
      .replace(/#{1,6}\s*/g, '')           // remove headers
      .replace(/\*\*([^*]+)\*\*/g, '$1')   // bold → plain
      .replace(/\*([^*]+)\*/g, '$1')       // italic → plain
      .replace(/`([^`]+)`/g, '$1')         // inline code → plain
      .replace(/```[\s\S]*?```/g, '')      // remove code blocks
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // remove images
      .replace(/\[[^\]]*\]\([^)]*\)/g, (m) => m.replace(/\[([^\]]*)\]\([^)]*\)/, '$1')) // links → text only
      .replace(/[-*+]\s+/g, '')            // remove bullet markers
      .replace(/\d+\.\s+/g, '')            // remove numbered list markers
      .replace(/[🔍📄❌⏳👑🔷🟡🟢⚪💡✅❓🎯📌🔗]/g, '') // remove common emojis
      .replace(/\n{2,}/g, ' ')             // collapse multiple newlines
      .replace(/\n/g, ' ')                 // single newlines to space
      .replace(/\s{2,}/g, ' ')             // collapse whitespace
      .trim();

    if (!reply || reply.length < 2) return;

    isTtsSpeakingRef.current = true;
    suppressSttUntilRef.current = Date.now() + 900;

    // Split into chunks for longer replies (speechSynthesis can choke on long text)
    const MAX_CHUNK = 400;
    const chunks: string[] = [];
    if (reply.length <= MAX_CHUNK) {
      chunks.push(reply);
    } else {
      // Split at sentence boundaries (Thai period, space, etc.)
      const sentences = reply.match(/[^.。!?]+[.。!?]?\s*/g) || [reply];
      let current = '';
      for (const s of sentences) {
        if ((current + s).length > MAX_CHUNK && current) {
          chunks.push(current.trim());
          current = s;
        } else {
          current += s;
        }
      }
      if (current.trim()) chunks.push(current.trim());
    }

    // Limit total TTS to ~1200 chars to avoid very long speech
    let totalLen = 0;
    const speakChunks: string[] = [];
    for (const c of chunks) {
      if (totalLen + c.length > 1200) break;
      speakChunks.push(c);
      totalLen += c.length;
    }

    let chunkIndex = 0;
    let finished = false;

    const onAllDone = () => {
      if (finished) return;
      finished = true;
      if (ttsRecoveryTimerRef.current != null) {
        window.clearTimeout(ttsRecoveryTimerRef.current);
        ttsRecoveryTimerRef.current = null;
      }
      isTtsSpeakingRef.current = false;
      suppressSttUntilRef.current = Date.now() + 300;
      if (isMobileBrowser) {
        ensureSpeechRecognitionListening(true);
        window.setTimeout(() => ensureSpeechRecognitionListening(true), 900);
      } else {
        ensureSpeechRecognitionListening(false);
      }
    };

    const speakNext = () => {
      if (finished || chunkIndex >= speakChunks.length) {
        onAllDone();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(speakChunks[chunkIndex]);
      utterance.lang = 'th-TH';
      utterance.rate = 1.05;
      utterance.onend = () => { chunkIndex++; speakNext(); };
      utterance.onerror = () => { chunkIndex++; speakNext(); };
      try {
        window.speechSynthesis.speak(utterance);
      } catch {
        onAllDone();
      }
    };

    // Recovery timer in case TTS hangs (longer for chunked speech)
    const recoveryMs = Math.max(8000, speakChunks.length * 6000);
    ttsRecoveryTimerRef.current = window.setTimeout(onAllDone, recoveryMs);

    try {
      window.speechSynthesis.cancel();
      speakNext();
    } catch {
      onAllDone();
    }
  }, [ensureSpeechRecognitionListening, isMobileBrowser]);

  const stopAllVoiceIO = useCallback(() => {
    isTtsSpeakingRef.current = false;
    suppressSttUntilRef.current = 0;
    lastSentTranscriptRef.current = '';
    lastSentAtRef.current = 0;
    inputCooldownUntilRef.current = 0;
    awaitingAgentReplyRef.current = false;
    clearAgentReplyWatchdog();
    if (ttsRecoveryTimerRef.current != null) {
      window.clearTimeout(ttsRecoveryTimerRef.current);
      ttsRecoveryTimerRef.current = null;
    }
    try {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    } catch {
      // ignore speech synthesis errors
    }
    stopSpeechRecognition();
    stopMic();
    setIsVoiceAgentBusy(false);
  }, [clearAgentReplyWatchdog, stopMic, stopSpeechRecognition]);

  const ensureMicPermission = useCallback(async (transport: VoiceTransport): Promise<boolean> => {
    if (transport !== 'live') {
      return true;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      pushLog('system', 'เบราว์เซอร์นี้ไม่รองรับการใช้งานไมโครโฟนผ่านเว็บ');
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      return true;
    } catch (err: any) {
      const reason = String(err?.name || err?.message || err || 'unknown').trim();
      pushLog('system', `เปิดไมโครโฟนไม่สำเร็จ (${reason}) กรุณาอนุญาตสิทธิ์ไมค์แล้วลองใหม่`);
      return false;
    }
  }, [pushLog]);

  useEffect(() => {
    if (!isVoiceActive || voiceMode !== 'agent-tools' || voiceTransport !== 'stt') return;

    const timer = window.setInterval(() => {
      if (!isVoiceActiveRef.current) return;
      if (voiceModeRef.current !== 'agent-tools') return;
      if (voiceTransportRef.current !== 'stt') return;
      releaseTtsGateIfNeeded();
      if (isTtsSpeakingRef.current) return;
      if (Date.now() < suppressSttUntilRef.current) return;
      ensureSpeechRecognitionListening(false);
    }, 1200);

    return () => window.clearInterval(timer);
  }, [ensureSpeechRecognitionListening, isVoiceActive, releaseTtsGateIfNeeded, voiceMode, voiceTransport]);

  useEffect(() => {
    if (!connected) return;

    const offVoiceReady = on('voice:ready', (data?: { mode?: string; transport?: string }) => {
      markVoiceActivity();
      lastVoicePongAtRef.current = Date.now();
      clearStartCallTimeout();
      clearReconnectTimer();
      reconnectAttemptRef.current = 0;
      recoveryInProgressRef.current = false;
      userStoppedRef.current = false;
      setConnectionState('connected');
      const mode = normalizeVoiceMode(data?.mode);
      const transport: VoiceTransport = String(data?.transport || (mode === 'agent-tools' ? 'stt' : 'live')).toLowerCase() === 'live'
        ? 'live'
        : 'stt';
      voiceTransportRef.current = transport;
      setVoiceTransport(transport);
      isVoiceActiveRef.current = true;
      setIsVoiceLoading(false);
      setIsVoiceActive(true);
      pushLog('system', 'เชื่อมต่อสำเร็จ — Jarvis Live Call พร้อมใช้งาน');

      if (mode === 'agent-tools' && transport === 'stt') {
        const started = startSpeechRecognition();
        if (!started) {
          pushLog('system', 'เบราว์เซอร์นี้ไม่รองรับ SpeechRecognition สำหรับโหมด Agent Tools');
          emit('voice:stop', { reason: 'speech-recognition-unsupported' });
          setIsVoiceLoading(false);
          setIsVoiceActive(false);
          isVoiceActiveRef.current = false;
        }
        return;
      }

      startMic();
    });

    const offVoiceRecv = on('voice:audio_recv', (data: { data: string }) => {
      markVoiceActivity();
      if (!audioContextRef.current) return;

      try {
        const binaryString = window.atob(data.data);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i += 1) bytes[i] = binaryString.charCodeAt(i);

        const pcm16 = new Int16Array(bytes.buffer);
        const float32 = new Float32Array(pcm16.length);
        for (let i = 0; i < pcm16.length; i += 1) {
          float32[i] = pcm16[i] / 32768.0;
        }

        const sampleRate = 24000;
        const audioBuffer = audioContextRef.current.createBuffer(1, float32.length, sampleRate);
        audioBuffer.copyToChannel(float32, 0);

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

    const offVoiceText = on('voice:text_recv', (data: { text?: string; source?: string }) => {
      markVoiceActivity();
      const source = String(data?.source || 'voice');
      if (source === 'agent') return;
      const text = String(data?.text || '').trim();
      if (!text) return;
      pushLog('assistant', text);
    });

    const offVoiceAgentReply = on('voice:agent_reply', (data: { reply?: string }) => {
      markVoiceActivity();
      const reply = String(data?.reply || '').trim();
      if (!reply) return;
      awaitingAgentReplyRef.current = false;
      clearAgentReplyWatchdog();
      pushLog('assistant', reply);
      // Only use browser TTS in STT-only mode; in Live mode Gemini speaks via audio stream
      if (voiceTransportRef.current === 'stt') {
        speakAssistantReply(reply);
      }
    });

    const offVoiceFile = on('voice:file', (data: {
      url?: string;
      name?: string;
      kind?: string;
      mimeType?: string;
      sizeBytes?: number;
      caption?: string;
    }) => {
      markVoiceActivity();
      const url = String(data?.url || '').trim();
      if (!url) return;

      const name = String(data?.name || 'file').trim() || 'file';
      const kind: 'image' | 'file' = String(data?.kind || '').toLowerCase() === 'image' ? 'image' : 'file';
      const caption = String(data?.caption || '').trim();
      const captionLine = caption ? `\nคำอธิบาย: ${caption}` : '';
      pushLog(
        'assistant',
        `Jarvis ส่งไฟล์: ${name}${captionLine}`,
        {
          url,
          name,
          kind,
          mimeType: String(data?.mimeType || '').trim() || undefined,
          sizeBytes: typeof data?.sizeBytes === 'number' ? data.sizeBytes : undefined,
          caption: caption || undefined,
        },
      );
    });

    const offVoiceAgentStatus = on('voice:agent_status', (data: { status?: string }) => {
      markVoiceActivity();
      const isBusy = String(data?.status || '').toLowerCase() === 'processing';
      setIsVoiceAgentBusy(isBusy);
      if (isBusy) {
        awaitingAgentReplyRef.current = true;
        return;
      }
      awaitingAgentReplyRef.current = false;
      clearAgentReplyWatchdog();
      if (!isVoiceActiveRef.current) return;
      if (voiceModeRef.current !== 'agent-tools') return;
      if (voiceTransportRef.current !== 'stt') return;
      if (isTtsSpeakingRef.current) return;
      if (isMobileBrowser) {
        ensureSpeechRecognitionListening(true);
      } else {
        ensureSpeechRecognitionListening(false);
      }
    });

    const offVoicePong = on('voice:pong', () => {
      const now = Date.now();
      lastVoicePongAtRef.current = now;
      lastVoiceActivityAtRef.current = now;
    });

    const offVoiceReconnecting = on('voice:reconnecting', (data: { attempt: number; maxAttempts: number }) => {
      markVoiceActivity();
      pushLog('system', `Gemini Live reconnecting (${data.attempt}/${data.maxAttempts})...`);
      setConnectionState('reconnecting');
    });

    const offVoiceError = on('voice:error', (data: { message?: string; quotaExceeded?: boolean }) => {
      markVoiceActivity();
      clearStartCallTimeout();
      clearReconnectTimer();
      reconnectAttemptRef.current = 0;
      recoveryInProgressRef.current = false;
      const msg = String(data?.message || 'Unknown voice error');

      // Quota exceeded: fall back to STT mode automatically
      if (data?.quotaExceeded) {
        pushLog('system', `⚠️ ${msg}`);
        pushLog('system', 'สลับไปใช้โหมด STT (พิมพ์/พูดผ่านเบราว์เซอร์) อัตโนมัติ...');
        isVoiceActiveRef.current = false;
        setIsVoiceActive(false);
        setIsVoiceLoading(false);
        stopAllVoiceIO();

        // Auto-start STT fallback session
        voiceTransportRef.current = 'stt';
        setVoiceTransport('stt');
        setConnectionState('connecting');
        emit('voice:start', { mode: 'agent-tools', transport: 'stt' }, (ack: { ok?: boolean; error?: string }) => {
          if (!ack?.ok) {
            pushLog('system', `STT fallback ไม่สำเร็จ: ${String(ack?.error || 'unknown')}`);
            setConnectionState('idle');
          }
        });
        return;
      }

      pushLog('system', `เกิดข้อผิดพลาด: ${msg}`);
      isVoiceActiveRef.current = false;
      setIsVoiceActive(false);
      setIsVoiceLoading(false);
      setVoiceTransport('stt');
      voiceTransportRef.current = 'stt';
      setConnectionState('idle');
      awaitingAgentReplyRef.current = false;
      clearAgentReplyWatchdog();
      stopAllVoiceIO();
    });

    const offVoiceDisconnected = on('voice:disconnected', () => {
      markVoiceActivity();
      clearStartCallTimeout();
      isVoiceActiveRef.current = false;
      setIsVoiceActive(false);
      setIsVoiceLoading(false);
      setVoiceTransport('stt');
      voiceTransportRef.current = 'stt';
      awaitingAgentReplyRef.current = false;
      clearAgentReplyWatchdog();
      stopAllVoiceIO();

      // If user intentionally stopped, don't auto-reconnect
      if (userStoppedRef.current) {
        userStoppedRef.current = false;
        setConnectionState('idle');
        return;
      }

      // Auto-reconnect with exponential backoff (max 3 attempts)
      const attempt = reconnectAttemptRef.current;
      if (attempt < 3 && !recoveryInProgressRef.current) {
        const delaySec = Math.min(2 * Math.pow(2, attempt), 16); // 2s, 4s, 8s
        reconnectAttemptRef.current = attempt + 1;
        recoveryInProgressRef.current = true;
        setConnectionState('reconnecting');
        pushLog('system', `สายถูกตัดการเชื่อมต่อ — Auto-reconnect ใน ${delaySec}s (ครั้งที่ ${attempt + 1}/3)...`);
        setReconnectCountdown(delaySec);

        // Countdown display
        let remaining = delaySec;
        const countdownId = window.setInterval(() => {
          remaining -= 1;
          setReconnectCountdown(remaining);
          if (remaining <= 0) window.clearInterval(countdownId);
        }, 1000);

        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          recoveryInProgressRef.current = false;
          setReconnectCountdown(0);
          if (!connected || !socket?.connected) {
            pushLog('system', 'รีคอนเนกต์ไม่สำเร็จ (socket ยังไม่พร้อม) กรุณากดโทรอีกครั้ง');
            setConnectionState('idle');
            return;
          }
          startCallRef.current?.();
        }, delaySec * 1000);
      } else {
        pushLog('system', 'สายถูกตัดการเชื่อมต่อ กรุณากดโทรอีกครั้ง');
        reconnectAttemptRef.current = 0;
        recoveryInProgressRef.current = false;
        setConnectionState('idle');
      }
    });

    // Session ended normally (Gemini Live idle timeout) — silently reconnect
    const offVoiceSessionEnded = on('voice:session_ended', () => {
      markVoiceActivity();

      // Don't reconnect if user stopped
      if (userStoppedRef.current || !isVoiceActiveRef.current) return;

      // Silent auto-reconnect — minimal log for the user
      pushLog('system', 'เซสชันเสียงหมดเวลา กำลังเชื่อมต่อใหม่อัตโนมัติ...');
      clearStartCallTimeout();
      isVoiceActiveRef.current = false;
      setIsVoiceActive(false);
      setIsVoiceLoading(false);
      stopAllVoiceIO();

      // Short delay then reconnect automatically
      window.setTimeout(() => {
        if (userStoppedRef.current) return;
        if (!connected || !socket?.connected) {
          pushLog('system', 'Socket ไม่พร้อม กรุณากดโทรอีกครั้ง');
          setConnectionState('idle');
          return;
        }
        startCallRef.current?.();
      }, 500);
    });

    // Meeting Room step-by-step process tracking
    const offMeetingStep = on('voice:meeting_step', (data: { step?: string | null; status?: string; ts?: number }) => {
      if (data?.status === 'clear') {
        setMeetingSteps([]);
        return;
      }
      if (data?.step) {
        setMeetingSteps(prev => {
          const next = [...prev, { step: data.step!, status: data.status || 'working', ts: data.ts || Date.now() }];
          // Keep last 12 steps max to avoid overflow
          return next.length > 12 ? next.slice(-12) : next;
        });
      }
    });

    return () => {
      offVoiceReady();
      offVoiceRecv();
      offVoiceText();
      offVoiceAgentReply();
      offVoiceFile();
      offVoiceAgentStatus();
      offVoicePong();
      offVoiceReconnecting();
      offVoiceError();
      offVoiceDisconnected();
      offVoiceSessionEnded();
      offMeetingStep();
    };
  }, [clearAgentReplyWatchdog, clearReconnectTimer, clearStartCallTimeout, connected, emit, ensureSpeechRecognitionListening, isMobileBrowser, markVoiceActivity, on, pushLog, socket, speakAssistantReply, startMic, stopAllVoiceIO]);

  useEffect(() => {
    return () => {
      clearStartCallTimeout();
      clearReconnectTimer();
      emit('voice:stop', { reason: 'component-unmount' });
      isVoiceActiveRef.current = false;
      stopAllVoiceIO();
    };
  }, [clearReconnectTimer, clearStartCallTimeout, emit, stopAllVoiceIO]);

  const startCall = useCallback(() => {
    if (isVoiceActive || isVoiceLoading) return;

    (async () => {
      if (!socket?.connected) {
        pushLog('system', 'Socket ยังไม่เชื่อมต่อกับเซิร์ฟเวอร์ กรุณารอสักครู่แล้วลองใหม่');
        return;
      }

      const requestedMode: VoiceMode = 'agent-tools';
      // Gemini Live: native audio voice conversation + tool bridge to Agent
      const requestedTransport: VoiceTransport = 'live';
      voiceTransportRef.current = requestedTransport;
      setVoiceTransport(requestedTransport);
      const now = Date.now();
      lastVoiceActivityAtRef.current = now;
      lastVoicePongAtRef.current = now;

      setIsVoiceLoading(true);
      setConnectionState('connecting');
      pushLog('system', 'กำลังเชื่อมต่อ Jarvis Live Call...');

      const micReady = await ensureMicPermission(requestedTransport);
      if (!micReady) {
        setIsVoiceLoading(false);
        return;
      }

      clearStartCallTimeout();
      startCallTimeoutRef.current = window.setTimeout(() => {
        if (!isVoiceActiveRef.current) {
          setIsVoiceLoading(false);
          setIsVoiceAgentBusy(false);
          pushLog('system', 'เชื่อมต่อไม่สำเร็จภายในเวลาที่กำหนด กรุณาลองใหม่อีกครั้ง');
          emit('voice:stop', { reason: 'connect-timeout' });
        }
      }, 20000);

      emit('voice:start', { mode: requestedMode, transport: requestedTransport }, (ack: { ok?: boolean; stage?: string; error?: string }) => {
        if (!ack?.ok) {
          clearStartCallTimeout();
          setIsVoiceLoading(false);
          pushLog('system', `เซิร์ฟเวอร์ไม่รับคำขอเริ่มโทร: ${String(ack?.error || 'unknown')}`);
          return;
        }
        if (ack.stage === 'received') {
          pushLog('system', 'เซิร์ฟเวอร์รับคำขอแล้ว กำลังเปิดช่องเสียง...');
        }
      });
    })().catch((err) => {
      setIsVoiceLoading(false);
      pushLog('system', `เริ่มการโทรไม่สำเร็จ: ${String(err)}`);
    });
  }, [clearStartCallTimeout, emit, ensureMicPermission, isMobileBrowser, isVoiceActive, isVoiceLoading, pushLog, socket]);

  // Keep ref in sync so socket effect can call startCall without circular dep
  useEffect(() => { startCallRef.current = startCall; }, [startCall]);

  const stopCall = useCallback(() => {
    if (!isVoiceActive && !isVoiceLoading && connectionState !== 'reconnecting') return;
    userStoppedRef.current = true;
    recoveryInProgressRef.current = false;
    reconnectAttemptRef.current = 0;
    clearStartCallTimeout();
    clearReconnectTimer();
    emit('voice:stop', { reason: 'manual-stop' });
    isVoiceActiveRef.current = false;
    setIsVoiceActive(false);
    setIsVoiceLoading(false);
    setVoiceTransport('stt');
    voiceTransportRef.current = 'stt';
    setConnectionState('idle');
    stopAllVoiceIO();
    pushLog('system', 'จบการโทร');
  }, [clearReconnectTimer, clearStartCallTimeout, connectionState, emit, isVoiceActive, isVoiceLoading, pushLog, stopAllVoiceIO]);

  useEffect(() => {
    if (!connected || !isVoiceActive) return;

    const pingTimer = window.setInterval(() => {
      if (!isVoiceActiveRef.current) return;
      emit('voice:ping');
    }, 8000);

    const watchdogTimer = window.setInterval(() => {
      if (!isVoiceActiveRef.current) return;
      if (isVoiceLoading) return;
      if (recoveryInProgressRef.current) return;

      const now = Date.now();
      const lastSeen = Math.max(lastVoiceActivityAtRef.current, lastVoicePongAtRef.current);
      if (now - lastSeen < 30000) return;

      recoveryInProgressRef.current = true;
      pushLog('system', 'สัญญาณการโทรค้าง กำลังเชื่อมต่อใหม่อัตโนมัติ...');
      clearStartCallTimeout();
      emit('voice:stop', { reason: 'heartbeat-timeout' });
      isVoiceActiveRef.current = false;
      setIsVoiceActive(false);
      setIsVoiceLoading(false);
      setIsVoiceAgentBusy(false);
      setVoiceTransport('stt');
      voiceTransportRef.current = 'stt';
      awaitingAgentReplyRef.current = false;
      clearAgentReplyWatchdog();
      stopAllVoiceIO();

      window.setTimeout(() => {
        recoveryInProgressRef.current = false;
        if (!connected || !socket?.connected) {
          pushLog('system', 'รีคอนเนกต์อัตโนมัติไม่สำเร็จ (socket ยังไม่พร้อม) กรุณากดโทรอีกครั้ง');
          return;
        }
        startCall();
      }, 900);
    }, 5000);

    return () => {
      window.clearInterval(pingTimer);
      window.clearInterval(watchdogTimer);
    };
  }, [
    clearAgentReplyWatchdog,
    clearStartCallTimeout,
    connected,
    emit,
    isVoiceActive,
    isVoiceLoading,
    pushLog,
    socket,
    startCall,
    stopAllVoiceIO,
  ]);

  const sendChatText = useCallback((rawText: string) => {
    const text = String(rawText || '').trim();
    if (!text) return;
    pushLog('user', text);
    emit('voice:text_input', { text });
  }, [emit, pushLog]);

  const uploadAndSendFile = useCallback(async (file: File) => {
    const selectedName = String(file?.name || '').trim();
    if (!selectedName) return;

    setIsUploadingFile(true);
    pushLog('system', `กำลังแนบไฟล์: ${selectedName}`);
    try {
      const result = await api.uploadFile(file);
      if (!result?.success || !result.file) {
        throw new Error('Invalid upload response');
      }

      const uploaded = result.file;
      pushLog('user', `[แนบไฟล์] ${uploaded.originalName} (${uploaded.sizeKB}KB)`);
      const command = buildAttachmentCommand(uploaded).slice(0, 3900);
      emit('voice:text_input', { text: command });
    } catch (err: any) {
      const message = String(err?.message || err || 'unknown error').trim();
      pushLog('system', `แนบไฟล์ไม่สำเร็จ: ${message}`);
    } finally {
      setIsUploadingFile(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [emit, pushLog]);

  const handleAttachClick = useCallback(() => {
    if (isUploadingFile) return;
    fileInputRef.current?.click();
  }, [isUploadingFile]);

  const handleFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    void uploadAndSendFile(file);
  }, [uploadAndSendFile]);

  const handleSendChat = useCallback((event: React.FormEvent) => {
    event.preventDefault();
    const text = chatInput.trim();
    if (!text) return;
    setChatInput('');
    sendChatText(text);
  }, [chatInput, sendChatText]);

  useEffect(() => {
    if (!connected || autoStartDoneRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const autoStart = params.get('autostart');
    const modeParam = normalizeVoiceMode(params.get('mode'));

    if (modeParam !== voiceModeRef.current) {
      setVoiceMode(modeParam);
    }

    if (autoStart === '1' || autoStart === 'true') {
      autoStartDoneRef.current = true;
      startCall();
    }
  }, [connected, startCall]);

  const shareLink = useMemo(() => {
    const origin = window.location.origin.replace(/\/$/, '');
    const mode = voiceMode === 'agent-tools' ? 'agent-tools' : 'live-direct';
    return `${origin}/call?autostart=1&mode=${mode}`;
  }, [voiceMode]);

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1800);
    } catch {
      setLinkCopied(false);
    }
  }, [shareLink]);

  return (
    <div className="h-screen w-full bg-[radial-gradient(circle_at_top,_#153047_0%,_#0c121f_45%,_#070b14_100%)] text-gray-100">
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col p-3 sm:p-4">
        <div className="rounded-2xl border border-cyan-500/25 bg-slate-950/80 backdrop-blur p-3 sm:p-4 shadow-[0_20px_70px_-30px_rgba(0,190,255,0.45)]">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <PhoneCall className="w-5 h-5 text-cyan-300" />
              <div>
                <h2 className="text-sm sm:text-base font-semibold text-white">Jarvis Live Call</h2>
                <p className="text-[11px] sm:text-xs text-gray-400">App-to-App Call ผ่านเว็บ</p>
              </div>
            </div>
            <button
              onClick={copyLink}
              className="px-2.5 py-1.5 text-[11px] sm:text-xs rounded-lg border border-cyan-400/35 text-cyan-200 hover:bg-cyan-500/15 transition-colors"
              title={shareLink}
            >
              {linkCopied ? 'Copied' : 'Copy Link'}
            </button>
          </div>

          <div className="mt-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[11px] sm:text-xs">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 border ${
                connectionState === 'reconnecting' ? 'border-amber-400/30 text-amber-300 bg-amber-500/10'
                : connected ? 'border-emerald-400/30 text-emerald-300 bg-emerald-500/10' : 'border-red-400/30 text-red-300 bg-red-500/10'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  connectionState === 'reconnecting' ? 'bg-amber-300 animate-pulse'
                  : connected ? 'bg-emerald-300' : 'bg-red-300'
                }`} />
                {connectionState === 'reconnecting' ? 'Reconnecting' : connected ? 'Connected' : 'Offline'}
              </span>
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 border ${
                isVoiceAgentBusy ? 'border-amber-300/30 text-amber-200 bg-amber-400/10' : 'border-gray-600 text-gray-300 bg-gray-800/50'
              }`}>
                {isVoiceAgentBusy ? 'Jarvis Thinking' : 'Jarvis Ready'}
              </span>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 border border-violet-400/30 text-violet-300 bg-violet-500/10 text-[11px] sm:text-xs font-medium">
              <Wand2 className="w-3 h-3" />
              Jarvis Agent
            </span>
          </div>

          <div className="mt-4 flex justify-center">
            {!isVoiceActive && connectionState !== 'reconnecting' ? (
              <button
                onClick={startCall}
                disabled={!connected || isVoiceLoading}
                className="group relative h-20 w-20 rounded-full border border-emerald-300/40 bg-emerald-500/20 text-emerald-200 shadow-[0_0_45px_-15px_rgba(74,222,128,0.8)] hover:bg-emerald-500/30 disabled:opacity-50 transition-all"
              >
                <span className="absolute -inset-1 rounded-full border border-emerald-200/20 group-hover:scale-105 transition-transform" />
                <span className="relative flex h-full w-full items-center justify-center">
                  {isVoiceLoading ? <Loader2 className="w-7 h-7 animate-spin" /> : <Mic className="w-7 h-7" />}
                </span>
              </button>
            ) : (
              <button
                onClick={stopCall}
                className="group relative h-20 w-20 rounded-full border border-red-300/45 bg-red-500/20 text-red-200 shadow-[0_0_45px_-15px_rgba(248,113,113,0.75)] hover:bg-red-500/30 transition-all"
              >
                <span className="absolute -inset-1 rounded-full border border-red-200/20 group-hover:scale-105 transition-transform" />
                <span className="relative flex h-full w-full items-center justify-center">
                  <PhoneOff className="w-7 h-7" />
                </span>
              </button>
            )}
          </div>

          <p className="mt-2 text-center text-[11px] sm:text-xs text-gray-400">
            {connectionState === 'reconnecting'
              ? `กำลังเชื่อมต่อใหม่${reconnectCountdown > 0 ? ` ใน ${reconnectCountdown}s...` : '...'}`
              : isVoiceLoading ? 'กำลังเชื่อมต่อ...' : isVoiceActive ? 'กำลังคุยกับ Jarvis' : 'แตะปุ่มโทรเพื่อเริ่มคุย'}
          </p>
        </div>

        {/* Meeting Room Process Steps */}
        {meetingSteps.length > 0 && (
          <div className="mt-2 rounded-xl border border-indigo-500/20 bg-indigo-950/30 px-3 py-2">
            <div className="text-[10px] text-indigo-400/70 font-medium mb-1">Meeting Room Process</div>
            <div className="space-y-0.5">
              {meetingSteps.slice(-2).map((s, i, arr) => (
                <div key={s.ts} className={`text-[11px] leading-relaxed flex items-center gap-1.5 ${
                  s.status === 'done' ? 'text-emerald-400/80' :
                  s.status === 'error' ? 'text-red-400/80' :
                  s.status === 'info' ? 'text-amber-400/80' :
                  'text-gray-400'
                }`}>
                  <span className={`w-1 h-1 rounded-full shrink-0 ${
                    s.status === 'done' ? 'bg-emerald-400' :
                    s.status === 'error' ? 'bg-red-400' :
                    s.status === 'info' ? 'bg-amber-400' :
                    i === arr.length - 1 ? 'bg-indigo-400 animate-pulse' : 'bg-gray-500'
                  }`} />
                  {s.step}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-3 flex-1 min-h-0 rounded-2xl border border-gray-800/90 bg-[#101928]/85 backdrop-blur overflow-hidden">
          <div className="h-full flex flex-col">
            <div className="px-3 py-2.5 border-b border-gray-800 text-xs sm:text-sm text-gray-300 flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-cyan-300" />
              ประวัติการคุย
              {isVoiceAgentBusy && <Loader2 className="w-3 h-3 animate-spin text-amber-300" />}
            </div>
            <div ref={logListRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
              {logs.length === 0 && (
                <div className="h-full min-h-[170px] flex items-center justify-center text-gray-500 text-sm">
                  เริ่มโทรหรือพิมพ์ข้อความถึง Jarvis ได้เลย
                </div>
              )}
              {logs.map((entry) => (
                <div key={entry.id} className={`flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[90%] rounded-2xl border px-3 py-2 text-sm whitespace-pre-wrap ${
                      entry.role === 'user'
                        ? 'bg-blue-500/20 border-blue-400/40 text-blue-100 rounded-br-md'
                        : entry.role === 'assistant'
                          ? 'bg-emerald-500/20 border-emerald-400/40 text-emerald-100 rounded-bl-md'
                          : 'bg-gray-800/70 border-gray-700 text-gray-300'
                    }`}
                  >
                    <div>{entry.text}</div>
                    {entry.attachment && (
                      <div className="mt-2">
                        {entry.attachment.kind === 'image' ? (
                          <a
                            href={entry.attachment.url}
                            target="_blank"
                            rel="noreferrer"
                            className="block"
                          >
                            <img
                              src={entry.attachment.url}
                              alt={entry.attachment.name}
                              className="max-h-56 w-auto rounded-lg border border-white/15 object-contain"
                              loading="lazy"
                            />
                          </a>
                        ) : (
                          <a
                            href={entry.attachment.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center rounded-lg border border-cyan-300/35 bg-cyan-500/15 px-2.5 py-1.5 text-xs text-cyan-100 hover:bg-cyan-500/25"
                          >
                            ดาวน์โหลดไฟล์: {entry.attachment.name}
                          </a>
                        )}
                      </div>
                    )}
                    <div className="mt-1 text-[10px] text-gray-400">{formatClock(entry.timestamp)}</div>
                  </div>
                </div>
              ))}
            </div>

            <form onSubmit={handleSendChat} className="border-t border-gray-800 p-2 sm:p-3">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".jpg,.jpeg,.png,.gif,.webp,.bmp,.mp3,.wav,.m4a,.ogg,.flac,.aac,.pdf,.docx,.txt,.md,.csv,.json,.tsv,.xml"
                onChange={handleFileChange}
              />
              {/* @mention quick buttons */}
              <div className="flex items-center gap-1 mb-1.5 overflow-x-auto pb-0.5 scrollbar-none">
                {[
                  { tag: '@jarvis', icon: '👑', color: 'border-violet-400/40 text-violet-300 bg-violet-500/10' },
                  { tag: '@gemini', icon: '🔷', color: 'border-cyan-400/40 text-cyan-300 bg-cyan-500/10' },
                  { tag: '@claude', icon: '🟡', color: 'border-amber-400/40 text-amber-300 bg-amber-500/10' },
                  { tag: '@codex', icon: '🟢', color: 'border-emerald-400/40 text-emerald-300 bg-emerald-500/10' },
                  { tag: '@opencode', icon: '📜', color: 'border-amber-400/40 text-amber-300 bg-amber-500/10' },
                  { tag: '@kilo', icon: '⚪', color: 'border-slate-400/40 text-slate-300 bg-slate-500/10' },
                  { tag: '@all', icon: '🌐', color: 'border-rose-400/40 text-rose-300 bg-rose-500/10' },
                ].map(({ tag, icon, color }) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => {
                      const current = chatInput;
                      if (current.includes(tag)) return;
                      setChatInput(prev => `${tag} ${prev}`.trim());
                    }}
                    className={`shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-lg border text-[11px] font-medium transition-colors hover:brightness-125 ${
                      chatInput.includes(tag) ? color + ' ring-1 ring-white/20' : color + ' opacity-60 hover:opacity-100'
                    }`}
                  >
                    <span className="text-xs">{icon}</span>
                    {tag}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleAttachClick}
                  disabled={isUploadingFile}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-indigo-300/30 bg-indigo-500/20 text-indigo-200 hover:bg-indigo-500/30 disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
                  title={isUploadingFile ? 'กำลังอัปโหลดไฟล์...' : 'แนบไฟล์หรือรูป'}
                >
                  {isUploadingFile ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
                </button>
                <input
                  type="text"
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  placeholder="พิมพ์ข้อความ หรือ @gemini @claude สั่งงาน CLI..."
                  className="flex-1 rounded-xl border border-gray-700 bg-[#0c1422] px-3 py-2.5 text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-cyan-400/60 focus:border-cyan-400/50"
                />
                <button
                  type="submit"
                  disabled={!chatInput.trim()}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-300/30 bg-cyan-500/20 text-cyan-200 hover:bg-cyan-500/30 disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </form>
          </div>
        </div>

        <div className="mt-2 text-[10px] text-gray-500 px-1">
          <Wand2 className="inline-block w-3 h-3 mr-1 -mt-0.5 text-cyan-400/70" />
          ลิงก์โทร: {shareLink}
        </div>
      </div>
    </div>
  );
}

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { FunctionDeclaration } from '@google/genai';
import { createLogger } from '../utils/logger';

const logger = createLogger('LiveVoice');

const HOST = 'generativelanguage.googleapis.com';
const DEFAULT_LIVE_API_VERSION = process.env.GEMINI_LIVE_API_VERSION || 'v1beta';
const DEFAULT_LIVE_MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
const DEFAULT_MODEL_CANDIDATES = [
  DEFAULT_LIVE_MODEL,
  'models/gemini-2.5-flash-native-audio-preview-09-2025',
  'models/gemini-2.5-flash-live-preview',
  'models/gemini-2.0-flash-live-001',
];

interface GeminiModelInfo {
  name?: string;
  supportedGenerationMethods?: string[];
}

interface GeminiListModelsResponse {
  models?: GeminiModelInfo[];
}

function normalizeModelName(name: string): string {
  const raw = String(name || '').trim();
  if (!raw) return '';
  return raw.startsWith('models/') ? raw : `models/${raw}`;
}

function parseCandidateModels(): string[] {
  const configuredCandidates = String(process.env.GEMINI_LIVE_MODEL_CANDIDATES || '')
    .split(',')
    .map((item) => normalizeModelName(item))
    .filter(Boolean);
  const merged = configuredCandidates.length > 0 ? configuredCandidates : DEFAULT_MODEL_CANDIDATES;
  return Array.from(new Set(merged.map((item) => normalizeModelName(item))));
}

function extractBidiModelsFromResponse(payload: GeminiListModelsResponse): string[] {
  const models = Array.isArray(payload.models) ? payload.models : [];
  return models
    .filter((model) => Array.isArray(model.supportedGenerationMethods))
    .filter((model) => model.supportedGenerationMethods!.includes('bidiGenerateContent'))
    .map((model) => normalizeModelName(String(model.name || '')))
    .filter(Boolean);
}

function rankLiveModel(name: string): number {
  const lower = name.toLowerCase();
  let score = 0;
  if (lower.includes('native-audio')) score += 60;
  if (lower.includes('live')) score += 25;
  if (lower.includes('2.5')) score += 12;
  if (lower.includes('flash')) score += 8;
  if (lower.includes('preview-12-2025')) score += 6;
  if (lower.includes('preview')) score += 3;
  if (lower.includes('deprecated')) score -= 200;
  return score;
}

export function chooseLiveModelFromAvailable(
  availableModels: string[],
  candidateModels: string[],
): string | null {
  const normalizedAvailable = Array.from(new Set(
    (availableModels || []).map((model) => normalizeModelName(model)).filter(Boolean),
  ));
  if (normalizedAvailable.length === 0) return null;

  for (const candidate of candidateModels) {
    const normalizedCandidate = normalizeModelName(candidate);
    if (normalizedAvailable.includes(normalizedCandidate)) {
      return normalizedCandidate;
    }
  }

  const ranked = [...normalizedAvailable].sort((a, b) => rankLiveModel(b) - rankLiveModel(a));
  return ranked[0] || null;
}

export async function resolveGeminiLiveModel(apiKey: string): Promise<string> {
  const forcedModel = normalizeModelName(String(process.env.GEMINI_LIVE_MODEL || ''));
  const candidates = parseCandidateModels();
  const candidatePool = forcedModel ? [forcedModel, ...candidates] : candidates;

  try {
    const listUrl = `https://${HOST}/v1beta/models?key=${apiKey}&pageSize=1000`;
    const response = await fetch(listUrl);
    if (!response.ok) {
      throw new Error(`ListModels failed with HTTP ${response.status}`);
    }
    const payload = await response.json() as GeminiListModelsResponse;
    const availableBidiModels = extractBidiModelsFromResponse(payload);
    const selected = chooseLiveModelFromAvailable(availableBidiModels, candidatePool);
    if (selected) return selected;
  } catch (err) {
    console.warn(`[LiveVoice] Failed to resolve live model dynamically: ${String(err)}`);
  }

  return candidatePool[0] || DEFAULT_LIVE_MODEL;
}

export class LiveVideoClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private model: string;
  private apiVersion: string;
  private systemInstruction?: string;
  private toolDeclarations: FunctionDeclaration[];
  public isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 3;
  private reconnectDelayMs: number = 2000;
  private intentionalDisconnect: boolean = false;

  constructor(
    apiKey: string,
    model: string,
    apiVersion: string = DEFAULT_LIVE_API_VERSION,
    systemInstruction?: string,
    toolDeclarations: FunctionDeclaration[] = [],
  ) {
    super();
    this.apiKey = apiKey;
    this.model = normalizeModelName(model) || DEFAULT_LIVE_MODEL;
    this.apiVersion = String(apiVersion || DEFAULT_LIVE_API_VERSION).trim() || DEFAULT_LIVE_API_VERSION;
    this.systemInstruction = String(systemInstruction || '').trim() || undefined;
    this.toolDeclarations = Array.isArray(toolDeclarations) ? toolDeclarations : [];
  }

  connect() {
    if (this.ws) {
      console.warn('[LiveVoice] Already connected.');
      return;
    }

    const url = `wss://${HOST}/ws/google.ai.generativelanguage.${this.apiVersion}.GenerativeService.BidiGenerateContent?key=${this.apiKey}`;
    logger.info(`Connecting to Gemini Live API with model ${this.model} (${this.apiVersion})...`);
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      logger.info('WebSocket connection established.');
      this.isConnected = true;
      // NOTE: reconnectAttempts is reset in handleMessage on setupComplete,
      // NOT here — because quota errors arrive after open but before setup completes.
      this.intentionalDisconnect = false;
      this.emit('connected');
      this.sendSetupMessage();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch (err) {
        console.error('[LiveVoice] Failed to parse message from Gemini:', err);
      }
    });

    this.ws.on('close', (code, reason) => {
      const reasonText = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason || '');
      console.log(`[LiveVoice] Connection closed: ${code} - ${reasonText}`);
      this.isConnected = false;
      this.ws = null;

      // Detect quota/billing errors — these will never succeed on retry
      const isQuotaError = /quota|billing|resource.?exhausted/i.test(reasonText);
      if (isQuotaError) {
        console.warn(`[LiveVoice] Quota/billing error detected — will NOT retry. Reason: ${reasonText}`);
        this.emit('quotaError', reasonText);
        this.emit('disconnected');
        return;
      }

      // Normal close (code 1000) — session ended naturally (idle timeout, etc.)
      if (code === 1000) {
        console.log('[LiveVoice] Session ended normally (code 1000).');
        this.emit('sessionEnded');
        this.emit('disconnected');
        return;
      }

      // Auto-reconnect on server-side deadline errors (1011) and abnormal closures (1006)
      const isRecoverableClose = (code === 1011 || code === 1006) && !this.intentionalDisconnect;
      if (isRecoverableClose && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = this.reconnectDelayMs * this.reconnectAttempts;
        console.log(`[LiveVoice] Auto-reconnecting (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms...`);
        this.emit('reconnecting', { attempt: this.reconnectAttempts, maxAttempts: this.maxReconnectAttempts });
        setTimeout(() => {
          if (!this.intentionalDisconnect) {
            this.connect();
          }
        }, delay);
        return; // Don't emit disconnected yet — reconnecting
      }

      if (!isRecoverableClose) {
        this.emit('error', new Error(`Live connection closed (${code}): ${reasonText || 'no reason'}`));
      }
      this.emit('disconnected');
    });

    this.ws.on('error', (err) => {
      console.error('[LiveVoice] WebSocket error:', err);
      this.emit('error', err);
    });
  }

  disconnect() {
    this.intentionalDisconnect = true;
    this.reconnectAttempts = this.maxReconnectAttempts; // prevent auto-reconnect
    if (this.ws) {
      this.ws.close();
    }
  }

  private sendSetupMessage() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const toolsConfig = this.toolDeclarations.length > 0
      ? [{ functionDeclarations: this.toolDeclarations }]
      : undefined;

    const setup = {
      setup: {
        model: this.model,
        ...(this.systemInstruction
          ? {
              systemInstruction: {
                role: 'system',
                parts: [{ text: this.systemInstruction }],
              },
            }
          : {}),
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Aoede',
              },
            },
          },
        },
        tools: toolsConfig,
      },
    };

    this.ws.send(JSON.stringify(setup));
  }

  sendAudioChunk(base64Audio: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[LiveVoice] Cannot send audio, websocket not open.');
      return;
    }

    const msg = {
      realtimeInput: {
        audio: {
          mimeType: 'audio/pcm;rate=16000',
          data: base64Audio,
        },
      },
    };

    this.ws.send(JSON.stringify(msg));
  }

  signalAudioStreamEnd() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      realtimeInput: {
        audioStreamEnd: true,
      },
    }));
  }

  sendToolResponses(functionResponses: Array<{
    id?: string;
    name: string;
    response: Record<string, unknown>;
  }>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!Array.isArray(functionResponses) || functionResponses.length === 0) return;

    // Use ASCII-safe JSON encoding to prevent potential multi-byte UTF-8
    // corruption at the Gemini Live API's WebSocket receiver.
    // Non-ASCII characters (e.g. Thai ราคาทอง) are encoded as \uXXXX escapes.
    const payload = {
      toolResponse: {
        functionResponses,
      },
    };
    const jsonStr = JSON.stringify(payload).replace(
      /[\u0080-\uffff]/g,
      (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
    );
    console.log('[LiveVoice] Sending tool response', {
      responseCount: functionResponses.length,
      payloadLength: jsonStr.length,
      firstResponsePreview: JSON.stringify(functionResponses[0]?.response)?.slice(0, 200),
    });
    this.ws.send(jsonStr);
  }

  private handleMessage(message: any) {
    if (message.setupComplete) {
      console.log('[LiveVoice] Setup completed.');
      this.reconnectAttempts = 0; // Only reset after full setup success
      this.emit('setupComplete');
      return;
    }

    if (message.toolCall?.functionCalls) {
      const functionCalls = Array.isArray(message.toolCall.functionCalls)
        ? message.toolCall.functionCalls
        : [];
      if (functionCalls.length > 0) {
        this.emit('toolCall', functionCalls);
      }
    }

    if (message.serverContent?.modelTurn?.parts) {
      const parts = message.serverContent.modelTurn.parts;
      for (const part of parts) {
        if (part.inlineData && part.inlineData.mimeType.startsWith('audio/pcm')) {
          this.emit('audioPart', part.inlineData.data);
        }
      }
    }

    if (message.serverContent?.modelTurn?.parts) {
      const parts = message.serverContent.modelTurn.parts;
      for (const part of parts) {
        if (part.text) {
          this.emit('textPart', part.text);
        }
      }
    }

    if (message.serverContent?.turnComplete) {
      this.emit('turnComplete');
    }
  }
}

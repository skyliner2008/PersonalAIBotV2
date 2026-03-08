import { Content, Part, GoogleGenAI } from '@google/genai';
import { tools, getFunctionHandlers, setCurrentChatId } from './tools/index.js';
import type { BotContext, SystemToolContext } from './tools/index.js';
import { getBot } from './registries/botRegistry.js';
import type {
  AgentStats as IAgentStats,
  ToolTelemetry,
  ToolHandlerMap,
  CircuitState,
  ToolCall,
  ToolExecutionResult,
} from './types.js';
import {
  addMessage as umAddMessage, addEpisode, buildContext,
  setCoreMemory, shouldExtractCore, shouldExtractArchival,
  saveArchivalFact, setEmbeddingProvider,
} from '../memory/unifiedMemory.js';
import { setSummarizeProvider } from '../memory/conversationSummarizer.js';
import { classifyTask, TaskType, type TaskClassification } from './config/aiConfig.js';
import { configManager } from './config/configManager.js';
import { personaManager } from '../ai/personaManager.js';
import { GeminiProvider } from './providers/geminiProvider.js';
import { OpenAICompatibleProvider } from './providers/openaiCompatibleProvider.js';
import type { AIProvider } from './providers/baseProvider.js';
import { shouldReflect, triggerReflection } from '../evolution/selfReflection.js';
import { runHealthCheck } from '../evolution/selfHealing.js';
import { buildLearningsContext } from '../evolution/learningJournal.js';

// ============================================================
// Timing & Limits — ปรับให้รองรับงาน multi-step ที่ซับซ้อน
// ============================================================
const AGENT_TIMEOUT_MS = 120_000;  // 120 วินาที
const TOOL_TIMEOUT_MS = 45_000;   // 45 วินาทีต่อ tool
const MAX_TURNS = 20;       // รองรับงานหลายขั้นตอน
const MAX_TOOL_OUTPUT = 12_000;   // context window สำหรับ tool output
const PARALLEL_TOOL_MAX = 5;        // จำนวน tools ที่รันพร้อมกันได้
// Task types ที่ต้องวางแผนก่อน (ReAct planning)
const PLANNING_TASK_TYPES = new Set([TaskType.COMPLEX, TaskType.CODE, TaskType.DATA, TaskType.THINKING]);

// ============================================================
// Circuit Breaker — ป้องกัน tool ที่ fail ซ้ำๆ (Exponential Backoff)
// ============================================================
const toolCircuits: Map<string, CircuitState> = new Map();
const CIRCUIT_THRESHOLD = 3;          // เปิด circuit หลัง fail 3 ครั้ง
const CIRCUIT_BASE_MS = 10_000;     // base reset = 10 วินาที
const CIRCUIT_MAX_MS = 120_000;    // max reset = 120 วินาที

function isCircuitOpen(toolName: string): boolean {
  const c = toolCircuits.get(toolName);
  if (!c) return false;
  if (c.openUntil > Date.now()) return true;
  // Auto-reset: ลด failures ลงครึ่งหนึ่ง (half-open state)
  c.failures = Math.floor(c.failures / 2);
  c.openUntil = 0;
  if (c.failures === 0) toolCircuits.delete(toolName);
  else toolCircuits.set(toolName, c);
  return false;
}

function recordToolResult(toolName: string, success: boolean): void {
  if (success) {
    const c = toolCircuits.get(toolName);
    if (c) {
      // Gradual recovery: ลด failures ทีละ 1 เมื่อสำเร็จ
      c.failures = Math.max(0, c.failures - 1);
      if (c.failures === 0) toolCircuits.delete(toolName);
      else toolCircuits.set(toolName, c);
    }
    return;
  }
  const c = toolCircuits.get(toolName) ?? { failures: 0, openUntil: 0 };
  c.failures++;
  if (c.failures >= CIRCUIT_THRESHOLD) {
    // Exponential backoff: 10s → 20s → 40s → 80s → 120s (cap)
    const backoffMs = Math.min(CIRCUIT_BASE_MS * Math.pow(2, c.failures - CIRCUIT_THRESHOLD), CIRCUIT_MAX_MS);
    c.openUntil = Date.now() + backoffMs;
    console.warn(`[CircuitBreaker] ${toolName} OPEN for ${backoffMs / 1000}s after ${c.failures} failures`);
  }
  toolCircuits.set(toolName, c);
}

// ============================================================
// Per-user processing queue (ป้องกัน race condition)
// ============================================================
const processingQueues: Map<string, Promise<string>> = new Map();

function enqueueForUser(chatId: string, task: () => Promise<string>): Promise<string> {
  const prev = processingQueues.get(chatId) ?? Promise.resolve('');
  const next = prev.catch(() => { }).then(task);
  processingQueues.set(chatId, next);
  next.finally(() => {
    if (processingQueues.get(chatId) === next) processingQueues.delete(chatId);
  });
  return next;
}

// ============================================================
// Agent Execution Stats — เก็บ telemetry ทุก request
// ============================================================
function newStats(): IAgentStats {
  return { turns: 0, toolCalls: [] as ToolTelemetry[], totalTokens: 0, startTime: Date.now() };
}

// ============================================================
// Global Agent Run History — Circular buffer (last 100 runs)
// ============================================================
export interface AgentRun {
  id: string;
  chatId: string;
  message: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  turns: number;
  toolCalls: ToolTelemetry[];
  totalTokens: number;
  reply?: string;
  error?: string;
  taskType?: string;
}

const _runHistory: AgentRun[] = [];
const MAX_RUN_HISTORY = 100;
let _runCounter = 0;

function startRun(chatId: string, message: string, taskType: string): AgentRun {
  const run: AgentRun = {
    id: `run_${++_runCounter}_${Date.now()}`,
    chatId,
    message: message.substring(0, 200),
    startTime: Date.now(),
    turns: 0,
    toolCalls: [],
    totalTokens: 0,
    taskType,
  };
  _runHistory.push(run);
  if (_runHistory.length > MAX_RUN_HISTORY) _runHistory.shift();
  return run;
}

function finishRun(run: AgentRun, stats: IAgentStats, reply?: string, error?: string) {
  run.endTime = Date.now();
  run.durationMs = run.endTime - run.startTime;
  run.turns = stats.turns;
  run.toolCalls = stats.toolCalls;
  run.totalTokens = stats.totalTokens;
  run.reply = reply?.substring(0, 300);
  run.error = error;
}

export function getAgentRunHistory(): AgentRun[] {
  return [..._runHistory].reverse();
}

export function getAgentActiveRuns(): AgentRun[] {
  return _runHistory.filter(r => !r.endTime);
}

export function getAgentStats(): { totalRuns: number; activeRuns: number; avgDurationMs: number; avgTokens: number; totalToolCalls: number } {
  const finished = _runHistory.filter(r => r.endTime);
  const avgDuration = finished.length > 0
    ? Math.round(finished.reduce((s, r) => s + (r.durationMs || 0), 0) / finished.length)
    : 0;
  const avgTokens = finished.length > 0
    ? Math.round(finished.reduce((s, r) => s + r.totalTokens, 0) / finished.length)
    : 0;
  return {
    totalRuns: _runHistory.length,
    activeRuns: _runHistory.filter(r => !r.endTime).length,
    avgDurationMs: avgDuration,
    avgTokens,
    totalToolCalls: _runHistory.reduce((s, r) => s + r.toolCalls.length, 0),
  };
}

// ============================================================
// Main Agent — Enhanced Agentic AI
// ============================================================
export class Agent {
  private providers: Record<string, AIProvider>;

  constructor(apiKey: string) {
    this.providers = {
      gemini: new GeminiProvider(apiKey),
      openai: new OpenAICompatibleProvider(process.env.OPENAI_API_KEY || ''),
      minimax: new OpenAICompatibleProvider(
        process.env.MINIMAX_API_KEY || '',
        'https://api.minimax.io/v1'
      )
    };
    const ai = new GoogleGenAI({ apiKey });
    setEmbeddingProvider(async (text: string) => {
      const result = await ai.models.embedContent({
        model: 'gemini-embedding-001',
        contents: [{ role: 'user', parts: [{ text }] }]
      });
      return result.embeddings?.[0]?.values || [];
    });
    // Set up conversation summarizer provider
    setSummarizeProvider(async (prompt: string) => {
      const res = await this.providers.gemini.generateResponse('gemini-2.0-flash-lite',
        'สรุปบทสนทนาให้กระชับ ไม่เกิน 3 บรรทัด ภาษาไทย ไม่ต้องมี tag',
        [{ role: 'user', parts: [{ text: prompt }] }]);
      return res.text?.trim() || '';
    });
  }

  // ── Public entry: queue per-user ────────────────────────────
  public processMessage(
    chatId: string, message: string, ctx: BotContext, attachments?: Part[]
  ): Promise<string> {
    return enqueueForUser(chatId, () => this._processMessageCore(chatId, message, ctx, attachments));
  }

  // ── Core agentic processing ─────────────────────────────────
  private async _processMessageCore(
    chatId: string, message: string, ctx: BotContext, attachments?: Part[]
  ): Promise<string> {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), AGENT_TIMEOUT_MS);
    const stats = newStats();
    // ──── 1. Task Classification (done first so we can log it) ─
    const classification = classifyTask(message, !!attachments);
    const taskType = classification.confidence === 'low' ? TaskType.GENERAL : classification.type;
    const agentRun = startRun(chatId, message, taskType);

    try {
      // ──── Provider Routing (with per-bot override + failover) ─
      const config = this.resolveModelConfig(ctx?.botId, taskType);
      const { provider, providerName, modelName } = this.resolveProvider(config);
      if (!provider) return `❌ ไม่มี AI provider ที่ใช้งานได้ กรุณาเช็ค .env`;
      console.log(`[Router] ${taskType} (confidence: ${classification.confidence}, score: ${classification.topScore}) → ${modelName} (${providerName})`);

      // ──── 2. Build Unified Memory Context (4 layers) ────────
      const memoryCtx = await buildContext(chatId, message, {
        maxArchival: 5,
        archivalThreshold: 0.55,
      });

      // 3. Save user message
      umAddMessage(chatId, 'user', message);
      addEpisode(chatId, 'user', message);

      // ──── 4. Build Conversation History ─────────────────────
      const history: Content[] = memoryCtx.workingMessages.map(m => ({
        role: m.role === 'user' ? 'user' as const : 'model' as const,
        parts: [{ text: m.content }]
      }));

      const userParts: Part[] = [{ text: message }];
      if (attachments) userParts.push(...attachments);

      // ──── 4.5 Pre-search for web tasks ──────────────────────
      if (taskType === TaskType.WEB_BROWSER) {
        try {
          const { webSearch } = await import('./tools/limitless.js');
          console.log(`[Agent] Pre-searching: "${message}"`);
          const searchResults = await webSearch({ query: message });
          if (searchResults && !searchResults.includes('ไม่พบผลลัพธ์')) {
            userParts.push({ text: `\n\n[ผลการค้นหาล่าสุดจากอินเทอร์เน็ต — ใช้ข้อมูลนี้ตอบผู้ใช้โดยตรง]:\n${searchResults}` });
          }
        } catch (err) {
          console.error('[Agent] Pre-search failed:', err);
        }
      }

      let currentContents: Content[] = [...history, { role: 'user', parts: userParts }];

      // ──── 4.7 ReAct Planning Step (สำหรับงานซับซ้อน) ────────
      // สร้าง execution plan ก่อน เพื่อเพิ่มประสิทธิภาพการใช้ tools
      let planContext = '';
      if (PLANNING_TASK_TYPES.has(taskType) && message.length > 30 && !attachments) {
        try {
          const planRes = await this.providers.gemini.generateResponse(
            'gemini-2.0-flash-lite',
            `วิเคราะห์งานที่ผู้ใช้ต้องการและสร้าง execution plan สั้นๆ (3-5 ขั้นตอน)
รูปแบบ:
GOAL: [เป้าหมายหลัก]
STEPS:
1. [ขั้นตอนที่ 1]
2. [ขั้นตอนที่ 2]
...
TOOLS_NEEDED: [tools ที่จะใช้]
ตอบเป็นภาษาไทย กระชับ ไม่เกิน 100 คำ`,
            [{ role: 'user', parts: [{ text: message }] }]
          );
          if (planRes.text && planRes.text.includes('GOAL:')) {
            planContext = `\n\n[Execution Plan สำหรับงานนี้]:\n${planRes.text}`;
            console.log(`[Agent] ReAct Plan: ${planRes.text.substring(0, 150)}...`);
          }
        } catch { /* planning เป็น optional */ }
      }

      // ──── 5. Load Persona & Build System Instruction ────────
      const personaConfig = personaManager.loadPersona(ctx?.platform ?? 'telegram');
      const archivalCtx = memoryCtx.archivalFacts.length > 0
        ? `\n[Archival Memory — สิ่งที่รู้เกี่ยวกับผู้ใช้]: ${memoryCtx.archivalFacts.join(' | ')}` : '';
      const summaryCtx = memoryCtx.conversationSummary
        ? `\n[Conversation Summary]: ${memoryCtx.conversationSummary}` : '';

      // Bot Identity Block — ให้ Agent รู้จักตัวเอง
      // 1. Get Tools from Persona file (TOOLS.md)
      let enabledToolNames = personaConfig.enabledTools || [];

      // 2. Merge with Tools from Database (Dashboard Agent Manager)
      if (ctx?.botId) {
        const botInstance = getBot(ctx.botId);
        if (botInstance && botInstance.enabled_tools) {
          enabledToolNames = Array.from(new Set([...enabledToolNames, ...botInstance.enabled_tools]));
        }
      }
      const botIdentityBlock = `
## ข้อมูลของฉัน (Bot Identity)
- ชื่อ: ${ctx?.botName ?? 'AI Assistant'}
- Platform: ${ctx?.platform ?? 'unknown'}
- Model ปัจจุบัน: ${modelName} (${providerName})
- Task Type ที่จำแนกได้: ${taskType}
- Tools ที่เปิดใช้: ${enabledToolNames.length} tools
ฉันสามารถตรวจสอบ config ของตัวเอง ดูรายการ model ทั้งหมด เปลี่ยน model และตรวจสอบสถานะระบบได้ผ่าน tools: get_my_config, list_available_models, set_my_model, get_system_status
ฉันยังมีความสามารถในการ evolve ตัวเอง: self_read_source, self_edit_persona, self_add_learning, self_view_evolution, self_reflect, self_heal`;

      // Self-Evolution context: inject learnings
      const learningsCtx = buildLearningsContext();

      const systemInstruction = `${personaConfig.systemInstruction}
${botIdentityBlock}

[Core Profile]
${memoryCtx.coreMemoryText}
${archivalCtx}
${summaryCtx}
${learningsCtx}

## Agentic Capabilities
คุณเป็น Autonomous AI Agent ที่ทำงานหลายขั้นตอนได้ด้วยตัวเอง

### วิธีคิดเชิงกลยุทธ์ (Strategic Thinking)
1. **วิเคราะห์**: ทำความเข้าใจสิ่งที่ผู้ใช้ต้องการจริงๆ
2. **วางแผน**: ถ้างานซับซ้อน ให้คิดแผนก่อนลงมือทำ
3. **เลือกเครื่องมือ**: ใช้ tool ที่เหมาะสมที่สุด — เรียกหลาย tools พร้อมกันได้
4. **ตรวจสอบผลลัพธ์**: ถ้าข้อมูลไม่เพียงพอ ให้ค้นหาเพิ่มเติม
5. **สังเคราะห์คำตอบ**: รวบรวมข้อมูลทั้งหมดตอบอย่างสมบูรณ์

### กฎการทำงาน
- ถ้าต้องใช้ข้อมูลหลายแหล่ง → เรียก tool หลายครั้งแล้วสรุปรวม
- ถ้า tool ล้มเหลว → ลองวิธีอื่น ห้ามยอมแพ้ง่ายๆ
- ถ้าไม่มั่นใจ → ค้นหาเพิ่มเติมก่อนตอบ
- ตอบภาษาเดียวกับผู้ใช้ (ไทย→ไทย, อังกฤษ→อังกฤษ)
- กระชับ ตรงประเด็น ห้ามแต่งข้อมูลขึ้นเอง${planContext}`;

      // Set chatId for memory tools & filter tools
      const activeTools = tools.filter(t => t.name && enabledToolNames.includes(t.name));
      console.log(`[Agent] Active Tools Check: Enabled count=${activeTools.length}, Contains self_heal=${activeTools.some(t => t.name === 'self_heal')}`);

      // Build SystemToolContext for self-awareness tools
      const sysCtx: SystemToolContext = {
        ctx: ctx ?? { botId: 'default', botName: 'AI Assistant', platform: 'telegram', replyWithFile: async () => '' },
        listModels: (provider: string) => this.getAvailableModels(provider),
        getProviderNames: () => Object.keys(this.providers),
      };
      const allHandlers: ToolHandlerMap = getFunctionHandlers(
        ctx ?? { botId: 'default', botName: 'AI Assistant', platform: 'telegram', replyWithFile: async () => '' },
        sysCtx
      );
      const activeHandlers: ToolHandlerMap = {};
      const useGoogleSearch = enabledToolNames.includes('google_search');
      for (const [name, fn] of Object.entries(allHandlers)) {
        if (enabledToolNames.includes(name)) activeHandlers[name] = fn;
      }

      // ──── 6. Agentic Loop — Enhanced with parallel tools ────
      let currentTurn = 0;
      let finalResponseText = '';
      let consecutiveToolErrors = 0;

      while (currentTurn < MAX_TURNS) {
        if (abortController.signal.aborted) {
          console.warn(`[Agent] Timeout after ${currentTurn} turns for ${chatId}`);
          return this.buildTimeoutResponse(stats);
        }
        currentTurn++;
        stats.turns = currentTurn;

        const response = await provider.generateResponse(
          modelName, systemInstruction, currentContents,
          activeTools.length > 0 ? activeTools : undefined, useGoogleSearch
        );

        if (response.usage) {
          stats.totalTokens += response.usage.totalTokens;
          console.log(`[Tokens T${currentTurn}] P=${response.usage.promptTokens} C=${response.usage.completionTokens} T=${response.usage.totalTokens}`);
        }

        // ── Handle Tool Calls (parallel when safe) ──
        if (response.toolCalls && response.toolCalls.length > 0) {
          if (response.rawModelContent) {
            currentContents.push(response.rawModelContent);
          } else {
            currentContents.push({
              role: 'model',
              parts: (response.toolCalls as ToolCall[]).map((call) => ({
                functionCall: { name: call.name, args: call.args }
              }))
            });
          }

          // Classify tools: safe for parallel vs sequential
          const SEQUENTIAL_TOOLS = new Set([
            'browser_navigate', 'browser_click', 'browser_type',
            'run_command', 'write_file_content', 'delete_file',
            'run_python', 'mouse_click', 'keyboard_type'
          ]);

          const parallelBatch: Promise<ToolExecutionResult>[] = [];
          const responseParts: Part[] = [];

          const executeOneTool = async (funcName: string, args: Record<string, unknown>): Promise<ToolExecutionResult> => {
            const toolStart = Date.now();

            // 🔌 Circuit Breaker — ข้าม tool ที่ fail ซ้ำๆ
            if (isCircuitOpen(funcName)) {
              console.warn(`[CircuitBreaker] ${funcName} is OPEN — skipping`);
              stats.toolCalls.push({ name: funcName, durationMs: 0, success: false });
              return { name: funcName, result: `⚡ Tool '${funcName}' ชั่วคราวถูก disable (fail บ่อยเกินไป) ลองใช้ tool อื่นแทน` };
            }

            try {
              const toolFn = activeHandlers[funcName];
              if (!toolFn) return { name: funcName, result: `❌ Tool '${funcName}' ไม่พบหรือไม่ได้เปิดใช้งาน` };

              let resultStr = await Promise.race([
                toolFn(args),
                new Promise<string>((_, rej) =>
                  setTimeout(() => rej(new Error(`Timeout ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS))
              ]);
              resultStr = typeof resultStr === 'string' ? resultStr : String(resultStr);
              if (resultStr.length > MAX_TOOL_OUTPUT) {
                resultStr = resultStr.substring(0, MAX_TOOL_OUTPUT) + '\n...(ตัดให้สั้นลง)';
              }
              stats.toolCalls.push({ name: funcName, durationMs: Date.now() - toolStart, success: true });
              recordToolResult(funcName, true);
              consecutiveToolErrors = 0;
              return { name: funcName, result: resultStr };
            } catch (err: any) {
              stats.toolCalls.push({ name: funcName, durationMs: Date.now() - toolStart, success: false });
              recordToolResult(funcName, false);
              consecutiveToolErrors++;
              console.error(`[Tool] ${funcName} error: ${err.message}`);
              return { name: funcName, result: `❌ Error: ${err.message}` };
            }
          };

          for (const call of response.toolCalls as ToolCall[]) {
            if (abortController.signal.aborted) break;
            const { name: funcName, args } = call;
            console.log(`[Tool] ${funcName}(${JSON.stringify(args).substring(0, 100)})`);

            if (!SEQUENTIAL_TOOLS.has(funcName) && parallelBatch.length < PARALLEL_TOOL_MAX) {
              parallelBatch.push(executeOneTool(funcName, args));
            } else {
              // Flush parallel batch first
              if (parallelBatch.length > 0) {
                const results = await Promise.all(parallelBatch);
                for (const r of results) {
                  responseParts.push({ functionResponse: { name: r.name, response: { output: r.result } } } as any);
                  addEpisode(chatId, 'system', `Tool: ${r.name}`);
                }
                parallelBatch.length = 0;
              }
              // Execute sequential tool
              const r = await executeOneTool(funcName, args);
              responseParts.push({ functionResponse: { name: r.name, response: { output: r.result } } } as any);
              addEpisode(chatId, 'system', `Tool: ${r.name}`);
            }
          }

          // Flush remaining parallel batch
          if (parallelBatch.length > 0) {
            const results = await Promise.all(parallelBatch);
            for (const r of results) {
              responseParts.push({ functionResponse: { name: r.name, response: { output: r.result } } } as any);
              addEpisode(chatId, 'system', `Tool: ${r.name}`);
            }
          }

          // Safety: break if too many consecutive errors
          if (consecutiveToolErrors >= 3) {
            console.warn('[Agent] Too many consecutive tool errors — forcing text response');
            currentContents.push({ role: 'user', parts: responseParts });
            currentContents.push({ role: 'user', parts: [{ text: '[System: เกิดข้อผิดพลาดหลายครั้ง กรุณาสรุปสิ่งที่ทำได้และตอบผู้ใช้]' }] });
            continue;
          }

          currentContents.push({ role: 'user', parts: responseParts });
          continue;
        }

        // ── Final Text Response ──
        if (response.text) {
          finalResponseText = response.text;
          umAddMessage(chatId, 'assistant', finalResponseText);
          addEpisode(chatId, 'model', finalResponseText);
          break;
        }
        break;
      }

      // ──── 7. Async Memory Extraction (non-blocking) ─────────
      if (message.length > 10 && shouldExtractArchival(chatId)) {
        setImmediate(() => this.extractFact(chatId, message, finalResponseText));
      }
      if (shouldExtractCore(chatId)) {
        setImmediate(() => this.extractCoreProfile(chatId, message, finalResponseText));
      }

      const elapsed = Date.now() - stats.startTime;
      console.log(`[Agent] Done in ${elapsed}ms | Turns: ${stats.turns} | Tools: ${stats.toolCalls.length} | Tokens: ${stats.totalTokens}`);
      const reply = finalResponseText || '✅ เสร็จแล้วครับ';
      finishRun(agentRun, stats, reply);

      // ──── 8. Self-Evolution Triggers (async, non-blocking) ──
      setImmediate(() => {
        if (shouldReflect()) {
          triggerReflection().catch(() => { });
        }
        // Periodic health check every 100 runs
        if ((getAgentStats().totalRuns % 100) === 0) {
          runHealthCheck();
        }
      });

      return reply;

    } catch (error: any) {
      if (error.name === 'AbortError') {
        const timeoutReply = this.buildTimeoutResponse(stats);
        finishRun(agentRun, stats, timeoutReply, 'timeout');
        return timeoutReply;
      }
      console.error('[Agent Error]:', error);
      finishRun(agentRun, stats, undefined, error.message);

      // Fallback: try a simpler model
      try {
        const fb = this.providers.gemini;
        const res = await fb.generateResponse('gemini-2.0-flash-lite', 'ตอบสั้นๆ ภาษาเดียวกับผู้ใช้',
          [{ role: 'user', parts: [{ text: message }] }]);
        if (res.text) return res.text;
      } catch { /* ignore */ }
      return `❌ เกิดข้อผิดพลาด: ${error.message}`;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── Timeout response with progress info ─────────────────────
  private buildTimeoutResponse(stats: IAgentStats): string {
    const done = stats.toolCalls.filter(t => t.success).map(t => t.name);
    if (done.length > 0) {
      return `⏰ ใช้เวลานานเกิน แต่ทำสำเร็จแล้ว:\n${done.map(t => `• ${t}`).join('\n')}\n\nกรุณาลองถามใหม่ให้เจาะจงมากขึ้น`;
    }
    return '⏰ ขออภัย ใช้เวลานานเกินไป กรุณาลองใหม่อีกครั้งครับ';
  }

  // ── Knowledge extraction ────────────────────────────────────
  private async extractFact(chatId: string, userMsg: string, aiMsg: string) {
    try {
      const res = await this.providers.gemini.generateResponse('gemini-2.0-flash-lite',
        `จาก conversation นี้ ดึงข้อเท็จจริงเกี่ยวกับผู้ใช้ 1 ข้อ (ชื่อ,อาชีพ,ความชอบ,นิสัย)
ถ้าไม่มีข้อมูลใหม่ ตอบว่า 'NONE' — ตอบสั้นๆ ไม่เกิน 1 ประโยค ไม่ต้องมี tag`,
        [{ role: 'user', parts: [{ text: `User:${userMsg}\nAI:${aiMsg}` }] }]);
      const fact = res.text?.trim();
      if (fact && fact !== 'NONE' && fact.length > 5 && fact.length < 200) {
        await saveArchivalFact(chatId, fact);
        console.log(`[LTM] Extracted: ${fact}`);
      }
    } catch (err) { console.error('[Agent] Archival extraction failed:', err); }
  }

  private async extractCoreProfile(chatId: string, userMsg: string, aiMsg: string) {
    try {
      const res = await this.providers.gemini.generateResponse('gemini-2.0-flash-lite',
        `สรุปสิ่งที่รู้เกี่ยวกับผู้ใช้คนนี้ 2-3 บรรทัด ไม่ต้อง tag ไม่ต้อง JSON`,
        [{ role: 'user', parts: [{ text: `User:${userMsg}\nAI:${aiMsg}` }] }]);
      const profile = res.text?.trim();
      if (profile && profile.length > 5) setCoreMemory(chatId, 'human', profile);
    } catch (err) { console.error('[Agent] Core extraction failed:', err); }
  }

  // ── Per-bot model config resolution ────────────────────────────
  private resolveModelConfig(botId: string | undefined, taskType: TaskType): { provider: string; modelName: string } {
    // 1. Try per-bot override from bot_instances.config.modelOverrides
    if (botId) {
      try {
        const bot = getBot(botId);
        const overrides = (bot?.config as any)?.modelOverrides;
        if (overrides?.[taskType]?.provider && overrides?.[taskType]?.modelName) {
          console.log(`[Router] Bot "${botId}" override: ${taskType} → ${overrides[taskType].modelName}`);
          return overrides[taskType];
        }
      } catch { /* bot not found — use global */ }
    }
    // 2. Fall back to global config
    const routing = configManager.getConfig();
    return routing[taskType] ?? routing[TaskType.GENERAL];
  }

  // ── Provider failover chain ──────────────────────────────────
  private static FALLBACK_CHAIN: Array<{ provider: string; model: string }> = [
    { provider: 'gemini', model: 'gemini-2.0-flash' },
    { provider: 'gemini', model: 'gemini-2.0-flash-lite' },
    { provider: 'openai', model: 'gpt-4o-mini' },
    { provider: 'minimax', model: 'MiniMax-Text-01' },
  ];

  private resolveProvider(config: { provider: string; modelName: string }): {
    provider: AIProvider | null;
    providerName: string;
    modelName: string;
  } {
    // Try configured provider first
    const primary = this.providers[config.provider];
    if (primary) return { provider: primary, providerName: config.provider, modelName: config.modelName };

    // Fallback chain
    for (const fb of Agent.FALLBACK_CHAIN) {
      const p = this.providers[fb.provider];
      if (p) {
        console.warn(`[Failover] ${config.provider} unavailable → using ${fb.provider}/${fb.model}`);
        return { provider: p, providerName: fb.provider, modelName: fb.model };
      }
    }
    return { provider: null, providerName: 'none', modelName: '' };
  }

  // ── List models ─────────────────────────────────────────────
  public async getAvailableModels(providerName: string): Promise<string[]> {
    const provider = this.providers[providerName];
    return provider ? await provider.listModels() : [];
  }
}

import { Content, Part } from '@google/genai';
import { tools, getFunctionHandlers, BotContext } from './tools';
import { memoryManager } from './memory';
import { LongTermMemory } from './longTermMemory';
import { classifyTask, TaskType } from './config/aiConfig';
import { configManager } from './config/configManager';
import { GeminiProvider } from './providers/geminiProvider';
import { OpenAICompatibleProvider } from './providers/openaiCompatibleProvider';
import { AIProvider } from './providers/baseProvider';

// ============================================================
// Types
// ============================================================
interface CircuitState {
  failures: number;
  openUntil: number;
}

interface ToolTelemetry {
  name: string;
  durationMs: number;
  success: boolean;
}

interface AgentStats {
  turns: number;
  toolCalls: ToolTelemetry[];
  totalTokens: number;
  startTime: number;
}

// ============================================================
// Timing constants
// ============================================================
const AGENT_TIMEOUT_MS = 120_000;  // 120 วินาที (เพิ่มจาก 90)
const TOOL_TIMEOUT_MS  = 45_000;   // 45 วินาทีต่อ tool (เพิ่มจาก 30)
const MAX_TURNS        = 20;       // เพิ่มจาก 12 → รองรับ multi-step
const MAX_TOOL_OUTPUT  = 12_000;   // เพิ่ม output size
const LTM_EXTRACT_EVERY = 4;       // ดึง knowledge ถี่ขึ้น (ทุก 4 ข้อความ)

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
// Agent Stats Tracking — เก็บ telemetry ทุก request
// ============================================================
const globalStats = {
  totalRuns: 0,
  totalToolCalls: 0,
  totalTokens: 0,
  totalLatencyMs: 0,
  avgLatencyMs: 0,
};

function recordStats(stats: AgentStats): void {
  globalStats.totalRuns++;
  globalStats.totalToolCalls += stats.toolCalls.length;
  globalStats.totalTokens += stats.totalTokens;
  const latency = Date.now() - stats.startTime;
  globalStats.totalLatencyMs += latency;
  globalStats.avgLatencyMs = Math.round(globalStats.totalLatencyMs / globalStats.totalRuns);
}

export function getAgentStats() {
  return { ...globalStats };
}

// ============================================================
// Rate Limiting — per-user cooldown
// ============================================================
const userLastMessageTime: Map<string, number> = new Map();
const MIN_USER_COOLDOWN_MS = 1000;  // 1 second

async function enforceUserRateLimit(chatId: string): Promise<void> {
  const now = Date.now();
  const lastTime = userLastMessageTime.get(chatId) ?? 0;
  const elapsed = now - lastTime;
  if (elapsed < MIN_USER_COOLDOWN_MS) {
    const delay = MIN_USER_COOLDOWN_MS - elapsed;
    console.log(`[RateLimit] ${chatId} cooldown: ${delay}ms`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  userLastMessageTime.set(chatId, Date.now());
}

// ============================================================
// Per-user queue (ป้องกัน race condition)
// ============================================================
const processingQueues: Map<string, Promise<string>> = new Map();

function enqueueForUser(chatId: string, task: () => Promise<string>): Promise<string> {
  const prev = processingQueues.get(chatId) ?? Promise.resolve('');
  const next = prev.then(task).catch(task); // ถ้า prev fail ก็ยัง run task ต่อได้
  processingQueues.set(chatId, next);
  // GC: ลบ entry เมื่อ resolve แล้ว
  next.finally(() => {
    if (processingQueues.get(chatId) === next) processingQueues.delete(chatId);
  });
  return next;
}

// ============================================================
// Main Agent
// ============================================================
export class Agent {
  private providers: Record<string, AIProvider>;
  private ltm: LongTermMemory;
  private messageCountPerUser: Map<string, number> = new Map();

  constructor(apiKey: string) {
    // ============================================================
    // Provider Validation — Set null for unconfigured providers
    // ============================================================
    if (!apiKey || apiKey.trim() === '') {
      console.warn('[Agent] Warning: Gemini API key is not configured (empty or undefined)');
    }

    const openaiKey = process.env.OPENAI_API_KEY?.trim() || '';
    const minimaxKey = process.env.MINIMAX_API_KEY?.trim() || '';

    this.providers = {
      gemini:  new GeminiProvider(apiKey),
      openai:  openaiKey ? new OpenAICompatibleProvider(openaiKey) : (null as any),
      minimax: minimaxKey ? new OpenAICompatibleProvider(minimaxKey, 'https://api.minimax.io/v1') : (null as any)
    };

    // Log configured providers
    const configured = Object.entries(this.providers)
      .filter(([_, p]) => p !== null)
      .map(([name]) => name);
    console.log(`[Agent] Configured providers: ${configured.join(', ')}`);

    this.ltm = new LongTermMemory(apiKey);
  }

  // ── Public: queue per-user ──────────────────────────────────
  public async processMessage(
    chatId: string,
    message: string,
    ctx: BotContext,
    attachments?: Part[]
  ): Promise<string> {
    // Apply rate limiting
    await enforceUserRateLimit(chatId);
    return enqueueForUser(chatId, () => this._processMessageCore(chatId, message, ctx, attachments));
  }

  // ── Core processing ─────────────────────────────────────────
  private async _processMessageCore(
    chatId: string,
    message: string,
    ctx: BotContext,
    attachments?: Part[]
  ): Promise<string> {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), AGENT_TIMEOUT_MS);
    const stats: AgentStats = {
      turns: 0,
      toolCalls: [],
      totalTokens: 0,
      startTime: Date.now()
    };

    try {
      // 1. Task routing
      const taskType = classifyTask(message, !!attachments);
      const routing = configManager.getConfig();
      const config = routing[taskType] ?? routing[TaskType.GENERAL];
      const provider = this.providers[config.provider];
      if (!provider) {
        return `❌ Provider "${config.provider}" ไม่ได้ตั้งค่าใน .env`;
      }
      console.log(`[Router] ${taskType} -> ${config.modelName} (${config.provider})`);

      // 2. Long-term memory retrieval
      const relevantFacts = await this.ltm.retrieveRelevantKnowledge(chatId, message);
      const knowledgeCtx = relevantFacts.length > 0
        ? `\n[สิ่งที่รู้เกี่ยวกับผู้ใช้]: ${relevantFacts.join(' | ')}`
        : '';

      // 3. Save user message & build history
      memoryManager.addMessage(chatId, 'user', message);
      const history = memoryManager.getSessionMemory(chatId);

      const userParts: Part[] = [{ text: message }];
      if (attachments) userParts.push(...attachments);

      let currentContents: Content[] = [
        ...history.slice(0, -1),
        { role: 'user', parts: userParts }
      ];

      // 4. System instruction — Enhanced Agentic AI
      const systemInstruction = `คุณคือ Personal AI Assistant ที่ฉลาด รวดเร็ว เป็น Autonomous AI Agent ที่ทำงานหลายขั้นตอนได้ด้วยตัวเอง ทำงานบน Windows
${knowledgeCtx}

## ความสามารถ
- ค้นหาข้อมูลจากอินเทอร์เน็ต (web_search — ไม่ต้องเปิด browser)
- ควบคุมเว็บเบราว์เซอร์ (navigate, click, type, scroll, screenshot)
- รันคำสั่ง Windows CMD/PowerShell
- รัน Python code โดยตรง (คำนวณ, วิเคราะห์ข้อมูล, สร้างกราฟ)
- จัดการไฟล์ (อ่าน, เขียน, ลบ, แสดงรายการ)
- วิเคราะห์รูปภาพและไฟล์ (Multimodal)
- ส่งไฟล์กลับไปยัง Chat
- จัดการความทรงจำระยะยาว (จดจำข้อมูลผู้ใช้)

## วิธีคิดเชิงกลยุทธ์ (Strategic Thinking)
1. **วิเคราะห์**: ทำความเข้าใจสิ่งที่ผู้ใช้ต้องการจริงๆ
2. **วางแผน**: ถ้างานซับซ้อน ให้คิดแผนก่อนลงมือทำ
3. **เลือกเครื่องมือ**: ใช้ tool ที่เหมาะสม — เรียกหลาย tools ได้
4. **ตรวจสอบผลลัพธ์**: ถ้าข้อมูลไม่เพียงพอ ให้ค้นหาเพิ่ม
5. **สังเคราะห์คำตอบ**: รวบรวมทุกอย่างตอบอย่างสมบูรณ์

## กฎสำคัญ
1. **ใช้ web_search ก่อนเสมอ** เมื่อต้องการข้อมูลปัจจุบัน
2. เปิด browser เฉพาะเมื่อต้อง interact กับเว็บจริง
3. **ปิด browser ทันทีหลังใช้งานเสร็จ**
4. ตอบภาษาเดียวกับผู้ใช้ (ไทย→ไทย, อังกฤษ→อังกฤษ)
5. กระชับ ตรงประเด็น
6. ถ้าไม่รู้ให้บอกตรงๆ ห้ามแต่งข้อมูลขึ้นเอง
7. ถ้า tool ล้มเหลว → ลองวิธีอื่น ห้ามยอมแพ้ง่ายๆ
8. ถ้าต้องใช้ข้อมูลหลายแหล่ง → เรียก tool หลายครั้งแล้วสรุปรวม`;

      // 5. Agentic loop
      let currentTurn = 0;
      let finalResponseText = '';
      const handlers = getFunctionHandlers(ctx);

      while (currentTurn < MAX_TURNS) {
        if (abortController.signal.aborted) {
          console.warn(`[Agent] Timeout after ${currentTurn} turns for ${chatId}`);
          recordStats(stats);
          return '⏰ ขออภัย ใช้เวลานานเกินไป กรุณาลองใหม่อีกครั้งครับ';
        }

        currentTurn++;
        stats.turns = currentTurn;

        const response = await provider.generateResponse(
          config.modelName,
          systemInstruction,
          currentContents,
          tools
        );

        if (response.usage) {
          stats.totalTokens += response.usage.totalTokens;
          console.log(`[Tokens T${currentTurn}] P=${response.usage.promptTokens} C=${response.usage.completionTokens} Total=${response.usage.totalTokens}`);
        }

        // Tool call handling — use proper Gemini functionCall/functionResponse format
        if (response.toolCalls && response.toolCalls.length > 0) {
          // 1. Push the model turn with the REAL functionCall parts (not placeholder text)
          //    This is required for Gemini to understand the conversation history
          if (response.rawModelContent) {
            currentContents.push(response.rawModelContent);
          } else {
            // Fallback: reconstruct functionCall parts from toolCalls
            currentContents.push({
              role: 'model',
              parts: response.toolCalls.map((call: any) => ({
                functionCall: { name: call.name, args: call.args }
              }))
            });
          }

          // 2. Execute each tool and collect functionResponse parts
          const responseParts: Part[] = [];

          for (const call of response.toolCalls) {
            if (abortController.signal.aborted) break;

            const funcName = call.name;
            const args = call.args;
            console.log(`[Tool] Calling ${funcName}(${JSON.stringify(args).substring(0, 100)})`);

            let resultStr: string;
            const toolStart = Date.now();
            let success = false;

            try {
              // 🔌 Circuit Breaker — ข้าม tool ที่ fail ซ้ำๆ
              if (isCircuitOpen(funcName)) {
                console.warn(`[CircuitBreaker] ${funcName} is OPEN — skipping`);
                resultStr = `⚡ Tool '${funcName}' ชั่วคราวถูก disable (fail บ่อยเกินไป) ลองใช้ tool อื่นแทน`;
              } else {
                const toolFn = handlers[funcName];
                if (!toolFn) {
                  resultStr = `❌ Tool '${funcName}' ไม่พบ`;
                } else {
                  resultStr = await Promise.race([
                    toolFn(args),
                    new Promise<string>((_, reject) =>
                      setTimeout(() => reject(new Error(`Tool timeout: ${funcName}`)), TOOL_TIMEOUT_MS)
                    )
                  ]);
                  success = true;
                }
              }
            } catch (err: any) {
              resultStr = `❌ Tool error (${funcName}): ${err.message}`;
              success = false;
            }

            // Record tool result for circuit breaker
            recordToolResult(funcName, success);

            // ตัดผลลัพธ์ที่ยาวเกินไป — เพิ่ม limit
            if (typeof resultStr === 'string' && resultStr.length > MAX_TOOL_OUTPUT) {
              resultStr = resultStr.substring(0, MAX_TOOL_OUTPUT) + '\n...(ข้อมูลถูกตัดให้สั้นลง)';
            }

            // Track telemetry
            stats.toolCalls.push({
              name: funcName,
              durationMs: Date.now() - toolStart,
              success
            });

            // 3. Build proper functionResponse part (Gemini SDK format)
            responseParts.push({
              functionResponse: {
                name: funcName,
                response: { output: resultStr }
              }
            } as any);
          }

          // 4. Push user turn with all functionResponse parts at once
          currentContents.push({ role: 'user', parts: responseParts });
          continue;
        }

        // Final text response
        if (response.text) {
          finalResponseText = response.text;
          memoryManager.addMessage(chatId, 'model', finalResponseText);
          break;
        }
        break;
      }

      // 6. Async knowledge extraction (ทุก N ข้อความ, ไม่ block response)
      const count = (this.messageCountPerUser.get(chatId) ?? 0) + 1;
      this.messageCountPerUser.set(chatId, count);
      if (count % LTM_EXTRACT_EVERY === 0 && message.length > 15) {
        setImmediate(() => this.extractNewKnowledge(chatId, message, finalResponseText));
      }

      // Record stats
      recordStats(stats);
      const reply = finalResponseText || '✅ เสร็จแล้วครับ';
      console.log(`[Agent] Done in ${Date.now() - stats.startTime}ms | Turns: ${stats.turns} | Tools: ${stats.toolCalls.length} | Tokens: ${stats.totalTokens}`);
      return reply;
    } catch (error: any) {
      console.error('[Agent Error]:', error);

      // Automatic failover: ลองใช้ provider อื่นถ้า primary ล้มเหลว
      const fallbackProviders = ['gemini', 'openai', 'minimax'];
      for (const fbName of fallbackProviders) {
        const fbProvider = this.providers[fbName];
        if (!fbProvider || fbProvider === this.providers[config.provider]) continue;
        try {
          console.warn(`[Agent] Failover: trying ${fbName}`);
          const fbRes = await fbProvider.generateResponse(
            fbName === 'gemini' ? 'gemini-2.0-flash-lite' : 'gpt-4o-mini',
            'ตอบสั้นๆ ภาษาเดียวกับผู้ใช้',
            [{ role: 'user', parts: [{ text: message }] }]
          );
          if (fbRes.text) {
            memoryManager.addMessage(chatId, 'model', fbRes.text);
            return fbRes.text;
          }
        } catch { continue; }
      }

      return `❌ เกิดข้อผิดพลาด: ${error.message}`;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── Knowledge extraction (async, silent) ────────────────────
  private async extractNewKnowledge(chatId: string, userMsg: string, aiMsg: string) {
    try {
      if (!this.providers.gemini) {
        console.warn('[Agent] Gemini provider not available for knowledge extraction');
        return;
      }

      // Timeout protection
      const extractionPromise = this.providers.gemini.generateResponse(
        'gemini-2.0-flash-lite',
        "จาก conversation นี้ ดึงข้อเท็จจริงสั้นๆ เกี่ยวกับผู้ใช้ 1 ข้อ (ชื่อ, อาชีพ, ความชอบ, นิสัย) หรือตอบว่า 'NONE' ถ้าไม่มีข้อมูลใหม่",
        [{ role: 'user', parts: [{ text: `User: ${userMsg}\nAI: ${aiMsg}` }] }]
      );

      const timeoutPromise = new Promise<any>((_, reject) =>
        setTimeout(() => reject(new Error('Knowledge extraction timeout')), 10000)
      );

      const res = await Promise.race([extractionPromise, timeoutPromise]);
      const fact = res.text?.trim();
      if (fact && fact !== 'NONE' && fact.length > 5 && fact.length < 200) {
        await this.ltm.saveKnowledge(chatId, fact);
        console.log(`[LTM] Extracted: ${fact}`);
      }
    } catch (err: any) {
      console.error('[Agent] Knowledge extraction error:', err.message);
    }
  }

  // ── List models ──────────────────────────────────────────────
  public async getAvailableModels(providerName: string): Promise<string[]> {
    const provider = this.providers[providerName];
    if (!provider) return [];
    return await provider.listModels();
  }

  // ── Health Check ───────────────────────────────────────────
  public async selfHealthCheck(): Promise<{ healthy: boolean; issues: string[] }> {
    const issues: string[] = [];

    // Check memory system
    try {
      if (!memoryManager) {
        issues.push('Memory system not accessible');
      }
    } catch (err) {
      issues.push('Failed to access memory system');
    }

    // Check at least one provider is configured
    const configuredProviders = Object.entries(this.providers)
      .filter(([_, p]) => p !== null && p !== undefined)
      .map(([name]) => name);

    if (configuredProviders.length === 0) {
      issues.push('No AI providers are configured');
    }

    // Check LTM
    try {
      if (!this.ltm) {
        issues.push('Long-term memory not initialized');
      }
    } catch (err) {
      issues.push('Failed to access long-term memory');
    }

    return {
      healthy: issues.length === 0,
      issues
    };
  }
}

// ============================================================
// Export health check as standalone function
// ============================================================
export async function agentHealthCheck(): Promise<{ healthy: boolean; issues: string[] }> {
  try {
    const agent = new Agent(process.env.GEMINI_API_KEY || '');
    return await agent.selfHealthCheck();
  } catch (err: any) {
    return {
      healthy: false,
      issues: [`Failed to create agent: ${err.message}`]
    };
  }
}

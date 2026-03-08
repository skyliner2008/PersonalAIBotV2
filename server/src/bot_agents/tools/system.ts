// ============================================================
// System Self-Awareness Tools — ความสามารถพื้นฐานทุก Agent มีตั้งแต่สร้าง
// ให้ Agent รู้จักตัวเอง, รู้จัก Model, เปลี่ยน Model ได้
// ============================================================

import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import type { BotContext, ToolHandlerMap } from '../types.js';
import { TaskType, type ModelConfig } from '../config/aiConfig.js';
import { configManager } from '../config/configManager.js';
import { getBot, updateBot } from '../registries/botRegistry.js';
import { getAllTools, getToolsByCategory, type ToolMeta } from '../registries/toolRegistry.js';
import { getAgentRunHistory, getAgentStats } from '../agent.js';

// ============================================================
// Types for System Tool Context
// ============================================================

export interface SystemToolContext {
  ctx: BotContext;
  /** Function to list models from a provider */
  listModels: (provider: string) => Promise<string[]>;
  /** Get all available providers */
  getProviderNames: () => string[];
}

// ============================================================
// Tool Declarations (FunctionDeclaration)
// ============================================================

export const getMyConfigDeclaration: FunctionDeclaration = {
  name: 'get_my_config',
  description: 'ดูข้อมูล config ของตัวเอง เช่น ชื่อ, platform, model ที่ใช้อยู่, จำนวน tools ที่เปิดใช้',
  parameters: { type: Type.OBJECT, properties: {} },
};

export const listAvailableModelsDeclaration: FunctionDeclaration = {
  name: 'list_available_models',
  description: 'แสดงรายการ AI model ทั้งหมดที่ใช้ได้ในระบบ จัดกลุ่มตาม provider (gemini, openai, minimax)',
  parameters: {
    type: Type.OBJECT,
    properties: {
      provider: {
        type: Type.STRING,
        description: 'กรอง provider ที่ต้องการ เช่น "gemini", "openai", "minimax" (ถ้าไม่ระบุจะแสดงทั้งหมด)',
      },
    },
  },
};

export const setMyModelDeclaration: FunctionDeclaration = {
  name: 'set_my_model',
  description: 'เปลี่ยน AI model ที่ใช้สำหรับ task type ที่กำหนด เช่น เปลี่ยนจาก gemini-2.0-flash เป็น gpt-4o สำหรับงาน complex',
  parameters: {
    type: Type.OBJECT,
    properties: {
      task_type: {
        type: Type.STRING,
        description: `ประเภทงาน: ${Object.values(TaskType).join(', ')}`,
      },
      provider: {
        type: Type.STRING,
        description: 'provider: gemini, openai, minimax',
      },
      model_name: {
        type: Type.STRING,
        description: 'ชื่อ model เช่น gemini-2.0-flash, gpt-4o, MiniMax-M2.5',
      },
    },
    required: ['task_type', 'provider', 'model_name'],
  },
};

export const getSystemStatusDeclaration: FunctionDeclaration = {
  name: 'get_system_status',
  description: 'ดูสถานะระบบ: uptime, providers ที่ใช้ได้, สถิติการทำงาน',
  parameters: { type: Type.OBJECT, properties: {} },
};

export const getMyCapabilitiesDeclaration: FunctionDeclaration = {
  name: 'get_my_capabilities',
  description: 'แสดงรายการ tools และความสามารถที่เปิดใช้อยู่ จัดกลุ่มตามประเภท',
  parameters: { type: Type.OBJECT, properties: {} },
};

export const helpDeclaration: FunctionDeclaration = {
  name: 'help',
  description: 'แสดงคู่มือการใช้งานและความสามารถทั้งหมดของ AI Agent',
  parameters: { type: Type.OBJECT, properties: {} },
};

export const getRecentErrorsDeclaration: FunctionDeclaration = {
  name: 'get_recent_errors',
  description: 'ดูข้อผิดพลาดล่าสุดของระบบ เพื่อวินิจฉัยปัญหา',
  parameters: {
    type: Type.OBJECT,
    properties: {
      limit: {
        type: Type.NUMBER,
        description: 'จำนวนรายการที่ต้องการดู (ค่าเริ่มต้น 10)',
      },
    },
  },
};

export const getSessionStatsDeclaration: FunctionDeclaration = {
  name: 'get_session_stats',
  description: 'ดูสถิติการทำงานของ Agent: จำนวน runs, tokens ที่ใช้, เวลาเฉลี่ย',
  parameters: { type: Type.OBJECT, properties: {} },
};

// ============================================================
// All declarations for export
// ============================================================

export const systemToolDeclarations: FunctionDeclaration[] = [
  getMyConfigDeclaration,
  listAvailableModelsDeclaration,
  setMyModelDeclaration,
  getSystemStatusDeclaration,
  getMyCapabilitiesDeclaration,
  helpDeclaration,
  getRecentErrorsDeclaration,
  getSessionStatsDeclaration,
];

// ============================================================
// Tool Handlers
// ============================================================

export function getSystemToolHandlers(sysCtx: SystemToolContext): ToolHandlerMap {
  const { ctx, listModels, getProviderNames } = sysCtx;

  return {
    // ── get_my_config ────────────────────────────────────
    get_my_config: async () => {
      const bot = getBot(ctx.botId);
      const globalConfig = configManager.getConfig();
      const botOverrides = (bot?.config as any)?.modelOverrides ?? {};

      // Build model config per task type (bot override → global)
      const modelConfig: Record<string, { provider: string; modelName: string; source: string }> = {};
      for (const tt of Object.values(TaskType)) {
        if (botOverrides[tt]) {
          modelConfig[tt] = { ...botOverrides[tt], source: 'bot-override' };
        } else if (globalConfig[tt]) {
          modelConfig[tt] = { ...globalConfig[tt], source: 'global' };
        }
      }

      const result = {
        botId: ctx.botId,
        botName: ctx.botName,
        platform: ctx.platform,
        persona: bot?.persona_id ?? 'default',
        enabledToolsCount: bot?.enabled_tools?.length ?? 0,
        modelConfig,
        status: bot?.status ?? 'unknown',
        createdAt: bot?.created_at,
      };

      return `🤖 ข้อมูล Config ของฉัน:\n${JSON.stringify(result, null, 2)}`;
    },

    // ── list_available_models ─────────────────────────────
    list_available_models: async (args) => {
      const filterProvider = args?.provider as string | undefined;
      const providers = filterProvider ? [filterProvider] : getProviderNames();
      const result: Record<string, string[]> = {};

      for (const providerName of providers) {
        try {
          const models = await listModels(providerName);
          result[providerName] = models;
        } catch (err: any) {
          result[providerName] = [`❌ Error: ${err.message}`];
        }
      }

      let output = '📋 AI Models ที่ใช้ได้ในระบบ:\n';
      for (const [provider, models] of Object.entries(result)) {
        output += `\n🔹 ${provider.toUpperCase()} (${models.length} models):\n`;
        output += models.map(m => `  • ${m}`).join('\n');
      }

      return output;
    },

    // ── set_my_model ─────────────────────────────────────
    set_my_model: async (args) => {
      const taskType = String(args.task_type) as TaskType;
      const provider = String(args.provider);
      const modelName = String(args.model_name);

      // Validate task type
      if (!Object.values(TaskType).includes(taskType)) {
        return `❌ task_type ไม่ถูกต้อง ต้องเป็น: ${Object.values(TaskType).join(', ')}`;
      }

      // Validate provider
      if (!['gemini', 'openai', 'minimax'].includes(provider)) {
        return `❌ provider ไม่ถูกต้อง ต้องเป็น: gemini, openai, minimax`;
      }

      // Validate model exists
      try {
        const models = await listModels(provider);
        if (models.length > 0 && !models.includes(modelName)) {
          return `❌ ไม่พบ model "${modelName}" ใน ${provider}\nModels ที่ใช้ได้: ${models.slice(0, 10).join(', ')}`;
        }
      } catch {
        // Can't verify — proceed anyway (model list may be unavailable)
      }

      // Update bot config
      const bot = getBot(ctx.botId);
      if (!bot) {
        return `❌ ไม่พบ bot ID: ${ctx.botId}`;
      }

      const currentConfig = (bot.config ?? {}) as Record<string, unknown>;
      const modelOverrides = (currentConfig.modelOverrides ?? {}) as Record<string, ModelConfig>;
      modelOverrides[taskType] = { provider: provider as any, modelName };
      currentConfig.modelOverrides = modelOverrides;

      updateBot(ctx.botId, { config: currentConfig });

      return `✅ เปลี่ยน model สำเร็จ!\n` +
        `📌 Task: ${taskType}\n` +
        `🔄 Model: ${provider}/${modelName}\n` +
        `💡 การเปลี่ยนจะมีผลตั้งแต่ข้อความถัดไป`;
    },

    // ── get_system_status ─────────────────────────────────
    get_system_status: async () => {
      const uptimeSeconds = Math.floor(process.uptime());
      const hours = Math.floor(uptimeSeconds / 3600);
      const mins = Math.floor((uptimeSeconds % 3600) / 60);

      // Check available providers
      const providerStatus: Record<string, string> = {};
      for (const p of getProviderNames()) {
        try {
          const models = await listModels(p);
          providerStatus[p] = `✅ Active (${models.length} models)`;
        } catch {
          providerStatus[p] = '❌ Unavailable';
        }
      }

      // Memory usage
      const mem = process.memoryUsage();
      const memMB = {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      };

      // Agent stats
      const agentStats = getAgentStats();

      const result = {
        uptime: `${hours}h ${mins}m`,
        providers: providerStatus,
        memory: `${memMB.heapUsed}MB / ${memMB.heapTotal}MB (RSS: ${memMB.rss}MB)`,
        agentStats: {
          totalRuns: agentStats.totalRuns,
          activeRuns: agentStats.activeRuns,
          avgDuration: `${agentStats.avgDurationMs}ms`,
          avgTokens: agentStats.avgTokens,
          totalToolCalls: agentStats.totalToolCalls,
        },
        nodeVersion: process.version,
      };

      return `📊 สถานะระบบ:\n${JSON.stringify(result, null, 2)}`;
    },

    // ── get_my_capabilities ──────────────────────────────
    get_my_capabilities: async () => {
      const bot = getBot(ctx.botId);
      const enabledToolNames = bot?.enabled_tools ?? [];
      const allTools = getAllTools();

      // Group enabled tools by category
      const grouped: Record<string, ToolMeta[]> = {};
      for (const tool of allTools) {
        if (enabledToolNames.includes(tool.name)) {
          if (!grouped[tool.category]) grouped[tool.category] = [];
          grouped[tool.category].push(tool);
        }
      }

      const categoryEmojis: Record<string, string> = {
        utility: '🔧', os: '💻', file: '📁', browser: '🌐',
        web: '🔍', memory: '🧠', communication: '💬', system: '⚙️',
      };

      let output = `🤖 ความสามารถของ ${ctx.botName}:\n`;
      output += `Platform: ${ctx.platform} | Tools: ${enabledToolNames.length}/${allTools.length}\n\n`;

      for (const [category, tools] of Object.entries(grouped)) {
        const emoji = categoryEmojis[category] || '📦';
        output += `${emoji} ${category.toUpperCase()} (${tools.length}):\n`;
        for (const tool of tools) {
          output += `  • ${tool.displayName}: ${tool.description}\n`;
        }
        output += '\n';
      }

      return output;
    },

    // ── help ─────────────────────────────────────────────
    help: async () => {
      return `📖 คู่มือการใช้งาน AI Agent

🤖 ฉันเป็น Personal AI Agent ที่ทำงานหลายขั้นตอนได้ด้วยตัวเอง

⚙️ ระบบ Self-Awareness (รู้จักตัวเอง):
  • "ใช้โมเดลอะไร" → ฉันจะบอกว่าใช้ model อะไรอยู่
  • "มีโมเดลอะไรบ้าง" → แสดงรายการ model ทั้งหมด
  • "เปลี่ยนไปใช้ gpt-4o" → เปลี่ยน model ได้ทันที
  • "สถานะระบบ" → ดูสุขภาพของระบบ
  • "ทำอะไรได้บ้าง" → แสดงความสามารถทั้งหมด

🔍 ค้นหาและข้อมูล:
  • ค้นหาข้อมูลจากอินเทอร์เน็ต
  • อ่านและสรุปเนื้อหาเว็บเพจ
  • จดจำข้อมูลผู้ใช้ระยะยาว

💻 ควบคุมคอมพิวเตอร์:
  • รันคำสั่ง CMD/Shell
  • รัน Python Script
  • จัดการไฟล์ (อ่าน/เขียน/ลบ)
  • เปิด/ปิดโปรแกรม

🌐 ควบคุมเบราว์เซอร์:
  • เปิดเว็บ, คลิก, พิมพ์

📊 Model Routing:
  แต่ละประเภทงานใช้ model ต่างกัน:
  • general → งานทั่วไป
  • complex → งานซับซ้อน
  • thinking → งานวิเคราะห์
  • code → เขียนโค้ด
  • data → วิเคราะห์ข้อมูล
  • vision → วิเคราะห์ภาพ
  • web → ค้นหาข้อมูล

💡 ใช้ get_my_config เพื่อดู model แต่ละประเภท
💡 ใช้ set_my_model เพื่อเปลี่ยน model ตามต้องการ`;
    },

    // ── get_recent_errors ─────────────────────────────────
    get_recent_errors: async (args) => {
      const limit = Number(args?.limit) || 10;
      const runs = getAgentRunHistory();
      const errors = runs.filter(r => r.error).slice(0, limit);

      if (errors.length === 0) {
        return '✅ ไม่พบข้อผิดพลาดล่าสุด ระบบทำงานปกติ';
      }

      let output = `⚠️ ข้อผิดพลาดล่าสุด (${errors.length} รายการ):\n\n`;
      for (const run of errors) {
        const time = new Date(run.startTime).toLocaleString('th-TH');
        output += `🔴 ${time}\n`;
        output += `  Task: ${run.taskType} | Turns: ${run.turns}\n`;
        output += `  Error: ${run.error}\n`;
        output += `  Message: "${run.message}"\n\n`;
      }

      return output;
    },

    // ── get_session_stats ─────────────────────────────────
    get_session_stats: async () => {
      const stats = getAgentStats();
      const runs = getAgentRunHistory();
      const recentRuns = runs.slice(0, 20);

      // Calculate per-task-type stats
      const taskTypeStats: Record<string, { count: number; avgTokens: number; avgDuration: number }> = {};
      for (const run of runs) {
        const tt = run.taskType || 'unknown';
        if (!taskTypeStats[tt]) taskTypeStats[tt] = { count: 0, avgTokens: 0, avgDuration: 0 };
        taskTypeStats[tt].count++;
        taskTypeStats[tt].avgTokens += run.totalTokens;
        taskTypeStats[tt].avgDuration += run.durationMs || 0;
      }
      for (const tt of Object.keys(taskTypeStats)) {
        const s = taskTypeStats[tt];
        s.avgTokens = Math.round(s.avgTokens / s.count);
        s.avgDuration = Math.round(s.avgDuration / s.count);
      }

      // Tool usage frequency
      const toolUsage: Record<string, number> = {};
      for (const run of runs) {
        for (const tc of run.toolCalls) {
          toolUsage[tc.name] = (toolUsage[tc.name] || 0) + 1;
        }
      }
      const topTools = Object.entries(toolUsage)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      const result = {
        overview: {
          totalRuns: stats.totalRuns,
          activeRuns: stats.activeRuns,
          avgDuration: `${stats.avgDurationMs}ms`,
          avgTokens: stats.avgTokens,
          totalToolCalls: stats.totalToolCalls,
        },
        taskTypeBreakdown: taskTypeStats,
        topToolsUsed: Object.fromEntries(topTools),
        recentActivity: recentRuns.slice(0, 5).map(r => ({
          time: new Date(r.startTime).toLocaleString('th-TH'),
          task: r.taskType,
          tokens: r.totalTokens,
          tools: r.toolCalls.length,
          success: !r.error,
        })),
      };

      return `📈 สถิติการทำงาน:\n${JSON.stringify(result, null, 2)}`;
    },
  };
}

import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import type { BotContext, ToolHandlerMap, NgrokApiResponse } from '../types.js';
import {
  runCommand, runCommandDeclaration,
  openApplication, openApplicationDeclaration,
  closeApplication, closeApplicationDeclaration,
  runPython, runPythonDeclaration,
  systemInfo, systemInfoDeclaration,
  screenshotDesktop, screenshotDesktopDeclaration,
  clipboardRead, clipboardReadDeclaration,
  clipboardWrite, clipboardWriteDeclaration,
} from './os.js';
import { listFiles, listFilesDeclaration, readFileContent, readFileContentDeclaration, writeFileContent, writeFileContentDeclaration, deleteFile, deleteFileDeclaration, replaceCodeBlock, replaceCodeBlockDeclaration } from './file.js';
import { browserNavigate, browserNavigateDeclaration, browserClick, browserClickDeclaration, browserType, browserTypeDeclaration, browserClose, browserCloseDeclaration } from './browser.js';
import { webSearch, webSearchDeclaration, readWebpage, readWebpageDeclaration, mouseClick, mouseClickDeclaration, keyboardType, keyboardTypeDeclaration } from './limitless.js';
import { systemToolDeclarations, getSystemToolHandlers, type SystemToolContext } from './system.js';
import { evolutionToolDeclarations, getEvolutionToolHandlers } from './evolution.js';
import { loadDynamicTools, getDynamicToolDeclarations, getDynamicToolHandlers, refreshDynamicTools } from './dynamicTools.js';
import { swarmToolDeclarations, getSwarmToolHandlers } from '../../swarm/swarmTools.js';
import { planningToolDeclarations, getPlanningToolHandlers } from './planning.js';
import { uiToolDeclarations, getUiToolHandlers } from './ui.js';
import { addCliAgent, addCliAgentDeclaration } from './cli_management.js';
import { createLogger } from '../../utils/logger.js';

export type { BotContext, SystemToolContext };

const logger = createLogger('Tools');

// Utility Tools
const getCurrentTimeDeclaration: FunctionDeclaration = {
  name: "get_current_time",
  description: "บอกเวลาปัจจุบันของระบบ เพื่อช่วยจัดตารางงานหรืออ้างอิงเวลา",
  parameters: { type: Type.OBJECT, properties: {} },
};

function getCurrentTime() {
  return new Date().toLocaleString('th-TH');
}

const echoMessageDeclaration: FunctionDeclaration = {
  name: "echo_message",
  description: "พิมพ์ข้อความออกทางหน้าจอ Console ของเครื่องที่รันบอทอยู่ (ใช้ debug หรือแจ้งเตือนฝั่ง server)",
  parameters: {
    type: Type.OBJECT,
    properties: {
      message: { type: Type.STRING, description: "ข้อความที่ต้องการพิมพ์" },
    },
    required: ["message"],
  },
};

function echoMessage({ message }: { message: string }) {
  logger.info(`🤖 [AI SAY]: ${message}`);
  return "พิมพ์ข้อความสำเร็จแล้ว";
}

// ==========================================
// Bot Specific Tools (File Transfer)
// ==========================================
export const sendFileToChatDeclaration: FunctionDeclaration = {
  name: "send_file_to_chat",
  description: "ส่งไฟล์จากคอมพิวเตอร์ไปยังแชทของผู้ใช้ (Telegram/LINE). ใช้เมื่อผู้ใช้ขอไฟล์หรือเอกสาร",
  parameters: {
    type: Type.OBJECT,
    properties: {
      file_path: {
        type: Type.STRING,
        description: "พาธของไฟล์ที่ต้องการส่ง (เช่น 'C:\\test.txt')",
      },
      caption: {
        type: Type.STRING,
        description: "คำอธิบายไฟล์ที่จะส่งไปพร้อมกัน (ถ้ามี)",
      }
    },
    required: ["file_path"],
  },
};

// Auto-detect ngrok public URL via local API, cache it
let cachedPublicUrl: string | null = null;
let lastUrlCheck = 0;
const URL_CHECK_INTERVAL = 30_000; // Re-check every 30s

async function getPublicBaseUrl(): Promise<string> {
  const now = Date.now();
  if (cachedPublicUrl && now - lastUrlCheck < URL_CHECK_INTERVAL) {
    return cachedPublicUrl;
  }

  // 1. Try ngrok local API
  try {
    const res = await fetch('http://localhost:4040/api/tunnels', {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json() as NgrokApiResponse;
      const httpsTunnel = data.tunnels?.find((t) => t.proto === 'https');
      const tunnel = httpsTunnel || data.tunnels?.[0];
      if (tunnel?.public_url) {
        cachedPublicUrl = tunnel.public_url as string;
        lastUrlCheck = now;
        logger.info(`Auto-detected ngrok URL: ${cachedPublicUrl}`);
        return cachedPublicUrl;
      }
    }
  } catch { /* ngrok not running, fallback */ }

  // 2. Fallback to env variable
  if (process.env.PUBLIC_URL) {
    cachedPublicUrl = process.env.PUBLIC_URL.replace(/\/$/, '');
    lastUrlCheck = now;
    return cachedPublicUrl;
  }

  // 3. Last resort: localhost
  return 'http://localhost:3000';
}

export const createSendFileHandler = (ctx: BotContext) => {
  return async ({ file_path, caption }: { file_path: string, caption?: string }) => {
    // LINE requires a public HTTP URL to receive files
    if (ctx.platform === 'line') {
      const baseUrl = await getPublicBaseUrl();
      const normalizedPath = file_path.replace(/\\/g, '/');
      const encodedPath = encodeURI(normalizedPath.startsWith('/') ? normalizedPath : '/' + normalizedPath);
      const proxyUrl = `${baseUrl}/media${encodedPath}`;
      console.log(`[Tools] LINE file transfer URL: ${proxyUrl}`);
      return await ctx.replyWithFile(proxyUrl, caption);
    }

    // Telegram and others generally accept local file paths
    return await ctx.replyWithFile(file_path, caption);
  };
};

// ==========================================
// Memory Management Tools
// ==========================================
import {
  searchArchival, saveArchivalFact
} from '../../memory/unifiedMemory.js';

export const memorySearchDeclaration: FunctionDeclaration = {
  name: "memory_search",
  description: "ค้นหาข้อมูลจากความทรงจำระยะยาว (Archival Memory) ของผู้ใช้ ใช้เมื่อต้องการดึงข้อมูลเก่าที่เคยคุยกัน เช่น ชื่อ งาน สิ่งที่ชอบ",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: "คำค้นหา เช่น 'ชื่อผู้ใช้', 'งานอดิเรก', 'อาหารที่ชอบ'" },
    },
    required: ["query"],
  },
};

export const memorySaveDeclaration: FunctionDeclaration = {
  name: "memory_save",
  description: "บันทึกข้อเท็จจริงใหม่เกี่ยวกับผู้ใช้ลงในความทรงจำระยะยาว ใช้เมื่อผู้ใช้บอกข้อมูลเกี่ยวกับตนเอง เช่น ชื่อ อาชีพ ความชอบ",
  parameters: {
    type: Type.OBJECT,
    properties: {
      fact: { type: Type.STRING, description: "ข้อเท็จจริงที่ต้องการบันทึก เช่น 'ผู้ใช้ชื่อ สมชาย ทำงานเป็นวิศวกร'" },
    },
    required: ["fact"],
  },
};

// Initialize function to load dynamic tools at startup
let dynamicToolsLoaded = false;

async function initializeToolsAsync() {
  if (!dynamicToolsLoaded) {
    await loadDynamicTools();
    dynamicToolsLoaded = true;
  }
}

// Call initialization (non-blocking)
initializeToolsAsync().catch(err => console.error('Failed to load dynamic tools:', err));

export const tools = [
  // Utility
  getCurrentTimeDeclaration,
  echoMessageDeclaration,
  // OS Control
  runCommandDeclaration,
  runPythonDeclaration,
  openApplicationDeclaration,
  closeApplicationDeclaration,
  systemInfoDeclaration,
  screenshotDesktopDeclaration,
  clipboardReadDeclaration,
  clipboardWriteDeclaration,
  // File Operations
  listFilesDeclaration,
  readFileContentDeclaration,
  writeFileContentDeclaration,
  deleteFileDeclaration,
  replaceCodeBlockDeclaration,
  sendFileToChatDeclaration,
  // Browser Tools
  browserNavigateDeclaration,
  browserClickDeclaration,
  browserTypeDeclaration,
  browserCloseDeclaration,
  // Web & Search Tools
  webSearchDeclaration,
  readWebpageDeclaration,
  mouseClickDeclaration,
  keyboardTypeDeclaration,
  // Memory Tools
  memorySearchDeclaration,
  memorySaveDeclaration,
  // System Self-Awareness Tools
  ...systemToolDeclarations,
  // Self-Evolution Tools
  ...evolutionToolDeclarations,
  // Swarm Coordination Tools
  ...swarmToolDeclarations,
  // Stateful Planning Tools
  ...planningToolDeclarations,
  // Generative UI Tools
  ...uiToolDeclarations,
  // CLI Management Tools
  addCliAgentDeclaration,
];

/**
 * Get all tools including dynamic ones
 */
export function getAllTools(): FunctionDeclaration[] {
  return [...tools, ...getDynamicToolDeclarations()];
}

export const getFunctionHandlers = (ctx: BotContext, sysCtx?: SystemToolContext, chatId?: string): ToolHandlerMap => {
  const effectiveChatId = chatId || 'system_fallback';

  const handlers: ToolHandlerMap = {
    // Utility
    get_current_time: getCurrentTime,
    echo_message: echoMessage,
    // OS Control
    run_command: (args) => runCommand(args as { command: string }, { chatId: effectiveChatId }),
    run_python: runPython,
    open_application: openApplication,
    close_application: closeApplication,
    system_info: systemInfo,
    screenshot_desktop: screenshotDesktop,
    clipboard_read: clipboardRead,
    clipboard_write: clipboardWrite,
    // File Operations
    list_files: listFiles,
    read_file_content: readFileContent,
    write_file_content: writeFileContent,
    delete_file: deleteFile,
    replace_code_block: replaceCodeBlock,
    send_file_to_chat: createSendFileHandler(ctx),
    // Browser
    browser_navigate: browserNavigate,
    browser_click: browserClick,
    browser_type: browserType,
    browser_close: browserClose,
    // Web & Search
    web_search: webSearch,
    read_webpage: readWebpage,
    mouse_click: mouseClick,
    keyboard_type: keyboardType,
    // Memory Management
    memory_search: async (args) => {
      const query = String(args.query ?? '');
      const facts = await searchArchival(effectiveChatId, query, 5, 0.55);
      if (facts.length === 0) return '🧠 ไม่พบข้อมูลที่เกี่ยวข้องในความทรงจำ';
      return `🧠 ข้อมูลที่พบ:\n${facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;
    },
    memory_save: async (args) => {
      const fact = String(args.fact ?? '');
      await saveArchivalFact(effectiveChatId, fact);
      return `✅ บันทึกลงความทรงจำแล้ว: "${fact}"`;
    },
  };

  // Register System Self-Awareness tools
  if (sysCtx) {
    Object.assign(handlers, getSystemToolHandlers(sysCtx));
  }
  Object.assign(handlers, getEvolutionToolHandlers());
  Object.assign(handlers, getSwarmToolHandlers(ctx));
  Object.assign(handlers, getPlanningToolHandlers(effectiveChatId));
  Object.assign(handlers, getUiToolHandlers(effectiveChatId));
  handlers.add_cli_agent = addCliAgent;
  Object.assign(handlers, getDynamicToolHandlers());

  return handlers;
};

export async function refreshDynamicToolsRegistry(): Promise<void> {
  await refreshDynamicTools();
}

/** @deprecated Legacy */
export function setCurrentChatId(_chatId: string) {}
/** @deprecated Legacy */
export function getCurrentChatId() { return ''; }

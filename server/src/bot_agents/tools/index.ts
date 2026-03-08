import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import type { BotContext, ToolHandler, ToolHandlerMap, NgrokApiResponse } from '../types.js';
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
import { listFiles, listFilesDeclaration, readFileContent, readFileContentDeclaration, writeFileContent, writeFileContentDeclaration, deleteFile, deleteFileDeclaration } from './file.js';
import { browserNavigate, browserNavigateDeclaration, browserClick, browserClickDeclaration, browserType, browserTypeDeclaration, browserClose, browserCloseDeclaration } from './browser.js';
import { webSearch, webSearchDeclaration, readWebpage, readWebpageDeclaration, mouseClick, mouseClickDeclaration, keyboardType, keyboardTypeDeclaration } from './limitless.js';
import { systemToolDeclarations, getSystemToolHandlers, type SystemToolContext } from './system.js';
import { evolutionToolDeclarations, getEvolutionToolHandlers } from './evolution.js';

export type { BotContext, SystemToolContext };

// Utility Tools
const getCurrentTimeDeclaration: FunctionDeclaration = {
  name: "get_current_time",
  description: "บอกเวลาปัจจุบันของระบบ เพื่อช่วยจัดตารางงาน",
  parameters: { type: Type.OBJECT, properties: {} },
};

function getCurrentTime() {
  return new Date().toLocaleString('th-TH');
}

const echoMessageDeclaration: FunctionDeclaration = {
  name: "echo_message",
  description: "พิมพ์ข้อความออกทางหน้าจอ Console ของเครื่องที่รันบอทอยู่",
  parameters: {
    type: Type.OBJECT,
    properties: {
      message: { type: Type.STRING, description: "ข้อความที่ต้องการพิมพ์" },
    },
    required: ["message"],
  },
};

function echoMessage({ message }: { message: string }) {
  console.log(`🤖 [AI SAY]: ${message}`);
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
        console.log(`[Tools] Auto-detected ngrok URL: ${cachedPublicUrl}`);
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
// Memory Management Tools (ให้ AI จัดการ memory ได้เอง)
// ==========================================
import {
  searchArchival, saveArchivalFact, searchRecall
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
  description: "บันทึกข้อเท็จจริงใหม่เกี่ยวกับผู้ใช้ลงในความทรงจำระยะยาว ใช้เมื่อผู้ใช้บอกข้อมูลเกี่ยวกับตัวเอง เช่น ชื่อ อาชีพ ความชอบ",
  parameters: {
    type: Type.OBJECT,
    properties: {
      fact: { type: Type.STRING, description: "ข้อเท็จจริงที่ต้องการบันทึก เช่น 'ผู้ใช้ชื่อ สมชาย ทำงานเป็นวิศวกร'" },
    },
    required: ["fact"],
  },
};

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
];

// Per-request chatId holder — set by the handler wrapper
let _currentChatId = '';

export const getFunctionHandlers = (ctx: BotContext, sysCtx?: SystemToolContext): ToolHandlerMap => {
  const handlers: ToolHandlerMap = {
    // Utility
    get_current_time: getCurrentTime,
    echo_message: echoMessage,
    // OS Control
    run_command: runCommand,
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
      const facts = await searchArchival(_currentChatId, query, 5, 0.5);
      if (facts.length === 0) return '🧠 ไม่พบข้อมูลที่เกี่ยวข้องในความทรงจำ';
      return `🧠 ข้อมูลที่พบ:\n${facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;
    },
    memory_save: async (args) => {
      const fact = String(args.fact ?? '');
      await saveArchivalFact(_currentChatId, fact);
      return `✅ บันทึกลงความทรงจำแล้ว: "${fact}"`;
    },
  };

  // Register System Self-Awareness tools (if context provided)
  if (sysCtx) {
    Object.assign(handlers, getSystemToolHandlers(sysCtx));
  }

  // Register Self-Evolution tools
  Object.assign(handlers, getEvolutionToolHandlers());

  return handlers;
};

/** Set the current chatId for memory tools — called by agent before tool execution */
export function setCurrentChatId(chatId: string) { _currentChatId = chatId; }

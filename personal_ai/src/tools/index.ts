import { Type, FunctionDeclaration } from '@google/genai';
import {
  runCommand, runCommandDeclaration,
  runPython, runPythonDeclaration,
  openApplication, openApplicationDeclaration,
  closeApplication, closeApplicationDeclaration
} from './os';
import {
  listFiles, listFilesDeclaration,
  readFileContent, readFileContentDeclaration,
  writeFileContent, writeFileContentDeclaration,
  deleteFile, deleteFileDeclaration
} from './file';
import {
  browserNavigate, browserNavigateDeclaration,
  browserGetState, browserGetStateDeclaration,
  browserScreenshot, browserScreenshotDeclaration,
  browserClick, browserClickDeclaration,
  browserType, browserTypeDeclaration,
  browserPressKey, browserPressKeyDeclaration,
  browserScroll, browserScrollDeclaration,
  browserClose, browserCloseDeclaration
} from './browser';

export interface BotContext {
  platform: 'telegram' | 'line';
  replyWithFile: (filePath: string, caption?: string) => Promise<string>;
}

// ==========================================
// Utility Tools
// ==========================================
const getCurrentTimeDeclaration: FunctionDeclaration = {
  name: 'get_current_time',
  description: 'บอกวันเวลาปัจจุบันของระบบ ใช้เพื่อจัดตารางงาน หรือเช็คเวลาและวันที่',
  parameters: { type: Type.OBJECT, properties: {} },
};
function getCurrentTime() {
  return new Date().toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'full',
    timeStyle: 'medium'
  } as any);
}

const echoMessageDeclaration: FunctionDeclaration = {
  name: 'echo_message',
  description: 'พิมพ์ข้อความออกทาง Console ของเครื่องที่รันบอท',
  parameters: {
    type: Type.OBJECT,
    properties: {
      message: { type: Type.STRING, description: 'ข้อความที่ต้องการพิมพ์' },
    },
    required: ['message'],
  },
};
function echoMessage({ message }: { message: string }) {
  console.log(`🤖 [AI SAY]: ${message}`);
  return '✅ พิมพ์ข้อความสำเร็จ';
}

// ==========================================
// Web Search Tool (DuckDuckGo Lite)
// ==========================================
export const webSearchDeclaration: FunctionDeclaration = {
  name: 'web_search',
  description: 'ค้นหาข้อมูลในอินเทอร์เน็ตผ่าน DuckDuckGo ใช้เมื่อต้องการข้อมูลปัจจุบัน ข่าวสาร ราคาสินค้า หรือข้อมูลที่อัปเดตบ่อย ไม่ต้องเปิดเบราว์เซอร์',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: 'คำค้นหา (ภาษาไทยหรืออังกฤษ)' },
    },
    required: ['query'],
  },
};

/** Strip HTML tags and decode common entities */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Try DuckDuckGo Lite HTML scraping */
async function searchDDGLite(query: string): Promise<string | null> {
  const response = await fetch('https://lite.duckduckgo.com/lite/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
    },
    body: `q=${encodeURIComponent(query)}&kl=th-th&df=`,
    signal: AbortSignal.timeout(12000),
  });

  if (!response.ok) return null;
  const html = await response.text();
  if (html.length < 200) return null;

  // Extract snippets — try multiple patterns to handle DDG HTML changes
  const snippetPatterns = [
    /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi,
    /<td[^>]*class=['"][^'"]*snippet[^'"]*['"][^>]*>([\s\S]*?)<\/td>/gi,
    /<a[^>]+class=['"]result-link['"][^>]*>[\s\S]*?<\/a>\s*<br[^>]*>\s*([\s\S]*?)(?=<br|<\/tr|<tr)/gi,
  ];

  const snippets: string[] = [];
  const links: string[] = [];

  for (const pat of snippetPatterns) {
    let m;
    const re = new RegExp(pat);
    while ((m = re.exec(html)) !== null) {
      const text = stripHtml(m[1]);
      if (text.length > 20) snippets.push(text);
      if (snippets.length >= 5) break;
    }
    if (snippets.length > 0) break;
  }

  // Extract result links
  const linkRe = /<a[^>]+class=['"]result-link['"][^>]+href=['"]([^'"]+)['"][^>]*>/gi;
  let lm;
  while ((lm = linkRe.exec(html)) !== null) {
    links.push(lm[1]);
    if (links.length >= 5) break;
  }
  // Fallback: extract any https links
  if (links.length === 0) {
    const allLinks = html.match(/https?:\/\/(?!duckduckgo)[^\s"'<>&]{10,}/g) || [];
    links.push(...allLinks.slice(0, 5));
  }

  if (snippets.length === 0) return null;

  let result = `🔍 ผลการค้นหา: "${query}"\n\n`;
  const limit = Math.min(4, snippets.length);
  for (let i = 0; i < limit; i++) {
    const url = links[i] ? `\n   🔗 ${links[i]}` : '';
    result += `${i + 1}. ${snippets[i]}${url}\n\n`;
  }
  return result;
}

/** Try DuckDuckGo Instant Answer API (JSON — more reliable, fewer results) */
async function searchDDGInstant(query: string): Promise<string | null> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&no_redirect=1`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return null;

  const data = await response.json() as any;

  let result = `🔍 ผลการค้นหา: "${query}"\n\n`;
  let hasContent = false;

  // Abstract (Wikipedia-style summary)
  if (data.AbstractText && data.AbstractText.length > 20) {
    result += `📖 ${data.AbstractText}\n`;
    if (data.AbstractURL) result += `   🔗 ${data.AbstractURL}\n`;
    result += '\n';
    hasContent = true;
  }

  // Answer (instant answer)
  if (data.Answer && data.Answer.length > 5) {
    result += `💡 ${data.Answer}\n\n`;
    hasContent = true;
  }

  // Related topics (top 3)
  const topics: any[] = data.RelatedTopics || [];
  let count = 0;
  for (const t of topics) {
    if (count >= 3) break;
    const text = t.Text || t.Result;
    const url = t.FirstURL;
    if (text && text.length > 10) {
      result += `${count + 1}. ${text}`;
      if (url) result += `\n   🔗 ${url}`;
      result += '\n\n';
      count++;
      hasContent = true;
    }
  }

  return hasContent ? result : null;
}

export async function webSearch({ query }: { query: string }): Promise<string> {
  try {
    // Try DDG Lite first (richer results)
    const liteResult = await searchDDGLite(query).catch(() => null);
    if (liteResult) return liteResult;

    // Fallback: DDG Instant Answer API
    const instantResult = await searchDDGInstant(query).catch(() => null);
    if (instantResult) return instantResult;

    return `🔍 ค้นหา "${query}"\n\nไม่พบผลลัพธ์ในขณะนี้ ลองปรับคำค้นหาหรือเปิดเบราว์เซอร์เพื่อค้นหาโดยตรง`;
  } catch (error: any) {
    return `❌ ค้นหาไม่สำเร็จ: ${error.message}`;
  }
}

// ==========================================
// File Transfer (Bot-specific)
// ==========================================
export const sendFileToChatDeclaration: FunctionDeclaration = {
  name: 'send_file_to_chat',
  description: 'ส่งไฟล์จากคอมพิวเตอร์ไปยังแชท Telegram/LINE ของผู้ใช้',
  parameters: {
    type: Type.OBJECT,
    properties: {
      file_path: { type: Type.STRING, description: "path ของไฟล์ (เช่น 'C:\\Downloads\\report.pdf')" },
      caption: { type: Type.STRING, description: 'คำอธิบายไฟล์ (ถ้ามี)' },
    },
    required: ['file_path'],
  },
};

export const createSendFileHandler = (ctx: BotContext) => {
  return async ({ file_path, caption }: { file_path: string; caption?: string }) => {
    return await ctx.replyWithFile(file_path, caption);
  };
};

// ==========================================
// All Tools Registry
// ==========================================
export const tools: FunctionDeclaration[] = [
  // Utility
  getCurrentTimeDeclaration,
  echoMessageDeclaration,
  // Search (ไม่ต้องเปิดเบราว์เซอร์)
  webSearchDeclaration,
  // OS Control
  runCommandDeclaration,
  runPythonDeclaration,
  openApplicationDeclaration,
  closeApplicationDeclaration,
  // File Management
  listFilesDeclaration,
  readFileContentDeclaration,
  writeFileContentDeclaration,
  deleteFileDeclaration,
  // File Transfer
  sendFileToChatDeclaration,
  // Browser Automation (ใช้เมื่อต้องการ interact กับเว็บจริง)
  browserNavigateDeclaration,
  browserGetStateDeclaration,
  browserScreenshotDeclaration,
  browserClickDeclaration,
  browserTypeDeclaration,
  browserPressKeyDeclaration,
  browserScrollDeclaration,
  browserCloseDeclaration,
];

export const getFunctionHandlers = (ctx: BotContext): Record<string, Function> => ({
  // Utility
  get_current_time: getCurrentTime,
  echo_message: echoMessage,
  // Search
  web_search: webSearch,
  // OS Control
  run_command: runCommand,
  run_python: runPython,
  open_application: openApplication,
  close_application: closeApplication,
  // File Management
  list_files: listFiles,
  read_file_content: readFileContent,
  write_file_content: writeFileContent,
  delete_file: deleteFile,
  // File Transfer
  send_file_to_chat: createSendFileHandler(ctx),
  // Browser Automation
  browser_navigate: browserNavigate,
  browser_get_state: browserGetState,
  browser_screenshot: browserScreenshot,
  browser_click: browserClick,
  browser_type: browserType,
  browser_press_key: browserPressKey,
  browser_scroll: browserScroll,
  browser_close: browserClose,
});

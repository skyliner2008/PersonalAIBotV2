import { Type } from '@google/genai';
import { runCommand, runCommandDeclaration, openApplication, openApplicationDeclaration, closeApplication, closeApplicationDeclaration } from './os';
import { listFiles, listFilesDeclaration, readFileContent, readFileContentDeclaration, writeFileContent, writeFileContentDeclaration, deleteFile, deleteFileDeclaration } from './file';
import { browserNavigate, browserNavigateDeclaration, browserClick, browserClickDeclaration, browserType, browserTypeDeclaration, browserClose, browserCloseDeclaration } from './browser.js';
import { webSearch, webSearchDeclaration, readWebpage, readWebpageDeclaration, mouseClick, mouseClickDeclaration, keyboardType, keyboardTypeDeclaration } from './limitless.js';
// Utility Tools
const getCurrentTimeDeclaration = {
    name: "get_current_time",
    description: "บอกเวลาปัจจุบันของระบบ เพื่อช่วยจัดตารางงาน",
    parameters: { type: Type.OBJECT, properties: {} },
};
function getCurrentTime() {
    return new Date().toLocaleString('th-TH');
}
const echoMessageDeclaration = {
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
function echoMessage({ message }) {
    console.log(`🤖 [AI SAY]: ${message}`);
    return "พิมพ์ข้อความสำเร็จแล้ว";
}
// ==========================================
// Bot Specific Tools (File Transfer)
// ==========================================
export const sendFileToChatDeclaration = {
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
let cachedPublicUrl = null;
let lastUrlCheck = 0;
const URL_CHECK_INTERVAL = 30_000; // Re-check every 30s
async function getPublicBaseUrl() {
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
            const data = await res.json();
            const httpsTunnel = data.tunnels?.find((t) => t.proto === 'https');
            const tunnel = httpsTunnel || data.tunnels?.[0];
            if (tunnel?.public_url) {
                cachedPublicUrl = tunnel.public_url;
                lastUrlCheck = now;
                console.log(`[Tools] Auto-detected ngrok URL: ${cachedPublicUrl}`);
                return cachedPublicUrl;
            }
        }
    }
    catch { /* ngrok not running, fallback */ }
    // 2. Fallback to env variable
    if (process.env.PUBLIC_URL) {
        cachedPublicUrl = process.env.PUBLIC_URL.replace(/\/$/, '');
        lastUrlCheck = now;
        return cachedPublicUrl;
    }
    // 3. Last resort: localhost
    return 'http://localhost:3000';
}
export const createSendFileHandler = (ctx) => {
    return async ({ file_path, caption }) => {
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
export const tools = [
    getCurrentTimeDeclaration,
    echoMessageDeclaration,
    runCommandDeclaration,
    openApplicationDeclaration,
    closeApplicationDeclaration,
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
    // Limitless Tools
    webSearchDeclaration,
    readWebpageDeclaration,
    mouseClickDeclaration,
    keyboardTypeDeclaration
];
export const getFunctionHandlers = (ctx) => {
    return {
        get_current_time: getCurrentTime,
        echo_message: echoMessage,
        run_command: runCommand,
        open_application: openApplication,
        close_application: closeApplication,
        list_files: listFiles,
        read_file_content: readFileContent,
        write_file_content: writeFileContent,
        delete_file: deleteFile,
        send_file_to_chat: createSendFileHandler(ctx),
        // Browser Handlers
        browser_navigate: browserNavigate,
        browser_click: browserClick,
        browser_type: browserType,
        browser_close: browserClose,
        // Limitless Handlers
        web_search: webSearch,
        read_webpage: readWebpage,
        mouse_click: mouseClick,
        keyboard_type: keyboardType
    };
};
//# sourceMappingURL=index.js.map
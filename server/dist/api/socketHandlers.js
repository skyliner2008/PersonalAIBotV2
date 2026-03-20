import { launchBrowser, closeBrowser, isRunning } from '../automation/browser.js';
import { login, isLoggedIn } from '../automation/facebook.js';
import { startChatMonitor, stopChatMonitor, isChatMonitorActive } from '../automation/chatBot.js';
import { startCommentMonitor, stopCommentMonitor, isCommentMonitorActive } from '../automation/commentBot.js';
import { startScheduler, stopScheduler } from '../scheduler/scheduler.js';
import { addLog } from '../database/db.js';
import { Type } from '@google/genai';
import { LiveVideoClient, resolveGeminiLiveModel } from './liveVoice.js';
import { resolveProviderApiKey } from '../config/settingsSecurity.js';
import { personaManager } from '../ai/personaManager.js';
import { getBot } from '../bot_agents/registries/botRegistry.js';
import { executeCommand } from '../terminal/terminalGateway.js';
import * as os from 'os';
import * as path from 'path';
import { getAvailableBackends } from '../terminal/commandRouter.js';
import { getRootAdminIdentity } from '../system/rootAdmin.js';
import { runMeetingRoom } from './meetingRoom.js';
import { notifyUserActivity } from '../evolution/selfUpgrade.js';
import { getVoiceToolBridgeOutputMaxChars, getVoiceToolBridgeTimeoutMs } from '../config/runtimeSettings.js';
import { addMessage } from '../memory/unifiedMemory.js';
import { createLogger } from '../utils/logger.js';
export async function handleBrowserStart(io, socket) {
    try {
        addLog('browser', 'Starting browser...', undefined, 'info');
        await launchBrowser();
        io.emit('browser:status', { running: true });
        addLog('browser', 'Browser started', undefined, 'success');
    }
    catch (e) {
        const msg = e?.message || String(e);
        console.error('[Browser] Launch error:', msg);
        addLog('browser', 'Browser launch failed', msg, 'error');
        socket.emit('error', { message: `Browser launch failed: ${msg}` });
        io.emit('browser:status', { running: false });
    }
}
export async function handleBrowserStop(io) {
    try {
        await closeBrowser();
    }
    catch (e) {
        addLog('browser', 'Browser close error', String(e), 'error');
    }
    io.emit('browser:status', { running: false });
    io.emit('chatbot:status', { active: false });
    io.emit('commentbot:status', { active: false });
}
export async function handleFbLogin(io, socket, data) {
    try {
        addLog('facebook', 'Login attempt...', undefined, 'info');
        if (!isRunning()) {
            addLog('facebook', 'Auto-launching browser for login', undefined, 'info');
            await launchBrowser();
            io.emit('browser:status', { running: true });
        }
        const success = await login(data.email, data.password);
        addLog('facebook', success ? 'Login successful' : 'Login failed', undefined, success ? 'success' : 'error');
        io.emit('fb:loginResult', { success, message: success ? 'Logged in!' : 'Login failed - check credentials or 2FA' });
    }
    catch (e) {
        const msg = e?.message || String(e);
        console.error('[FB] Login error:', msg);
        addLog('facebook', 'Login error', msg, 'error');
        io.emit('fb:loginResult', { success: false, message: `Error: ${msg}` });
    }
}
export async function handleFbCheckLogin(socket) {
    try {
        const loggedIn = isRunning() ? await isLoggedIn() : false;
        socket.emit('fb:loginStatus', { loggedIn });
    }
    catch {
        socket.emit('fb:loginStatus', { loggedIn: false });
    }
}
export async function handleChatbotStart(io, socket) {
    try {
        if (!isRunning()) {
            await launchBrowser();
            io.emit('browser:status', { running: true });
        }
        await startChatMonitor(io);
        io.emit('chatbot:status', { active: true });
    }
    catch (e) {
        addLog('chatbot', 'Start failed', String(e), 'error');
        socket.emit('error', { message: `Chat bot start failed: ${e}` });
    }
}
export function handleChatbotStop(io) {
    stopChatMonitor(io);
    io.emit('chatbot:status', { active: false });
}
export async function handleCommentbotStart(io, socket) {
    try {
        if (!isRunning()) {
            await launchBrowser();
            io.emit('browser:status', { running: true });
        }
        await startCommentMonitor(io);
        io.emit('commentbot:status', { active: true });
    }
    catch (e) {
        addLog('commentbot', 'Start failed', String(e), 'error');
        socket.emit('error', { message: `Comment bot start failed: ${e}` });
    }
}
export function handleCommentbotStop(io) {
    stopCommentMonitor(io);
    io.emit('commentbot:status', { active: false });
}
export function handleSchedulerStart(io) {
    try {
        startScheduler(io);
        io.emit('scheduler:status', { active: true });
    }
    catch (e) {
        addLog('scheduler', 'Start failed', String(e), 'error');
    }
}
export function handleSchedulerStop(io) {
    stopScheduler();
    io.emit('scheduler:status', { active: false });
}
// Cache active Live clients per socket
const liveClients = new Map();
const voiceAgentQueues = new Map();
const log = createLogger('SocketHandlers');
const LIVE_AGENT_TOOL_NAME = 'jarvis_agent_execute';
const LIVE_AGENT_TOOL_DECLARATIONS = [
    {
        name: LIVE_AGENT_TOOL_NAME,
        description: 'Delegate the user request to Jarvis Agent with full internal tools, then return the tool result for final voice reply.',
        parameters: {
            type: Type.OBJECT,
            properties: {
                command: {
                    type: Type.STRING,
                    description: 'User request in plain text (Thai preferred).',
                },
            },
            required: ['command'],
        },
    },
];
function queueVoiceAgentTask(socketId, task) {
    const previous = voiceAgentQueues.get(socketId) || Promise.resolve();
    const next = previous
        .catch(() => undefined)
        .then(async () => {
        // Check if this task is still the "latest" in the queue for this socket
        // If the queue was cleared/reset, we might want to skip stale tasks
        if (voiceAgentQueues.get(socketId) !== next && voiceAgentQueues.has(socketId)) {
            return;
        }
        return task();
    })
        .catch((err) => {
        log.error('[VoiceAgent] queued task failed', { socketId, error: String(err) });
    })
        .finally(() => {
        if (voiceAgentQueues.get(socketId) === next) {
            voiceAgentQueues.delete(socketId);
        }
    });
    voiceAgentQueues.set(socketId, next);
}
function clearVoiceAgentQueue(socketId) {
    voiceAgentQueues.delete(socketId);
    log.info('[VoiceAgent] Queue cleared for interruption', { socketId });
}
function extractLiveToolCommand(args) {
    if (args == null)
        return '';
    if (typeof args === 'string') {
        const raw = args.trim();
        if (!raw)
            return '';
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && 'command' in parsed) {
                return String(parsed.command ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000);
            }
        }
        catch { }
        return raw.replace(/\s+/g, ' ').trim().slice(0, 4000);
    }
    if (typeof args === 'object' && 'command' in args) {
        return String(args.command ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    }
    if (typeof args === 'object' && 'fields' in args) {
        const fields = args.fields;
        const commandField = fields && typeof fields === 'object' ? fields.command : undefined;
        return String(commandField?.stringValue ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    }
    return '';
}
function buildVoiceUserId(socketId) {
    const safe = String(socketId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
    return `voice_${safe || 'session'}`;
}
function autoEscapeWindowsPaths(text) {
    if (!text || !text.includes('\\'))
        return text;
    // Pattern matches Windows drive letters followed by backslash (e.g., C:\, D:\) 
    // and correctly follows through subsequent single backslashes in a path-like string.
    if (/([a-zA-Z]:\\)/i.test(text)) {
        // Find segments starting with Drive Letter or words followed by a single \
        return text.replace(/([a-zA-Z]:\\|[^\\]+\\)(?![\\/])/g, (match) => {
            return match.endsWith('\\') ? match + '\\' : match;
        });
    }
    return text;
}
function buildVoiceChatId(socketId) {
    // Return a session-specific ID to ensure a "clean slate" for every new voice call.
    // This prevents stale memory (like old file lists) from causing hallucinations.
    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const safeSocket = String(socketId || 'anon').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
    return `voice_${dateStr}_${timeStr}_${safeSocket}`;
}
function saveVoiceToMemory(chatId, role, content) {
    try {
        const text = String(content || '').trim();
        if (!text || text.length < 2)
            return;
        addMessage(chatId, role, text);
    }
    catch (err) {
        log.warn('[VoiceMemory] Failed to save message', { chatId, role, error: String(err) });
    }
}
function normalizeBridgeOutput(text) {
    const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!normalized)
        return 'No response from Jarvis Agent.';
    // 1. Strip "Agentic Thoughts" and redundant headers often used by Jarvis
    // These are blocks like **Thinking**, **Reviewing Results**, etc.
    const cleaned = normalized
        .split('\n')
        .filter(line => {
        const trimmed = line.trim();
        // Skip lines that are just headers like **Thinking** or **Task Complete**
        if (trimmed.startsWith('**') && trimmed.endsWith('**') && trimmed.length < 60)
            return false;
        if (trimmed.startsWith('###') && trimmed.length < 60)
            return false;
        return true;
    })
        .join('\n')
        .trim();
    const outputMaxChars = getVoiceToolBridgeOutputMaxChars();
    if (!cleaned)
        return 'Task processed successfully.';
    const sanitized = sanitizeForLiveApi(cleaned);
    if (sanitized.length <= outputMaxChars)
        return sanitized;
    let cutPoint = outputMaxChars;
    while (cutPoint > 0 && isHighSurrogate(sanitized.charCodeAt(cutPoint - 1)))
        cutPoint--;
    return `${sanitized.slice(0, cutPoint)}\n...[truncated]`;
}
function isHighSurrogate(code) {
    return code >= 0xD800 && code <= 0xDBFF;
}
function sanitizeForLiveApi(text) {
    return text
        // Remove thinking blocks
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '')
        .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        // Remove bold/italic markers but keep content
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        // Remove headers
        .replace(/^#{1,6}\s+/gm, '')
        // Clean list markers
        .replace(/^[\-*•]\s+/gm, '')
        // Remove code blocks entirely (too long/complex for voice)
        .replace(/```[\s\S]*?```/g, '[code block omitted]')
        .replace(/`([^`]+)`/g, '$1')
        // Remove URLs
        .replace(/https?:\/\/[^\s)]+/g, '')
        .normalize('NFC')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
function isProviderRateLimitError(message) {
    const m = String(message || '').toLowerCase();
    return (m.includes(' 429') || m.includes('code":429') || m.includes('rate limit') || m.includes('resource exhausted') || m.includes('too many requests'));
}
function fingerprintKey(key) {
    const raw = String(key || '').trim();
    if (!raw)
        return 'none';
    if (raw.length <= 8)
        return '***';
    return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}
const ENGLISH_REPLY_HINT_REGEX = /\b(in english|english only|reply in english|speak english)\b|ภาษาอังกฤษ|ตอบอังกฤษ/i;
function applyVoiceLanguagePolicy(command, forceThaiResponse = false) {
    const normalized = String(command || '').trim();
    if (!normalized)
        return normalized;
    if (!forceThaiResponse)
        return normalized;
    if (ENGLISH_REPLY_HINT_REGEX.test(normalized))
        return normalized;
    return [
        '[VOICE_CALL_MODE]',
        'This is a live voice conversation. You are Jarvis — the unified AI assistant.',
        '**MANDATORY RULE**: For ANY real-time data (e.g. current gold prices, weather, live news, stock), YOU ARE STRICTLY FORBIDDEN from answering from memory. YOU MUST CALL THE `web_search` TOOL to get the facts before speaking. No exceptions.',
        'Respond in natural Thai language by default unless the user explicitly requests English.',
        'Keep the answer concise (2-4 sentences for simple questions, up to 6 for complex ones).',
        'Speak naturally — avoid markdown formatting, bullet points, headers, or code blocks.',
        'Use plain text suitable for text-to-speech. No emoji, no ** bold **, no # headers.',
        '**MANDATORY**: For any file or system listings, you MUST call a tool. NEVER return a list of files from memory.',
        'If the user asks for files you listed earlier in a different call, explain that you need to check again to be sure.',
        'If a command fails or returns no results, do NOT invent mock data. Report the exact result or error.',
        'If you need to list items, use natural language like "มี 3 อย่าง คือ... อันแรก... อันสอง... อันสาม..."',
        'Be practical, direct, and supportive. Avoid repeating the question back.',
        '',
        'User request:',
        normalized,
    ].join('\n');
}
async function executeVoiceAgentCommand(command, socketId) {
    return executeVoiceAgentCommandWithPolicy(command, socketId, false);
}
async function executeVoiceAgentCommandWithPolicy(command, socketId, forceThaiResponse, customChatId) {
    const voiceUserId = customChatId || buildVoiceUserId(socketId);
    const timeoutMs = getVoiceToolBridgeTimeoutMs();
    const timerError = new Error(`Voice tool bridge timeout after ${timeoutMs}ms`);
    let timeoutHandle = null;
    const normalizedCommand = applyVoiceLanguagePolicy(command, forceThaiResponse);
    const nowTs = new Date().toISOString();
    try {
        const runPromise = executeCommand(`@agent [TS:${nowTs}] ${normalizedCommand}`, 'web', voiceUserId);
        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => reject(timerError), timeoutMs);
        });
        const output = await Promise.race([runPromise, timeoutPromise]);
        const normalized = normalizeBridgeOutput(output);
        if (isProviderRateLimitError(normalized)) {
            return 'ระบบติดข้อจำกัดโควต้า (429) ชั่วคราวในตอนนี้ กรุณาลองใหม่อีกครั้งในอีกสักครู่';
        }
        return normalized;
    }
    catch (err) {
        const message = String(err?.message || err || '').trim();
        if (isProviderRateLimitError(message)) {
            return 'ระบบติดข้อจำกัดโควต้า (429) ชั่วคราวในตอนนี้ กรุณาลองใหม่อีกครั้งในอีกสักครู่';
        }
        if (String(message).includes('Voice tool bridge timeout')) {
            return 'คำขอนี้ใช้เวลานานเกินกำหนดสำหรับโหมดเสียง กรุณาลองใหม่แบบสั้นลงหรือรอสักครู่';
        }
        return `Voice bridge error: ${message || 'unknown error'}`;
    }
    finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}
function buildJarvisLiveSystemInstruction() {
    try {
        const rootAdmin = getRootAdminIdentity();
        const preferredJarvisIds = rootAdmin.supervisorBotIds;
        const jarvisBot = preferredJarvisIds.map((id) => getBot(id)).find((bot) => Boolean(bot));
        const persona = personaManager.loadPersona('system');
        const base = String(persona?.systemInstruction || '').trim();
        const botIdentityBlock = [
            '[BOT_IDENTITY]',
            `Bot ID: ${jarvisBot?.id || rootAdmin.botId}`,
            `Bot Name: ${jarvisBot?.name || rootAdmin.botName}`,
            `Platform: ${jarvisBot?.platform || 'system'}`,
            `Enabled Tools: ${jarvisBot?.enabled_tools?.length ?? 0}`,
        ].join('\n');
        const homeDir = os.homedir();
        const systemPathsBlock = [
            '[WINDOWS_SYSTEM_PATHS]',
            'You are running on a Windows system. Here are the common user paths for this machine:',
            `- Home: ${homeDir}`,
            `- Desktop: ${path.join(homeDir, 'Desktop')}`,
            `- Documents: ${path.join(homeDir, 'Documents')}`,
            `- Downloads: ${path.join(homeDir, 'Downloads')}`,
            `- AppData: ${process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming')}`,
            `- Project Root: ${process.cwd()}`,
            'Use these paths directly when the user mentions "Desktop", "Documents", or "my files".',
        ].join('\n');
        const strictLanguagePolicy = [
            '[STRICT_LANGUAGE_POLICY]',
            'Default output language: Thai (th-TH).',
            'If user speaks Thai, always answer in natural Thai.',
            'Avoid robotic tone. Speak naturally and concise.',
            '**[CHANNEL_AWARENESS]**: You are in a "Live Call & Chat" environment. If the user speaks via voice, respond with natural spoken Thai. If the user sends a TEXT message (tagged with `[USER_TEXT_INPUT]`), you should respond with content optimized for reading (can be slightly longer, use bullet points, or provide links), but still keep the voice and identity consistent.',
        ].join('\n');
        const liveToolPolicy = [
            '[LIVE_TOOL_POLICY]',
            `Available function tool: ${LIVE_AGENT_TOOL_NAME}(command).`,
            '**THE GATEWAY TOOL**: This is your ONLY tool, but it is an "Omnipotent Gateway". It sends your commands to the Jarvis Core which has 40+ specialized tools (file system, web search, OS control, etc.).',
            'When you need to do ANYTHING (check files, search web, list system info) → ALWAYS call `jarvis_agent_execute` with your intent in English or Thai.',
            'If the user asks "What tools do you have?", call `jarvis_agent_execute("List all available tools and capabilities")` to get the full list from the core.',
            '**[WINDOWS_ENVIRONMENT]**: The system is running on Windows. You MUST use Windows commands (e.g., `dir`, `ipconfig`, `type`). DO NOT use Linux commands like `ls`, `rm`, `cat`, or `grep`. For listing files, it is STRONGLY RECOMMENDED to use the `list_files` tool instead of `run_command` as it is safer and more reliable.',
            '**STRICT GROUNDING**: You are FORBIDDEN from mentioning specific file names, directory contents, or system status unless you have FIRST received that information from a tool output in the current voice session.',
            '**MANDATORY RE-VERIFICATION**: Files and system states change rapidly. You MUST NOT reuse file lists or system status from previous turns or memory if they are not from the current conversation flow. When asked for files, ALWAYS call the tool again to be certain.',
            'If you have not called a tool to check the Desktop in this session, you MUST say "I need to check the Desktop" and then call the tool, rather than listing imaginary files.',
            'After receiving tool response, summarize the result for user in Thai naturally and concisely.',
            'Never claim tool execution before receiving tool output.',
            'If tool returns timeout error, tell user briefly and suggest trying again.',
        ].join('\n');
        const projectIdentity = [
            `You are ${rootAdmin.botName} for the PersonalAIBotV2 project.`,
            'Always keep this identity while speaking in live call mode.',
            'Speak concisely, calm, practical, and supportive.',
            'If user speaks Thai, you MUST reply in Thai.',
            'Use Thai by default unless user explicitly asks another language.',
            'Do not claim capabilities outside this project context.',
            'If a capability is unavailable in live voice mode, explain limits clearly and suggest the correct channel.',
        ].join('\n');
        return base
            ? `${strictLanguagePolicy}\n\n${liveToolPolicy}\n\n${systemPathsBlock}\n\n${base}\n\n${botIdentityBlock}\n\n[LIVE_CALL_IDENTITY]\n${projectIdentity}`
            : `${strictLanguagePolicy}\n\n${liveToolPolicy}\n\n${systemPathsBlock}\n\n${botIdentityBlock}\n\n${projectIdentity}`;
    }
    catch {
        const rootAdmin = getRootAdminIdentity();
        return [
            `You are ${rootAdmin.botName} for the PersonalAIBotV2 project.`,
            'Speak Thai by default, concise and practical.',
            'Never use English unless user explicitly requests it.',
            `Use ${LIVE_AGENT_TOOL_NAME}(command) when tool execution is required.`,
            'Keep answers grounded in project context.',
        ].join('\n');
    }
}
function setupSocketEventHandlers(io, socket) {
    // Send initial status
    socket.emit('status', {
        browser: isRunning(),
        chatBot: isChatMonitorActive(),
        commentBot: isCommentMonitorActive(),
    });
    socket.on('browser:start', () => handleBrowserStart(io, socket));
    socket.on('browser:stop', () => handleBrowserStop(io));
    socket.on('fb:login', (data) => handleFbLogin(io, socket, data));
    socket.on('fb:checkLogin', () => handleFbCheckLogin(socket));
    socket.on('chatbot:start', () => handleChatbotStart(io, socket));
    socket.on('chatbot:stop', () => handleChatbotStop(io));
    socket.on('commentbot:start', () => handleCommentbotStart(io, socket));
    socket.on('commentbot:stop', () => handleCommentbotStop(io));
    socket.on('scheduler:start', () => handleSchedulerStart(io));
    socket.on('scheduler:stop', () => handleSchedulerStop(io));
    // ========== Gemini Live Voice ============
    socket.on('voice:start', async (payload, ack) => {
        try {
            const requestedModeRaw = String(payload?.mode || 'live-direct').trim().toLowerCase();
            const requestedMode = requestedModeRaw === 'agent-tools' ? 'agent-tools' : 'live-direct';
            const requestedTransportRaw = String(payload?.transport || '').trim().toLowerCase();
            const requestedTransport = requestedTransportRaw === 'stt' ? 'stt' : 'live';
            const useAgentToolsMode = requestedMode === 'agent-tools';
            const useAgentToolsSttMode = useAgentToolsMode && requestedTransport === 'stt';
            log.info('[LiveVoice] Start requested', { socketId: socket.id, mode: requestedMode, transport: requestedTransport });
            try {
                ack?.({ ok: true, stage: 'received' });
            }
            catch { /* ignore ack errors */ }
            const existing = liveClients.get(socket.id);
            if (existing) {
                existing.client.disconnect();
                liveClients.delete(socket.id);
            }
            // ─── STT-only fallback (if explicitly requested) ───
            if (useAgentToolsSttMode) {
                socket.emit('voice:model', { model: 'jarvis-agent', apiVersion: 'internal', mode: requestedMode, transport: 'stt' });
                socket.emit('voice:connected');
                socket.emit('voice:ready', { mode: requestedMode, transport: 'stt' });
                try {
                    ack?.({ ok: true, stage: 'ready' });
                }
                catch { /* ignore ack errors */ }
                return;
            }
            // ─── Gemini Live Mode (default): real-time voice + tool bridge to Agent ───
            const keyResolution = resolveProviderApiKey('gemini');
            const apiKey = keyResolution.key || process.env.GEMINI_API_KEY;
            if (!apiKey) {
                socket.emit('voice:error', { message: 'Gemini API key is not configured' });
                return;
            }
            const liveModel = await resolveGeminiLiveModel(apiKey);
            const liveApiVersion = process.env.GEMINI_LIVE_API_VERSION || 'v1beta';
            // Create a unique Chat ID for THIS specific voice session
            const sessionChatId = buildVoiceChatId(socket.id);
            log.info('[LiveVoice] Starting isolated session', { sessionChatId });
            const liveSystemInstruction = buildJarvisLiveSystemInstruction();
            const client = new LiveVideoClient(apiKey, liveModel, liveApiVersion, liveSystemInstruction, LIVE_AGENT_TOOL_DECLARATIONS);
            socket.emit('voice:model', { model: liveModel, apiVersion: liveApiVersion, mode: requestedMode, transport: 'live' });
            client.on('connected', () => {
                socket.emit('voice:connected');
            });
            client.on('setupComplete', () => {
                socket.emit('voice:ready', { mode: requestedMode, transport: 'live' });
            });
            client.on('audioPart', (base64Data) => {
                socket.emit('voice:audio_recv', { data: base64Data });
            });
            client.on('textPart', (text) => {
                socket.emit('voice:text_recv', { text, source: 'live' });
            });
            client.on('toolCall', (functionCalls) => {
                // Clear search/process queue if a new tool call arrives to ensure 
                // the voice model receives tool results with minimum latency.
                clearVoiceAgentQueue(socket.id);
                queueVoiceAgentTask(socket.id, async () => {
                    socket.emit('voice:agent_status', { status: 'processing' });
                    const functionResponses = [];
                    try {
                        for (const call of functionCalls || []) {
                            const callName = String(call?.name || '').trim();
                            const callId = typeof call?.id === 'string' ? call.id : undefined;
                            if (callName !== LIVE_AGENT_TOOL_NAME) {
                                functionResponses.push({ id: callId, name: callName || LIVE_AGENT_TOOL_NAME, response: { error: `Unsupported live tool: ${callName || '(empty)'}` } });
                                continue;
                            }
                            const command = extractLiveToolCommand(call?.args);
                            if (!command) {
                                functionResponses.push({ id: callId, name: LIVE_AGENT_TOOL_NAME, response: { error: 'Missing required argument: command' } });
                                continue;
                            }
                            addLog('voice', 'Jarvis live tool call', command.slice(0, 200), 'info');
                            saveVoiceToMemory(sessionChatId, 'user', command);
                            const result = await executeVoiceAgentCommandWithPolicy(command, socket.id, true, sessionChatId);
                            const output = normalizeBridgeOutput(result);
                            socket.emit('voice:agent_reply', { input: command, reply: output, source: 'tool-bridge' });
                            saveVoiceToMemory(sessionChatId, 'assistant', output);
                            functionResponses.push({ id: callId, name: LIVE_AGENT_TOOL_NAME, response: { output } });
                        }
                    }
                    catch (err) {
                        const message = err?.message || String(err);
                        socket.emit('voice:agent_reply', { reply: `Voice tool error: ${message}` });
                        if (functionResponses.length === 0) {
                            functionResponses.push({ name: LIVE_AGENT_TOOL_NAME, response: { error: `Tool bridge error: ${message}` } });
                        }
                    }
                    finally {
                        client.sendToolResponses(functionResponses);
                        socket.emit('voice:agent_status', { status: 'idle' });
                    }
                });
            });
            client.on('error', (err) => {
                socket.emit('voice:error', { message: String(err) });
            });
            client.on('quotaError', (reason) => {
                socket.emit('voice:error', {
                    message: 'Gemini API quota exceeded — กรุณาตรวจสอบ plan และ billing ของ Gemini API หรือรอจนกว่าโควต้าจะรีเซ็ต',
                    quotaExceeded: true,
                });
                liveClients.delete(socket.id);
            });
            client.on('reconnecting', (info) => {
                socket.emit('voice:reconnecting', info);
            });
            client.on('disconnected', () => {
                socket.emit('voice:disconnected');
                liveClients.delete(socket.id);
            });
            client.on('sessionEnded', () => {
                socket.emit('voice:session_ended');
            });
            client.connect();
            liveClients.set(socket.id, { client, sessionChatId });
        }
        catch (err) {
            try {
                ack?.({ ok: false, error: String(err?.message || err || 'voice:start failed') });
            }
            catch { /* ignore */ }
            socket.emit('voice:error', { message: err.message });
        }
    });
    socket.on('voice:text_input', (data) => {
        notifyUserActivity();
        const rawText = String(data?.text || '').trim();
        const textWithEscapedPaths = autoEscapeWindowsPaths(rawText);
        const text = textWithEscapedPaths.replace(/\\s+/g, ' ').trim().slice(0, 4000);
        if (!text)
            return;
        const sessionInfo = liveClients.get(socket.id);
        const sessionChatId = sessionInfo?.sessionChatId || buildVoiceChatId(socket.id);
        saveVoiceToMemory(sessionChatId, 'user', text);
        const mentionPattern = /@([a-zA-Z0-9_-]+)/g;
        const mentions = [];
        let match;
        while ((match = mentionPattern.exec(text)) !== null) {
            mentions.push(match[1].toLowerCase());
        }
        const cleanMessage = text.replace(/@[a-zA-Z0-9_-]+\\s*/g, '').trim();
        const backends = getAvailableBackends();
        const cliBackends = backends.filter(b => b.kind === 'cli' && b.available);
        const validCliIds = cliBackends.map(b => b.id.replace(/-cli$/, ''));
        const activeMentions = mentions.filter(m => validCliIds.includes(m) || ['jarvis', 'agent', 'admin', 'all'].includes(m));
        if (activeMentions.length === 0 && mentions.length > 0) {
            socket.emit('voice:text_recv', { text: `⚠️ ไม่พบ CLI: @${mentions.join(', @')} (หรือ CLI ยังไม่พร้อมใช้)`, source: 'agent' });
            return;
        }
        const isMultiDispatch = activeMentions.length > 0 && activeMentions.some(m => !['jarvis', 'agent', 'admin', 'all'].includes(m));
        const hasAllMention = activeMentions.includes('all');
        if (hasAllMention) {
            queueVoiceAgentTask(socket.id, async () => {
                socket.emit('voice:agent_status', { status: 'processing' });
                try {
                    const message = cleanMessage || text;
                    addLog('voice', 'Meeting Room', `@all ${message.slice(0, 150)}`, 'info');
                    const summary = await runMeetingRoom({
                        socket: socket,
                        message,
                        availableCLIs: validCliIds,
                        userId: buildVoiceUserId(socket.id),
                        maxReviewRounds: 1,
                    });
                    socket.emit('voice:agent_reply', { input: text, reply: summary });
                    socket.emit('voice:text_recv', { text: `👑 **Meeting Room สรุป:**\n\n${summary}`, source: 'agent' });
                    saveVoiceToMemory(socket.id, 'assistant', summary);
                }
                catch (err) {
                    socket.emit('voice:agent_reply', { input: text, reply: `Meeting Room error: ${err?.message || String(err)}` });
                }
                finally {
                    socket.emit('voice:agent_status', { status: 'idle' });
                }
            });
        }
        else if (isMultiDispatch) {
            queueVoiceAgentTask(socket.id, async () => {
                socket.emit('voice:agent_status', { status: 'processing' });
                try {
                    const message = cleanMessage || text;
                    const targets = [...new Set(mentions)];
                    addLog('voice', 'Multi-CLI dispatch', `[${targets.join(',')}] ${message.slice(0, 150)}`, 'info');
                    const dispatchPromises = targets.map(async (target) => {
                        const prefix = target === 'jarvis' || target === 'agent' || target === 'admin'
                            ? `@agent ${message}`
                            : `@${target} ${message}`;
                        try {
                            const result = await executeCommand(prefix, 'web', buildVoiceUserId(socket.id));
                            return { target, output: String(result || '').trim(), status: 'success' };
                        }
                        catch (err) {
                            return { target, output: String(err?.message || err || 'error'), status: 'error' };
                        }
                    });
                    const results = await Promise.allSettled(dispatchPromises);
                    const parts = [];
                    const iconMap = { jarvis: '👑', gemini: '🔷', claude: '🟡', codex: '🟢', kilo: '⚪', openai: '🔵', opencode: '📜' };
                    for (const r of results) {
                        if (r.status === 'fulfilled') {
                            const { target, output, status: resultStatus } = r.value;
                            const icon = iconMap[target] || '⬜';
                            if (resultStatus === 'success' && output) {
                                parts.push(`${icon} @${target.toUpperCase()}:\n${output}`);
                                socket.emit('voice:cli_reply', { agent: target, reply: output, status: 'success' });
                            }
                            else {
                                parts.push(`${icon} @${target.toUpperCase()}: ❌ ${output || 'No response'}`);
                                socket.emit('voice:cli_reply', { agent: target, reply: output || 'No response', status: 'error' });
                            }
                        }
                    }
                    const fullReply = parts.join('\n\n---\n\n') || 'ไม่มี CLI ตอบกลับ';
                    socket.emit('voice:agent_reply', { input: text, reply: fullReply });
                    socket.emit('voice:text_recv', { text: fullReply, source: 'agent' });
                    saveVoiceToMemory(socket.id, 'assistant', fullReply);
                }
                catch (err) {
                    socket.emit('voice:agent_reply', { input: text, reply: `Multi-CLI error: ${err?.message || String(err)}` });
                }
                finally {
                    socket.emit('voice:agent_status', { status: 'idle' });
                }
            });
        }
        else if (mentions.length === 1 && mentions[0] !== 'jarvis' && mentions[0] !== 'agent') {
            const target = mentions[0];
            const message = cleanMessage || text;
            queueVoiceAgentTask(socket.id, async () => {
                socket.emit('voice:agent_status', { status: 'processing' });
                try {
                    addLog('voice', `CLI dispatch: @${target}`, message.slice(0, 200), 'info');
                    const result = await executeCommand(`@${target} ${message}`, 'web', buildVoiceUserId(socket.id));
                    const reply = String(result || '').trim() || `@${target} ไม่มีการตอบกลับ`;
                    socket.emit('voice:cli_reply', { agent: target, reply, status: 'success' });
                    socket.emit('voice:agent_reply', { input: text, reply });
                    socket.emit('voice:text_recv', { text: reply, source: 'agent' });
                    saveVoiceToMemory(socket.id, 'assistant', reply);
                }
                catch (err) {
                    socket.emit('voice:agent_reply', { input: text, reply: `@${target} error: ${err?.message || String(err)}` });
                }
                finally {
                    socket.emit('voice:agent_status', { status: 'idle' });
                }
            });
        }
        else {
            // For direct voice/text agent integration, we clear the queue to ensure
            // the new request is processed as soon as possible (interruption-like behavior)
            clearVoiceAgentQueue(socket.id);
            queueVoiceAgentTask(socket.id, async () => {
                socket.emit('voice:agent_status', { status: 'processing' });
                try {
                    addLog('voice', 'Jarvis voice input', text.slice(0, 200), 'info');
                    const nowTs = new Date().toISOString();
                    const result = await executeVoiceAgentCommandWithPolicy(`[TS:${nowTs}] [USER_TEXT_INPUT] ${text}`, socket.id, true, sessionChatId);
                    const reply = String(result || '').trim() || 'No response from Jarvis.';
                    socket.emit('voice:agent_reply', { input: text, reply });
                    socket.emit('voice:text_recv', { text: reply, source: 'agent' });
                    saveVoiceToMemory(sessionChatId, 'assistant', reply);
                }
                catch (err) {
                    socket.emit('voice:agent_reply', { input: text, reply: `Voice agent error: ${err?.message || String(err)}` });
                }
                finally {
                    socket.emit('voice:agent_status', { status: 'idle' });
                }
            });
        }
    });
    socket.on('voice:audio_send', (data) => {
        const clientInfo = liveClients.get(socket.id);
        if (clientInfo && clientInfo.client.isConnected) {
            clientInfo.client.sendAudioChunk(data.audio);
        }
    });
    socket.on('voice:ping', () => {
        socket.emit('voice:pong', { ts: Date.now() });
    });
    socket.on('voice:stop', (payload) => {
        voiceAgentQueues.delete(socket.id);
        socket.emit('voice:agent_status', { status: 'idle' });
        const clientInfo = liveClients.get(socket.id);
        if (clientInfo) {
            clientInfo.client.signalAudioStreamEnd();
            clientInfo.client.disconnect();
            liveClients.delete(socket.id);
        }
    });
    socket.on('disconnect', () => {
    });
}
export function attachSocketAuth(io) {
    const expectedToken = process.env.SOCKET_AUTH_TOKEN;
    io.use((socket, next) => {
        if (!expectedToken)
            return next();
        const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
        if (token === expectedToken)
            return next();
        log.warn(`[Socket] Auth failed for ${socket.id}`);
        return next(new Error('Authentication required'));
    });
}
export function setupSocketHandlers(io) {
    io.on('connection', (socket) => {
        setupSocketEventHandlers(io, socket);
    });
}
//# sourceMappingURL=socketHandlers.js.map
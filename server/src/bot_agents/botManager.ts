import { Telegraf } from 'telegraf';
import { middleware as lineMiddleware, Client as LineClient, WebhookEvent } from '@line/bot-sdk';
import express from 'express';
import * as dotenv from 'dotenv';
import { Agent } from './agent.js';
import { clearMemory } from '../memory/unifiedMemory.js';
import { configManager } from './config/configManager.js';
import { getDb, upsertConversation } from '../database/db.js';
import { listBots, getBot, updateBot, createBot, type BotInstance } from './registries/botRegistry.js';
import axios from 'axios';
import { Part } from '@google/genai';
import { isAdminCommand, handleAdminCommand, isBossModeActive } from '../terminal/messagingBridge.js';
import { approvalSystem } from '../utils/approvalSystem.js';
import { getProviderApiKey } from '../config/settingsSecurity.js';
import { getAgentCompatibleProviders } from '../providers/agentRuntime.js';
import { verifyCliConnections } from '../terminal/commandRouter.js';
import { createLogger } from '../utils/logger.js';

dotenv.config();

const TELEGRAM_MESSAGE_MAX_LENGTH = 4096;
const TELEGRAM_TYPING_PULSE_MS = 4500;
const TELEGRAM_HANDLER_TIMEOUT_MS = 240_000;
const STARTUP_COMPACT = process.env.STARTUP_COMPACT === '1';
const logger = createLogger('BotManager');

function botInfo(message: string): void {
    if (!STARTUP_COMPACT) {
        logger.info(message);
    }
}

function hasConfiguredLlmApiKey(): boolean {
    try {
        return getAgentCompatibleProviders({ enabledOnly: true }).some((provider) => Boolean(getProviderApiKey(provider.id)));
    } catch {
        return Boolean(
            process.env.GEMINI_API_KEY?.trim() ||
            process.env.OPENAI_API_KEY?.trim() ||
            process.env.MINIMAX_API_KEY?.trim()
        );
    }
}

// Shared AI Agent (singleton)
let aiAgent: Agent | null = null;

function getAiAgent(): Agent | null {
    if (aiAgent) {
        return aiAgent;
    }

    if (!hasConfiguredLlmApiKey()) {
        return null;
    }

    try {
        aiAgent = new Agent(process.env.GEMINI_API_KEY || '');
        return aiAgent;
    } catch (err) {
        console.error('[BotManager] Failed to initialize shared AI Agent:', err);
        return null;
    }
}

// Active bot instances
// Maps bot registry ID to the running instance handle
const activeBots = new Map<string, { type: string; instance: any; stop: () => void }>();

// Maps LINE bot ID -> its currently active Express router
const lineRouters = new Map<string, express.Router>();

// Store Express app reference for dynamic bot start/stop from dashboard
let _expressApp: express.Express | null = null;

// Helpers

async function getGeminiPartFromTelegram(ctx: any, fileId: string, mimeType: string): Promise<Part> {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await axios.get(fileLink.toString(), { responseType: 'arraybuffer' });
    const data = Buffer.from(response.data).toString('base64');
    return { inlineData: { data, mimeType } };
}

async function sendTelegramText(bot: Telegraf<any>, chatId: number | string, text: string): Promise<void> {
    const message = String(text || '').trim() || '(no output)';
    for (let i = 0; i < message.length; i += TELEGRAM_MESSAGE_MAX_LENGTH) {
        const chunk = message.substring(i, i + TELEGRAM_MESSAGE_MAX_LENGTH);
        await bot.telegram.sendMessage(chatId, chunk);
    }
}

function runTelegramAdminCommandAsync(
    bot: Telegraf<any>,
    botId: string,
    chatId: number,
    userMessage: string,
    userId: string
): void {
    const typingPulse = setInterval(() => {
        void bot.telegram.sendChatAction(chatId, 'typing').catch(() => undefined);
    }, TELEGRAM_TYPING_PULSE_MS);

    void bot.telegram.sendChatAction(chatId, 'typing').catch(() => undefined);

    void (async () => {
        try {
            const result = await handleAdminCommand(userMessage, 'telegram', userId);
            await sendTelegramText(bot, chatId, result);
        } catch (err: any) {
            console.error(`[Telegram:${botId}] Admin command error:`, err);
            await sendTelegramText(bot, chatId, `[Error] ${err?.message || 'Admin command failed'}`);
        } finally {
            clearInterval(typingPulse);
        }
    })();
}

// Telegram bot helpers

async function handleTelegramMultimodal(ctx: any, agent: Agent, botConfig: BotInstance) {
    const chatId = `telegram_${ctx.chat.id.toString()}`;
    let fileId = '';
    let mimeType = '';

    if ('document' in ctx.message) {
        fileId = ctx.message.document.file_id;
        mimeType = ctx.message.document.mime_type || 'application/octet-stream';
    } else if ('photo' in ctx.message) {
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        fileId = photo.file_id;
        mimeType = 'image/jpeg';
    }

    if (fileId) {
        await ctx.reply('Analyzing file/image with multimodal pipeline...');
        try {
            const attachmentPart = await getGeminiPartFromTelegram(ctx, fileId, mimeType);
            const caption = ('caption' in ctx.message ? ctx.message.caption : null) || 'Please analyze this file/image.';
            upsertConversation(chatId, ctx.chat.id.toString(), 'Telegram User');
            const agentResponse = await agent.processMessage(
                chatId,
                caption,
                {
                    botId: botConfig.id,
                    botName: botConfig.name,
                    platform: 'telegram',
                    replyWithFile: async (fp: string, cap?: string) => {
                        await ctx.replyWithDocument({ source: fp }, { caption: cap });
                        return 'File sent successfully';
                    },
                },
                [attachmentPart],
            );
            await ctx.reply(agentResponse);
        } catch (err) {
            console.error(`[Telegram:${botConfig.id}] Multimodal Error:`, err);
            await ctx.reply('Failed to analyze the attached file/image.');
        }
    }
}

async function handleTelegramText(ctx: any, bot: Telegraf<any>, agent: Agent, botConfig: BotInstance) {
    const userMessage = ctx.message.text;
    const chatId = `telegram_${ctx.chat.id.toString()}`;
    // Allow admin commands and empty messages (in boss mode) to pass
    if (userMessage.startsWith('/') && !userMessage.startsWith('/admin')) return;

    const userId = ctx.from?.id?.toString() || '';

    // Intercept admin commands AND active Boss Mode sessions from text
    if (isAdminCommand(userMessage) || isBossModeActive('telegram', userId)) {
        runTelegramAdminCommandAsync(bot, botConfig.id, ctx.chat.id, userMessage, userId);
        return;
    }

    console.log(`[Telegram:${botConfig.id}] ${chatId}: ${userMessage}`);
    await ctx.sendChatAction('typing');

    try {
        upsertConversation(chatId, ctx.chat.id.toString(), "Telegram User");
        const responseText = await agent.processMessage(chatId, userMessage, {
            botId: botConfig.id,
            botName: botConfig.name,
            platform: 'telegram',
            replyWithFile: async (filePath: string, caption?: string) => {
                await ctx.replyWithDocument({ source: filePath }, { caption });
                return `Sent file ${filePath} successfully`;
            }
        });
        await sendTelegramText(bot, ctx.chat.id, responseText);
    } catch (err: any) {
        console.error(`[Telegram:${botConfig.id}] Reply Error:`, err);
        await sendTelegramText(bot, ctx.chat.id, 'An error occurred while sending a reply.');
    }
}

function setupTelegramBotHandlers(bot: Telegraf<any>, agent: Agent, botConfig: BotInstance) {
    bot.catch(async (err, ctx) => {
        const errorText = String((err as any)?.message || err || '');
        console.error(`[Telegram:${botConfig.id}] Update handler error:`, err);
        if (/Promise timed out/i.test(errorText)) {
            try {
                await ctx.reply('Command is taking too long. Please try again.');
            } catch {
                // ignore reply failure
            }
        }
    });

    bot.start((ctx) => {
        ctx.reply(`Hello! I am ${botConfig.name} - Personal AI Assistant`);
    });

    bot.command('clear', (ctx) => {
        const chatId = ctx.chat.id.toString();
        clearMemory(`telegram_${chatId}`);
        ctx.reply('Memory cleared successfully.');
    });

    bot.on(['document', 'photo'], (ctx) => handleTelegramMultimodal(ctx, agent, botConfig));

    // Handle Approval System Inline Callbacks
    bot.action(/^(approve|reject)_(.+)$/, async (ctx) => {
        const action = ctx.match[1];
        const approvalId = ctx.match[2];
        const isApproved = action === 'approve';
        
        const resolved = approvalSystem.resolveApproval(approvalId, isApproved);
        
        if (resolved) {
            await ctx.editMessageText(`[OK] Request ${isApproved ? 'approved' : 'rejected'} successfully.`);
        } else {
            await ctx.answerCbQuery('This approval request is expired or already handled.');
        }
    });

    bot.on('text', (ctx) => handleTelegramText(ctx, bot, agent, botConfig));
}

// Telegram bot factory

function startTelegramBot(botConfig: BotInstance): void {
    const agent = getAiAgent();
    if (!agent) {
        updateBot(botConfig.id, { status: 'error', last_error: 'No configured LLM provider key' });
        return;
    }
    const token = botConfig.credentials.bot_token;
    if (!token) {
        console.warn(`[BotManager] Telegram bot "${botConfig.id}" - missing bot_token`);
        updateBot(botConfig.id, { status: 'error', last_error: 'Missing bot_token' });
        return;
    }

    try {
        const bot = new Telegraf(token, { handlerTimeout: TELEGRAM_HANDLER_TIMEOUT_MS });

        setupTelegramBotHandlers(bot, agent, botConfig);

        bot.launch({ dropPendingUpdates: true }).then(() => {
            botInfo(`[BotManager] Telegram bot "${botConfig.id}" ready`);
            updateBot(botConfig.id, { status: 'active', last_error: null });
        }).catch((err: any) => {
            console.error(`[BotManager] Telegram bot "${botConfig.id}" launch failed:`, err);
            const raw = String(err?.description || err?.message || err || '');
            const isConflict = /409|terminated by other getUpdates request|Conflict/i.test(raw);
            const humanMessage = isConflict
                ? '409 Telegram polling conflict: token is being used by another running bot/process'
                : raw;
            updateBot(botConfig.id, { status: 'error', last_error: humanMessage });
        });

        activeBots.set(botConfig.id, {
            type: 'telegram',
            instance: bot,
            stop: () => { try { bot.stop('SHUTDOWN'); } catch (e) { console.debug('[BotManager] stop:', String(e)); } },
        });
    } catch (err: any) {
        console.error(`[BotManager] Telegram bot "${botConfig.id}" error:`, err);
        updateBot(botConfig.id, { status: 'error', last_error: err.message });
    }
}

// LINE bot factory

function startLineBot(app: express.Express, botConfig: BotInstance): void {
    const agent = getAiAgent();
    if (!agent) {
        updateBot(botConfig.id, { status: 'error', last_error: 'No configured LLM provider key' });
        return;
    }
    const accessToken = botConfig.credentials.channel_access_token;
    const secret = botConfig.credentials.channel_secret;

    if (!accessToken || !secret) {
        console.warn(`[BotManager] LINE bot "${botConfig.id}" - missing credentials`);
        updateBot(botConfig.id, { status: 'error', last_error: 'Missing channel_access_token or channel_secret' });
        return;
    }

    try {
        const lineConfig = { channelAccessToken: accessToken, channelSecret: secret };
        const lineClient = new LineClient(lineConfig);

        // Register both the new path AND the legacy /webhook/line path for backward compat
        const webhookPaths = [`/webhook/line/${botConfig.id}`];
        // If this is the env-migrated bot, also listen on the original /webhook/line
        if (String(botConfig.id || '').toLowerCase() === 'env-line') {
            webhookPaths.push('/webhook/line');
        }

        // Create an isolated router for this LINE bot so we can unmount it later
        const lineRouter = express.Router();

        for (const webhookPath of webhookPaths) {
            lineRouter.post(webhookPath, lineMiddleware(lineConfig), (req, res) => {
                res.status(200).json({});

                const eventPromises = (req.body.events || []).map(async (event: WebhookEvent) => {
                    if (event.type !== 'message' || event.message.type !== 'text') return;

                    const userMessage = event.message.text;
                    const userId = event.source.userId;
                    const chatId = `line_${userId}`;
                    if (!userId) return;

                    try {
                        // Intercept admin commands AND active Boss Mode sessions from LINE
                        if (isAdminCommand(userMessage) || isBossModeActive('line', userId)) {
                            const result = await handleAdminCommand(userMessage, 'line', userId);
                            const trimmed = result.length > 5000 ? result.substring(0, 4997) + '...' : result;
                            await lineClient.pushMessage(userId, { type: 'text', text: trimmed });
                            return;
                        }

                        console.log(`[LINE:${botConfig.id}] ${chatId}: ${userMessage}`);
                        upsertConversation(chatId, userId, "LINE User");
                        const responseText = await agent.processMessage(chatId, userMessage, {
                            botId: botConfig.id,
                            botName: botConfig.name,
                            platform: 'line',
                            replyWithFile: async (fileUrl: string, caption?: string) => {
                                try {
                                    const ext = fileUrl.split('.').pop()?.toLowerCase() || '';
                                    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
                                    const videoExts = ['mp4', 'mpeg', 'mov'];
                                    const audioExts = ['mp3', 'wav', 'm4a'];
                                    let message: any;
                                    if (imageExts.includes(ext)) {
                                        message = { type: 'image', originalContentUrl: fileUrl, previewImageUrl: fileUrl };
                                    } else if (videoExts.includes(ext)) {
                                        message = { type: 'video', originalContentUrl: fileUrl, previewImageUrl: fileUrl };
                                    } else if (audioExts.includes(ext)) {
                                        message = { type: 'audio', originalContentUrl: fileUrl, duration: 60000 };
                                    } else {
                                        const fileName = fileUrl.split('/').pop() || 'file';
                                        message = { type: 'text', text: `File: ${caption || fileName}` + "\\n" + `Download: ${fileUrl}` };
                                    }
                                    await lineClient.pushMessage(userId!, [message]);
                                    return `Sent file link successfully`;
                                } catch (err: any) {
                                    return `Failed to send file: ${err.message}`;
                                }
                            }
                        });
                        const text = responseText.length > 5000 ? responseText.substring(0, 4997) + '...' : responseText;
                        await lineClient.pushMessage(userId, { type: 'text', text });
                    } catch (err) {
                        console.error(`[LINE:${botConfig.id}] Error chat=${chatId}:`, err);
                    }
                });
                Promise.allSettled(eventPromises).then(results => {
                    const failures = results.filter(r => r.status === 'rejected');
                    if (failures.length > 0) {
                        console.error(`[LINE:${botConfig.id}] ${failures.length} event(s) failed:`,
                            failures.map(f => (f as PromiseRejectedResult).reason));
                    }
                });
            });
        }

        // Add a custom property to the router function to find it later
        (lineRouter as any).botId = botConfig.id;
        
        // Mount the router under root (webhook paths already contain /webhook)
        app.use('/', lineRouter);
        lineRouters.set(botConfig.id, lineRouter);

        botInfo(`[BotManager] LINE bot "${botConfig.id}" webhook ready at ${webhookPaths.join(', ')}`);
        updateBot(botConfig.id, { status: 'active', last_error: null });

        activeBots.set(botConfig.id, {
            type: 'line',
            instance: lineClient,
            stop: () => {
                // Remove the router from Express stack to prevent route stacking
                const stack = (app as any)._router?.stack;
                if (stack) {
                    // Try to find the layer that contains our specific router
                    const idx = stack.findIndex((layer: any) => layer.handle && layer.handle.botId === botConfig.id);
                    if (idx >= 0) {
                        stack.splice(idx, 1);
                        botInfo(`[BotManager] Removed Express router for LINE bot "${botConfig.id}"`);
                    }
                }
                lineRouters.delete(botConfig.id);
            },
        });
    } catch (err: any) {
        console.error(`[BotManager] LINE bot "${botConfig.id}" error:`, err);
        updateBot(botConfig.id, { status: 'error', last_error: err.message });
    }
}

// Legacy environment migration
// Auto-create bot_instances from .env vars for backward compatibility

function migrateEnvBots(): void {
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const LINE_SECRET = process.env.LINE_CHANNEL_SECRET;

    if (BOT_TOKEN) {
        const existing = getBot('env-telegram');
        if (!existing) {
            createBot({
                id: 'env-telegram',
                name: 'Telegram (from .env)',
                platform: 'telegram',
                credentials: { bot_token: BOT_TOKEN },
            });
            updateBot('env-telegram', { status: 'active' });
            botInfo('[BotManager] Migrated TELEGRAM_BOT_TOKEN from .env -> bot registry');
        } else if (existing.status === 'stopped') {
            // If it was previously created but stopped (e.g. from old buggy migration),
            // re-activate it on server restart since the env var is present
            updateBot('env-telegram', { status: 'active', last_error: null });
            botInfo('[BotManager] Re-activated env-telegram bot');
        }
    }

    if (LINE_TOKEN && LINE_SECRET) {
        const existing = getBot('env-line');
        if (!existing) {
            createBot({
                id: 'env-line',
                name: 'LINE (from .env)',
                platform: 'line',
                credentials: { channel_access_token: LINE_TOKEN, channel_secret: LINE_SECRET },
            });
            updateBot('env-line', { status: 'active' });
            botInfo('[BotManager] Migrated LINE credentials from .env -> bot registry');
        } else if (existing.status === 'stopped') {
            updateBot('env-line', { status: 'active', last_error: null });
            botInfo('[BotManager] Re-activated env-line bot');
        }
    }
}

// Public API

/** Start a single bot by registry ID (uses stored app reference) */
export function startBotInstance(app: express.Express | null, botId: string): boolean {
    const effectiveApp = app || _expressApp;
    if (!effectiveApp) {
        console.error(`[BotManager] Cannot start bot "${botId}" - no Express app reference`);
        return false;
    }
    if (!getAiAgent()) {
        console.error(`[BotManager] Cannot start bot "${botId}" - no configured LLM provider key`);
        return false;
    }

    const botConfig = getBot(botId);
    if (!botConfig) return false;

    // Stop existing instance if running
    stopBotInstance(botId);

    switch (botConfig.platform) {
        case 'telegram':
            startTelegramBot(botConfig);
            return true;
        case 'line':
            startLineBot(effectiveApp, botConfig);
            return true;
        default:
            console.warn(`[BotManager] Platform "${botConfig.platform}" not yet implemented for bot "${botId}"`);
            updateBot(botId, { status: 'error', last_error: `Platform "${botConfig.platform}" not supported yet` });
            return false;
    }
}

/** Stop a single bot by registry ID */
export function stopBotInstance(botId: string): void {
    const active = activeBots.get(botId);
    if (active) {
        active.stop();
        activeBots.delete(botId);
        updateBot(botId, { status: 'stopped' });
        console.log(`[BotManager] Stopped bot "${botId}"`);
    }
}

/** Start all bots (called at server startup) */
export function startBots(app: express.Express) {
    // Store app reference for later dynamic start/stop
    _expressApp = app;

    if (!getAiAgent()) {
        console.error("[BotManager] Missing LLM provider keys. Telegram/LINE bots cannot start.");
    }

    // Migrate legacy .env bots to registry (one-time)
    migrateEnvBots();

    // Start all registered bots that are marked 'active'
    // (newly migrated bots are set to 'active', manually stopped bots stay 'stopped')
    const bots = listBots();
    for (const bot of bots) {
        if (bot.status === 'active' || bot.status === 'error') {
            startBotInstance(app, bot.id);
        }
    }

    // Verify CLI API Health in the background
    verifyCliConnections().catch((err: any) => {
        console.error('[BotManager] Error verifying CLI connections:', err);
    });

    // Dashboard API and static files
    app.use('/personal-ai', express.static('public_personal_ai'));

    app.get('/api/config', (_req, res) => {
        res.json(configManager.getConfig());
    });

    app.post('/api/config', (req, res) => {
        configManager.updateConfig(req.body);
        res.json({ success: true });
    });

    app.get('/api/memory/episodes', (_req, res) => {
        const episodes = getDb().prepare('SELECT * FROM episodes ORDER BY id DESC LIMIT 100').all();
        res.json(episodes);
    });

    app.get('/api/memory/knowledge', (_req, res) => {
        const knowledge = getDb().prepare('SELECT id, chat_id, fact, timestamp FROM knowledge ORDER BY id DESC').all();
        res.json(knowledge);
    });

    app.delete('/api/memory/knowledge/:id', (req, res) => {
        getDb().prepare('DELETE FROM knowledge WHERE id = ?').run(req.params.id);
        res.json({ success: true });
    });

    app.post('/api/cli/chat', async (req, res) => {
        const agent = getAiAgent();
        if (!agent) {
            res.status(500).json({ error: 'AI Agent is not initialized' });
            return;
        }

        const { message, chatId = 'web_dashboard_user' } = req.body;
        if (!message) {
            res.status(400).json({ error: 'Message is required' });
            return;
        }

        try {
            upsertConversation(chatId, 'web_dashboard', 'Web Dashboard User');

            const ctx = {
                botId: 'env-telegram',
                botName: 'Web CLI Bot',
                platform: 'telegram' as any,
                replyWithText: async (_text: string) => {
                    // For Web CLI, we don't stream back intermediate text yet, 
                    // we just return the final response.
                },
                replyWithFile: async (_filePath: string, _caption?: string) => {
                    return 'File sent successfully (file preview is limited in this simple CLI mode)';
                }
            };

            const responseText = await agent.processMessage(chatId, message, ctx);
            res.json({ reply: responseText });
        } catch (err: any) {
            console.error('[Web CLI] Error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/models/:provider', async (req, res) => {
        const agent = getAiAgent();
        const models = agent ? await agent.getAvailableModels(req.params.provider) : [];
        res.json(models);
    });
}

/** Stop all bot agents gracefully */
export function stopBots(): void {
    for (const [id, bot] of activeBots) {
        try {
            bot.stop();
            console.log(`[BotManager] Stopped bot "${id}"`);
        } catch (err) {
            console.error(`[BotManager] Error stopping bot "${id}":`, err);
        }
    }
    activeBots.clear();
}

/** Get list of active bot IDs */
export function getActiveBotIds(): string[] {
    return Array.from(activeBots.keys());
}




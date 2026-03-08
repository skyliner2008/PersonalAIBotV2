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

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Shared AI Agent (singleton — all bots share the same Gemini connection)
const aiAgent = GEMINI_API_KEY ? new Agent(GEMINI_API_KEY) : null;

// ── Active Bot Instances ─────────────────────────────
// Maps bot registry ID → running instance handle
const activeBots = new Map<string, { type: string; instance: any; stop: () => void }>();

// Store Express app reference for dynamic bot start/stop from dashboard
let _expressApp: express.Express | null = null;

// ── Helpers ──────────────────────────────────────────

async function getGeminiPartFromTelegram(ctx: any, fileId: string, mimeType: string): Promise<Part> {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await axios.get(fileLink.toString(), { responseType: 'arraybuffer' });
    const data = Buffer.from(response.data).toString('base64');
    return { inlineData: { data, mimeType } };
}

// ── Telegram Bot Factory ─────────────────────────────

function startTelegramBot(botConfig: BotInstance): void {
    if (!aiAgent) return;
    const token = botConfig.credentials.bot_token;
    if (!token) {
        console.warn(`[BotManager] Telegram bot "${botConfig.id}" — missing bot_token`);
        updateBot(botConfig.id, { status: 'error', last_error: 'Missing bot_token' });
        return;
    }

    try {
        const bot = new Telegraf(token);

        bot.start((ctx) => {
            ctx.reply(`สวัสดีครับ! ผมคือ ${botConfig.name} — Personal AI Assistant`);
        });

        bot.command('clear', (ctx) => {
            const chatId = ctx.chat.id.toString();
            clearMemory(`telegram_${chatId}`);
            ctx.reply("🧹 ล้างความจำเรียบร้อยแล้วครับ");
        });

        bot.on(['document', 'photo'], async (ctx) => {
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
                await ctx.reply("🧠 กำลังวิเคราะห์ไฟล์/รูปภาพด้วยพลัง Multimodal...");
                try {
                    const attachmentPart = await getGeminiPartFromTelegram(ctx, fileId, mimeType);
                    const caption = ('caption' in ctx.message ? ctx.message.caption : null) || "ช่วยวิเคราะห์ไฟล์/รูปภาพนี้ให้หน่อยครับ";
                    upsertConversation(chatId, ctx.chat.id.toString(), "Telegram User");
                    const agentResponse = await aiAgent!.processMessage(
                        chatId, caption,
                        { botId: botConfig.id, botName: botConfig.name, platform: 'telegram', replyWithFile: async (fp: string, cap?: string) => { await ctx.replyWithDocument({ source: fp }, { caption: cap }); return 'ส่งสำเร็จ'; } },
                        [attachmentPart]
                    );
                    await ctx.reply(agentResponse);
                } catch (err) {
                    console.error(`[Telegram:${botConfig.id}] Multimodal Error:`, err);
                    await ctx.reply("❌ เกิดข้อผิดพลาดในการวิเคราะห์ไฟล์");
                }
            }
        });

        bot.on('text', async (ctx) => {
            const userMessage = ctx.message.text;
            const chatId = `telegram_${ctx.chat.id.toString()}`;
            if (userMessage.startsWith('/')) return;
            console.log(`[Telegram:${botConfig.id}] ${chatId}: ${userMessage}`);
            await ctx.sendChatAction('typing');

            try {
                upsertConversation(chatId, ctx.chat.id.toString(), "Telegram User");
                const responseText = await aiAgent!.processMessage(chatId, userMessage, {
                    botId: botConfig.id,
                    botName: botConfig.name,
                    platform: 'telegram',
                    replyWithFile: async (filePath: string, caption?: string) => {
                        await ctx.replyWithDocument({ source: filePath }, { caption });
                        return `ส่งไฟล์ ${filePath} ให้ผู้ใช้เรียบร้อย`;
                    }
                });
                if (responseText.length > 4096) {
                    for (let i = 0; i < responseText.length; i += 4096) {
                        await ctx.reply(responseText.substring(i, i + 4096));
                    }
                } else {
                    await ctx.reply(responseText);
                }
            } catch (err: any) {
                console.error(`[Telegram:${botConfig.id}] Reply Error:`, err);
                await ctx.reply("เกิดข้อผิดพลาดในการตอบกลับครับ");
            }
        });

        bot.launch().then(() => {
            console.log(`✅ Telegram Bot "${botConfig.id}" Ready`);
            updateBot(botConfig.id, { status: 'active', last_error: null });
        }).catch((err: any) => {
            console.error(`[BotManager] Telegram bot "${botConfig.id}" launch failed:`, err);
            updateBot(botConfig.id, { status: 'error', last_error: err.message });
        });

        activeBots.set(botConfig.id, {
            type: 'telegram',
            instance: bot,
            stop: () => { try { bot.stop('SHUTDOWN'); } catch { } },
        });
    } catch (err: any) {
        console.error(`[BotManager] Telegram bot "${botConfig.id}" error:`, err);
        updateBot(botConfig.id, { status: 'error', last_error: err.message });
    }
}

// ── LINE Bot Factory ─────────────────────────────────

function startLineBot(app: express.Express, botConfig: BotInstance): void {
    if (!aiAgent) return;
    const accessToken = botConfig.credentials.channel_access_token;
    const secret = botConfig.credentials.channel_secret;

    if (!accessToken || !secret) {
        console.warn(`[BotManager] LINE bot "${botConfig.id}" — missing credentials`);
        updateBot(botConfig.id, { status: 'error', last_error: 'Missing channel_access_token or channel_secret' });
        return;
    }

    try {
        const lineConfig = { channelAccessToken: accessToken, channelSecret: secret };
        const lineClient = new LineClient(lineConfig);

        // Register both the new path AND the legacy /webhook/line path for backward compat
        const webhookPaths = [`/webhook/line/${botConfig.id}`];
        // If this is the env-migrated bot, also listen on the original /webhook/line
        if (botConfig.id === 'env-line') {
            webhookPaths.push('/webhook/line');
        }

        for (const webhookPath of webhookPaths) {
            app.post(webhookPath, lineMiddleware(lineConfig), (req, res) => {
                res.status(200).json({});

                const eventPromises = (req.body.events || []).map(async (event: WebhookEvent) => {
                    if (event.type !== 'message' || event.message.type !== 'text') return;

                    const userMessage = event.message.text;
                    const userId = event.source.userId;
                    const chatId = `line_${userId}`;
                    if (!userId) return;

                    try {
                        console.log(`[LINE:${botConfig.id}] ${chatId}: ${userMessage}`);
                        upsertConversation(chatId, userId, "LINE User");
                        const responseText = await aiAgent!.processMessage(chatId, userMessage, {
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
                                        message = { type: 'text', text: `📎 ไฟล์: ${caption || fileName}\n🔗 ดาวน์โหลด: ${fileUrl}` };
                                    }
                                    await lineClient.pushMessage(userId!, [message]);
                                    return `ส่งไฟล์ให้ผู้ใช้เรียบร้อยแล้ว`;
                                } catch (err: any) {
                                    return `ไม่สามารถส่งไฟล์ได้: ${err.message}`;
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

        console.log(`✅ LINE Bot "${botConfig.id}" Webhook at ${webhookPaths.join(', ')}`);
        updateBot(botConfig.id, { status: 'active', last_error: null });

        activeBots.set(botConfig.id, {
            type: 'line',
            instance: lineClient,
            stop: () => { /* LINE webhooks are Express routes — no graceful stop needed */ },
        });
    } catch (err: any) {
        console.error(`[BotManager] LINE bot "${botConfig.id}" error:`, err);
        updateBot(botConfig.id, { status: 'error', last_error: err.message });
    }
}

// ── Legacy Environment Migration ─────────────────────
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
            console.log('[BotManager] Migrated TELEGRAM_BOT_TOKEN from .env → bot registry');
        } else if (existing.status === 'stopped') {
            // If it was previously created but stopped (e.g. from old buggy migration),
            // re-activate it on server restart since the env var is present
            updateBot('env-telegram', { status: 'active', last_error: null });
            console.log('[BotManager] Re-activated env-telegram bot');
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
            console.log('[BotManager] Migrated LINE credentials from .env → bot registry');
        } else if (existing.status === 'stopped') {
            updateBot('env-line', { status: 'active', last_error: null });
            console.log('[BotManager] Re-activated env-line bot');
        }
    }
}

// ── Public API ───────────────────────────────────────

/** Start a single bot by registry ID (uses stored app reference) */
export function startBotInstance(app: express.Express | null, botId: string): boolean {
    const effectiveApp = app || _expressApp;
    if (!effectiveApp) {
        console.error(`[BotManager] Cannot start bot "${botId}" — no Express app reference`);
        return false;
    }
    if (!aiAgent) {
        console.error(`[BotManager] Cannot start bot "${botId}" — no AI agent (missing GEMINI_API_KEY)`);
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

    if (!aiAgent) {
        console.error("❌ ขาด GEMINI_API_KEY ในไฟล์ .env, บอท Telegram/LINE จะไม่ทำงาน");
        return;
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

    // ── Dashboard API & Static Files ──
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
        if (!aiAgent) {
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
                replyWithText: async (text: string) => {
                    // For Web CLI, we don't stream back intermediate text yet, 
                    // we just return the final response.
                },
                replyWithFile: async (filePath: string, caption?: string) => {
                    return 'ส่งสำเร็จ (File preview not fully supported in simple CLI)';
                }
            };

            const responseText = await aiAgent.processMessage(chatId, message, ctx);
            res.json({ reply: responseText });
        } catch (err: any) {
            console.error('[Web CLI] Error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/models/:provider', async (req, res) => {
        const models = aiAgent ? await aiAgent.getAvailableModels(req.params.provider) : [];
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

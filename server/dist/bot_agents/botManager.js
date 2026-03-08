import { Telegraf } from 'telegraf';
import { middleware as lineMiddleware, Client as LineClient } from '@line/bot-sdk';
import express from 'express';
import * as dotenv from 'dotenv';
import { Agent } from './agent.js';
import { clearMemory } from '../memory/unifiedMemory.js';
import { configManager } from './config/configManager.js';
import { getDb, upsertConversation } from '../database/db.js';
import axios from 'axios';
dotenv.config();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
// 1. Setup AI Agent
const aiAgent = GEMINI_API_KEY ? new Agent(GEMINI_API_KEY) : null;
// Track active bot instances for graceful shutdown
let telegramBot = null;
// Helper: Convert Telegram file to Gemini Part
async function getGeminiPartFromTelegram(ctx, fileId, mimeType) {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await axios.get(fileLink.toString(), { responseType: 'arraybuffer' });
    const data = Buffer.from(response.data).toString('base64');
    return { inlineData: { data, mimeType } };
}
export function startBots(app) {
    if (!aiAgent) {
        console.error("❌ ขาด GEMINI_API_KEY ในไฟล์ .env, บอท Telegram/LINE จะไม่ทำงาน");
        return;
    }
    // ==========================================
    // 1. Setup Telegram Bot
    // ==========================================
    if (BOT_TOKEN) {
        const bot = new Telegraf(BOT_TOKEN);
        telegramBot = bot;
        bot.start((ctx) => {
            ctx.reply("สวัสดีครับ! ผมคือ Ultimate Personal AI Assistant พร้อมพลังเต็มสูบจาก Gemini Pro!\n- OS Control\n- Web Browser\n- Google Search\n- Python Code Execution\n- Multimodal Vision");
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
            }
            else if ('photo' in ctx.message) {
                const photo = ctx.message.photo[ctx.message.photo.length - 1];
                fileId = photo.file_id;
                mimeType = 'image/jpeg';
            }
            if (fileId) {
                await ctx.reply("🧠 กำลังวิเคราะห์ไฟล์/รูปภาพด้วยพลัง Multimodal...");
                try {
                    const attachmentPart = await getGeminiPartFromTelegram(ctx, fileId, mimeType);
                    const caption = ('caption' in ctx.message ? ctx.message.caption : null) || "ช่วยวิเคราะห์ไฟล์/รูปภาพนี้ให้หน่อยครับ";
                    // Upsert conversation to satisfy SQLite foreign key constraints for unified memory
                    upsertConversation(chatId, ctx.chat.id.toString(), "Telegram User");
                    const agentResponse = await aiAgent.processMessage(chatId, caption, { platform: 'telegram', replyWithFile: async (fp, cap) => { await ctx.replyWithDocument({ source: fp }, { caption: cap }); return 'ส่งสำเร็จ'; } }, [attachmentPart]);
                    await ctx.reply(agentResponse);
                }
                catch (err) {
                    console.error("[Telegram] Multimodal Analysis Error:", err);
                    await ctx.reply("❌ เกิดข้อผิดพลาดในการวิเคราะห์ไฟล์");
                }
            }
        });
        bot.on('text', async (ctx) => {
            const userMessage = ctx.message.text;
            const chatId = `telegram_${ctx.chat.id.toString()}`;
            if (userMessage.startsWith('/'))
                return;
            console.log(`[Telegram] Incoming message from ${chatId}: ${userMessage}`);
            await ctx.sendChatAction('typing');
            try {
                // Upsert conversation to satisfy SQLite foreign key constraints for unified memory
                upsertConversation(chatId, ctx.chat.id.toString(), "Telegram User");
                const responseText = await aiAgent.processMessage(chatId, userMessage, {
                    platform: 'telegram',
                    replyWithFile: async (filePath, caption) => {
                        await ctx.replyWithDocument({ source: filePath }, { caption });
                        return `ส่งไฟล์ ${filePath} ให้ผู้ใช้เรียบร้อย`;
                    }
                });
                // Telegram message limit = 4096 chars; split if needed
                if (responseText.length > 4096) {
                    for (let i = 0; i < responseText.length; i += 4096) {
                        await ctx.reply(responseText.substring(i, i + 4096));
                    }
                }
                else {
                    await ctx.reply(responseText);
                }
            }
            catch (err) {
                console.error("[Telegram] Bot Reply Error:", err);
                await ctx.reply("เกิดข้อผิดพลาดในการตอบกลับครับ");
            }
        });
        bot.launch().then(() => console.log("✅ Telegram Bot Ready"));
        // NOTE: SIGINT/SIGTERM are handled in index.ts via stopBots() — no duplicate handlers here
    }
    else {
        console.warn("⚠️ ไม่พบ TELEGRAM_BOT_TOKEN ใน .env");
    }
    // ==========================================
    // 2. Setup LINE Bot Webhook
    // ==========================================
    if (LINE_CHANNEL_ACCESS_TOKEN && LINE_CHANNEL_SECRET) {
        const lineConfig = { channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET };
        const lineClient = new LineClient(lineConfig);
        app.post('/webhook/line', lineMiddleware(lineConfig), (req, res) => {
            // ตอบกลับ LINE ทันทีเพื่อป้องกัน Timeout
            res.status(200).json({});
            // Process events in background — use Promise.allSettled to avoid unhandled rejections
            const eventPromises = (req.body.events || []).map(async (event) => {
                if (event.type !== 'message' || event.message.type !== 'text')
                    return;
                const userMessage = event.message.text;
                const userId = event.source.userId;
                const chatId = `line_${userId}`;
                if (!userId)
                    return;
                try {
                    console.log(`[LINE] Incoming message from ${chatId}: ${userMessage}`);
                    // Upsert conversation to satisfy SQLite foreign key constraints for unified memory
                    upsertConversation(chatId, userId, "LINE User");
                    const responseText = await aiAgent.processMessage(chatId, userMessage, {
                        platform: 'line',
                        replyWithFile: async (fileUrl, caption) => {
                            try {
                                // The URL is already rewritten by createSendFileHandler to use ngrok
                                const ext = fileUrl.split('.').pop()?.toLowerCase() || '';
                                const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
                                const videoExts = ['mp4', 'mpeg', 'mov'];
                                const audioExts = ['mp3', 'wav', 'm4a'];
                                let message;
                                if (imageExts.includes(ext)) {
                                    message = { type: 'image', originalContentUrl: fileUrl, previewImageUrl: fileUrl };
                                }
                                else if (videoExts.includes(ext)) {
                                    message = { type: 'video', originalContentUrl: fileUrl, previewImageUrl: fileUrl };
                                }
                                else if (audioExts.includes(ext)) {
                                    message = { type: 'audio', originalContentUrl: fileUrl, duration: 60000 };
                                }
                                else {
                                    // For other file types, send as text with download link
                                    const fileName = fileUrl.split('/').pop() || 'file';
                                    message = { type: 'text', text: `📎 ไฟล์: ${caption || fileName}\n🔗 ดาวน์โหลด: ${fileUrl}` };
                                }
                                await lineClient.pushMessage(userId, [message]);
                                console.log(`[LINE] Sent file to ${chatId}: ${fileUrl}`);
                                return `ส่งไฟล์ให้ผู้ใช้เรียบร้อยแล้ว`;
                            }
                            catch (err) {
                                console.error(`[LINE] File send error:`, err);
                                return `ไม่สามารถส่งไฟล์ได้: ${err.message}`;
                            }
                        }
                    });
                    // LINE message limit = 5000 chars
                    const text = responseText.length > 5000 ? responseText.substring(0, 4997) + '...' : responseText;
                    await lineClient.pushMessage(userId, { type: 'text', text });
                    console.log(`[LINE] Sent push message to ${chatId}`);
                }
                catch (err) {
                    console.error(`[LINE Process Error] chat=${chatId}:`, err);
                }
            });
            Promise.allSettled(eventPromises).catch(err => console.error('[LINE] Event batch error:', err));
        });
        console.log("✅ LINE Webhook Configured at /webhook/line");
    }
    else {
        console.warn("⚠️ ไม่พบ LINE_CHANNEL_ACCESS_TOKEN ใน .env");
    }
    // ==========================================
    // 3. Personal AI Dashboard API & Static Files
    // ==========================================
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
    app.get('/api/models/:provider', async (req, res) => {
        const models = aiAgent ? await aiAgent.getAvailableModels(req.params.provider) : [];
        res.json(models);
    });
    // NOTE: /api/env endpoints REMOVED for security — API keys should not be exposed via HTTP
}
/**
 * Stop all bot agents gracefully.
 */
export function stopBots() {
    if (telegramBot) {
        try {
            telegramBot.stop('SHUTDOWN');
            console.log('[BotManager] Telegram bot stopped');
        }
        catch (err) {
            console.error('[BotManager] Error stopping Telegram bot:', err);
        }
        telegramBot = null;
    }
}
//# sourceMappingURL=botManager.js.map
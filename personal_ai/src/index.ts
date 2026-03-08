import { Telegraf } from 'telegraf';
import * as dotenv from 'dotenv';
import { Agent } from './agent';
import { memoryManager } from './memory';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import express from 'express';
import { middleware as lineMiddleware, Client as LineClient, WebhookEvent, TextMessage } from '@line/bot-sdk';
import { Part } from '@google/genai';

// Load environment variables
dotenv.config();

// ── Startup Environment Validation ──────────────────────────
function validateEnv(): void {
  const required: { key: string; hint: string }[] = [
    { key: 'GEMINI_API_KEY', hint: 'https://aistudio.google.com/apikey' },
  ];
  const missing = required.filter(r => !process.env[r.key]);
  if (missing.length > 0) {
    for (const m of missing) {
      console.error(`❌ Missing required env var: ${m.key}  →  ${m.hint}`);
    }
    console.error('💡 Copy .env.example to .env and fill in your values');
    process.exit(1);
  }
  // Warn (not fatal) for optional but commonly needed vars
  if (!process.env.TELEGRAM_BOT_TOKEN && !process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.warn('⚠️  Neither TELEGRAM_BOT_TOKEN nor LINE_CHANNEL_ACCESS_TOKEN set — no bots will start');
  }
}
validateEnv();

// ── Global unhandled rejection safety net ───────────────────
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Promise Rejection:', reason);
  console.error('Promise:', promise);
  // Log but don't crash — let the agent retry on next message
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

// LINE Configuration
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const PORT = process.env.PORT || 3000;

// 1. Setup AI Agent
const aiAgent = new Agent(GEMINI_API_KEY);

// สร้างโฟลเดอร์ดาวน์โหลดถ้าไม่มี
const DOWNLOADS_DIR = path.join(process.cwd(), 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// ==========================================
// 2. Setup Telegram Bot
// ==========================================
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
    ctx.reply("สวัสดีครับ! ผมคือ Ultimate Personal AI Assistant พร้อมพลังเต็มสูบจาก Gemini Pro!\n- OS Control\n- Web Browser\n- Google Search\n- Python Code Execution\n- Multimodal Vision");
});

bot.command('clear', (ctx) => {
    const chatId = ctx.chat.id.toString();
    memoryManager.clearMemory(`telegram_${chatId}`);
    ctx.reply("🧹 ล้างความจำเรียบร้อยแล้วครับ");
});

// ฟังก์ชันสำหรับแปลงไฟล์ Telegram เป็น Gemini Part
async function getGeminiPartFromTelegram(ctx: any, fileId: string, mimeType: string): Promise<Part> {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await axios.get(fileLink.toString(), { responseType: 'arraybuffer' });
    const data = Buffer.from(response.data).toString('base64');
    return {
        inlineData: {
            data,
            mimeType
        }
    };
}

bot.on(['document', 'photo'], async (ctx) => {
    const chatId = `telegram_${ctx.chat.id.toString()}`;
    let fileId = '';
    let mimeType = '';
    let fileName = '';

    if ('document' in ctx.message) {
        fileId = ctx.message.document.file_id;
        mimeType = ctx.message.document.mime_type || 'application/octet-stream';
        fileName = ctx.message.document.file_name || `file_${Date.now()}`;
    } else if ('photo' in ctx.message) {
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        fileId = photo.file_id;
        mimeType = 'image/jpeg';
        fileName = `photo_${Date.now()}.jpg`;
    }

    if (fileId) {
        await ctx.reply("🧠 กำลังวิเคราะห์ไฟล์/รูปภาพด้วยพลัง Multimodal...");
        try {
            const attachmentPart = await getGeminiPartFromTelegram(ctx, fileId, mimeType);
            
            // ส่งไฟล์ให้ Agent วิเคราะห์
            const agentResponse = await aiAgent.processMessage(
                chatId, 
                ctx.message.caption || "ช่วยวิเคราะห์ไฟล์/รูปภาพนี้ให้หน่อยครับ",
                { platform: 'telegram', replyWithFile: async (fp, cap) => { await ctx.replyWithDocument({ source: fp }, { caption: cap }); return 'ส่งสำเร็จ'; } },
                [attachmentPart]
            );
            await ctx.reply(agentResponse);
        } catch (err) {
            console.error("Multimodal Analysis Error:", err);
            await ctx.reply("❌ เกิดข้อผิดพลาดในการวิเคราะห์ไฟล์");
        }
    }
});

bot.on('text', async (ctx) => {
  const userMessage = ctx.message.text;
  const chatId = `telegram_${ctx.chat.id.toString()}`;
  if (userMessage.startsWith('/')) return;
  await ctx.sendChatAction('typing');

  const MAX_RETRIES = 2;
  let lastError: any;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`[Telegram] Retry ${attempt}/${MAX_RETRIES} for ${chatId}`);
        await ctx.sendChatAction('typing');
      }
      const responseText = await aiAgent.processMessage(chatId, userMessage, {
          platform: 'telegram',
          replyWithFile: async (filePath: string, caption?: string) => {
              await ctx.replyWithDocument({ source: filePath }, { caption });
              return `ส่งไฟล์ ${filePath} ให้ผู้ใช้เรียบร้อย`;
          }
      });

      // แบ่งข้อความยาวออกเป็นหลายส่วน (Telegram limit: 4096 chars)
      if (responseText.length > 4000) {
        const chunks = responseText.match(/.{1,4000}/gs) || [responseText];
        for (const chunk of chunks) {
          await ctx.reply(chunk);
        }
      } else {
        await ctx.reply(responseText);
      }
      return; // success
    } catch (err: any) {
      lastError = err;
      console.error(`[Telegram] Attempt ${attempt} error:`, err.message);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // backoff
      }
    }
  }
  console.error("[Telegram] All retries failed:", lastError);
  try { await ctx.reply("เกิดข้อผิดพลาดในการตอบกลับครับ กรุณาลองใหม่อีกครั้ง"); } catch { }
});

bot.launch()
  .then(() => console.log('✅ Telegram Bot (Ultimate) Ready'))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ [Telegram] Bot launch failed: ${msg}`);
    process.exit(1);
  });

import db from './db';
import { configManager } from './config/configManager';

// ... (existing code)

// ==========================================
// 3. Dashboard API & Static Files
// ==========================================
const app = express();
app.use(express.json());
app.use(express.static('public')); // สำหรับหน้าเว็บ Dashboard

// ดึงการตั้งค่าโมเดลปัจจุบัน
app.get('/api/config', (req, res) => {
    res.json(configManager.getConfig());
});

// บันทึกการตั้งค่าโมเดลใหม่
app.post('/api/config', (req, res) => {
    configManager.updateConfig(req.body);
    res.json({ success: true });
});

// ดึงประวัติความจำเหตุการณ์ (Episodic Memory)
app.get('/api/memory/episodes', (req, res) => {
    const episodes = db.prepare('SELECT * FROM episodes ORDER BY id DESC LIMIT 100').all();
    res.json(episodes);
});

// ดึงความรู้ระยะยาว (Semantic Memory)
app.get('/api/memory/knowledge', (req, res) => {
    const knowledge = db.prepare('SELECT id, chat_id, fact, timestamp FROM knowledge ORDER BY id DESC').all();
    res.json(knowledge);
});

// ลบความจำระยะยาว
app.delete('/api/memory/knowledge/:id', (req, res) => {
    db.prepare('DELETE FROM knowledge WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

// ดึงรายชื่อโมเดลจาก Provider
app.get('/api/models/:provider', async (req, res) => {
    const models = await aiAgent.getAvailableModels(req.params.provider);
    res.json(models);
});

// ⚠️  /api/env endpoint ถูกลบออกเพื่อความปลอดภัย
//    การแก้ไข API keys ให้แก้ไฟล์ .env โดยตรงแล้ว restart server
//    เพื่อป้องกันการ expose secrets ผ่าน HTTP

// Health check — ไม่เปิดเผย secrets
app.get('/api/health', (_req, res) => {
    const mem = process.memoryUsage();
    res.json({
        status: 'ok',
        uptime: Math.round(process.uptime()),
        memoryMB: Math.round(mem.rss / 1024 / 1024),
        telegram: !!BOT_TOKEN,
        line: !!(LINE_CHANNEL_ACCESS_TOKEN && LINE_CHANNEL_SECRET),
        ai: !!GEMINI_API_KEY,
    });
});

if (LINE_CHANNEL_ACCESS_TOKEN && LINE_CHANNEL_SECRET) {
    const lineConfig = { channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET };
    const lineClient = new LineClient(lineConfig);

    app.post('/webhook', lineMiddleware(lineConfig), (req, res) => {
        // ตอบกลับ LINE ทันทีเพื่อป้องกัน Timeout และให้การ Verify ผ่าน
        res.status(200).json({});

        // ประมวลผลทุก event พร้อมกัน — ใช้ Promise.allSettled เพื่อ:
        // 1. ไม่ drop Promise (แก้ forEach async bug)
        // 2. event หนึ่ง fail ไม่กระทบ event อื่น
        const processEvent = async (event: WebhookEvent): Promise<void> => {
            if (event.type !== 'message' || event.message.type !== 'text') return;

            const userMessage = event.message.text;
            const userId = event.source.userId;
            const chatId = `line_${userId}`;
            if (!userId) return;

            try {
                console.log(`[LINE] Incoming message from ${chatId}: ${userMessage}`);
                const responseText = await aiAgent.processMessage(chatId, userMessage, {
                    platform: 'line',
                    replyWithFile: async (fp) => `[LINE Limit] ไม่สามารถส่งไฟล์ ${fp} ได้โดยตรง`
                });
                // ใช้ pushMessage แทน replyMessage เพื่อไม่ให้ติดเรื่อง Timeout
                await lineClient.pushMessage(userId, { type: 'text', text: responseText });
                console.log(`[LINE] Sent push message to ${chatId}`);
            } catch (err) {
                console.error('[LINE Process Error]:', err);
            }
        };

        // Fire-and-forget with proper error tracking per event
        Promise.allSettled((req.body.events as WebhookEvent[]).map(processEvent))
            .then(results => {
                const failed = results.filter(r => r.status === 'rejected');
                if (failed.length > 0) {
                    console.error(`[LINE] ${failed.length}/${results.length} events failed`);
                }
            });
    });

    app.listen(Number(PORT), '0.0.0.0', () => {
        console.log(`✅ LINE Server is listening on port ${PORT}`);
        console.log(`💡 Local Webhook URL: http://127.0.0.1:${PORT}/webhook`);
    });
}

process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(0); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });

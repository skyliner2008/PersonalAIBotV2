import { Telegraf } from 'telegraf';
import * as dotenv from 'dotenv';
import { Agent } from './agent';
import { memoryManager } from './memory';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import express from 'express';
import { middleware as lineMiddleware, Client as LineClient } from '@line/bot-sdk';
// Load environment variables
dotenv.config();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// LINE Configuration
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const PORT = process.env.PORT || 3000;
if (!BOT_TOKEN || !GEMINI_API_KEY) {
    console.error("❌ ขาด TELEGRAM_BOT_TOKEN หรือ GEMINI_API_KEY ในไฟล์ .env");
    process.exit(1);
}
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
async function getGeminiPartFromTelegram(ctx, fileId, mimeType) {
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
    }
    else if ('photo' in ctx.message) {
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
            const agentResponse = await aiAgent.processMessage(chatId, ctx.message.caption || "ช่วยวิเคราะห์ไฟล์/รูปภาพนี้ให้หน่อยครับ", { platform: 'telegram', replyWithFile: async (fp, cap) => { await ctx.replyWithDocument({ source: fp }, { caption: cap }); return 'ส่งสำเร็จ'; } }, [attachmentPart]);
            await ctx.reply(agentResponse);
        }
        catch (err) {
            console.error("Multimodal Analysis Error:", err);
            await ctx.reply("❌ เกิดข้อผิดพลาดในการวิเคราะห์ไฟล์");
        }
    }
});
bot.on('text', async (ctx) => {
    const userMessage = ctx.message.text;
    const chatId = `telegram_${ctx.chat.id.toString()}`;
    if (userMessage.startsWith('/'))
        return;
    await ctx.sendChatAction('typing');
    try {
        const responseText = await aiAgent.processMessage(chatId, userMessage, {
            platform: 'telegram',
            replyWithFile: async (filePath, caption) => {
                await ctx.replyWithDocument({ source: filePath }, { caption });
                return `ส่งไฟล์ ${filePath} ให้ผู้ใช้เรียบร้อย`;
            }
        });
        await ctx.reply(responseText);
    }
    catch (err) {
        console.error("Bot Reply Error:", err);
        await ctx.reply("เกิดข้อผิดพลาดในการตอบกลับครับ");
    }
});
bot.launch().then(() => console.log("✅ Telegram Bot (Ultimate) Ready"));
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
// ดึงข้อมูลในไฟล์ .env
app.get('/api/env', (req, res) => {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        res.send(fs.readFileSync(envPath, 'utf8'));
    }
    else {
        res.send('');
    }
});
// บันทึกข้อมูลลงไฟล์ .env และโหลดค่าใหม่เข้า process.env
app.post('/api/env', (req, res) => {
    const { content } = req.body;
    const envPath = path.join(process.cwd(), '.env');
    fs.writeFileSync(envPath, content, 'utf8');
    // โหลดค่าใหม่เข้า process.env ทันที (Override ค่าเก่า)
    dotenv.config({ override: true });
    // แจ้งเตือนว่าบอทบางส่วนอาจต้องใช้การ restart agent
    res.json({ success: true, message: 'บันทึก .env และอัปเดต process.env เรียบร้อย' });
});
if (LINE_CHANNEL_ACCESS_TOKEN && LINE_CHANNEL_SECRET) {
    const lineConfig = { channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET };
    const lineClient = new LineClient(lineConfig);
    app.post('/webhook', lineMiddleware(lineConfig), (req, res) => {
        // ตอบกลับ LINE ทันทีเพื่อป้องกัน Timeout และให้การ Verify ผ่าน
        res.status(200).json({});
        // ประมวลผลเหตุการณ์ต่างๆ เบื้องหลัง
        req.body.events.forEach(async (event) => {
            if (event.type !== 'message' || event.message.type !== 'text')
                return;
            const userMessage = event.message.text;
            const userId = event.source.userId; // เก็บ userId ไว้สำหรับส่ง Push
            const chatId = `line_${userId}`;
            if (!userId)
                return;
            try {
                console.log(`[LINE] Incoming message from ${chatId}: ${userMessage}`);
                // ส่งข้อความแจ้งเตือนเบื้องต้น (ถ้าต้องการ)
                // await lineClient.pushMessage(userId, { type: 'text', text: '🤖 กำลังประมวลผลคำสั่งของคุณ โปรดรอสักครู่...' });
                const responseText = await aiAgent.processMessage(chatId, userMessage, {
                    platform: 'line',
                    replyWithFile: async (fp) => `[LINE Limit] ไม่สามารถส่งไฟล์ ${fp} ได้โดยตรง`
                });
                // ใช้ pushMessage แทน replyMessage เพื่อไม่ให้ติดเรื่อง Timeout
                await lineClient.pushMessage(userId, {
                    type: 'text',
                    text: responseText
                });
                console.log(`[LINE] Sent push message to ${chatId}`);
            }
            catch (err) {
                console.error("[LINE Process Error]:", err);
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
//# sourceMappingURL=index.js.map
import { Agent } from '../bot_agents/agent.js';
import { getDb, upsertConversation } from '../database/db.js';
import { createLogger } from '../utils/logger.js';
import { getIsSleeping } from '../scheduler/subconscious.js';

const log = createLogger('IdleLoop');
let idleInterval: NodeJS.Timeout | null = null;
const STARTUP_COMPACT = process.env.STARTUP_COMPACT === '1';

// Configuration for the Idle Loop
const IDLE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // Check every 1 hour
const IDLE_THRESHOLD_HOURS = 2; // Consider AI "idle" if no user message in 2 hours

// Flag to prevent concurrent execution of idle loop handler
let isIdleLoopRunning = false;

export function startIdleLoop(aiAgent: Agent | null) {
    if (!aiAgent) {
        log.warn('Disabled: AI Agent is not initialized.');
        return;
    }

    if (!STARTUP_COMPACT) {
        log.info(`Started. Checking for inactivity every ${IDLE_CHECK_INTERVAL_MS / 60000} minutes.`);
    }

    setInterval(async () => {
        // Prevent overlapping executions if async callback takes longer than interval
        if (isIdleLoopRunning) {
            log.debug('Still processing from previous interval, skipping');
            return;
        }
        // Skip if subconscious sleep is already running to avoid duplicate work
        if (getIsSleeping()) {
            log.debug('Subconscious Sleep is active, skipping idle loop to avoid conflicts');
            return;
        }

        isIdleLoopRunning = true;
        try {
            await checkAndTriggerProactiveTask(aiAgent);
        } catch (err: any) {
            console.error('[IdleLoop] Error during proactive task execution:', err.message);
        } finally {
            isIdleLoopRunning = false;
        }
    }, IDLE_CHECK_INTERVAL_MS);
}

async function checkAndTriggerProactiveTask(aiAgent: Agent) {
    const db = getDb();

    // Check the last time any user sent a message (role = 'user')
    // Exclude messages from 'system' or 'assistant' to focus on human interaction
    const stmt = db.prepare(`
        SELECT timestamp 
        FROM episodes 
        WHERE role = 'user' AND chat_id NOT LIKE 'system_%'
        ORDER BY timestamp DESC 
        LIMIT 1
    `);

    const lastInteraction = stmt.get() as { timestamp: string } | undefined;

    let isIdle = false;
    let hoursSinceLastMessage = 0;

    if (!lastInteraction) {
        // If there's literally no history, the bot has been idle since birth
        isIdle = true;
        hoursSinceLastMessage = 999;
    } else {
        const lastMsgTime = new Date(lastInteraction.timestamp).getTime();
        const now = Date.now();
        const diffMs = now - lastMsgTime;
        hoursSinceLastMessage = diffMs / (1000 * 60 * 60);

        if (hoursSinceLastMessage >= IDLE_THRESHOLD_HOURS) {
            isIdle = true;
        }
    }

    if (!isIdle) {
        log.debug(`Bot is active. Last user message was ${hoursSinceLastMessage.toFixed(1)} hours ago.`);
        return;
    }

    console.log(`[IdleLoop] ⚠️ Bot has been idle for ${hoursSinceLastMessage.toFixed(1)} hours. Triggering Proactive Task...`);

    // We create a special "System" chat session for the bot's internal thoughts
    const systemChatId = 'system_idle_loop';
    upsertConversation(systemChatId, 'system', 'Autonomous AI Routine');

    const proactivePrompt = `
[SYSTEM PROMPT: PROACTIVE IDLE STATE]
คุณไม่ได้คุยกับ User (มนุษย์) มาเป็นเวลา ${hoursSinceLastMessage.toFixed(1)} ชั่วโมงแล้ว ตอนนี้เข้าระบบ Background Process 
ในฐานะ Autonomous Agent คุณสามารถใช้เวลาว่างนี้ทำประโยชน์ได้:
- คุณสามารถตรวจสอบ error logs ที่ผ่านมา (ถ้ามี tool) 
- คุณสามารถวิเคราะห์หรือเรียนรู้เพิ่มเติม
- หรือคุณจะรัน self_heal / reflection ก็ได้
- หรือคุณจะดึงข่าวสารผ่าน web_search มาสรุปไว้เผื่อเตะตา

จงคิดและลงมือทำ 1 งานที่คุณคิดว่ามีประโยชน์ต่อระบบที่สุดในตอนนี้ 
ถ้าไม่มีอะไรให้ทำ ให้ตอบสั้นๆ ว่า "ไม่มีงานที่ต้องทำ พักผ่อนระบบ"
`;

    // Context that suppresses immediate text output back to a literal "user" 
    // but executes the LLM reasoning chain
    const ctx = {
        botId: 'system-agent',
        botName: 'Auto Core',
        platform: 'system' as any,
        replyWithText: async (text: string) => {
            console.log(`\n[IdleLoop: Thought]\n${text}`);
        },
        replyWithFile: async (filePath: string, caption?: string) => {
            console.log(`\n[IdleLoop: File Generated]\n${filePath} - ${caption}`);
            return 'File logged internally';
        }
    };

    // Execute the agent process purely for side-effects (tool usage) and logging
    await aiAgent.processMessage(systemChatId, proactivePrompt, ctx);

    console.log('[IdleLoop] Proactive Task Completed.');
}

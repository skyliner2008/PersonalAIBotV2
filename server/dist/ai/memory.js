// ============================================================
// 3-Layer Memory Architecture
// ============================================================
// Layer 1: Short-term  — Last 5 messages (exact text, ~250 tokens)
// Layer 2: Mid-term    — Conversation summary in Markdown (~100-150 tokens)
// Layer 3: Long-term   — User profile facts & tags (~50-100 tokens)
//
// TOKEN BUDGET (target ~800-1500 per request):
//   System prompt:  ~200 tokens
//   Layer 3 profile: ~80 tokens
//   Layer 2 summary: ~120 tokens
//   Layer 1 recent:  ~250 tokens
//   User message:    ~50 tokens
//   AI response:     ~100-200 tokens
// ============================================================
import { aiChat } from './aiRouter.js';
import { getConversationMessages, getConversationSummary, updateConversationSummary, getMessageCount, getUserProfile, upsertUserProfile, addLog, } from '../database/db.js';
// ---- Config ----
const RECENT_MSG_LIMIT = 5; // Layer 1: keep last 5 messages
const SUMMARY_TRIGGER = 8; // Update summary every 8 new messages
const SUMMARY_MAX_TOKENS = 200; // Max tokens for summary generation
const PROFILE_MAX_TOKENS = 150; // Max tokens for profile extraction
/**
 * Build memory context for a conversation.
 * Returns 3 layers optimized for minimal token usage.
 */
export async function getConversationMemory(convId, userId, userName) {
    // ---- Layer 1: Recent messages (exact) ----
    const recentRaw = getConversationMessages(convId, RECENT_MSG_LIMIT);
    const recentMessages = recentRaw.map(m => ({
        role: m.role,
        content: m.content,
    }));
    // ---- Layer 2: Conversation summary ----
    const { summary, summaryMsgCount } = getConversationSummary(convId);
    const totalMsgs = getMessageCount(convId);
    let summaryMarkdown = summary;
    // Check if summary needs update (every SUMMARY_TRIGGER new messages)
    const newMsgsSinceSummary = totalMsgs - summaryMsgCount;
    if (newMsgsSinceSummary >= SUMMARY_TRIGGER && totalMsgs > RECENT_MSG_LIMIT) {
        try {
            summaryMarkdown = await generateSummary(convId, summary, summaryMsgCount);
            updateConversationSummary(convId, summaryMarkdown, totalMsgs);
            addLog('memory', 'Summary updated', `[${convId}] ${totalMsgs} msgs → ${summaryMarkdown.length} chars`, 'info');
        }
        catch (e) {
            addLog('memory', 'Summary failed', e.message, 'warning');
            // Keep old summary on failure
        }
    }
    // ---- Layer 3: User profile ----
    let userProfileMarkdown = '';
    const profile = getUserProfile(userId);
    if (profile) {
        userProfileMarkdown = formatUserProfile(profile);
    }
    // Update profile periodically (every 15 messages across all conversations)
    if (!profile || (totalMsgs > 10 && totalMsgs - (profile?.total_messages || 0) >= 15)) {
        try {
            await updateUserProfileFromHistory(userId, userName, convId, totalMsgs);
            const updated = getUserProfile(userId);
            if (updated)
                userProfileMarkdown = formatUserProfile(updated);
        }
        catch (e) {
            addLog('memory', 'Profile update failed', e.message, 'warning');
        }
    }
    // ---- Estimate tokens ----
    const tokenEstimate = estimateTokens(recentMessages, summaryMarkdown, userProfileMarkdown);
    return { recentMessages, summaryMarkdown, userProfileMarkdown, tokenEstimate };
}
// ============================================================
// LAYER 2: Conversation Summary Generation
// ============================================================
async function generateSummary(convId, existingSummary, lastSummaryCount) {
    // Get messages since last summary (or last 20 if no summary)
    const allMsgs = getConversationMessages(convId, 30);
    // Only use messages AFTER the last summary point
    const newMessages = lastSummaryCount > 0
        ? allMsgs.slice(Math.max(0, allMsgs.length - (allMsgs.length - lastSummaryCount + RECENT_MSG_LIMIT)))
        : allMsgs;
    if (newMessages.length < 3)
        return existingSummary;
    const msgText = newMessages
        .map(m => `${m.role === 'user' ? 'ลูกค้า' : 'แอดมิน'}: ${m.content}`)
        .join('\n');
    const prompt = [
        {
            role: 'system',
            content: `คุณคือผู้ช่วยสรุปบทสนทนา สรุปให้กระชับที่สุดเป็น Markdown (ไม่เกิน 80 คำ)
รูปแบบ:
## สรุป
- [หัวข้อหลัก]
- [สิ่งที่ลูกค้าต้องการ]
- [สิ่งที่ตกลง/รอดำเนินการ]

ห้ามใช้ <think> tag ห้ามอธิบายยาว ตอบเฉพาะ Markdown สรุปเท่านั้น`,
        },
        {
            role: 'user',
            content: existingSummary
                ? `สรุปเดิม:\n${existingSummary}\n\nข้อความใหม่:\n${msgText}\n\nอัปเดตสรุปให้รวมข้อมูลใหม่`
                : `สรุปบทสนทนานี้:\n${msgText}`,
        },
    ];
    const result = await aiChat('summary', prompt, {
        maxTokens: SUMMARY_MAX_TOKENS,
        temperature: 0.3,
    });
    let text = result.text || '';
    // Clean think tags if any
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    text = text.replace(/<\/?think>/gi, '').trim();
    return text || existingSummary;
}
// ============================================================
// LAYER 3: User Profile Extraction
// ============================================================
async function updateUserProfileFromHistory(userId, userName, convId, totalMsgs) {
    // Get recent user messages only
    const allMsgs = getConversationMessages(convId, 20);
    const userMsgs = allMsgs
        .filter(m => m.role === 'user')
        .map(m => m.content)
        .slice(-10);
    if (userMsgs.length < 3) {
        // Not enough data — just create/update basic profile
        const existing = getUserProfile(userId);
        upsertUserProfile(userId, userName, existing ? JSON.parse(existing.facts || '[]') : [], existing ? JSON.parse(existing.tags || '[]') : [], totalMsgs);
        return;
    }
    const prompt = [
        {
            role: 'system',
            content: `วิเคราะห์ข้อความของลูกค้าและสกัดข้อมูลสำคัญ ตอบเป็น JSON เท่านั้น (ไม่ต้อง markdown code block):
{"facts":["ข้อเท็จจริงสำคัญ 1","ข้อ 2"],"tags":["สนใจสินค้า","ลูกค้าเก่า"]}

กฎ:
- facts: ข้อเท็จจริงที่เป็นประโยชน์สำหรับการตอบแชทครั้งถัดไป (ชื่อ, สินค้าที่สนใจ, ปัญหาที่เคยมี, ที่อยู่)
- tags: หมวดหมู่สั้นๆ (สนใจสินค้า, ถามราคา, ลูกค้าเก่า, ร้องเรียน, สนใจโปรโมชัน)
- ไม่เกิน 5 facts และ 4 tags
- ห้ามใช้ <think> tag`,
        },
        {
            role: 'user',
            content: `ชื่อ: ${userName}\nข้อความล่าสุดของลูกค้า:\n${userMsgs.join('\n')}`,
        },
    ];
    const result = await aiChat('summary', prompt, {
        maxTokens: PROFILE_MAX_TOKENS,
        temperature: 0.2,
    });
    let text = result.text || '';
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    text = text.replace(/<\/?think>/gi, '').trim();
    // Strip markdown code fences if present
    text = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
        const parsed = JSON.parse(text);
        const facts = Array.isArray(parsed.facts) ? parsed.facts.slice(0, 5) : [];
        const tags = Array.isArray(parsed.tags) ? parsed.tags.slice(0, 4) : [];
        // Merge with existing facts (keep unique)
        const existing = getUserProfile(userId);
        if (existing) {
            const oldFacts = (() => { try {
                return JSON.parse(existing.facts || '[]');
            }
            catch {
                return [];
            } })();
            const mergedFacts = [...new Set([...facts, ...oldFacts])].slice(0, 8);
            const oldTags = (() => { try {
                return JSON.parse(existing.tags || '[]');
            }
            catch {
                return [];
            } })();
            const mergedTags = [...new Set([...tags, ...oldTags])].slice(0, 6);
            upsertUserProfile(userId, userName, mergedFacts, mergedTags, totalMsgs);
        }
        else {
            upsertUserProfile(userId, userName, facts, tags, totalMsgs);
        }
    }
    catch {
        // JSON parse failed — just update message count
        addLog('memory', 'Profile parse failed', `Raw: ${text.substring(0, 100)}`, 'warning');
        const existing = getUserProfile(userId);
        upsertUserProfile(userId, userName, existing ? JSON.parse(existing.facts || '[]') : [], existing ? JSON.parse(existing.tags || '[]') : [], totalMsgs);
    }
}
// ============================================================
// FORMATTING
// ============================================================
function formatUserProfile(profile) {
    const facts = (() => { try {
        return JSON.parse(profile.facts || '[]');
    }
    catch {
        return [];
    } })();
    const tags = (() => { try {
        return JSON.parse(profile.tags || '[]');
    }
    catch {
        return [];
    } })();
    if (facts.length === 0 && tags.length === 0)
        return '';
    let md = '';
    if (facts.length > 0) {
        md += `ข้อมูลลูกค้า: ${facts.join(' | ')}`;
    }
    if (tags.length > 0) {
        md += (md ? ' · ' : '') + `[${tags.join(', ')}]`;
    }
    return md;
}
// ============================================================
// TOKEN ESTIMATION
// ============================================================
function estimateTokens(messages, summary, profile) {
    // Rough estimate: 1 token ≈ 4 chars (English) or 2 chars (Thai)
    let chars = 0;
    for (const m of messages)
        chars += m.content.length;
    chars += summary.length;
    chars += profile.length;
    chars += 600; // system prompt + overhead
    // Thai text uses ~2 chars per token on average
    return Math.round(chars / 2.5);
}
//# sourceMappingURL=memory.js.map
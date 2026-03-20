/**
 * Build optimized message array using 3-Layer Memory Architecture.
 *
 * Token budget breakdown:
 *   System prompt (persona + rules):  ~200 tokens
 *   Layer 3 (user profile):           ~80 tokens
 *   Layer 2 (conversation summary):   ~120 tokens
 *   Layer 1 (last 5 messages):        ~250 tokens
 *   New user message:                 ~50 tokens
 *   = ~800-1000 per request (down from 2000-6000)
 */
/**
 * Helper to append valid recent messages to an array with optional limit.
 */
function appendRecentMessages(target, source, limit) {
    const recent = limit ? source.slice(-limit) : source;
    for (const msg of recent) {
        const isValid = msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system';
        if (isValid) {
            target.push(msg);
        }
        else {
            console.warn(`Invalid role '${msg.role}' encountered. Skipping.`);
        }
    }
}
function assembleMessages(systemPrompt, recentMessages, newMessage, limit) {
    const messages = [{ role: 'system', content: systemPrompt }];
    appendRecentMessages(messages, recentMessages, limit);
    messages.push({ role: 'user', content: newMessage });
    return messages;
}
function buildSystemPrompt(basePrompt, options) {
    const parts = [basePrompt];
    if (options.traits && options.traits.length > 0) {
        parts.push(`\nลักษณะ: ${options.traits.join(', ')}`);
    }
    if (options.userProfile) {
        parts.push(`\n\n[ข้อมูลลูกค้า] ${options.userProfile}`);
    }
    if (options.summary) {
        parts.push(`\n\n[สรุปบทสนทนาก่อนหน้า]\n${options.summary}`);
    }
    parts.push(`\n\n${options.rules}`);
    return parts.join('');
}
export function buildChatMessages(systemInstruction, memory, newMessage) {
    const rules = `[กฎสำคัญมาก]
- ⚠️ ตอบสั้นมากๆ เหมือนแชท Messenger จริง! ตอบแค่ 1-2 ประโยคสั้นๆ ห้ามเกิน 100 ตัวอักษรเด็ดขาด!
- โต้ตอบเป็นภาษาเดียวกับที่ลูกค้าใช้
- ห้ามบอกว่าเป็น AI หรือ bot
- 🚫 **ห้ามใช้อีโมจิเด็ดขาด** (No Emojis)
- ไม่รู้คำตอบ → "ขอเช็คข้อมูลให้ก่อนนะคะ แป๊บนึงค่ะ 🙏"
- ห้ามใช้ <think> tag ใดๆ
- ห้ามพูดซ้ำข้อความเก่า
- ห้ามเขียนยาว ห้ามอธิบายเยอะ ห้ามใส่หัวข้อ ห้ามใช้ bullet points
- ห้ามตอบว่างเปล่า`;
    const systemPrompt = buildSystemPrompt(systemInstruction, {
        userProfile: memory.userProfileMarkdown,
        summary: memory.summaryMarkdown,
        rules
    });
    return assembleMessages(systemPrompt, memory.recentMessages, newMessage);
}
/**
 * Legacy fallback: Build messages without memory system.
 * Used when memory is not available (e.g., test replies).
 */
export function buildChatMessagesLegacy(persona, conversationHistory, newMessage) {
    const traits = (() => {
        try {
            if (!persona.personality_traits)
                return [];
            const rawInput = persona.personality_traits.trim();
            // Basic validation: must look like a JSON array
            if (!rawInput.startsWith('[') || !rawInput.endsWith(']')) {
                return [];
            }
            const parsed = JSON.parse(rawInput);
            if (Array.isArray(parsed)) {
                return parsed
                    .map(t => String(t)
                    .replace(/[<>{}]/g, '') // Sanitize potentially dangerous characters
                    .replace(/[\r\n\t]/g, ' ')
                    .trim())
                    .filter(t => t.length > 0 && t.length <= 200); // Limit length
            }
            return [];
        }
        catch (e) {
            console.error('Error parsing personality traits:', e);
            return [];
        }
    })();
    const rules = `[กฎ]
- ตอบภาษาเดียวกับลูกค้า สั้นกระชับ 1-3 ประโยค
- ห้ามบอกว่าเป็น AI/bot
- ห้ามใช้ <think> tag ใดๆ ตอบข้อความตรงเท่านั้น`;
    const systemPromptParts = [persona.system_prompt];
    if (traits.length > 0) {
        systemPromptParts.push(`\nลักษณะ: ${traits.join(', ')}`);
    }
    if (persona.speaking_style) {
        systemPromptParts.push(`\nสไตล์การพูด: ${persona.speaking_style}`);
    }
    systemPromptParts.push(`\n\n${rules}`);
    const systemPrompt = systemPromptParts.join('');
    // Use last 5 messages (not 20) for token efficiency
    const NUM_RECENT_MESSAGES = 5;
    const recent = conversationHistory.slice(-NUM_RECENT_MESSAGES);
    return assembleMessages(systemPrompt, recent, newMessage);
}
//# sourceMappingURL=chatPersona.js.map
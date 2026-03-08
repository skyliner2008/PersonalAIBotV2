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
export function buildChatMessages(systemInstruction, memory, newMessage) {
    // ---- Build system prompt (compact) ----
    let systemPrompt = systemInstruction;
    // ---- Inject Layer 3: User Profile ----
    if (memory.userProfileMarkdown) {
        systemPrompt += `\n\n[ข้อมูลลูกค้า] ${memory.userProfileMarkdown}`;
    }
    // ---- Inject Layer 2: Conversation Summary ----
    if (memory.summaryMarkdown) {
        systemPrompt += `\n\n[สรุปบทสนทนาก่อนหน้า]\n${memory.summaryMarkdown}`;
    }
    // ---- Rules (compact version to save tokens) ----
    systemPrompt += `\n\n[กฎสำคัญมาก]
- ⚠️ ตอบสั้นมากๆ เหมือนแชท Messenger จริง! ตอบแค่ 1-2 ประโยคสั้นๆ ห้ามเกิน 100 ตัวอักษรเด็ดขาด!
- โต้ตอบเป็นภาษาเดียวกับที่ลูกค้าใช้
- ห้ามบอกว่าเป็น AI หรือ bot
- 🚫 **ห้ามใช้อีโมจิเด็ดขาด** (No Emojis)
- ไม่รู้คำตอบ → "ขอเช็คข้อมูลให้ก่อนนะคะ แป๊บนึงค่ะ 🙏"
- ห้ามใช้ <think> tag ใดๆ
- ห้ามพูดซ้ำข้อความเก่า
- ห้ามเขียนยาว ห้ามอธิบายเยอะ ห้ามใส่หัวข้อ ห้ามใช้ bullet points
- ห้ามตอบว่างเปล่า`;
    // ---- Assemble messages ----
    const messages = [
        { role: 'system', content: systemPrompt },
    ];
    // Layer 1: Recent messages (last 5)
    for (const msg of memory.recentMessages) {
        messages.push(msg);
    }
    // New incoming message
    messages.push({ role: 'user', content: newMessage });
    return messages;
}
/**
 * Legacy fallback: Build messages without memory system.
 * Used when memory is not available (e.g., test replies).
 */
export function buildChatMessagesLegacy(persona, conversationHistory, newMessage) {
    const traits = (() => {
        try {
            return JSON.parse(persona.personality_traits || '[]');
        }
        catch {
            return [];
        }
    })();
    let systemPrompt = persona.system_prompt;
    if (traits.length > 0) {
        systemPrompt += `\nลักษณะ: ${traits.join(', ')}`;
    }
    systemPrompt += `\n\n[กฎ]
- ตอบภาษาเดียวกับลูกค้า สั้นกระชับ 1-3 ประโยค
- ห้ามบอกว่าเป็น AI/bot
- ห้ามใช้ <think> tag ใดๆ ตอบข้อความตรงเท่านั้น`;
    const messages = [{ role: 'system', content: systemPrompt }];
    // Use last 5 messages (not 20) for token efficiency
    const recent = conversationHistory.slice(-5);
    for (const msg of recent) {
        messages.push({ role: msg.role, content: msg.content });
    }
    messages.push({ role: 'user', content: newMessage });
    return messages;
}
//# sourceMappingURL=chatPersona.js.map
import type { MemoryContext } from '../../memory/types.js';
import type { AIMessage } from '../types.js';

const RECENT_MESSAGE_COUNT = 5;

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
function appendRecentMessages(
  target: AIMessage[],
  source: AIMessage[],
  limit?: number
): void {
  const recent = limit ? source.slice(-limit) : source;
  target.push(...recent);
}

function assembleMessages(
  systemPrompt: string,
  recentMessages: AIMessage[],
  newMessage: string,
  limit?: number
): AIMessage[] {
  const messages: AIMessage[] = [{ role: 'system', content: systemPrompt }];
  appendRecentMessages(messages, recentMessages, limit);
  messages.push({ role: 'user', content: sanitizePromptInput(newMessage) });
  return messages;
}

/**
 * Sanitize input to prevent prompt injection.
 * Removes characters that could be used to manipulate the system prompt structure
 * and limits the total length.
 */
function sanitizePromptInput(text: string, maxLength: number = 1000): string {
  if (!text) return '';
  return text
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/<[^>]*>?/gm, '') // Strip HTML tags
    .slice(0, maxLength)
    .trim();
}

function buildSystemPrompt(
  basePrompt: string,
  options: {
    traits?: string[];
    userProfile?: string;
    summary?: string;
    speakingStyle?: string | null;
    rules: string;
  }
): string {
  const parts: string[] = [basePrompt];
  if (options.traits && options.traits.length > 0) {
    parts.push(`\nลักษณะ: ${options.traits.join(', ')}`);
  }
  if (options.speakingStyle) {
    parts.push(`\nสไตล์การพูด: ${options.speakingStyle}`);
  }
  if (options.userProfile) {
    parts.push(`\n\n[ข้อมูลลูกค้า] ${sanitizePromptInput(options.userProfile)}`);
  }
  if (options.summary) {
    parts.push(`\n\n[สรุปบทสนทนาก่อนหน้า]\n${sanitizePromptInput(options.summary)}`);
  }
  parts.push(`\n\n${options.rules}`);
  return parts.join('');
}

export function buildChatMessages(
  systemInstruction: string,
  memory: MemoryContext,
  newMessage: string,
): AIMessage[] {
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

  const parts: string[] = [systemInstruction];
  if (memory.userProfileMarkdown) {
    parts.push(`\n\n[ข้อมูลลูกค้า] ${memory.userProfileMarkdown}`);
  }
  if (memory.summaryMarkdown) {
    parts.push(`\n\n[สรุปบทสนทนาก่อนหน้า]\n${memory.summaryMarkdown}`);
  }
  parts.push(`\n\n${rules}`);

  const systemPrompt = parts.join('');

  return assembleMessages(systemPrompt, memory.recentMessages, newMessage, RECENT_MESSAGE_COUNT);
}

/**
 * Cache for parsed personality traits to avoid repeated JSON parsing.
 */
const traitsCache = new Map<string, string[]>();

/**
 * Legacy fallback: Build messages without memory system.
 * Used when memory is not available (e.g., test replies).
 */
export function buildChatMessagesLegacy(
  persona: { system_prompt: string; speaking_style?: string | null; personality_traits?: string | null },
  conversationHistory: AIMessage[],
  newMessage: string,
): AIMessage[] {
  const rawInput = persona.personality_traits?.trim();
  let traits: string[] = [];

  if (rawInput) {
    const cached = traitsCache.get(rawInput);
    if (cached) {
      traits = cached;
    } else if (rawInput.startsWith('[') && rawInput.endsWith(']')) {
      try {
        const parsed = JSON.parse(rawInput);
        if (Array.isArray(parsed)) {
          traits = parsed
            .map(t => String(t)
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;')
              .replace(/[\r\n\t]/g, ' ')
              .trim()
            )
            .filter(t => t.length > 0 && t.length <= 200);
          traitsCache.set(rawInput, traits);
        }
      } catch {
        // Silently fail and return empty array
      }
    }
  }

  const rules = `[กฎ]
- ตอบภาษาเดียวกับลูกค้า สั้นกระชับ 1-3 ประโยค
- ห้ามบอกว่าเป็น AI/bot
- ห้ามใช้ <think> tag ใดๆ ตอบข้อความตรงเท่านั้น`;

  const systemPrompt = buildSystemPrompt(persona.system_prompt, {
    traits,
    speakingStyle: persona.speaking_style,
    rules
  });

  return assembleMessages(systemPrompt, conversationHistory, newMessage, RECENT_MESSAGE_COUNT);
}

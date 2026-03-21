import type { MemoryContext } from '../../memory/types.js';
import type { AIMessage } from '../types.js';

const RECENT_MESSAGE_COUNT = 5;

type SupportedLanguage = 'th' | 'en';

const CHAT_RULES: Record<SupportedLanguage, string> = {
  th: `[กฎสำคัญมาก]
- ⚠️ ตอบสั้นมากๆ เหมือนแชท Messenger จริง! ตอบแค่ 1-2 ประโยคสั้นๆ ห้ามเกิน 100 ตัวอักษรเด็ดขาด!
- โต้ตอบเป็นภาษาเดียวกับที่ลูกค้าใช้
- ห้ามบอกว่าเป็น AI หรือ bot
- 🚫 **ห้ามใช้อีโมจิเด็ดขาด** (No Emojis)
- ไม่รู้คำตอบ → "ขอเช็คข้อมูลให้ก่อนนะคะ แป๊บนึงค่ะ 🙏"
- ห้ามใช้ <think> tag ใดๆ
- ห้ามพูดซ้ำข้อความเก่า
- ห้ามเขียนยาว ห้ามอธิบายเยอะ ห้ามใส่หัวข้อ ห้ามใช้ bullet points
- ห้ามตอบว่างเปล่า`,
  en: `[CRITICAL RULES]
- ⚠️ Reply very briefly like a real Messenger chat! 1-2 short sentences only. Max 100 characters!
- Respond in the same language as the user.
- Never mention being an AI or bot.
- 🚫 **Strictly NO emojis**.
- If you don't know the answer → "Let me check that for you. One moment please."
- Do not use <think> tags.
- Do not repeat previous messages.
- No long explanations, no headers, no bullet points.
- Do not send empty responses.`
};

const SYSTEM_LABELS: Record<SupportedLanguage, Record<string, string>> = {
  th: {
    traits: 'ลักษณะ',
    style: 'สไตล์การพูด',
    profile: 'ข้อมูลลูกค้า',
    summary: 'สรุปบทสนทนาก่อนหน้า'
  },
  en: {
    traits: 'Traits',
    style: 'Speaking Style',
    profile: 'User Profile',
    summary: 'Conversation Summary'
  }
};

const DEFAULT_LANG: SupportedLanguage = 'th';
const DEFAULT_CHAT_RULES = CHAT_RULES[DEFAULT_LANG];

/**
 * Build optimized message array using 3-Layer Memory Architecture.
 * Pre-allocates the array for performance and applies sanitization.
 *
 * Token budget breakdown:
 *   System prompt (persona + rules):  ~200 tokens
 *   Layer 3 (user profile):           ~80 tokens
 *   Layer 2 (conversation summary):   ~120 tokens
 *   Layer 1 (last 5 messages):        ~250 tokens
 *   New user message:                 ~50 tokens
 *   = ~800-1000 per request (down from 2000-6000)
 */
function assembleMessages(
  systemPrompt: string,
  recentMessages: AIMessage[],
  newMessage: string,
  limit: number = RECENT_MESSAGE_COUNT
): AIMessage[] {
  const sourceArray = recentMessages || [];
  let recent: AIMessage[];

  // 1. Calculate safe limit and slice recent messages (Hard cap at 20 messages)
  // Optimization: If limit is 0 or negative, we treat it as "no limit" and avoid slice()
  // to prevent unnecessary array allocation/copying.
  if (limit <= 0) {
    recent = sourceArray;
  } else {
    const safeLimit = Math.min(limit, 20);
    recent = sourceArray.length > safeLimit ? sourceArray.slice(-safeLimit) : sourceArray;
  }

  // 2. Pre-allocate array with exact required size: system + recent + user
  const messages: AIMessage[] = new Array(recent.length + 2);
  
  // 3. Fill array using direct index assignment to avoid dynamic resizing
  messages[0] = { role: 'system', content: systemPrompt };
  
  for (let i = 0; i < recent.length; i++) {
    messages[i + 1] = {
      ...recent[i],
      content: sanitizePromptInput(recent[i].content, 1000, false)
    };
  }
  
  messages[recent.length + 1] = { 
    role: 'user', 
    content: sanitizePromptInput(newMessage) 
  };

  return messages;
}

/**
 * Sanitize input to prevent prompt injection.
 * Neutralizes common injection patterns and removes characters that could 
 * be used to manipulate the system prompt structure.
 */
function sanitizePromptInput(text: string, maxLength: number = 1000, neutralize: boolean = true): string {
  if (!text) return '';
  
  // 1. Normalize, strip control characters
  let sanitized = text
    .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
    .slice(0, maxLength)
    .trim();

  // 2. Neutralize common prompt injection phrases using Zero-Width Space (U+200B)
  // This breaks pattern matching for LLM instructions while remaining human-readable.
  if (neutralize) {
    const injectionPatterns = [
      /ignore (all )?previous/gi,
      /system instruction/gi,
      /you are now/gi,
      /acting as/gi,
      /new rules/gi,
      /disregard/gi,
      /forget everything/gi,
      /dan mode/gi,
      /jailbreak/gi,
      /\b(system|assistant|user|human|bot):/gi
    ];

    injectionPatterns.forEach(regex => {
      sanitized = sanitized.replace(regex, (match) => match[0] + '\u200B' + match.slice(1));
    });
  }

  // 3. Escape structural characters using a robust regex
  const charMap: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;', '[': '(', ']': ')'
  };
  return sanitized.replace(/[&<>"'\[\]]/g, (m) => charMap[m]);
}

/**
 * Sanitize a single personality trait.
 */
function sanitizeTrait(trait: string): string {
  return sanitizePromptInput(trait, 200).replace(/\s+/g, ' ');
}

function buildSystemPrompt(
  basePrompt: string,
  options: {
    traits?: string[];
    userProfile?: string;
    summary?: string;
    speakingStyle?: string;
    rules: string;
  }
): string {
  let prompt = sanitizePromptInput(basePrompt, 2000);

  if (options.traits && options.traits.length > 0) {
    prompt += `\nลักษณะ: ${options.traits.join(', ')}`;
  }
  if (options.speakingStyle) {
    prompt += `\nสไตล์การพูด: ${sanitizePromptInput(options.speakingStyle, 500)}`;
  }
  if (options.userProfile) {
    prompt += `\n\n[ข้อมูลลูกค้า] ${sanitizePromptInput(options.userProfile)}`;
  }
  if (options.summary) {
    prompt += `\n\n[สรุปบทสนทนาก่อนหน้า]\n${sanitizePromptInput(options.summary)}`;
  }

  prompt += `\n\n${options.rules}`;
  return prompt;
}

export function buildChatMessages(
  systemPrompt: string,
  memory: MemoryContext,
  newMessage: string,
): AIMessage[] {
  const formattedPrompt = buildSystemPrompt(systemPrompt, {
    userProfile: memory.coreMemoryText || undefined,
    summary: memory.conversationSummary || undefined,
    rules: DEFAULT_CHAT_RULES
  });

  return assembleMessages(formattedPrompt, memory.workingMessages, newMessage, RECENT_MESSAGE_COUNT);
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
  persona: { systemPrompt: string; speaking_style?: string; personality_traits?: string | null },
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
            .map(t => sanitizeTrait(String(t)))
            .filter(t => t.length > 0);
          traitsCache.set(rawInput, traits);
        }
      } catch (error) {
        console.warn('[Persona] Failed to parse personality_traits JSON:', error);
      }
    }
  }

  const rules = DEFAULT_CHAT_RULES;

  const formattedPrompt = buildSystemPrompt(persona.systemPrompt, {
    traits,
    speakingStyle: persona.speaking_style,
    rules
  });

  return assembleMessages(formattedPrompt, conversationHistory, newMessage, RECENT_MESSAGE_COUNT);
}

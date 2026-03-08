// ============================================================
// Facebook Webhook Handler
// Processes incoming events from Facebook webhooks
// ============================================================

import { addLog, upsertConversation, addMessage, findQAMatch, getDefaultPersona, getConversationMessages as getDbMessages, getDb } from '../database/db.js';
import { sendMessage, sendTypingAction, getFBConfig } from './graphAPI.js';
import { aiChat, getProviderForTask } from '../ai/aiRouter.js';
import { stripThinkTags, delay, randomBetween } from '../utils.js';
import { buildChatMessagesLegacy as buildChatMessages } from '../ai/prompts/chatPersona.js';
import type { FBWebhookEntry, FBMessagingEvent, FBChangeEvent } from './types.js';

// Track recently processed message IDs — DB-backed for persistence across restarts
const processedMessageIds = new Set<string>();
const MAX_PROCESSED = 5000;

function initDedup(): void {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS processed_messages (mid TEXT PRIMARY KEY, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    // Load recent entries into memory
    const rows = db.prepare('SELECT mid FROM processed_messages ORDER BY created_at DESC LIMIT ?').all(MAX_PROCESSED) as any[];
    for (const row of rows) processedMessageIds.add(row.mid);
  } catch { /* table may already exist */ }
}
initDedup();

// markProcessed logic is inlined in handleMessagingEvent for atomicity

// ---- Event emitter for Socket.io broadcast ----
type BroadcastFn = (event: string, data: any) => void;
let broadcastFn: BroadcastFn | null = null;

export function setWebhookBroadcast(fn: BroadcastFn) {
  broadcastFn = fn;
}

function broadcast(event: string, data: any) {
  if (broadcastFn) broadcastFn(event, data);
}

// ============================================================
// Main Webhook Processor
// ============================================================

export async function processWebhookEntries(entries: FBWebhookEntry[]): Promise<void> {
  for (const entry of entries) {
    // Handle messaging events (Messenger)
    if (entry.messaging) {
      for (const event of entry.messaging) {
        await handleMessagingEvent(event);
      }
    }

    // Handle change events (page feed: comments, posts, etc.)
    if (entry.changes) {
      for (const change of entry.changes) {
        await handleChangeEvent(change, entry.id);
      }
    }
  }
}

// ============================================================
// Messenger Message Handler
// ============================================================

async function handleMessagingEvent(event: FBMessagingEvent): Promise<void> {
  const cfg = getFBConfig();

  // Skip if it's from the page itself (echo)
  if (event.sender.id === cfg.pageId) return;

  // Handle read receipts
  if (event.read) {
    addLog('webhook', 'Message read', `User ${event.sender.id} read messages`, 'info');
    return;
  }

  // Handle delivery confirmations
  if (event.delivery) {
    return; // Silent — just acknowledge
  }

  // Handle postbacks (button clicks)
  if (event.postback) {
    addLog('webhook', 'Postback received', `From: ${event.sender.id}, Payload: ${event.postback.payload}`, 'info');
    broadcast('webhook:postback', {
      senderId: event.sender.id,
      title: event.postback.title,
      payload: event.postback.payload,
    });
    return;
  }

  // Handle text messages
  if (event.message?.text) {
    const mid = event.message.mid;

    // Deduplicate — atomic check+set to prevent race condition
    if (processedMessageIds.has(mid)) return;
    processedMessageIds.add(mid); // memory gate first
    try { getDb().prepare('INSERT OR IGNORE INTO processed_messages (mid) VALUES (?)').run(mid); } catch { }
    // Evict old entries
    if (processedMessageIds.size > MAX_PROCESSED) {
      const toDelete = [...processedMessageIds].slice(0, 1000);
      for (const id of toDelete) processedMessageIds.delete(id);
      try {
        const stmt = getDb().prepare('DELETE FROM processed_messages WHERE mid = ?');
        getDb().transaction(() => { for (const id of toDelete) stmt.run(id); })();
      } catch { }
    }

    const senderId = event.sender.id;
    const text = event.message.text;

    addLog('webhook', 'Message received', `From: ${senderId}, Text: "${text.substring(0, 60)}"`, 'info');

    broadcast('webhook:message', {
      senderId,
      text,
      mid,
      timestamp: event.timestamp,
    });

    // Auto-reply via AI
    await processAndReplyMessage(senderId, text, mid);
  }

  // Handle attachments (images, files, etc.)
  if (event.message?.attachments) {
    const senderId = event.sender.id;
    const attachTypes = event.message.attachments.map(a => a.type).join(', ');
    addLog('webhook', 'Attachment received', `From: ${senderId}, Types: ${attachTypes}`, 'info');

    broadcast('webhook:attachment', {
      senderId,
      attachments: event.message.attachments,
      mid: event.message.mid,
    });
  }
}

// ============================================================
// Auto-Reply Logic (similar to content script flow but via API)
// ============================================================

async function processAndReplyMessage(senderId: string, text: string, messageId: string): Promise<void> {
  const convId = `fb_${senderId}`;

  try {
    // 1. Upsert conversation
    upsertConversation(convId, senderId, `User_${senderId}`);

    // 2. Save incoming message
    addMessage(convId, 'user', text, messageId);

    // 3. Check Q&A first
    const qaMatch = findQAMatch(text);
    if (qaMatch) {
      const reply = qaMatch.answer;
      addMessage(convId, 'assistant', reply);
      addLog('webhook', 'Q&A reply', `"${text.substring(0, 40)}" → "${reply.substring(0, 40)}"`, 'success');

      await sendTypingAction(senderId, 'typing_on');
      await delay(randomBetween(1000, 3000));
      await sendMessage(senderId, reply);
      await sendTypingAction(senderId, 'typing_off');

      broadcast('webhook:reply', { senderId, reply, source: 'qa' });
      return;
    }

    // 4. Get persona (fallback to sensible defaults if none configured)
    const personaRow = getDefaultPersona();
    const persona = {
      system_prompt:      personaRow?.system_prompt      ?? 'คุณคือแอดมินเพจ ตอบสุภาพ เป็นกันเอง',
      speaking_style:     personaRow?.speaking_style     ?? 'casual-thai',
      personality_traits: personaRow?.personality_traits ?? '["friendly","helpful"]',
      temperature:        personaRow?.temperature        ?? 0.7,
      max_tokens:         personaRow?.max_tokens         ?? 500,
    };

    // 5. Get conversation history
    const history = getDbMessages(convId, 20);

    // 6. Build AI prompt & get reply
    const aiMessages = buildChatMessages(persona, history, text);
    const aiResult = await aiChat('chat', aiMessages, {
      temperature: persona.temperature || 0.7,
      maxTokens: persona.max_tokens || 500,
    });

    // 7. Strip thinking tags
    let reply = stripThinkTags(aiResult.text);

    if (!reply) {
      reply = 'ขอตรวจสอบข้อมูลก่อนนะคะ แล้วจะแจ้งกลับค่ะ';
    }

    // 8. Save AI reply
    addMessage(convId, 'assistant', reply);
    addLog('webhook', 'AI reply via API', `To: ${senderId}, "${reply.substring(0, 50)}"`, 'success');

    // 9. Send via Graph API with human-like delay
    await sendTypingAction(senderId, 'typing_on');
    const typingDelay = Math.min(reply.length * 50, 5000); // ~50ms per char, max 5s
    await delay(randomBetween(1500, typingDelay));
    await sendMessage(senderId, reply);
    await sendTypingAction(senderId, 'typing_off');

    broadcast('webhook:reply', { senderId, reply, source: 'ai', usage: aiResult.usage });

  } catch (e: any) {
    addLog('webhook', 'Reply error', `${senderId}: ${e.message}`, 'error');
  }
}

// ============================================================
// Page Feed Change Handler (comments, etc.)
// ============================================================

async function handleChangeEvent(change: FBChangeEvent, pageId: string): Promise<void> {
  if (change.field === 'feed' && change.value) {
    const v = change.value;

    // New comment on a post
    if (v.item === 'comment' && v.verb === 'add' && v.comment_id) {
      addLog('webhook', 'New comment', `From: ${v.from?.name}, Post: ${v.post_id}, Text: "${(v.message || '').substring(0, 60)}"`, 'info');

      broadcast('webhook:comment', {
        commentId: v.comment_id,
        postId: v.post_id,
        from: v.from,
        message: v.message,
      });

      // Auto-reply to comment is handled by commentBot or can be triggered here
    }

    // New post on page
    if (v.item === 'post' && v.verb === 'add') {
      addLog('webhook', 'New post', `From: ${v.from?.name}, Post: ${v.post_id}`, 'info');
      broadcast('webhook:post', { postId: v.post_id, from: v.from });
    }
  }
}

// ---- Utility functions imported from ../utils.js ----

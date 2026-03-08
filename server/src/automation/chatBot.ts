import type { Page, ElementHandle } from 'playwright';
import { newPage, humanDelay, isRunning, navigateWithRetry } from './browser.js';
import { addLog, getDefaultPersona, upsertConversation, addMessage, getConversationMessages, findQAMatch, dbGet } from '../database/db.js';
import { aiChat } from '../ai/aiRouter.js';
import { buildChatMessagesLegacy as buildChatMessages } from '../ai/prompts/chatPersona.js';
import { config } from '../config.js';
import { stripThinkTags } from '../utils.js';
import type { Server as SocketServer } from 'socket.io';

let chatPage: Page | null = null;
let isMonitoring = false;
let pollInterval: NodeJS.Timeout | null = null;

const MESSENGER_URL = 'https://www.facebook.com/messages/t/';
const MAX_CONSECUTIVE_ERRORS = 3;
let consecutiveErrors = 0;

// Track the last message we've seen per conversation to avoid replying to ourselves
const lastRepliedMessageId = new Map<string, string>();

// ============================================================
// Helpers
// ============================================================

function isPageAlive(): boolean {
  try { return !!chatPage && !chatPage.isClosed() && isRunning(); }
  catch { return false; }
}

function forceStop(io: SocketServer): void {
  isMonitoring = false;
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  chatPage = null;
  io.emit('chatbot:status', { active: false });
}

function isClosedError(msg: string): boolean {
  return msg.includes('closed') || msg.includes('destroyed') || msg.includes('disposed') || msg.includes('Target page');
}

/**
 * Extract FB user ID from a Messenger URL like /messages/t/100015232654041
 */
function extractUserId(url: string): string | null {
  const m = url.match(/\/messages\/t\/(\d+)/);
  return m ? m[1] : null;
}

// ============================================================
// Start / Stop
// ============================================================

export async function startChatMonitor(io: SocketServer): Promise<void> {
  if (isMonitoring) return;
  isMonitoring = true;
  consecutiveErrors = 0;

  try {
    // Open a dedicated page for Messenger
    chatPage = await newPage();
    await navigateWithRetry(chatPage, MESSENGER_URL);
    await humanDelay(3000, 5000);

    addLog('chatbot', 'Chat monitor started', undefined, 'success');
    console.log('[ChatBot] Started — monitoring Messenger');
    io.emit('chatbot:status', { active: true });

    // Main poll loop
    pollInterval = setInterval(async () => {
      if (!isMonitoring) return;

      if (!isPageAlive()) {
        console.log('[ChatBot] Page/browser gone, auto-stopping');
        addLog('chatbot', 'Auto-stopped (browser closed)', undefined, 'warning');
        forceStop(io);
        return;
      }

      try {
        await pollUnreadConversations(io);
        consecutiveErrors = 0;
      } catch (e: any) {
        const msg = e?.message || String(e);
        if (isClosedError(msg)) { forceStop(io); return; }

        consecutiveErrors++;
        if (consecutiveErrors <= MAX_CONSECUTIVE_ERRORS) {
          addLog('chatbot', 'Poll error', msg, 'warning');
          console.error(`[ChatBot] Poll error (${consecutiveErrors}):`, msg);
        }
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          addLog('chatbot', 'Auto-stopped (repeated errors)', msg, 'error');
          forceStop(io);
        }
      }
    }, 7000); // Check every 7 seconds

  } catch (e: any) {
    addLog('chatbot', 'Failed to start chat monitor', String(e), 'error');
    isMonitoring = false;
    io.emit('chatbot:status', { active: false });
  }
}

export function stopChatMonitor(io: SocketServer): void {
  isMonitoring = false;
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  if (chatPage) {
    try { if (!chatPage.isClosed()) chatPage.close().catch(() => { }); } catch { }
  }
  chatPage = null;
  addLog('chatbot', 'Chat monitor stopped', undefined, 'info');
  console.log('[ChatBot] Stopped');
  io.emit('chatbot:status', { active: false });
}

export function isChatMonitorActive(): boolean {
  return isMonitoring;
}

// ============================================================
// Core logic: poll the conversation list for unread badges
// ============================================================

async function pollUnreadConversations(io: SocketServer): Promise<void> {
  if (!isPageAlive()) return;
  const page = chatPage!;

  // Make sure we're on the Messenger inbox (conversation list)
  const currentUrl = page.url();
  if (!currentUrl.includes('/messages')) {
    console.log('[ChatBot] Not on Messenger, navigating back...');
    await navigateWithRetry(page, MESSENGER_URL);
    await humanDelay(2000, 3000);
  }

  // ---- Step 1: Find conversation items that have unread indicators ----
  // Messenger shows unread threads with a bold title or a blue dot.
  // We look for conversation links in the sidebar.
  const convLinks = await page.$$('a[href*="/messages/t/"]');
  if (convLinks.length === 0) {
    // Try alternate: Messenger might use different structure
    return;
  }

  // Collect conversations with unread messages
  const unreadConvs: { userId: string; url: string; name: string; element: ElementHandle }[] = [];

  for (const link of convLinks) {
    try {
      const href = await link.getAttribute('href');
      if (!href || !href.includes('/messages/t/')) continue;

      const userId = extractUserId(href);
      if (!userId) continue;

      // Check if this conversation has unread indicator
      // Facebook marks unread with aria/bold/dot — look for visual cues
      const parentLi = await link.evaluateHandle(el => el.closest('[role="row"], [role="listitem"], li'));
      const parentEl = parentLi.asElement();

      let hasUnread = false;
      if (parentEl) {
        // Method 1: check for "unread" in aria-label
        const ariaLabel = await parentEl.getAttribute('aria-label') || '';
        if (ariaLabel.toLowerCase().includes('unread') || ariaLabel.includes('ยังไม่ได้อ่าน')) {
          hasUnread = true;
        }

        // Method 2: check for bold text (unread conversations have bold title)
        if (!hasUnread) {
          const boldEl = await parentEl.$('span[style*="font-weight"], strong, span[class*="bold"]');
          if (boldEl) hasUnread = true;
        }
      }

      // Also check: have we already replied to the latest message in this conv?
      // If yes, skip it
      if (!hasUnread && lastRepliedMessageId.has(userId)) continue;

      // Get user name from the link
      let name = 'Unknown';
      try {
        const nameEl = await link.$('span');
        if (nameEl) name = (await nameEl.textContent())?.trim() || 'Unknown';
      } catch { }

      if (hasUnread) {
        unreadConvs.push({ userId, url: `https://www.facebook.com${href}`, name, element: link });
      }
    } catch { continue; }
  }

  if (unreadConvs.length === 0) return;

  console.log(`[ChatBot] Found ${unreadConvs.length} unread conversation(s)`);

  // ---- Step 2: Process each unread conversation ----
  for (const conv of unreadConvs) {
    if (!isPageAlive() || !isMonitoring) return;

    try {
      await processConversation(page, conv.userId, conv.url, conv.name, io);

      // Go back to inbox for next conversation
      if (!isPageAlive()) return;
      await navigateWithRetry(page, MESSENGER_URL);
      await humanDelay(2000, 3000);
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (isClosedError(msg)) return;
      console.error(`[ChatBot] Error processing conv ${conv.userId}:`, msg);
      addLog('chatbot', `Error processing ${conv.name}`, msg, 'error');
    }
  }
}

// ============================================================
// Process a single conversation
// ============================================================

async function processConversation(
  page: Page,
  userId: string,
  convUrl: string,
  userName: string,
  io: SocketServer
): Promise<void> {
  console.log(`[ChatBot] Opening conversation: ${userName} (${userId})`);
  addLog('chatbot', `Processing chat: ${userName}`, userId, 'info');

  // Navigate directly to this conversation by URL
  await navigateWithRetry(page, convUrl);
  await humanDelay(2000, 3000);
  if (!isPageAlive()) return;

  // Verify URL matches expected conversation
  const currentUrl = page.url();
  const currentUserId = extractUserId(currentUrl);
  if (currentUserId !== userId) {
    console.warn(`[ChatBot] URL mismatch! Expected ${userId}, got ${currentUserId}`);
    return;
  }

  // Save conversation in DB
  upsertConversation(userId, userId, userName);

  // ---- Read messages ----
  // Facebook Messenger shows messages in a scrollable area.
  // Our own messages have a different background/alignment.
  // We need the LAST message from the OTHER person (not us).

  const lastIncoming = await getLastIncomingMessage(page);
  if (!lastIncoming) {
    console.log(`[ChatBot] No incoming message found for ${userName}`);
    return;
  }

  // Check if we already replied to this exact message
  const prevReplied = lastRepliedMessageId.get(userId);
  if (prevReplied === lastIncoming.id) {
    console.log(`[ChatBot] Already replied to latest message from ${userName}, skipping`);
    return;
  }

  console.log(`[ChatBot] New message from ${userName}: "${lastIncoming.text.substring(0, 60)}..."`);

  // Store the incoming message
  addMessage(userId, 'user', lastIncoming.text, lastIncoming.id);

  // Notify dashboard
  io.emit('chatbot:newMessage', {
    conversationId: userId,
    userName,
    message: lastIncoming.text,
    timestamp: new Date().toISOString(),
  });

  // ---- Generate reply ----
  const reply = await generateReply(userId, userName, lastIncoming.text);
  if (!reply) {
    console.log(`[ChatBot] No reply generated for ${userName}`);
    return;
  }

  // ---- Send reply ----
  if (!isPageAlive()) return;

  // Verify we're still on the right conversation
  const checkUrl = page.url();
  if (!checkUrl.includes(userId)) {
    console.warn(`[ChatBot] URL changed during reply generation! Aborting reply.`);
    return;
  }

  // Simulate thinking time
  const thinkTime = Math.max(config.minReplyDelay, Math.min(reply.length * 40, config.maxReplyDelay));
  await humanDelay(thinkTime * 0.8, thinkTime * 1.2);
  if (!isPageAlive() || !page.url().includes(userId)) return;

  const sent = await typeAndSendReply(page, reply);
  if (!sent) {
    addLog('chatbot', `Failed to send reply to ${userName}`, undefined, 'error');
    return;
  }

  // Mark as replied
  lastRepliedMessageId.set(userId, lastIncoming.id);

  // Store in DB
  addMessage(userId, 'assistant', reply);

  // Notify dashboard
  io.emit('chatbot:sentReply', {
    conversationId: userId,
    reply,
    timestamp: new Date().toISOString(),
  });

  addLog('chatbot', `Replied to ${userName}`,
    `"${lastIncoming.text.substring(0, 40)}..." → "${reply.substring(0, 40)}..."`,
    'success'
  );
  console.log(`[ChatBot] Replied to ${userName}: "${reply.substring(0, 60)}..."`);
}

// ============================================================
// Read the last INCOMING message (from the other person, NOT us)
// ============================================================

async function getLastIncomingMessage(page: Page): Promise<{ id: string; text: string } | null> {
  try {
    // In Messenger, messages are in rows.
    // OUR messages are on the RIGHT side, OTHER person's on the LEFT.
    // We need to find the last message that is NOT ours.

    // Strategy: get all message groups/rows, check their alignment or aria attributes
    // Facebook uses different structures, so we try multiple approaches.

    // Approach 1: Look for message rows and check if they're incoming
    // Incoming messages typically don't have a specific "you sent" indicator
    const allMessages = await page.$$('[role="row"]');

    if (allMessages.length === 0) {
      // Approach 2: Try generic message containers
      const msgContainers = await page.$$('div[dir="auto"]');
      if (msgContainers.length === 0) return null;

      const lastEl = msgContainers[msgContainers.length - 1];
      const text = (await lastEl.textContent())?.trim();
      if (!text) return null;
      return { id: hashMessage(text), text };
    }

    // Walk from the LAST message backwards to find the last INCOMING one
    for (let i = allMessages.length - 1; i >= 0 && i >= allMessages.length - 20; i--) {
      const row = allMessages[i];

      // Get text content of this row
      const textEls = await row.$$('div[dir="auto"]');
      let text = '';
      for (const el of textEls) {
        const t = await el.textContent();
        if (t) { text = t.trim(); break; }
      }
      if (!text) continue;

      // Determine if this is incoming or outgoing.
      // Facebook often puts outgoing messages in a colored bubble (blue) on the right
      // and incoming in gray on the left.
      // We can check: does this row have a colored (blue) background? → outgoing
      // Or check aria-label for "You sent" / "คุณส่ง"

      const rowHtml = await row.evaluate(el => el.outerHTML.substring(0, 500));

      // Method 1: check aria labels
      const ariaLabel = await row.getAttribute('aria-label') || '';
      const isOutgoing =
        ariaLabel.includes('You sent') ||
        ariaLabel.includes('คุณส่ง') ||
        ariaLabel.includes('You wrote');

      // Method 2: check for the "tail" indicator or specific styling of sent messages
      if (!isOutgoing) {
        // Check if there's an avatar image on the LEFT (= incoming from other person)
        const avatar = await row.$('img[alt]:not([alt=""])');

        // If this message has an avatar → it's from the other person
        // (Facebook shows avatar next to other person's messages)
        if (avatar || !ariaLabel.includes('You')) {
          return { id: hashMessage(text), text };
        }
      }
    }

    // Fallback: just return the very last message text (risky, might be ours)
    // But mark it so we can track
    return null;
  } catch (e) {
    console.error('[ChatBot] Error reading messages:', e);
    return null;
  }
}

/**
 * Create a deterministic hash for a message to track if we've seen it
 */
function hashMessage(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const chr = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return `msg_${Math.abs(hash).toString(36)}`;
}

// ============================================================
// Type and send a reply in the current conversation
// ============================================================

async function typeAndSendReply(page: Page, text: string): Promise<boolean> {
  // Find the message input box
  const inputSelectors = [
    '[aria-label="ข้อความ"]',
    '[aria-label="Message"]',
    '[aria-label="Aa"]',
    'div[role="textbox"][contenteditable="true"]',
    'p[contenteditable="true"]',
  ];

  for (const sel of inputSelectors) {
    try {
      const input = await page.$(sel);
      if (!input || !(await input.isVisible())) continue;

      // Focus the input
      await input.click();
      await humanDelay(300, 600);

      // Type the reply (in small chunks for natural feel)
      const chunks = text.match(/.{1,25}/gs) || [text];
      for (const chunk of chunks) {
        await page.keyboard.type(chunk, { delay: 25 });
        await humanDelay(50, 150);
      }

      await humanDelay(500, 1000);

      // Press Enter to send
      await page.keyboard.press('Enter');
      await humanDelay(1000, 2000);

      console.log('[ChatBot] Message sent successfully');
      return true;
    } catch { continue; }
  }

  console.error('[ChatBot] Could not find message input');
  return false;
}

// ============================================================
// Generate AI reply (Q&A first, then AI)
// ============================================================

async function generateReply(convId: string, userName: string, message: string): Promise<string | null> {
  // 1. Q&A database check first
  const qaMatch = findQAMatch(message);
  if (qaMatch) {
    addLog('chatbot', 'Q&A match', `"${qaMatch.question_pattern}" → using preset answer`, 'info');
    return qaMatch.answer;
  }

  // 2. Get conversation history for context
  const history = getConversationMessages(convId, 20);
  const persona = getDefaultPersona();

  if (!persona) {
    addLog('chatbot', 'No persona configured', undefined, 'warning');
    return null;
  }

  // 3. Build prompt with persona + history + new message
  const messages = buildChatMessages(
    persona,
    history.map((m: any) => ({ role: m.role, content: m.content })),
    message
  );

  // 4. Call AI
  try {
    const aiResult = await aiChat('chat', messages, {
      temperature: persona.temperature || 0.7,
      maxTokens: persona.max_tokens || 500,
    });
    let reply = stripThinkTags(aiResult.text || '');
    return reply || null;
  } catch (e) {
    addLog('chatbot', 'AI error', String(e), 'error');
    return null;
  }
}

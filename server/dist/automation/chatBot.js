import { newPage, humanDelay, isRunning, navigateWithRetry } from './browser.js';
import { addLog, getDefaultPersona, upsertConversation, addMessage, getConversationMessages } from '../database/db.js';
import { aiChat } from '../ai/aiRouter.js';
import { buildChatMessagesLegacy as buildChatMessages } from '../ai/prompts/chatPersona.js';
import { config } from '../config.js';
import { stripThinkTags } from '../utils.js';
import { getChatReplyDelayMs } from '../config/runtimeSettings.js';
import { createLogger } from '../utils/logger.js'; // Added import
const logger = createLogger('ChatBot'); // Added logger instance
let chatPage = null;
let isMonitoring = false;
let pollInterval = null;
const MESSENGER_URL = 'https://www.facebook.com/messages/t/';
const MAX_CONSECUTIVE_ERRORS = 3;
let consecutiveErrors = 0;
// Track the last message we've seen per conversation to avoid replying to ourselves
const lastRepliedMessageId = new Map();
// ============================================================
// Helpers
// ============================================================
function isPageAlive() {
    try {
        return !!chatPage && !chatPage.isClosed() && isRunning();
    }
    catch (e) {
        logger.debug('page check: ' + String(e));
        return false;
    } // Modified
}
function forceStop(io) {
    isMonitoring = false;
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
    chatPage = null;
    io.emit('chatbot:status', { active: false });
}
function isClosedError(msg) {
    return msg.includes('closed') || msg.includes('destroyed') || msg.includes('disposed') || msg.includes('Target page');
}
/**
 * Extract FB user ID from a Messenger URL like /messages/t/100015232654041
 */
function extractUserId(url) {
    const m = url.match(/\/messages\/t\/(\d+)/);
    return m ? m[1] : null;
}
// ============================================================
// Start / Stop
// ============================================================
export async function startChatMonitor(io) {
    if (isMonitoring)
        return;
    isMonitoring = true;
    consecutiveErrors = 0;
    try {
        // Open a dedicated page for Messenger
        chatPage = await newPage();
        await navigateWithRetry(chatPage, MESSENGER_URL);
        await humanDelay(3000, 5000);
        addLog('chatbot', 'Chat monitor started', undefined, 'success');
        logger.info('Started — monitoring Messenger'); // Modified
        io.emit('chatbot:status', { active: true });
        // Main poll loop
        pollInterval = setInterval(async () => {
            if (!isMonitoring)
                return;
            if (!isPageAlive()) {
                logger.warn('Page/browser gone, auto-stopping'); // Modified
                addLog('chatbot', 'Auto-stopped (browser closed)', undefined, 'warning');
                forceStop(io);
                return;
            }
            try {
                await pollUnreadConversations(io);
                consecutiveErrors = 0;
            }
            catch (e) {
                const msg = e?.message || String(e);
                if (isClosedError(msg)) {
                    forceStop(io);
                    return;
                }
                consecutiveErrors++;
                if (consecutiveErrors <= MAX_CONSECUTIVE_ERRORS) {
                    addLog('chatbot', 'Poll error', msg, 'warning');
                    logger.error(`Poll error (${consecutiveErrors}): ${msg}`); // Modified
                }
                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    addLog('chatbot', 'Auto-stopped (repeated errors)', msg, 'error');
                    forceStop(io);
                }
            }
        }, 7000); // Check every 7 seconds
    }
    catch (e) {
        addLog('chatbot', 'Failed to start chat monitor', String(e), 'error');
        isMonitoring = false;
        io.emit('chatbot:status', { active: false });
    }
}
export function stopChatMonitor(io) {
    isMonitoring = false;
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
    if (chatPage) {
        try {
            if (!chatPage.isClosed())
                chatPage.close().catch(() => { });
        }
        catch (e) {
            logger.debug('page close: ' + String(e));
        } // Modified
    }
    chatPage = null;
    addLog('chatbot', 'Chat monitor stopped', undefined, 'info');
    logger.info('Stopped'); // Modified
    io.emit('chatbot:status', { active: false });
}
export function isChatMonitorActive() {
    return isMonitoring;
}
async function ensureOnMessengerInbox(page) {
    const currentUrl = page.url();
    if (!currentUrl.includes('/messages')) {
        logger.warn('Not on Messenger, navigating back...');
        await navigateWithRetry(page, MESSENGER_URL);
        await humanDelay(2000, 3000);
    }
}
async function getUnreadConversations(page) {
    const convLinks = await page.$$('a[href*="/messages/t/"]');
    if (convLinks.length === 0)
        return [];
    const unreadConvs = [];
    for (const link of convLinks) {
        try {
            const href = await link.getAttribute('href');
            if (!href || !href.includes('/messages/t/'))
                continue;
            const userId = extractUserId(href);
            if (!userId)
                continue;
            const parentLi = await link.evaluateHandle((el) => el.closest('[role="row"], [role="listitem"], li'));
            if (!parentLi)
                continue;
            const parentEl = parentLi.asElement();
            let hasUnread = false;
            if (parentEl) {
                const ariaLabel = await parentEl.getAttribute('aria-label') || '';
                if (ariaLabel.toLowerCase().includes('unread') || ariaLabel.includes('ยังไม่ได้อ่าน')) {
                    hasUnread = true;
                }
                if (!hasUnread) {
                    const boldEl = await parentEl.$('span[style*="font-weight"], strong, span[class*="bold"]');
                    if (boldEl)
                        hasUnread = true;
                }
            }
            if (!hasUnread && lastRepliedMessageId.has(userId))
                continue;
            let name = 'Unknown';
            try {
                const nameEl = await link.$('span');
                if (nameEl)
                    name = (await nameEl.textContent())?.trim() || 'Unknown';
            }
            catch (e) {
                logger.debug('name extraction: ' + String(e));
            }
            if (hasUnread) {
                unreadConvs.push({ userId, url: `https://www.facebook.com${href}`, name });
            }
        }
        catch (e) {
            logger.debug('conversation item: ' + String(e));
            continue;
        }
    }
    return unreadConvs;
}
async function pollUnreadConversations(io) {
    if (!isPageAlive())
        return;
    const page = chatPage;
    await ensureOnMessengerInbox(page);
    const unreadConvs = await getUnreadConversations(page);
    if (unreadConvs.length === 0)
        return;
    logger.info(`Found ${unreadConvs.length} unread conversation(s)`);
    for (const conv of unreadConvs) {
        if (!isPageAlive() || !isMonitoring)
            return;
        try {
            await processConversation(page, conv.userId, conv.url, conv.name, io);
            if (!isPageAlive())
                return;
            await navigateWithRetry(page, MESSENGER_URL);
            await humanDelay(2000, 3000);
        }
        catch (e) {
            const msg = e?.message || String(e);
            if (isClosedError(msg))
                return;
            logger.error(`Error processing conv ${conv.userId}: ${msg}`);
            addLog('chatbot', `Error processing ${conv.name}`, msg, 'error');
        }
    }
}
// ============================================================
// Process a single conversation
// ============================================================
async function processConversation(page, userId, convUrl, userName, io) {
    logger.info(`Opening conversation: ${userName} (${userId})`); // Modified
    addLog('chatbot', `Processing chat: ${userName}`, userId, 'info');
    // Navigate directly to this conversation by URL
    await navigateWithRetry(page, convUrl);
    await humanDelay(2000, 3000);
    if (!isPageAlive())
        return;
    // Verify URL matches expected conversation
    const currentUrl = page.url();
    const currentUserId = extractUserId(currentUrl);
    if (currentUserId !== userId) {
        logger.warn(`URL mismatch! Expected ${userId}, got ${currentUserId}`); // Modified
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
        logger.info(`No incoming message found for ${userName}`); // Modified
        return;
    }
    // Check if we already replied to this exact message
    const prevReplied = lastRepliedMessageId.get(userId);
    if (prevReplied === lastIncoming.id) {
        logger.info(`Already replied to latest message from ${userName}, skipping`); // Modified
        return;
    }
    logger.info(`New message from ${userName}: "${lastIncoming.text.substring(0, 60)}..."`); // Modified
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
        logger.info(`No reply generated for ${userName}`); // Modified
        return;
    }
    // ---- Send reply ----
    if (!isPageAlive())
        return;
    // Verify we're still on the right conversation
    const checkUrl = page.url();
    if (!checkUrl.includes(userId)) {
        logger.warn(`URL changed during reply generation! Aborting reply.`); // Modified
        return;
    }
    // Simulate thinking time
    const minReplyDelay = getChatReplyDelayMs();
    const maxReplyDelay = Math.max(minReplyDelay, config.maxReplyDelay);
    const thinkTime = Math.max(minReplyDelay, Math.min(reply.length * 40, maxReplyDelay));
    await humanDelay(thinkTime * 0.8, thinkTime * 1.2);
    if (!isPageAlive() || !page.url().includes(userId))
        return;
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
    addLog('chatbot', `Replied to ${userName}`, `"${lastIncoming.text.substring(0, 40)}..." → "${reply.substring(0, 40)}..."`, 'success');
    logger.info(`Replied to ${userName}: "${reply.substring(0, 60)}..."`); // Modified
}
// ============================================================
// Read the last INCOMING message (from the other person, NOT us)
// ============================================================
async function getLastIncomingMessage(page) {
    try {
        // In Messenger, messages are in rows.
        // OUR messages are on the RIGHT side, OTHER person's on the LEFT.
        // We need to find
        const messageBubbles = await page.$$('[role="row"] [data-testid="message-bubble"]');
        let lastIncomingMessage = null;
        for (const bubble of messageBubbles) {
            const isOurMessage = await bubble.evaluate(el => {
                // Check for specific styling or attributes that indicate our messages
                // This might need adjustment based on current Messenger HTML
                const style = window.getComputedStyle(el);
                return style.alignSelf === 'flex-end' || style.backgroundColor === 'rgb(0, 132, 255)'; // Example: blue background for our messages
            });
            if (!isOurMessage) {
                // This is an incoming message
                const textElement = await bubble.$('span[dir="auto"]');
                const messageText = (await textElement?.textContent())?.trim();
                const messageId = await bubble.getAttribute('id'); // Messenger message IDs are usually on the bubble element
                if (messageText && messageId) {
                    lastIncomingMessage = { id: messageId, text: messageText };
                }
            }
        }
        return lastIncomingMessage;
    }
    catch (e) {
        logger.error('Error getting last incoming message: ' + String(e)); // Modified
        return null;
    }
}
// ============================================================
// Type and send reply
// ============================================================
async function typeAndSendReply(page, reply) {
    try {
        // Find the message input field
        const inputSelector = '[contenteditable="true"][role="textbox"]';
        await page.waitForSelector(inputSelector, { state: 'visible' });
        const inputField = await page.$(inputSelector);
        if (!inputField) {
            logger.error('Message input field not found.'); // Modified
            return false;
        }
        // Type the reply
        await inputField.type(reply, { delay: 10 });
        // Press Enter to send the message
        await page.keyboard.press('Enter');
        logger.info('Reply sent successfully.'); // Modified
        return true;
    }
    catch (e) {
        logger.error('Error typing and sending reply: ' + String(e)); // Modified
        return false;
    }
}
// ============================================================
// Generate reply using AI
// ============================================================
async function generateReply(userId, userName, lastMessage) {
    try {
        // Get conversation history from DB
        const messages = await getConversationMessages(userId);
        const defaultPersona = await getDefaultPersona();
        // Prepare messages for AI
        const fallbackPersona = {
            system_prompt: defaultPersona?.systemInstruction || '',
            personality_traits: '[]'
        };
        const chatMessages = buildChatMessages(fallbackPersona, messages, lastMessage);
        // Call AI
        const aiResponse = await aiChat('chat', chatMessages);
        if (!aiResponse || typeof aiResponse.text !== 'string')
            return null;
        // Strip any <think> tags from the AI response
        return stripThinkTags(aiResponse.text);
    }
    catch (e) {
        logger.error('Error generating AI reply: ' + String(e)); // Modified
        return null;
    }
}
//# sourceMappingURL=chatBot.js.map
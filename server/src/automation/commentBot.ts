import type { Page } from 'playwright';
import { newPage, humanDelay, humanType, isRunning, navigateWithRetry } from './browser.js';
import { addLog, dbAll, dbGet, dbRun } from '../database/db.js';
import { aiChat } from '../ai/aiRouter.js';
import { buildCommentReplyPrompt } from '../ai/prompts/contentCreator.js';
import type { Server as SocketServer } from 'socket.io';
import { getCommentReplyDelayMs } from '../config/runtimeSettings.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('CommentBot');
let isMonitoring = false;
let pollInterval: NodeJS.Timeout | null = null;

const MAX_CONSECUTIVE_ERRORS = 3;
let consecutiveErrors = 0;

/**
 * Start comment monitoring on watched posts.
 */
export async function startCommentMonitor(io: SocketServer): Promise<void> {
  if (isMonitoring) return;
  isMonitoring = true;
  consecutiveErrors = 0;

  addLog('commentbot', 'Comment monitor started', undefined, 'success');
  io.emit('commentbot:status', { active: true });

  pollInterval = setInterval(async () => {
    if (!isMonitoring) return;

    // Auto-stop if browser is gone
    if (!isRunning()) {
      logger.warn('Browser closed, auto-stopping...');
      addLog('commentbot', 'Auto-stopped (browser closed)', undefined, 'warning');
      forceStop(io);
      return;
    }

    try {
      await checkWatchedPosts(io);
      consecutiveErrors = 0;
    } catch (e: any) {
      consecutiveErrors++;
      const msg = e?.message || String(e);

      if (msg.includes('closed') || msg.includes('destroyed') || msg.includes('disposed') || msg.includes('Target page')) {
        logger.warn('Page/browser closed, stopping...');
        forceStop(io);
        return;
      }

      if (consecutiveErrors <= MAX_CONSECUTIVE_ERRORS) {
        addLog('commentbot', 'Poll error', msg, 'warning');
      }

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        logger.error('Too many errors, auto-stopping...');
        addLog('commentbot', 'Auto-stopped (repeated errors)', msg, 'error');
        forceStop(io);
      }
    }
  }, 30000);
}

function forceStop(io: SocketServer): void {
  isMonitoring = false;
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  io.emit('commentbot:status', { active: false });
}

export function stopCommentMonitor(io: SocketServer): void {
  isMonitoring = false;
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  addLog('commentbot', 'Comment monitor stopped', undefined, 'info');
  io.emit('commentbot:status', { active: false });
}

/**
 * Check all active watched posts for new comments.
 */
async function checkWatchedPosts(io: SocketServer): Promise<void> {
  const watches = dbAll(
    'SELECT * FROM comment_watches WHERE is_active = 1 AND auto_reply = 1'
  ) as any[];

  for (const watch of watches) {
    if (!isMonitoring || !isRunning()) return;
    if (watch.replies_count >= watch.max_replies) continue;

    let page: Page | null = null;
    try {
      page = await newPage();
      await navigateWithRetry(page, watch.fb_post_url);
      await humanDelay(3000, 5000);

      const postContent = await getPostContent(page);
      const comments = await getNewComments(page, watch.id);

      for (const comment of comments) {
        if (!isMonitoring || !isRunning()) break;
        if (watch.replies_count >= watch.max_replies) break;

        const existing = dbGet(
          'SELECT id FROM replied_comments WHERE fb_comment_id = ?',
          [comment.id]
        );
        if (existing) continue;

        const aiResult = await aiChat('comment',
          buildCommentReplyPrompt(
            postContent, comment.text, comment.author,
            watch.reply_style || 'friendly'
          )
        );
        const replyText = aiResult.text;

        if (replyText && page && !page.isClosed()) {
          const replied = await replyToComment(page, comment.element, replyText);

          if (replied) {
            dbRun(`
              INSERT INTO replied_comments (watch_id, fb_comment_id, commenter_name, comment_text, reply_text)
              VALUES (?, ?, ?, ?, ?)
            `, [watch.id, comment.id, comment.author, comment.text, replyText]);

            dbRun(
              'UPDATE comment_watches SET replies_count = replies_count + 1 WHERE id = ?',
              [watch.id]
            );

            io.emit('commentbot:replied', {
              watchId: watch.id, comment: comment.text,
              reply: replyText, commenter: comment.author,
            });

            addLog('commentbot', 'Replied to comment',
              `${comment.author}: "${comment.text.substring(0, 50)}" → "${replyText.substring(0, 50)}"`,
              'success'
            );

            const minDelay = getCommentReplyDelayMs();
            const maxDelay = Math.max(minDelay, minDelay * 3);
            await humanDelay(minDelay, maxDelay);
          }
        }
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (msg.includes('closed') || msg.includes('destroyed') || msg.includes('disposed')) {
        return; // Let poll loop handle
      }
      addLog('commentbot', `Error checking post ${watch.id}`, msg, 'error');
    } finally {
      if (page) {
        try { if (!page.isClosed()) await page.close(); } catch (e) { logger.debug(`page close error: ${String(e)}`); }
      }
    }
  }
}

async function getPostContent(page: Page): Promise<string> {
  try {
    const content = await page.$eval(
      '[data-testid="post_message"], [data-ad-preview="message"]',
      el => el.textContent
    );
    return content || 'Facebook post';
  } catch {
    return 'Facebook post';
  }
}

async function getNewComments(page: Page, watchId: number): Promise<Array<{ id: string; text: string; author: string; element: any }>> {
  const comments: Array<{ id: string; text: string; author: string; element: any }> = [];

  try {
    const viewMoreBtns = await page.$$('span:has-text("ดูความคิดเห็นเพิ่มเติม"), span:has-text("View more comments")');
    for (const btn of viewMoreBtns.slice(0, 2)) {
      try {
        await btn.click();
        await humanDelay(2000, 3000);
      } catch { break; }
    }

    const commentElements = await page.$$('[aria-label*="Comment"], [role="article"]');

    for (const el of commentElements) {
      try {
        const author = await el.$eval('a[role="link"] span, h3 span', e => e.textContent || '').catch(() => 'Unknown');
        const text = await el.$eval('[dir="auto"]:not(h3 *), [data-ad-preview="message"]', e => e.textContent || '').catch(() => '');
        if (!text) continue;

        const id = `comment-${Buffer.from(`${author}:${text}`).toString('base64').substring(0, 30)}`;
        comments.push({ id, text, author, element: el });
      } catch { continue; }
    }
  } catch (e) {
    addLog('commentbot', 'Error extracting comments', String(e), 'warning');
  }

  return comments;
}

async function replyToComment(page: Page, commentElement: any, replyText: string): Promise<boolean> {
  try {
    const replyBtn = await commentElement.$('span:has-text("ตอบกลับ"), span:has-text("Reply")');
    if (!replyBtn) return false;

    await replyBtn.click();
    await humanDelay(1000, 2000);

    await page.keyboard.type(replyText, { delay: 30 });
    await humanDelay(500, 1000);
    await page.keyboard.press('Enter');
    await humanDelay(2000, 3000);

    return true;
  } catch (e) {
    addLog('commentbot', 'Failed to reply to comment', String(e), 'error');
    return false;
  }
}

export function isCommentMonitorActive(): boolean {
  return isMonitoring;
}

import { dbAll, dbGet, dbRun, addLog } from '../database/db.js';
import { createPost } from './facebook.js';
import { aiChat } from '../ai/aiRouter.js';
import { buildContentPrompt } from '../ai/prompts/contentCreator.js';
import type { Server as SocketServer } from 'socket.io';
import { notifyUserActivity } from '../evolution/selfUpgrade.js';

export const POST_STATUS_PENDING = 'pending';
export const POST_STATUS_GENERATING = 'generating';
export const POST_STATUS_READY = 'ready';
export const POST_STATUS_POSTING = 'posting';
export const POST_STATUS_POSTED = 'posted';
export const POST_STATUS_FAILED = 'failed';

export interface ScheduledPost {
  id: number;
  content: string | null;
  ai_topic: string | null;
  post_type: string;
  target: string;
  target_id: string | null;
  target_name: string | null;
  scheduled_at: string;
  cron_expression: string | null;
  status: string;
  error_message?: string | null;
}

/**
 * Helper to update post status in DB and notify via socket.
 */
function updatePostStatus(
  io: SocketServer,
  id: number,
  status: string,
  options: { content?: string; error?: string; errorStack?: string; attempt?: number } = {}
): void {
  const { content, error, errorStack, attempt } = options;

  if (content) {
    dbRun('UPDATE scheduled_posts SET content = ?, status = ? WHERE id = ?', [content, status, id]);
  } else if (errorStack) {
    dbRun('UPDATE scheduled_posts SET status = ?, error_message = ? WHERE id = ?', [status, errorStack.substring(0, 1000), id]);
  } else {
    dbRun('UPDATE scheduled_posts SET status = ? WHERE id = ?', [status, id]);
  }

  io.emit('post:status', {
    id,
    status,
    content,
    error,
    attempt
  });
}

/**
 * Schedule a new post (either with pre-written content or AI-generated).
 */
export function schedulePost(data: {
  content?: string;
  aiTopic?: string;
  postType?: string;
  target?: string;
  targetId?: string;
  targetName?: string;
  scheduledAt: string;
  cronExpression?: string;
}): number {
  const params = [
    data.content || null,
    data.aiTopic || null,
    data.postType || 'text',
    data.target || 'profile',
    data.targetId || null,
    data.targetName || null,
    data.scheduledAt,
    data.cronExpression || null,
    data.content ? POST_STATUS_READY : POST_STATUS_PENDING
  ];

  dbRun(`
    INSERT INTO scheduled_posts (content, ai_topic, post_type, target, target_id, target_name, scheduled_at, cron_expression, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, params);

  const lastRow = dbGet('SELECT last_insert_rowid() as id');
  const insertId = lastRow?.id ? Number(lastRow.id) : 0;

  addLog('post', 'Post scheduled', `ID: ${insertId}, scheduled: ${data.scheduledAt}`, 'info');
  return insertId;
}

/**
 * Process pending scheduled posts (called by scheduler).
 */
export async function processPendingPosts(io: SocketServer): Promise<void> {
  const now = new Date().toISOString();

  try {
    dbRun('BEGIN TRANSACTION');

    // 1. Generate content for posts that need AI
    const pendingAi = dbAll(
      `SELECT id, ai_topic FROM scheduled_posts WHERE status = ? AND ai_topic IS NOT NULL AND scheduled_at <= ?`,
      [POST_STATUS_PENDING, now]
    ) as any[];

    if (pendingAi.length > 0) notifyUserActivity();

    for (const post of pendingAi) {
      let attempts = 0;
      const maxAttempts = 3;
      while (attempts < maxAttempts) {
        try {
          dbRun('UPDATE scheduled_posts SET status = ? WHERE id = ?', [POST_STATUS_GENERATING, post.id]);
          io.emit('post:status', { id: post.id, status: POST_STATUS_GENERATING, attempt: attempts + 1 });

          const messages = buildContentPrompt(post.ai_topic, 'engaging', 'th');
          const aiResult = await aiChat('content', messages, { maxTokens: 800 });
          const content = aiResult.text;

          if (!content) throw new Error('AI content generation returned empty result');

          dbRun('UPDATE scheduled_posts SET content = ?, status = ? WHERE id = ?', [content, POST_STATUS_READY, post.id]);
          io.emit('post:status', { id: post.id, status: POST_STATUS_READY, content });
          addLog('post', 'AI content generated', `Post ${post.id} successful on attempt ${attempts + 1}`, 'success');
          break;
        } catch (e) {
          attempts++;
          const errorStack = e instanceof Error ? (e.stack || e.message) : String(e);
          const errorMsg = e instanceof Error ? e.message : String(e);

          if (attempts >= maxAttempts) {
            dbRun('UPDATE scheduled_posts SET status = ?, error_message = ? WHERE id = ?', [POST_STATUS_FAILED, errorStack.substring(0, 1000), post.id]);
            io.emit('post:status', { id: post.id, status: POST_STATUS_FAILED, error: errorMsg });
            addLog('post', 'Content generation failed permanently', `Post ${post.id}: ${errorStack}`, 'error');
          } else {
            addLog('post', 'Content generation retry', `Post ${post.id} failed (attempt ${attempts}): ${errorMsg}. Retrying...`, 'warning');
            await new Promise(r => setTimeout(r, 2000 * attempts));
          }
        }
      }
    }

    // 2. Post ready content
    const readyPosts = dbAll(
      `SELECT id, content, target, target_id FROM scheduled_posts WHERE status = ? AND scheduled_at <= ?`,
      [POST_STATUS_READY, now]
    ) as any[];

    if (readyPosts.length > 0) notifyUserActivity();

    for (const post of readyPosts) {
      let attempts = 0;
      const maxAttempts = 2;
      while (attempts < maxAttempts) {
        try {
          dbRun('UPDATE scheduled_posts SET status = ? WHERE id = ?', [POST_STATUS_POSTING, post.id]);
          io.emit('post:status', { id: post.id, status: POST_STATUS_POSTING, attempt: attempts + 1 });

          const success = await createPost(post.content, post.target || 'profile', post.target_id);
          if (!success) throw new Error('Facebook API returned failure');

          dbRun('UPDATE scheduled_posts SET status = ? WHERE id = ?', [POST_STATUS_POSTED, post.id]);
          io.emit('post:status', { id: post.id, status: POST_STATUS_POSTED });
          addLog('post', 'Post published', `Post ${post.id} to ${post.target} on attempt ${attempts + 1}`, 'success');
          break;
        } catch (e) {
          attempts++;
          const errorStack = e instanceof Error ? (e.stack || e.message) : String(e);
          const errorMsg = e instanceof Error ? e.message : String(e);

          if (attempts >= maxAttempts) {
            dbRun('UPDATE scheduled_posts SET status = ?, error_message = ? WHERE id = ?', [POST_STATUS_FAILED, errorStack.substring(0, 1000), post.id]);
            io.emit('post:status', { id: post.id, status: POST_STATUS_FAILED, error: errorMsg });
            addLog('post', 'Post failed permanently', `Post ${post.id}: ${errorStack}`, 'error');
          } else {
            addLog('post', 'Post retry', `Post ${post.id} failed (attempt ${attempts}): ${errorMsg}. Retrying...`, 'warning');
            await new Promise(r => setTimeout(r, 5000));
          }
        }
      }
    }

    dbRun('COMMIT');
  } catch (err) {
    dbRun('ROLLBACK');
    addLog('post', 'Batch processing failed', err instanceof Error ? err.message : String(err), 'error');
    throw err;
  }
}

/**
 * Get all scheduled posts.
 */
export function getScheduledPosts(limit: number = 50): any[] {
  return dbAll(
    'SELECT id, content, ai_topic, post_type, target, target_id, target_name, scheduled_at, cron_expression, status, error_message FROM scheduled_posts ORDER BY scheduled_at DESC LIMIT ?',
    [limit]
  );
}

/**
 * Delete a scheduled post.
 */
export function deleteScheduledPost(id: number): void {
  dbRun('DELETE FROM scheduled_posts WHERE id = ?', [id]);
}

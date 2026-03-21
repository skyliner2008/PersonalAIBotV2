import { dbAll, dbGet, dbRun, addLog } from '../database/db.js';
import { createPost } from './facebook.js';
import { aiChat } from '../ai/aiRouter.js';
import { buildContentPrompt } from '../ai/prompts/contentCreator.js';
import type { Server as SocketServer } from 'socket.io';

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
    data.content ? 'ready' : 'pending'
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

  // 1. Generate content for posts that need AI
  const pendingAi = dbAll(
    `SELECT * FROM scheduled_posts WHERE status = 'pending' AND ai_topic IS NOT NULL AND scheduled_at <= ?`,
    [now]
  ) as any[];

  for (const post of pendingAi) {
    try {
      dbRun('UPDATE scheduled_posts SET status = ? WHERE id = ?', ['generating', post.id]);
      io.emit('post:status', { id: post.id, status: 'generating' });

      const messages = buildContentPrompt(post.ai_topic, 'engaging', 'th');
      const aiResult = await aiChat('content', messages, { maxTokens: 800 });
      const content = aiResult.text;

      if (content) {
        dbRun('UPDATE scheduled_posts SET content = ?, status = ? WHERE id = ?',
          [content, 'ready', post.id]);
        io.emit('post:status', { id: post.id, status: 'ready', content });
        addLog('post', 'AI content generated', `Post ${post.id}: ${content.substring(0, 80)}...`, 'success');
      } else {
        dbRun('UPDATE scheduled_posts SET status = ?, error_message = ? WHERE id = ?',
          ['failed', 'AI content generation failed', post.id]);
      }
    } catch (e) {
      const errorMsg = String(e).substring(0, 500);
      dbRun('UPDATE scheduled_posts SET status = ?, error_message = ? WHERE id = ?',
        ['failed', errorMsg, post.id]);
      addLog('post', 'Content generation failed', errorMsg, 'error');
    }
  }

  // 2. Post ready content
  const readyPosts = dbAll(
    `SELECT * FROM scheduled_posts WHERE status = 'ready' AND scheduled_at <= ?`,
    [now]
  ) as any[];

  for (const post of readyPosts) {
    try {
      dbRun('UPDATE scheduled_posts SET status = ? WHERE id = ?', ['posting', post.id]);
      io.emit('post:status', { id: post.id, status: 'posting' });

      const success = await createPost(
        post.content,
        post.target || 'profile',
        post.target_id
      );

      if (success) {
        dbRun('UPDATE scheduled_posts SET status = ? WHERE id = ?', ['posted', post.id]);
        io.emit('post:status', { id: post.id, status: 'posted' });
        addLog('post', 'Post published', `Post ${post.id} to ${post.target}`, 'success');
      } else {
        dbRun('UPDATE scheduled_posts SET status = ?, error_message = ? WHERE id = ?',
          ['failed', 'Failed to post to Facebook', post.id]);
        addLog('post', 'Post failed', `Post ${post.id}`, 'error');
      }
    } catch (e) {
      dbRun('UPDATE scheduled_posts SET status = ?, error_message = ? WHERE id = ?',
        ['failed', String(e), post.id]);
    }
  }
}

/**
 * Get all scheduled posts.
 */
export function getScheduledPosts(limit: number = 50): any[] {
  return dbAll(
    'SELECT * FROM scheduled_posts ORDER BY scheduled_at DESC LIMIT ?',
    [limit]
  );
}

/**
 * Delete a scheduled post.
 */
export function deleteScheduledPost(id: number): void {
  dbRun('DELETE FROM scheduled_posts WHERE id = ?', [id]);
}

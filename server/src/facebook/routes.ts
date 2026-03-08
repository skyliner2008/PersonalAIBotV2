// ============================================================
// Facebook Graph API Routes
// Webhook endpoint + management APIs
// ============================================================

import { Router } from 'express';

/** Parse a query param as a positive integer, clamped to [min, max] */
function parseIntParam(value: unknown, defaultVal: number, min = 1, max = 500): number {
  const n = parseInt(String(value ?? ''), 10);
  if (Number.isNaN(n) || n < min) return defaultVal;
  return Math.min(n, max);
}
import { addLog, setSetting, getSetting } from '../database/db.js';
import {
  getFBConfig,
  isFBConfigured,
  getPageInfo,
  getConnectedPages,
  getPagePosts,
  createPagePost,
  deletePost,
  getPostComments,
  replyToComment,
  likeComment,
  getPageConversations,
  getConversationMessages,
  sendMessage,
  debugToken,
  exchangeForLongLivedToken,
  subscribeAppToPage,
} from './graphAPI.js';
import { processWebhookEntries } from './webhookHandler.js';

export const fbRouter = Router();

// ============================================================
// WEBHOOK — Verification & Event Receiver
// ============================================================

// Facebook webhook verification (GET)
fbRouter.get('/webhook', (req, res) => {
  const cfg = getFBConfig();
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === cfg.verifyToken) {
    addLog('webhook', 'Webhook verified', `Challenge accepted`, 'success');
    return res.status(200).send(challenge);
  }

  addLog('webhook', 'Webhook verification failed', `Invalid token`, 'error');
  return res.sendStatus(403);
});

// Facebook webhook events (POST)
fbRouter.post('/webhook', (req, res) => {
  const body = req.body;

  if (body.object !== 'page') {
    return res.sendStatus(404);
  }

  // Respond immediately (Facebook requires 200 within 20s)
  res.sendStatus(200);

  // Process events asynchronously
  if (body.entry && Array.isArray(body.entry)) {
    processWebhookEntries(body.entry).catch(err => {
      addLog('webhook', 'Processing error', err.message, 'error');
    });
  }
});

// ============================================================
// STATUS & CONFIG
// ============================================================

fbRouter.get('/status', (req, res) => {
  const cfg = getFBConfig();
  res.json({
    configured: isFBConfigured(),
    pageId: cfg.pageId || null,
    hasAppId: !!cfg.appId,
    hasAppSecret: !!cfg.appSecret,
    hasPageToken: !!cfg.pageAccessToken,
    apiVersion: cfg.apiVersion,
  });
});

fbRouter.post('/config', (req, res) => {
  const { appId, appSecret, pageAccessToken, pageId, verifyToken, apiVersion } = req.body;
  if (appId !== undefined) setSetting('fb_app_id', appId);
  if (appSecret !== undefined) setSetting('fb_app_secret', appSecret);
  if (pageAccessToken !== undefined) setSetting('fb_page_access_token', pageAccessToken);
  if (pageId !== undefined) setSetting('fb_page_id', pageId);
  if (verifyToken !== undefined) setSetting('fb_verify_token', verifyToken);
  if (apiVersion !== undefined) setSetting('fb_api_version', apiVersion);
  addLog('fb-api', 'Config updated', 'Facebook API settings saved', 'success');
  res.json({ success: true });
});

// ============================================================
// PAGE INFO
// ============================================================

fbRouter.get('/page', async (req, res) => {
  if (!isFBConfigured()) return res.status(400).json({ error: 'Facebook API not configured' });
  const page = await getPageInfo();
  res.json(page || { error: 'Could not fetch page info' });
});

// Get all pages the user manages (requires user access token)
fbRouter.post('/pages', async (req, res) => {
  const { userAccessToken } = req.body;
  if (!userAccessToken) return res.status(400).json({ error: 'userAccessToken is required' });
  const pages = await getConnectedPages(userAccessToken);
  res.json(pages);
});

// Select a page to use
fbRouter.post('/page/select', async (req, res) => {
  const { pageId, pageAccessToken, pageName } = req.body;
  if (!pageId || !pageAccessToken) {
    return res.status(400).json({ error: 'pageId and pageAccessToken are required' });
  }
  setSetting('fb_page_id', pageId);
  setSetting('fb_page_access_token', pageAccessToken);
  if (pageName) setSetting('fb_page_name', pageName);
  addLog('fb-api', 'Page selected', `${pageName || pageId}`, 'success');
  res.json({ success: true });
});

// ============================================================
// TOKEN MANAGEMENT
// ============================================================

fbRouter.post('/token/debug', async (req, res) => {
  const { token } = req.body;
  const tokenToCheck = token || getFBConfig().pageAccessToken;
  if (!tokenToCheck) return res.status(400).json({ error: 'No token to debug' });
  const info = await debugToken(tokenToCheck);
  res.json(info);
});

fbRouter.post('/token/extend', async (req, res) => {
  const { shortLivedToken } = req.body;
  if (!shortLivedToken) return res.status(400).json({ error: 'shortLivedToken is required' });
  const longLived = await exchangeForLongLivedToken(shortLivedToken);
  if (longLived) {
    res.json({ success: true, accessToken: longLived });
  } else {
    res.status(500).json({ error: 'Token exchange failed' });
  }
});

// ============================================================
// WEBHOOK MANAGEMENT
// ============================================================

fbRouter.post('/webhook/subscribe', async (req, res) => {
  if (!isFBConfigured()) return res.status(400).json({ error: 'Facebook API not configured' });
  const success = await subscribeAppToPage();
  res.json({ success });
});

// ============================================================
// MESSAGING — Send messages via API
// ============================================================

fbRouter.post('/send', async (req, res) => {
  if (!isFBConfigured()) return res.status(400).json({ error: 'Facebook API not configured' });
  const { recipientId, text } = req.body;
  if (!recipientId || !text) return res.status(400).json({ error: 'recipientId and text are required' });
  const result = await sendMessage(recipientId, text);
  res.json(result || { error: 'Failed to send message' });
});

// ============================================================
// CONVERSATIONS
// ============================================================

fbRouter.get('/conversations', async (req, res) => {
  if (!isFBConfigured()) return res.status(400).json({ error: 'Facebook API not configured' });
  const limit = parseIntParam(req.query.limit, 20, 1, 100);
  const convs = await getPageConversations(limit);
  res.json(convs);
});

fbRouter.get('/conversations/:id/messages', async (req, res) => {
  if (!isFBConfigured()) return res.status(400).json({ error: 'Facebook API not configured' });
  const limit = parseIntParam(req.query.limit, 20, 1, 100);
  const msgs = await getConversationMessages(req.params.id, limit);
  res.json(msgs);
});

// ============================================================
// POSTS
// ============================================================

fbRouter.get('/posts', async (req, res) => {
  if (!isFBConfigured()) return res.status(400).json({ error: 'Facebook API not configured' });
  const limit = parseIntParam(req.query.limit, 10, 1, 100);
  const posts = await getPagePosts(limit);
  res.json(posts);
});

fbRouter.post('/posts', async (req, res) => {
  if (!isFBConfigured()) return res.status(400).json({ error: 'Facebook API not configured' });
  const { message, link, imageUrl } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });
  const post = await createPagePost(message, link, imageUrl);
  res.json(post || { error: 'Failed to create post' });
});

fbRouter.delete('/posts/:id', async (req, res) => {
  if (!isFBConfigured()) return res.status(400).json({ error: 'Facebook API not configured' });
  const success = await deletePost(req.params.id);
  res.json({ success });
});

// ============================================================
// COMMENTS
// ============================================================

fbRouter.get('/posts/:id/comments', async (req, res) => {
  if (!isFBConfigured()) return res.status(400).json({ error: 'Facebook API not configured' });
  const limit = parseIntParam(req.query.limit, 25, 1, 200);
  const comments = await getPostComments(req.params.id, limit);
  res.json(comments);
});

fbRouter.post('/comments/:id/reply', async (req, res) => {
  if (!isFBConfigured()) return res.status(400).json({ error: 'Facebook API not configured' });
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });
  const reply = await replyToComment(req.params.id, message);
  res.json(reply || { error: 'Failed to reply' });
});

fbRouter.post('/comments/:id/like', async (req, res) => {
  if (!isFBConfigured()) return res.status(400).json({ error: 'Facebook API not configured' });
  const success = await likeComment(req.params.id);
  res.json({ success });
});

import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { dbAll, dbGet, dbRun, getRecentLogs, getSetting, setSetting, getAllPersonas, getDefaultPersona, addLog, findQAMatch, upsertConversation, addMessage, getConversationMessages, getDb } from '../database/db.js';
import { isRunning } from '../automation/browser.js';
import { isLoggedIn, login } from '../automation/facebook.js';
import { isChatMonitorActive } from '../automation/chatBot.js';
import { isCommentMonitorActive } from '../automation/commentBot.js';
import { getScheduledPosts, schedulePost, deleteScheduledPost } from '../automation/postManager.js';
import { testAllProviders, getProvider, getProviderForTask, aiChat } from '../ai/aiRouter.js';
import { buildContentPrompt } from '../ai/prompts/contentCreator.js';
import { buildChatMessages } from '../ai/prompts/chatPersona.js';
import { personaManager, PLATFORMS } from '../ai/personaManager.js';
import type { PlatformType } from '../ai/personaManager.js';
import {
  buildContext as buildMemoryContext,
  addMessage as umAddMessage,
  shouldExtractArchival, shouldExtractCore,
  saveArchivalFact, setCoreMemory,
  getMemoryStats,
} from '../memory/unifiedMemory.js';
import { stripThinkTags } from '../utils.js';
import type { AIProviderType } from '../ai/types.js';
import { getAgentRunHistory, getAgentActiveRuns, getAgentStats } from '../bot_agents/agent.js';
import { getCoreMemory, getWorkingMemory, formatCoreMemory } from '../memory/unifiedMemory.js';

export const router = Router();

// ============ Status ============
router.get('/status', async (_req, res) => {
  try {
    const browser = isRunning();
    const loggedIn = browser ? await isLoggedIn() : false;
    res.json({
      browser,
      loggedIn,
      chatBot: isChatMonitorActive(),
      commentBot: isCommentMonitorActive(),
      uptime: process.uptime(),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

/** Parse a query param as a positive integer, clamped to [min, max] */
function parseIntParam(value: unknown, defaultVal: number, min = 1, max = 1000): number {
  const n = parseInt(String(value ?? ''), 10);
  if (Number.isNaN(n) || n < min) return defaultVal;
  return Math.min(n, max);
}

// ============ Logs ============
router.get('/logs', (req, res) => {
  const limit = parseIntParam(req.query.limit, 100, 1, 500);
  res.json(getRecentLogs(limit));
});

// ============ Facebook Auth ============
router.post('/fb/login', async (req, res) => {
  const { email, password } = req.body;
  const success = await login(email, password);
  res.json({ success });
});

router.get('/fb/status', async (req, res) => {
  res.json({ loggedIn: isRunning() ? await isLoggedIn() : false });
});

// ============ Settings ============
router.get('/settings', (req, res) => {
  const rows = dbAll('SELECT * FROM settings');
  res.json(rows);
});

router.post('/settings', (req, res) => {
  try {
    const { key, value } = req.body;
    if (key && value !== undefined) {
      // Single key-value pair
      setSetting(key, value);
    } else {
      // Batch: object of key-value pairs
      const entries = req.body as Record<string, string>;
      for (const [k, v] of Object.entries(entries)) {
        if (k !== 'key' && k !== 'value') setSetting(k, String(v));
      }
    }
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ============ AI Providers ============
router.get('/ai/test', async (_req, res) => {
  try {
    const results = await testAllProviders();
    res.json(results);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

router.post('/ai/test', async (req, res) => {
  const { provider: providerName, apiKey } = req.body;
  try {
    // Temporarily set the key if provided
    if (apiKey) setSetting(`ai_${providerName}_key`, apiKey);
    const provider = getProvider(providerName as AIProviderType);
    const success = await provider.testConnection();
    res.json({ success });
  } catch (e: any) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/ai/models', async (req, res) => {
  const { provider: providerName, apiKey } = req.body;
  try {
    if (apiKey) setSetting(`ai_${providerName}_key`, apiKey);
    const provider = getProvider(providerName as AIProviderType);
    const models = await provider.listModels();
    res.json({ models });
  } catch (e: any) {
    res.json({ models: [] });
  }
});

router.post('/ai/generate-post', async (req, res) => {
  const { topic, style } = req.body;
  try {
    const provider = getProviderForTask('content');
    const messages = buildContentPrompt(topic, style || 'engaging');
    const result = await provider.chat(messages);
    res.json({ content: result.text, usage: result.usage });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ============ Personas ============
router.get('/personas', (req, res) => {
  res.json(getAllPersonas());
});

router.get('/personas/default', (req, res) => {
  res.json(getDefaultPersona());
});

router.post('/personas', (req, res) => {
  const { name, description, system_prompt, personality_traits, speaking_style, language, temperature, max_tokens } = req.body;
  if (!name || !system_prompt) {
    return res.status(400).json({ error: 'name and system_prompt are required' });
  }
  const id = uuid().slice(0, 8);
  dbRun(`
    INSERT INTO personas (id, name, description, system_prompt, personality_traits, speaking_style, language, temperature, max_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, name, description, system_prompt,
    typeof personality_traits === 'string' ? personality_traits : JSON.stringify(personality_traits),
    speaking_style, language || 'th', temperature || 0.7, max_tokens || 500
  ]);
  res.json({ success: true, id });
});

router.put('/personas/:id', (req, res) => {
  const { name, description, system_prompt, personality_traits, speaking_style, language, temperature, max_tokens } = req.body;
  dbRun(`
    UPDATE personas SET name=?, description=?, system_prompt=?, personality_traits=?, speaking_style=?,
    language=?, temperature=?, max_tokens=?, updated_at=datetime('now')
    WHERE id=?
  `, [name, description, system_prompt,
    typeof personality_traits === 'string' ? personality_traits : JSON.stringify(personality_traits),
    speaking_style, language || 'th', temperature || 0.7, max_tokens || 500,
    req.params.id
  ]);
  res.json({ success: true });
});

router.post('/personas/:id/default', (req, res) => {
  dbRun('UPDATE personas SET is_default = 0', []);
  dbRun('UPDATE personas SET is_default = 1 WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

router.delete('/personas/:id', (req, res) => {
  dbRun('DELETE FROM personas WHERE id = ? AND is_default = 0', [req.params.id]);
  res.json({ success: true });
});

// ============================================================
// Bot Personas — file-based (AGENTS.md / IDENTITY.md / SOUL.md / TOOLS.md)
// ใช้โดย bot_agents ทั้ง 3 ช่องทาง (fb-extension, line, telegram)
// แก้ไขได้จาก Dashboard และ Extension UI
// ============================================================

/** GET /api/bot-personas — รายชื่อ platform ทั้งหมด */
router.get('/bot-personas', (_req, res) => {
  try {
    const result = PLATFORMS.map(platform => personaManager.readFiles(platform));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/bot-personas/:platform — ดึง files ของ platform นั้น */
router.get('/bot-personas/:platform', (req, res) => {
  const platform = req.params.platform as PlatformType;
  if (!PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: `Invalid platform. Use: ${PLATFORMS.join(', ')}` });
  }
  try {
    res.json(personaManager.readFiles(platform));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** PUT /api/bot-personas/:platform — บันทึก files + clear cache ทันที */
router.put('/bot-personas/:platform', (req, res) => {
  const platform = req.params.platform as PlatformType;
  if (!PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: `Invalid platform. Use: ${PLATFORMS.join(', ')}` });
  }
  const { agents, identity, soul, tools } = req.body;
  try {
    personaManager.writeFiles(platform, { agents, identity, soul, tools });
    addLog('system', 'Bot Persona Updated', `Platform: ${platform}`, 'success');
    res.json({ success: true, platform });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ============ Q&A Database ============

/**
 * Validate Q&A pattern to prevent:
 * 1. Empty/too-short patterns
 * 2. ReDoS (catastrophic backtracking) — check regex compiles in < 50ms
 * 3. Overly long patterns that could be expensive
 */
function validateQAPattern(pattern: string, matchType: string): { valid: boolean; error?: string } {
  if (!pattern || pattern.trim().length === 0) return { valid: false, error: 'Question pattern ห้ามว่าง' };
  if (pattern.length > 500) return { valid: false, error: 'Pattern ยาวเกินไป (max 500 chars)' };

  if (matchType === 'regex') {
    try {
      // Test regex compiles
      const re = new RegExp(pattern);
      // Test regex doesn't cause catastrophic backtracking with pathological input
      const testStr = 'a'.repeat(50) + '!';
      const start = Date.now();
      re.test(testStr);
      const elapsed = Date.now() - start;
      if (elapsed > 50) return { valid: false, error: 'Regex ช้าเกินไป (อาจเกิด ReDoS)' };
    } catch (e: any) {
      return { valid: false, error: `Regex syntax error: ${e.message}` };
    }
  }

  return { valid: true };
}

router.get('/qa', (_req, res) => {
  const rows = dbAll('SELECT * FROM qa_pairs ORDER BY priority DESC, id DESC');
  res.json(rows);
});

router.post('/qa', (req, res) => {
  const { question_pattern, answer, match_type, category, priority } = req.body;

  // Validate inputs
  if (!answer || answer.trim().length === 0) return res.status(400).json({ error: 'Answer ห้ามว่าง' });
  const validation = validateQAPattern(question_pattern, match_type || 'contains');
  if (!validation.valid) return res.status(400).json({ error: validation.error });

  dbRun(
    'INSERT INTO qa_pairs (question_pattern, answer, match_type, category, priority) VALUES (?, ?, ?, ?, ?)',
    [question_pattern.trim(), answer.trim(), match_type || 'contains', category || null, priority || 0]
  );
  const lastRow = dbGet('SELECT last_insert_rowid() as id');
  res.json({ success: true, id: lastRow?.id });
});

router.put('/qa/:id', (req, res) => {
  const fields = req.body;
  const current = dbGet<{ question_pattern: string; match_type: string; answer: string; category: string | null; priority: number; is_active: number }>('SELECT * FROM qa_pairs WHERE id = ?', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Not found' });

  // Validate pattern if being changed
  const newPattern = fields.question_pattern ?? current.question_pattern;
  const newMatchType = fields.match_type ?? current.match_type;
  const validation = validateQAPattern(newPattern, newMatchType);
  if (!validation.valid) return res.status(400).json({ error: validation.error });

  dbRun(`
    UPDATE qa_pairs SET question_pattern=?, answer=?, match_type=?, category=?, priority=?, is_active=?
    WHERE id=?
  `, [
    newPattern,
    fields.answer ?? current.answer,
    newMatchType,
    fields.category ?? current.category,
    fields.priority ?? current.priority,
    fields.is_active !== undefined ? (fields.is_active ? 1 : 0) : current.is_active,
    req.params.id
  ]);
  res.json({ success: true });
});

router.delete('/qa/:id', (req, res) => {
  dbRun('DELETE FROM qa_pairs WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

router.post('/qa/test', (req, res) => {
  const { question } = req.body;
  const match = findQAMatch(question);
  if (match) {
    res.json({ match: true, ...match });
  } else {
    res.json({ match: false });
  }
});

// ============ Scheduled Posts ============
router.get('/posts', (req, res) => {
  const limit = parseIntParam(req.query.limit, 50, 1, 200);
  res.json(getScheduledPosts(limit));
});

router.post('/posts', (req, res) => {
  try {
    const { content, scheduledTime } = req.body;
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({ error: 'content is required' });
    }
    const id = schedulePost(req.body);
    res.json({ success: true, id });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Failed to schedule post: ${msg}` });
  }
});

router.delete('/posts/:id', (req, res) => {
  const id = parseIntParam(req.params.id, 0, 1);
  if (!id) return res.status(400).json({ error: 'Invalid post id' });
  deleteScheduledPost(id);
  res.json({ success: true });
});

// ============ Comment Watches ============
router.get('/comments/watches', (req, res) => {
  const rows = dbAll('SELECT * FROM comment_watches ORDER BY created_at DESC');
  res.json(rows);
});

router.post('/comments/watches', (req, res) => {
  const { fb_post_url, reply_style, max_replies } = req.body;
  // Validate required URL
  if (!fb_post_url || typeof fb_post_url !== 'string' || !fb_post_url.includes('facebook.com')) {
    return res.status(400).json({ error: 'fb_post_url ต้องเป็น URL ของ Facebook ที่ถูกต้อง' });
  }
  // Validate optional max_replies
  const safeMaxReplies = Math.max(1, Math.min(parseInt(String(max_replies ?? '50'), 10) || 50, 1000));
  const safeStyle = ['friendly', 'formal', 'casual', 'auto'].includes(reply_style) ? reply_style : 'friendly';
  dbRun(
    'INSERT INTO comment_watches (fb_post_url, reply_style, max_replies) VALUES (?, ?, ?)',
    [fb_post_url.substring(0, 500), safeStyle, safeMaxReplies]
  );
  const lastRow = dbGet('SELECT last_insert_rowid() as id');
  res.json({ success: true, id: lastRow?.id });
});

router.delete('/comments/watches/:id', (req, res) => {
  dbRun('DELETE FROM comment_watches WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// ============ Chat Reply (Extension API) — 3-Layer Memory ============
router.post('/chat/reply', async (req, res) => {
  const { conversationId, userName, message, messageId } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required and must be a string' });
  }

  if (message.length > 10000) {
    return res.status(400).json({ error: 'message too long (max 10000 chars)' });
  }

  try {
    const convId = conversationId || 'unknown';
    const userId = convId; // In Messenger, convId = userId

    // 1. Upsert conversation
    upsertConversation(convId, userId, userName || 'Unknown');

    // 2. Anti-duplicate Check (Execution BEFORE database save)
    const priorMsgs = getConversationMessages(convId, 3);
    if (priorMsgs.length > 0) {
      const lastMsg = priorMsgs[priorMsgs.length - 1];

      // Case A: Double-send (User/Extension clicked/sent twice rapidly before AI replied)
      if (lastMsg.role === 'user' && lastMsg.content === message) {
        addLog('chat', 'Duplicate skip', `Double-send blocked: "${message.substring(0, 40)}"`, 'info');
        return res.json({ reply: 'Processing or duplicate', duplicate: true });
      }

      // Case B: Extension loop (AI already replied to this exact content)
      if (lastMsg.role === 'assistant') {
        const lastUserMsg = priorMsgs.slice().reverse().find(m => m.role === 'user');
        if (lastUserMsg && lastUserMsg.content === message) {
          addLog('chat', 'Duplicate skip', `Already replied to: "${message.substring(0, 40)}"`, 'info');
          return res.json({ reply: lastMsg.content, source: 'cached', duplicate: true });
        }
      }
    }

    // 3. Save incoming message
    addMessage(convId, 'user', message, messageId);

    // 3. Check Q&A database first (instant, no AI call)
    const qaMatch = findQAMatch(message);
    if (qaMatch) {
      const reply = qaMatch.answer;
      addMessage(convId, 'assistant', reply);
      addLog('chat', 'Q&A match', `"${message.substring(0, 40)}" → "${reply.substring(0, 40)}"`, 'success');
      return res.json({ reply, source: 'qa' });
    }

    // 4. Load File-Based Persona (OpenClaw Style)
    const personaConfig = personaManager.loadPersona('fb-extension');

    // 5. Build Unified Memory context (4 layers)
    const fbChatId = `fb_${convId}`;

    // Upsert conversation to satisfy SQLite foreign key constraints for unified memory
    upsertConversation(fbChatId, userId, userName || 'Unknown');
    umAddMessage(fbChatId, 'user', message); // Save to unified memory
    const memCtx = await buildMemoryContext(fbChatId, message);

    // 6. Determine which AI provider + model will be used
    const chatProvider = getProviderForTask('chat');
    const chatProviderModel = getSetting('ai_task_chat_model') || 'default';
    console.log(`[Chat] Provider: ${chatProvider.id}, Model: ${chatProviderModel}, Conv: ${convId}, Memory: core=${memCtx.stats.coreBlocks} working=${memCtx.stats.workingMessages} archival=${memCtx.stats.archivalFacts}`);
    addLog('chat', 'AI call', `Provider: ${chatProvider.id} | Memory: C${memCtx.stats.coreBlocks}/W${memCtx.stats.workingMessages}/A${memCtx.stats.archivalFacts} | ~${memCtx.tokenEstimate}t`, 'info');

    // 7. Build AI messages with unified memory context
    const aiMessages = buildChatMessages(personaConfig.systemInstruction, {
      recentMessages: memCtx.workingMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      summaryMarkdown: '',
      userProfileMarkdown: memCtx.coreMemoryText
    }, message);

    // Inject archival facts into system message if available
    if (memCtx.archivalFacts.length > 0) {
      const archivalNote = `\n[Archival Memory]: ${memCtx.archivalFacts.join(' | ')}`;
      if (aiMessages[0] && aiMessages[0].role === 'system') {
        aiMessages[0].content += archivalNote;
      }
    }

    let aiResult = await aiChat('chat', aiMessages, {
      temperature: 0.7,
      maxTokens: 300,
    });

    let rawReply = aiResult.text || '';

    // 8. Strip <think> tags and reasoning artifacts
    let reply = stripThinkTags(rawReply);

    // If reply is empty after stripping (likely <think> tags consumed all tokens),
    // retry with a non-thinking model
    if (!reply) {
      const wasThinking = rawReply.includes('<think>') || rawReply.includes('</think>');
      addLog('chat', 'Empty after strip',
        `${wasThinking ? 'Think tags ate all tokens' : 'AI returned empty'}. Raw: "${rawReply.substring(0, 80)}" — retrying with non-thinking model`,
        'warning');
      try {
        aiResult = await aiChat('chat', aiMessages, {
          temperature: 0.7,
          maxTokens: 300,
          model: 'gemini-2.0-flash-lite'
        });
        rawReply = aiResult.text || '';
        reply = stripThinkTags(rawReply);
        if (reply) {
          addLog('chat', 'Fallback success', `"${reply.substring(0, 50)}"`, 'success');
        }
      } catch (fallbackErr: any) {
        addLog('chat', 'Fallback failed', fallbackErr.message, 'error');
      }
    }

    if (!reply) {
      if (rawReply) {
        addLog('chat', 'Empty reply after stripping', `Raw was: ${rawReply.substring(0, 200)}`, 'warning');
      } else {
        addLog('chat', 'Empty reply from AI', `Provider ${chatProvider.id} returned empty. Check API key and model settings.`, 'error');
      }
      reply = 'ขอตรวจสอบข้อมูลก่อนนะคะ เดี๋ยวรีบมาแจ้งให้ทราบค่ะ';
    }

    const usage = aiResult.usage;

    // 9. Save AI reply to both old DB and unified memory
    addMessage(convId, 'assistant', reply);
    umAddMessage(fbChatId, 'assistant', reply);

    addLog('chat', 'AI reply',
      `[${userName}] "${message.substring(0, 30)}" → "${reply.substring(0, 30)}"` +
      (usage ? ` [${usage.totalTokens}t ~${memCtx.tokenEstimate}est]` : ''),
      'success'
    );

    return res.json({
      reply,
      source: 'ai',
      provider: chatProvider.id,
      model: chatProviderModel,
      usage,
      memory: {
        layers: {
          core: memCtx.stats.coreBlocks,
          working: memCtx.stats.workingMessages,
          archival: memCtx.stats.archivalFacts,
        },
        tokenEstimate: memCtx.tokenEstimate,
      },
    });
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    console.error('[Chat] Reply error:', errMsg);
    addLog('chat', 'Reply error', errMsg, 'error');
    return res.status(500).json({ error: errMsg });
  }
});

// ============ FB Conversation Memory Info Endpoint ============
router.get('/memory/fb/:convId', async (req, res) => {
  try {
    const convId = req.params.convId;
    const conv = dbGet<{ fb_user_name: string | null; summary: string; summary_msg_count: number }>('SELECT * FROM conversations WHERE id = ?', [convId]);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const profile = dbGet<{ facts: string; tags: string; total_messages: number; first_contact: string }>('SELECT * FROM user_profiles WHERE user_id = ?', [convId]);
    const msgCount = dbGet<{ c: number }>('SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?', [convId]);

    res.json({
      conversationId: convId,
      userName: conv.fb_user_name,
      messageCount: msgCount?.c || 0,
      summary: conv.summary || '',
      summaryMsgCount: conv.summary_msg_count || 0,
      profile: profile ? {
        facts: (() => { try { return JSON.parse(profile.facts); } catch { return []; } })(),
        tags: (() => { try { return JSON.parse(profile.tags); } catch { return []; } })(),
        totalMessages: profile.total_messages,
        firstContact: profile.first_contact,
      } : null,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ============ Clear AI Memory Endpoint ============
router.delete('/memory/all', async (req, res) => {
  try {
    dbRun('DELETE FROM messages');
    dbRun('DELETE FROM user_profiles');
    dbRun('DELETE FROM conversations');
    addLog('system', 'Wiped AI Memory', 'Cleared all conversations, messages, and profiles', 'warning');
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/memory/fb/:convId', async (req, res) => {
  try {
    const convId = req.params.convId;
    dbRun('DELETE FROM messages WHERE conversation_id = ?', [convId]);
    dbRun('DELETE FROM user_profiles WHERE user_id = ?', [convId]);
    dbRun('DELETE FROM conversations WHERE id = ?', [convId]);
    addLog('system', 'Cleared User Memory', `Cleared memory for ID: ${convId}`, 'info');
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});


// ============ Conversations ============
router.get('/conversations', (req, res) => {
  const rows = dbAll(`
    SELECT c.*, COUNT(m.id) as message_count
    FROM conversations c
    LEFT JOIN messages m ON m.conversation_id = c.id
    GROUP BY c.id
    ORDER BY c.last_message_at DESC LIMIT 50
      `);
  res.json(rows);
});

router.get('/conversations/:id/messages', (req, res) => {
  const limit = parseIntParam(req.query.limit, 50, 1, 500);
  const rows = dbAll(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT ?',
    [req.params.id, limit]
  );
  res.json(rows.reverse());
});

// ============ Health Monitoring & Stats ============
router.get('/health/detailed', (_req, res) => {
  const memUsage = process.memoryUsage();
  const dbSize = (() => {
    try {
      const row = dbGet<{ size: number }>(`SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()`);
      return row?.size || 0;
    } catch { return 0; }
  })();

  const messageCount      = dbGet<{ c: number }>('SELECT COUNT(*) as c FROM messages');
  const conversationCount = dbGet<{ c: number }>('SELECT COUNT(*) as c FROM conversations');
  const episodeCount      = dbGet<{ c: number }>('SELECT COUNT(*) as c FROM episodes');
  const knowledgeCount    = dbGet<{ c: number }>('SELECT COUNT(*) as c FROM knowledge');
  const logCount          = dbGet<{ c: number }>('SELECT COUNT(*) as c FROM activity_logs');

  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
      rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
    },
    database: {
      sizeBytes: dbSize,
      sizeMB: Math.round(dbSize / 1024 / 1024 * 100) / 100,
      messages: messageCount?.c || 0,
      conversations: conversationCount?.c || 0,
      episodes: episodeCount?.c || 0,
      knowledge: knowledgeCount?.c || 0,
      logs: logCount?.c || 0,
    },
    bots: {
      browser: isRunning(),
      chatBot: isChatMonitorActive(),
      commentBot: isCommentMonitorActive(),
    },
    timestamp: new Date().toISOString(),
  });
});

// ============ DB Maintenance ============
router.post('/maintenance/cleanup-logs', (_req, res) => {
  const cutoffDays = 30;
  const result = getDb().prepare(`DELETE FROM activity_logs WHERE created_at < datetime('now', '-' || ? || ' days')`).run(cutoffDays);
  const cleaned = (result as any).changes || 0;
  addLog('system', 'Log cleanup', `Removed ${cleaned} logs older than ${cutoffDays} days`, 'info');
  res.json({ success: true, cleaned });
});

router.post('/maintenance/cleanup-episodes', (_req, res) => {
  // Keep only last 500 episodes per chat
  const chatIds = dbAll<{ chat_id: string }>('SELECT DISTINCT chat_id FROM episodes');
  let totalCleaned = 0;
  for (const { chat_id } of chatIds) {
    const countRow = dbGet<{ c: number }>('SELECT COUNT(*) as c FROM episodes WHERE chat_id = ?', [chat_id]);
    if (countRow && countRow.c > 500) {
      const excess = countRow.c - 500;
      dbRun('DELETE FROM episodes WHERE id IN (SELECT id FROM episodes WHERE chat_id = ? ORDER BY id ASC LIMIT ?)', [chat_id, excess]);
      totalCleaned += excess;
    }
  }
  addLog('system', 'Episode cleanup', `Removed ${totalCleaned} old episodes`, 'info');
  res.json({ success: true, cleaned: totalCleaned });
});

// ============================================================
// 🤖 Agent Monitor API — Real-time agentic telemetry
// ============================================================

// GET /api/agent/runs — last N agent runs (default 50)
router.get('/agent/runs', (req, res) => {
  const limit = parseIntParam(req.query.limit, 50, 1, 100);
  res.json(getAgentRunHistory().slice(0, limit));
});

// GET /api/agent/active — currently processing requests
router.get('/agent/active', (_req, res) => {
  res.json(getAgentActiveRuns());
});

// GET /api/agent/stats — aggregate stats
router.get('/agent/stats', (_req, res) => {
  const stats = getAgentStats();
  const mem = process.memoryUsage();
  res.json({
    ...stats,
    uptime: Math.round(process.uptime()),
    memoryMB: Math.round(mem.rss / 1024 / 1024),
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
  });
});

// ============================================================
// 🧠 Memory Viewer API — Browse per-user memory state
// ============================================================

// GET /api/memory/chats — list of chat IDs with memory activity
router.get('/memory/chats', (_req, res) => {
  const db = getDb();
  try {
    const chats = db.prepare(`
      SELECT e.chat_id,
             COUNT(e.id) as episodeCount,
             MAX(e.timestamp) as lastSeen
      FROM episodes e
      GROUP BY e.chat_id
      ORDER BY lastSeen DESC
      LIMIT 50
    `).all();
    res.json(chats);
  } catch {
    res.json([]);
  }
});

// GET /api/memory/:chatId — full memory state for a chat
router.get('/memory/:chatId', (req, res) => {
  const { chatId } = req.params;
  const db = getDb();
  try {
    const stats = getMemoryStats(chatId);
    const coreBlocks = getCoreMemory(chatId);
    const coreText = formatCoreMemory(coreBlocks);
    const workingMessages = getWorkingMemory(chatId);
    const archival = db.prepare(
      'SELECT id, fact, created_at FROM archival_memory WHERE chat_id = ? ORDER BY created_at DESC LIMIT 30'
    ).all(chatId) as any[];
    const episodeCount = (db.prepare('SELECT COUNT(*) as c FROM episodes WHERE chat_id = ?').get(chatId) as any)?.c ?? 0;

    res.json({
      chatId,
      stats,
      core: { text: coreText, blocks: coreBlocks },
      working: workingMessages,
      archival,
      episodeCount,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/memory/:chatId — clear all memory for a chat
router.delete('/memory/:chatId', (req, res) => {
  const { chatId } = req.params;
  const db = getDb();
  try {
    db.prepare('DELETE FROM archival_memory WHERE chat_id = ?').run(chatId);
    db.prepare('DELETE FROM core_memory WHERE chat_id = ?').run(chatId);
    db.prepare('DELETE FROM episodes WHERE chat_id = ?').run(chatId);
    addLog('system', 'Memory cleared', chatId, 'info');
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

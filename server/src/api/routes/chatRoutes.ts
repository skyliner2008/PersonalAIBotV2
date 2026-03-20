import { Router } from 'express';
import { z } from 'zod';
import { GoogleGenAI } from '@google/genai';
import {
  addLog,
  addMessage,
  findQAMatch,
  getConversationMessages,
  getSetting,
  upsertConversation,
} from '../../database/db.js';
import { getProviderForTask, aiChat } from '../../ai/aiRouter.js';
import { buildChatMessages } from '../../ai/prompts/chatPersona.js';
import { personaManager } from '../../ai/personaManager.js';
import {
  buildContext as buildMemoryContext,
  addMessage as umAddMessage,
} from '../../memory/unifiedMemory.js';
import { stripThinkTags } from '../../utils.js';
import { asyncHandler } from '../../utils/errorHandler.js';
import { validateBody } from '../../utils/validation.js';
import { SSEWriter, streamGeminiResponse } from '../../utils/streamManager.js';

const chatReplySchema = z.object({
  conversationId: z.string().optional(),
  userName: z.string().max(200).optional(),
  message: z.string().min(1, 'message is required').max(10000),
  messageId: z.string().optional(),
});

const chatRoutes = Router();

// Chat reply (extension API)
chatRoutes.post('/chat/reply', validateBody(chatReplySchema), asyncHandler(async (req, res) => {
  const { conversationId, userName, message, messageId } = req.body;

  const convId = conversationId || 'unknown';
  const userId = convId;

  upsertConversation(convId, userId, userName || 'Unknown');

  // Anti-duplicate check before saving new message.
  const priorMsgs = getConversationMessages(convId, 3);
  if (priorMsgs.length > 0) {
    const lastMsg = priorMsgs[priorMsgs.length - 1];

    if (lastMsg.role === 'user' && lastMsg.content === message) {
      addLog('chat', 'Duplicate skip', `Double-send blocked: "${message.substring(0, 40)}"`, 'info');
      return res.json({ reply: 'Processing or duplicate', duplicate: true });
    }

    if (lastMsg.role === 'assistant') {
      const lastUserMsg = priorMsgs.slice().reverse().find(m => m.role === 'user');
      if (lastUserMsg && lastUserMsg.content === message) {
        addLog('chat', 'Duplicate skip', `Already replied to: "${message.substring(0, 40)}"`, 'info');
        return res.json({ reply: lastMsg.content, source: 'cached', duplicate: true });
      }
    }
  }

  addMessage(convId, 'user', message, messageId);

  const qaMatch = findQAMatch(message);
  if (qaMatch) {
    const reply = qaMatch.answer;
    addMessage(convId, 'assistant', reply);
    addLog('chat', 'Q&A match', `"${message.substring(0, 40)}" -> "${reply.substring(0, 40)}"`, 'success');
    return res.json({ reply, source: 'qa' });
  }

  const personaConfig = personaManager.loadPersona('web' as any);
  const chatMemId = `dash_${convId}`;
  umAddMessage(chatMemId, 'user', message);
  const memCtx = await buildMemoryContext(chatMemId, message);

  const chatProvider = getProviderForTask('chat');
  const chatProviderModel = getSetting('ai_task_chat_model') || 'default';

  if (!memCtx) {
    return res.status(500).json({ success: false, error: 'Failed to build memory context' });
  }

  console.log(
    `[Chat] Provider: ${chatProvider.id}, Model: ${chatProviderModel}, Conv: ${convId}, Memory: core=${memCtx.stats.coreBlocks} working=${memCtx.stats.workingMessages} archival=${memCtx.stats.archivalFacts}`,
  );
  addLog(
    'chat',
    'AI call',
    `Provider: ${chatProvider.id} | Memory: C${memCtx.stats.coreBlocks}/W${memCtx.stats.workingMessages}/A${memCtx.stats.archivalFacts} | ~${memCtx.tokenEstimate}t`,
    'info',
  );

  const aiMessages = buildChatMessages(
    personaConfig.systemInstruction,
    {
      recentMessages: memCtx.workingMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      summaryMarkdown: '',
      userProfileMarkdown: memCtx.coreMemoryText,
    },
    message,
  );

  if (memCtx.archivalFacts.length > 0) {
    const archivalNote = `\n[Archival Memory]: ${memCtx.archivalFacts.join(' | ')}`;
    if (aiMessages[0] && aiMessages[0].role === 'system') {
      aiMessages[0].content += archivalNote;
    }
  }

  let aiResult = await aiChat('chat', aiMessages, {
    temperature: 0.7,
    maxTokens: 1000,
  });

  let rawReply = aiResult.text || '';
  let reply = stripThinkTags(rawReply);

  // --- FALLBACK LOGIC FOR EMPTY REPLIES (THINKING TAGS ISSUE) ---
  if (!reply && rawReply) {
    const wasThinking = rawReply.includes('<think>') || rawReply.includes('</think>');
    addLog(
      'chat',
      'Empty after strip',
      `${wasThinking ? 'Think tags ate all tokens' : 'AI returned empty'}. Raw: "${rawReply.substring(0, 80)}" -> retrying with non-thinking model`,
      'warning',
    );
    try {
      aiResult = await aiChat('chat', aiMessages, {
        temperature: 0.7,
        maxTokens: 300,
        model: 'gemini-2.0-flash-lite',
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

  // Prevent XSS from AI generated malicious tags
  reply = reply.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
               .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');

  const usage = aiResult.usage;

  addMessage(convId, 'assistant', reply);
  umAddMessage(chatMemId, 'assistant', reply);

  addLog(
    'chat',
    'AI reply',
    `[${userName}] "${message.substring(0, 30)}" -> "${reply.substring(0, 30)}"${usage ? ` [${usage.totalTokens}t ~${memCtx.tokenEstimate}est]` : ''}`,
    'success',
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
}));

// Streaming chat reply (SSE)
chatRoutes.post('/chat/stream', validateBody(chatReplySchema), async (req, res) => {
  const { conversationId, userName, message } = req.body;
  const writer = new SSEWriter(res);

  try {
    const convId = conversationId || 'unknown';
    const userId = convId;
    upsertConversation(convId, userId, userName || 'Unknown');

    const qaMatch = findQAMatch(message);
    if (qaMatch) {
      writer.sendToken(qaMatch.answer);
      writer.sendDone(qaMatch.answer);
      addMessage(convId, 'user', message);
      addMessage(convId, 'assistant', qaMatch.answer);
      return;
    }

    addMessage(convId, 'user', message);
    writer.sendStatus('กำลังคิด...');

    const fbChatId = `fb_${convId}`;
    umAddMessage(fbChatId, 'user', message);
    const memCtx = await buildMemoryContext(fbChatId, message);

    if (!memCtx) {
      writer.sendError('Failed to build memory context');
      return;
    }

    const personaConfig = personaManager.loadPersona('fb-extension');
    const aiMessages = buildChatMessages(personaConfig.systemInstruction, {
      recentMessages: memCtx.workingMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      summaryMarkdown: '',
      userProfileMarkdown: memCtx.coreMemoryText,
    }, message);

    if (memCtx.archivalFacts.length > 0) {
      const archivalNote = `\n[Archival Memory]: ${memCtx.archivalFacts.join(' | ')}`;
      const sysMsg = aiMessages.find(m => m.role === 'system');
      if (sysMsg) {
        sysMsg.content += archivalNote;
      }
    }

    const systemInstruction = aiMessages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const contents = aiMessages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }],
    }));

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      writer.sendError('GEMINI_API_KEY not configured');
      return;
    }

    const chatProviderModel = getSetting('ai_task_chat_model') || 'gemini-2.0-flash';
    const ai = new GoogleGenAI({ apiKey });
    
    addLog('chat', 'Stream Start', `Model: ${chatProviderModel} | Search: enabled`, 'info');
    writer.sendStatus('กำลังคิด...');

    const result = await streamGeminiResponse({
      ai,
      modelName: chatProviderModel,
      systemInstruction,
      contents,
      useGoogleSearch: true,
      writer,
    });

    let reply = stripThinkTags(result.text) || result.text || 'ขอตรวจสอบข้อมูลก่อนนะคะ';
    reply = reply.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                 .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');

    addMessage(convId, 'assistant', reply);
    umAddMessage(fbChatId, 'assistant', reply);

    writer.sendDone(reply, result.usage);
  } catch (err: any) {
    writer.sendError(err.message || 'Unknown error');
  }
});

export default chatRoutes;

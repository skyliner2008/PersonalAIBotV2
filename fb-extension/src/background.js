// ============================================================
// FB AI Agent — Background Service Worker v4
// Token tracking, abort control, improved message routing
// ============================================================

const SERVER_URL = 'http://localhost:3000';
const FBAI_STATE_KEY = 'fbai_v4';
const TOKEN_KEY = 'fbai_tokens';
let serverConnected = false;

// In-memory extension log buffer
const extLogs = [];
const MAX_EXT_LOGS = 500;

// Cached settings for token tracking (avoid fetching every message)
let cachedProvider = null;
let cachedModel = null;
let settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 60000; // 1 minute

// ---- Token write lock (race condition prevention) ----
let tokenWriteLock = false;

// ---- Message processing queue per conversation ----
const messageProcessingQueues = new Map(); // convId -> Promise

function addExtLog(level, source, msg) {
  extLogs.push({ time: new Date().toISOString(), level, source, msg });
  if (extLogs.length > MAX_EXT_LOGS) extLogs.shift();
}

// ---- Open Side Panel on icon click ----
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => { });

// ---- Circuit breaker state ----
let apiConsecutiveFailures = 0;
let apiCircuitBreakerTime = 0;
const API_CIRCUIT_BREAKER_DELAY = 30000; // 30 seconds
const API_MAX_CONSECUTIVE_FAILURES = 3;

// ---- Server API helper with retry & circuit breaker ----
async function api(path, options = {}) {
  // Check circuit breaker
  if (apiCircuitBreakerTime && Date.now() < apiCircuitBreakerTime) {
    const remaining = Math.ceil((apiCircuitBreakerTime - Date.now()) / 1000);
    const msg = `Circuit breaker active for ${remaining}s`;
    addExtLog('warn', 'BG', `API ${path}: ${msg}`);
    return { error: msg };
  }

  const maxRetries = 2;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${SERVER_URL}/api${path}`, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(60000),
        ...options,
      });

      if (res.ok) {
        const data = await res.json();
        // Reset circuit breaker on success
        apiConsecutiveFailures = 0;
        apiCircuitBreakerTime = 0;
        return data;
      }

      // Don't retry client errors (4xx)
      if (res.status >= 400 && res.status < 500) {
        apiConsecutiveFailures++;
        if (apiConsecutiveFailures >= API_MAX_CONSECUTIVE_FAILURES) {
          apiCircuitBreakerTime = Date.now() + API_CIRCUIT_BREAKER_DELAY;
        }
        const error = `HTTP ${res.status}`;
        addExtLog('error', 'BG', `API ${path}: ${error}`);
        return { error };
      }

      // Retry server errors (5xx)
      lastError = `HTTP ${res.status}`;
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // exponential backoff: 1s, 2s
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
    } catch (e) {
      lastError = e.message;
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
    }
  }

  // All retries exhausted
  apiConsecutiveFailures++;
  if (apiConsecutiveFailures >= API_MAX_CONSECUTIVE_FAILURES) {
    apiCircuitBreakerTime = Date.now() + API_CIRCUIT_BREAKER_DELAY;
  }

  const error = `API ${path} failed after ${maxRetries + 1} attempts: ${lastError}`;
  addExtLog('error', 'BG', error);
  return { error };
}

// ---- fbai_v4 state helpers ----
function loadFbaiState() {
  return new Promise(r => chrome.storage.local.get(FBAI_STATE_KEY, d => r(d[FBAI_STATE_KEY] || {})));
}

function saveFbaiState(updates) {
  return new Promise(async r => {
    const current = await loadFbaiState();
    const newState = { ...current, ...updates };
    chrome.storage.local.set({ [FBAI_STATE_KEY]: newState }, r);
  });
}

// ---- Token tracking with write lock (race condition prevention) ----
async function trackTokenUsage(usage, provider, model) {
  if (!usage) return;

  // Wait for lock to be released
  while (tokenWriteLock) {
    await new Promise(r => setTimeout(r, 10));
  }

  return new Promise(resolve => {
    // Acquire lock
    tokenWriteLock = true;

    chrome.storage.local.get(TOKEN_KEY, (data) => {
      const tokens = data[TOKEN_KEY] || {
        daily: {},
        totalTokens: 0,
        totalRequests: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        byProvider: {},
      };

      const today = new Date().toISOString().split('T')[0];

      // Daily tracking
      if (!tokens.daily[today]) {
        tokens.daily[today] = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };
      }
      tokens.daily[today].promptTokens += usage.promptTokens || 0;
      tokens.daily[today].completionTokens += usage.completionTokens || 0;
      tokens.daily[today].totalTokens += usage.totalTokens || 0;
      tokens.daily[today].requests += 1;

      // Overall totals
      tokens.totalTokens += usage.totalTokens || 0;
      tokens.totalPromptTokens += usage.promptTokens || 0;
      tokens.totalCompletionTokens += usage.completionTokens || 0;
      tokens.totalRequests += 1;

      // Per-provider tracking
      const provKey = provider || 'unknown';
      if (!tokens.byProvider[provKey]) {
        tokens.byProvider[provKey] = { totalTokens: 0, requests: 0 };
      }
      tokens.byProvider[provKey].totalTokens += usage.totalTokens || 0;
      tokens.byProvider[provKey].requests += 1;

      // Clean up old daily entries (keep 30 days)
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
      for (const d of Object.keys(tokens.daily)) {
        if (d < cutoff) delete tokens.daily[d];
      }

      chrome.storage.local.set({ [TOKEN_KEY]: tokens }, () => {
        // Release lock
        tokenWriteLock = false;
        resolve();
      });
    });
  });
}

function getTokenUsage() {
  return new Promise(r => chrome.storage.local.get(TOKEN_KEY, d => r(d[TOKEN_KEY] || {})));
}

function resetTokenUsage() {
  return new Promise(r => chrome.storage.local.set({
    [TOKEN_KEY]: { daily: {}, totalTokens: 0, totalRequests: 0, totalPromptTokens: 0, totalCompletionTokens: 0, byProvider: {} }
  }, r));
}

// ---- Broadcast to ALL Messenger/FB tabs ----
function broadcastToFBTabs(msg) {
  chrome.tabs.query(
    { url: ['*://www.facebook.com/*', '*://web.facebook.com/*'] },
    (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, msg).catch(() => { });
      }
    }
  );
}

// ---- Server health check ----
async function checkServer() {
  try {
    const res = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    serverConnected = res.ok;
  } catch {
    serverConnected = false;
  }
  chrome.runtime.sendMessage({ type: 'serverStatus', connected: serverConnected }).catch(() => { });
}

chrome.alarms.create('checkServer', { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkServer') checkServer();
});

// ================================================================
// Message Router
// ================================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ---- Extension logs ----
  if (msg.type === 'extLog') {
    addExtLog(msg.level || 'info', msg.source || 'CS', msg.msg);
    sendResponse({ ok: true });
    return true;
  }

  // ---- Get all logs (server + extension) ----
  if (msg.type === 'getAllLogs') {
    const limit = msg.limit || 100;
    api(`/logs?limit=${limit}`).then(serverLogs => {
      const combined = [
        ...(serverLogs || []).map(l => ({ ...l, _src: 'server' })),
        ...extLogs.slice(-limit).map(l => ({
          type: l.source, action: l.msg, level: l.level,
          created_at: l.time, _src: 'ext'
        })),
      ]
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .slice(-limit);
      sendResponse(combined);
    });
    return true;
  }

  // ---- Server status ----
  if (msg.type === 'getServerStatus') {
    checkServer().then(() => sendResponse({ connected: serverConnected }));
    return true;
  }

  if (msg.type === 'getStatus') {
    api('/status').then(data => sendResponse(data));
    return true;
  }

  // ---- Settings ----
  if (msg.type === 'getSettings') {
    api('/settings').then(data => sendResponse(data));
    return true;
  }

  if (msg.type === 'setSetting') {
    api('/settings', { method: 'POST', body: JSON.stringify({ key: msg.key, value: msg.value }) })
      .then(data => sendResponse(data));
    return true;
  }

  if (msg.type === 'setMultipleSettings') {
    api('/settings', { method: 'POST', body: JSON.stringify(msg.settings) })
      .then(data => sendResponse(data));
    return true;
  }

  // ---- fbai_v4 bot state ----
  if (msg.type === 'getFbaiState') {
    loadFbaiState().then(s => sendResponse(s));
    return true;
  }

  if (msg.type === 'saveFbaiState') {
    saveFbaiState(msg.updates).then(() => sendResponse({ ok: true }));
    return true;
  }

  // ---- Token usage ----
  if (msg.type === 'getTokenUsage') {
    getTokenUsage().then(data => sendResponse(data));
    return true;
  }

  if (msg.type === 'resetTokenUsage') {
    resetTokenUsage().then(() => sendResponse({ ok: true }));
    return true;
  }

  // ---- AI ----
  if (msg.type === 'testAI') {
    api('/ai/test', { method: 'POST', body: JSON.stringify({ provider: msg.provider, apiKey: msg.apiKey }) })
      .then(data => sendResponse(data));
    return true;
  }

  if (msg.type === 'getAIModels') {
    api('/ai/models', { method: 'POST', body: JSON.stringify({ provider: msg.provider, apiKey: msg.apiKey }) })
      .then(data => sendResponse(data));
    return true;
  }

  // ---- Personas ----
  if (msg.type === 'getPersonas') {
    api('/personas').then(data => sendResponse(data));
    return true;
  }

  if (msg.type === 'createPersona') {
    api('/personas', { method: 'POST', body: JSON.stringify(msg.data) }).then(data => sendResponse(data));
    return true;
  }

  if (msg.type === 'updatePersona') {
    api(`/personas/${msg.id}`, { method: 'PUT', body: JSON.stringify(msg.data) }).then(data => sendResponse(data));
    return true;
  }

  if (msg.type === 'deletePersona') {
    api(`/personas/${msg.id}`, { method: 'DELETE' }).then(data => sendResponse(data));
    return true;
  }

  if (msg.type === 'setDefaultPersona') {
    api(`/personas/${msg.id}/default`, { method: 'POST' }).then(data => sendResponse(data));
    return true;
  }

  // ---- Bot File Personas (file-based: AGENTS/IDENTITY/SOUL/TOOLS) ----
  if (msg.type === 'getBotPersona') {
    api('/bot-personas/fb-extension').then(data => sendResponse(data));
    return true;
  }

  if (msg.type === 'saveBotPersona') {
    api('/bot-personas/fb-extension', { method: 'PUT', body: JSON.stringify(msg.data) })
      .then(data => sendResponse(data));
    return true;
  }

  // ---- Q&A ----
  if (msg.type === 'getQA') {
    api('/qa').then(data => sendResponse(data));
    return true;
  }

  if (msg.type === 'createQA') {
    api('/qa', { method: 'POST', body: JSON.stringify(msg.data) }).then(data => sendResponse(data));
    return true;
  }

  if (msg.type === 'updateQA') {
    api(`/qa/${msg.id}`, { method: 'PUT', body: JSON.stringify(msg.data) }).then(data => sendResponse(data));
    return true;
  }

  if (msg.type === 'deleteQA') {
    api(`/qa/${msg.id}`, { method: 'DELETE' }).then(data => sendResponse(data));
    return true;
  }

  if (msg.type === 'testQA') {
    api('/qa/test', { method: 'POST', body: JSON.stringify({ question: msg.question }) })
      .then(data => sendResponse(data));
    return true;
  }

  // ---- Conversations & Memory ----
  if (msg.type === 'getConversations') {
    api('/conversations').then(data => sendResponse(data));
    return true;
  }

  if (msg.type === 'getMessages') {
    api(`/conversations/${msg.convId}/messages?limit=${msg.limit || 50}`).then(data => sendResponse(data));
    return true;
  }

  if (msg.type === 'clearAllMemory') {
    api('/memory/all', { method: 'DELETE' }).then(data => sendResponse(data));
    return true;
  }

  if (msg.type === 'clearMemory') {
    api(`/memory/${msg.convId}`, { method: 'DELETE' }).then(data => sendResponse(data));
    return true;
  }

  // ---- Chat reply (AI processing) ----
  if (msg.type === 'newIncomingMessages') {
    const convId = msg.conversationId;

    // Chain onto existing queue for this conversation
    const existingPromise = messageProcessingQueues.get(convId) || Promise.resolve();
    const newPromise = existingPromise
      .then(() => handleIncomingMessages(msg.messages, convId, msg.userName))
      .catch(e => {
        addExtLog('error', 'BG', `Message processing error: ${e.message}`);
        return { error: e.message };
      })
      .finally(() => {
        // Clean up queue entry
        messageProcessingQueues.delete(convId);
      });

    messageProcessingQueues.set(convId, newPromise);

    newPromise.then(replies => sendResponse({ replies }));
    return true;
  }

  if (msg.type === 'chatReply') {
    api('/chat/reply', {
      method: 'POST',
      body: JSON.stringify({ conversationId: msg.conversationId, userName: msg.userName, message: msg.message }),
    }).then(data => sendResponse(data));
    return true;
  }

  // ---- Auto-reply toggle ----
  if (msg.type === 'getAutoReply') {
    chrome.storage.local.get('autoReplyEnabled', r => {
      sendResponse({ enabled: r.autoReplyEnabled ?? false });
    });
    return true;
  }

  if (msg.type === 'setAutoReply') {
    const enabled = msg.enabled;
    chrome.storage.local.set({ autoReplyEnabled: enabled }, async () => {
      // Update fbai_v4 bot state — ALSO clear queue on disable
      const stateUpdates = {
        autoReply: enabled,
        mode: enabled ? 'scanning' : 'idle',
        ...(enabled
          ? { processed: [], queue: [] }
          : { queue: [], processed: [] }  // Clear queue on disable too
        ),
      };

      // On disable, store abort generation timestamp for content scripts
      if (!enabled) {
        stateUpdates.abortGenerationTime = Date.now();
      }

      await saveFbaiState(stateUpdates);

      addExtLog('info', 'BG', `Auto-reply ${enabled ? 'ENABLED' : 'DISABLED'}`);

      // FIRST broadcast to all tabs (so content scripts abort immediately)
      broadcastToFBTabs({ type: 'autoReplyChanged', enabled });

      if (enabled) {
        // Determine navigation URL: if test mode has a target, go directly to it
        // to avoid Facebook redirecting to an old conversation
        const fbaiState = await loadFbaiState();
        const testTarget = (fbaiState.testModeEnabled && fbaiState.testTargetId) ? fbaiState.testTargetId : '';
        const navUrl = testTarget
          ? `https://www.facebook.com/messages/t/${testTarget}`
          : 'https://www.facebook.com/messages/';

        addExtLog('info', 'BG', `Navigating to: ${navUrl}`);

        // Open/focus a Facebook tab and navigate
        chrome.tabs.query({ url: ['*://www.facebook.com/*', '*://web.facebook.com/*'] }, (tabs) => {
          if (tabs.length > 0) {
            chrome.tabs.update(tabs[0].id, { url: navUrl, active: true });
            addExtLog('info', 'BG', 'Updated existing FB tab');
          } else {
            chrome.tabs.create({ url: navUrl });
            addExtLog('info', 'BG', 'Opened new FB tab');
          }
        });
      }

      sendResponse({ success: true });
    });
    return true;
  }
});

// ---- Process incoming messages ----
async function handleIncomingMessages(messages, conversationId, userName) {
  if (!messages || messages.length === 0) return [];

  // Check token budget before processing
  const tokenData = await getTokenUsage();
  const budgetState = await loadFbaiState();
  const dailyBudget = budgetState.dailyTokenBudget || 0; // 0 = unlimited

  if (dailyBudget > 0) {
    const today = new Date().toISOString().split('T')[0];
    const todayUsage = tokenData.daily?.[today]?.totalTokens || 0;
    if (todayUsage >= dailyBudget) {
      addExtLog('warn', 'AI', `Daily token budget exceeded (${todayUsage}/${dailyBudget}) — skipping`);
      return [{ messageId: messages[0]?.id, reply: null, error: 'Token budget exceeded' }];
    }
  }

  const replies = [];
  for (const msg of messages) {
    addExtLog('info', 'AI', `Processing msg from [${userName}]: "${msg.text.substring(0, 60)}"`);

    const result = await api('/chat/reply', {
      method: 'POST',
      body: JSON.stringify({ conversationId, userName, message: msg.text, messageId: msg.id }),
    });

    if (result?.error) {
      addExtLog('error', 'AI', `Reply error: ${result.error}`);
      replies.push({ messageId: msg.id, reply: null, error: result.error });
    } else if (result?.reply) {
      replies.push({ messageId: msg.id, reply: result.reply });
      addExtLog('success', 'AI', `Reply (${result.source}): "${result.reply.substring(0, 60)}"`);

      // Track token usage from server response
      if (result.usage) {
        // Use cached settings (refresh every 60s instead of every message)
        const now = Date.now();
        let needsRefresh = !cachedProvider || now - settingsCacheTime > SETTINGS_CACHE_TTL;

        if (needsRefresh) {
          const settings = await api('/settings');
          if (!settings?.error) {
            cachedProvider = settings?.find?.(s => s.key === 'ai_task_chat_provider')?.value || 'unknown';
            cachedModel = settings?.find?.(s => s.key === `ai_${cachedProvider}_model`)?.value || 'unknown';
            settingsCacheTime = now;
          } else {
            addExtLog('warn', 'TOKEN', 'Failed to refresh settings cache, using previous values');
          }
        }

        // Validate cache before using
        if (cachedProvider === 'unknown' || cachedModel === 'unknown') {
          addExtLog('warn', 'TOKEN', 'Cached provider/model are invalid, skipping token tracking');
        } else {
          await trackTokenUsage(result.usage, cachedProvider, cachedModel);
          addExtLog('info', 'TOKEN', `Used ${result.usage.totalTokens} tokens (in:${result.usage.promptTokens} out:${result.usage.completionTokens})`);
        }
      }
    } else {
      addExtLog('warn', 'AI', `No reply or error in result`);
      replies.push({ messageId: msg.id, reply: null, error: 'No reply received' });
    }
  }
  return replies;
}

// ---- Init ----
checkServer();
addExtLog('info', 'BG', 'Background service worker v4 started');

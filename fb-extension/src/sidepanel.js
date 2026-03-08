// ============================================================
// FB AI Agent — Side Panel v3
// CSP-safe (no inline onclick), Load Models, full CRUD
// ============================================================

// ---- BG message helper ----
function bg(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, r => resolve(r)));
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtTime(s) {
  if (!s) return '';
  try {
    const d = new Date(s);
    return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return s; }
}

function showResult(elId, ok, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = `<span class="result ${ok ? 'ok' : 'err'}">${esc(msg)}</span>`;
  setTimeout(() => { if (el) el.innerHTML = ''; }, 4000);
}

// ============================================================
// TAB NAVIGATION
// ============================================================
let currentTab = 'dash';

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.pg').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    const pg = document.getElementById('pg-' + t.dataset.page);
    if (pg) pg.classList.add('active');
    currentTab = t.dataset.page;
    onTabChange(t.dataset.page);
  });
});

function onTabChange(tab) {
  if (tab === 'dash') refreshDash();
  if (tab === 'chat') loadConversations();
  if (tab === 'fbapi') loadFbApiStatus();
  if (tab === 'personas') { loadPersonas(); loadBotPersona(); }
  if (tab === 'qa') loadQA();
  if (tab === 'settings') loadSettings();
}

// ============================================================
// SERVER STATUS
// ============================================================
let serverOk = false;
let autoReplyOn = false;

const srvDot = document.getElementById('srvDot');
const srvLabel = document.getElementById('srvLabel');
const dServer = document.getElementById('dServer');
const dAutoReply = document.getElementById('dAutoReply');

async function checkStatus() {
  const r = await bg({ type: 'getServerStatus' });
  serverOk = r?.connected || false;
  srvDot.className = 'srv-dot' + (serverOk ? ' on' : '');
  srvLabel.textContent = serverOk ? 'Online' : 'Offline';
  dServer.textContent = serverOk ? 'Connected ✓' : 'Disconnected ✗';
  dServer.className = 'sv ' + (serverOk ? 'on' : 'off');

  // Bot state from fbai_v4
  const botState = await bg({ type: 'getFbaiState' });
  if (botState) {
    const modeColors = { scanning: 'warn', processing: 'warn', standby: 'off', idle: 'off' };
    const modeLabels = {
      scanning: '🔍 Scanning unread...',
      processing: '💬 Replying...',
      standby: '⏸ Standby (watching)',
      idle: '— Idle',
    };
    const mode = botState.mode || 'idle';
    const modeEl = document.getElementById('dBotMode');
    if (modeEl) {
      modeEl.textContent = modeLabels[mode] || mode;
      modeEl.className = 'sv ' + (modeColors[mode] || 'off');
    }
    const queueEl = document.getElementById('dQueue');
    if (queueEl) {
      const q = botState.queue || [];
      queueEl.textContent = q.length > 0
        ? `${q.length} pending: ${q.map(c => c.name || c.id).slice(0, 3).join(', ')}${q.length > 3 ? '...' : ''}`
        : 'Empty';
      queueEl.className = 'sv ' + (q.length > 0 ? 'warn' : 'off');
    }
    // Load maxAgeDays into settings field if on settings tab
    const maxDaysEl = document.getElementById('settingMaxDays');
    if (maxDaysEl && botState.maxAgeDays) {
      maxDaysEl.value = botState.maxAgeDays;
    }

    // Load Test Mode state
    testModeOn = botState.testModeEnabled || false;
    updateTestModeUI();
    const testModeIdEl = document.getElementById('testModeId');
    if (testModeIdEl && botState.testTargetId) {
      testModeIdEl.value = botState.testTargetId;
    }
  }

  if (serverOk) {
    const personas = await bg({ type: 'getPersonas' });
    if (Array.isArray(personas)) {
      const def = personas.find(p => p.is_default) || personas[0];
      document.getElementById('dPersona').textContent = def ? def.name : 'None';
    }
  }

  // Token usage display
  await updateTokenDisplay();
}

async function updateTokenDisplay() {
  const tokens = await bg({ type: 'getTokenUsage' });
  if (!tokens) return;

  const today = new Date().toISOString().split('T')[0];
  const todayData = tokens.daily?.[today] || { totalTokens: 0, requests: 0 };

  const dTodayTokens = document.getElementById('dTodayTokens');
  const dTodayReqs = document.getElementById('dTodayReqs');
  const dTotalTokens = document.getElementById('dTotalTokens');
  const dBudgetStatus = document.getElementById('dBudgetStatus');

  if (dTodayTokens) {
    dTodayTokens.textContent = todayData.totalTokens.toLocaleString() + ' tokens';
    dTodayTokens.className = 'sv';
  }
  if (dTodayReqs) {
    dTodayReqs.textContent = todayData.requests + ' reqs';
    dTodayReqs.className = 'sv';
  }
  if (dTotalTokens) {
    dTotalTokens.textContent = (tokens.totalTokens || 0).toLocaleString() + ' tokens / ' + (tokens.totalRequests || 0) + ' reqs';
    dTotalTokens.className = 'sv';
  }
  // Average tokens per request
  const dAvgTokens = document.getElementById('dAvgTokens');
  if (dAvgTokens) {
    const avg = tokens.totalRequests > 0 ? Math.round(tokens.totalTokens / tokens.totalRequests) : 0;
    dAvgTokens.textContent = avg > 0 ? avg.toLocaleString() + ' tokens' : '--';
    dAvgTokens.className = 'sv ' + (avg > 2000 ? 'warn' : avg > 0 ? 'on' : '');
  }

  // Budget check
  const botState = await bg({ type: 'getFbaiState' });
  const budget = botState?.dailyTokenBudget || 0;
  if (dBudgetStatus) {
    if (budget <= 0) {
      dBudgetStatus.textContent = 'Unlimited';
      dBudgetStatus.className = 'sv';
    } else {
      const pct = Math.round((todayData.totalTokens / budget) * 100);
      dBudgetStatus.textContent = `${todayData.totalTokens.toLocaleString()} / ${budget.toLocaleString()} (${pct}%)`;
      dBudgetStatus.className = 'sv ' + (pct >= 100 ? 'off' : pct >= 80 ? 'warn' : 'on');
    }
  }

  // Load budget into settings field
  const budgetInput = document.getElementById('settingDailyBudget');
  if (budgetInput && budget > 0) budgetInput.value = budget;
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'serverStatus') {
    serverOk = msg.connected;
    srvDot.className = 'srv-dot' + (serverOk ? ' on' : '');
    srvLabel.textContent = serverOk ? 'Online' : 'Offline';
    dServer.textContent = serverOk ? 'Connected ✓' : 'Disconnected ✗';
    dServer.className = 'sv ' + (serverOk ? 'on' : 'off');
  }
});

// ============================================================
// AUTO-REPLY TOGGLE
// ============================================================
const bigToggle = document.getElementById('bigToggle');
const mainToggle = document.getElementById('mainToggle');
const autoReplySub = document.getElementById('autoReplySub');

async function syncAutoReply() {
  const r = await bg({ type: 'getAutoReply' });
  autoReplyOn = r?.enabled || false;
  updateToggleUI();
}

function updateToggleUI() {
  mainToggle.className = 'toggle' + (autoReplyOn ? ' active' : '');
  bigToggle.className = 'big-toggle' + (autoReplyOn ? ' active' : '');
  dAutoReply.textContent = autoReplyOn ? 'ON ✓' : 'OFF';
  dAutoReply.className = 'sv ' + (autoReplyOn ? 'on' : 'off');
  autoReplySub.textContent = autoReplyOn
    ? 'AI กำลังตอบแชทอัตโนมัติ — คลิกเพื่อหยุด'
    : 'คลิกเพื่อเปิด AI Auto-Reply';
}

bigToggle.addEventListener('click', async () => {
  autoReplyOn = !autoReplyOn;
  updateToggleUI();
  await bg({ type: 'setAutoReply', enabled: autoReplyOn });
  refreshDash();
});

// ============================================================
// TARGETED TEST MODE
// ============================================================
let testModeOn = false;
const testModeToggle = document.getElementById('testModeToggle');

function updateTestModeUI() {
  if (testModeToggle) {
    testModeToggle.className = 'toggle' + (testModeOn ? ' active' : '');
  }
}

testModeToggle?.addEventListener('click', async () => {
  testModeOn = !testModeOn;
  updateTestModeUI();
  await bg({ type: 'saveFbaiState', updates: { testModeEnabled: testModeOn } });
  showResult('testModeResult', true, testModeOn ? 'Test Mode Enabled' : 'Test Mode Disabled');
});

document.getElementById('btnSaveTestMode')?.addEventListener('click', async () => {
  const targetId = document.getElementById('testModeId').value.trim();
  if (!targetId && testModeOn) {
    showResult('testModeResult', false, 'Please enter a Target ID');
    return;
  }
  await bg({ type: 'saveFbaiState', updates: { testTargetId: targetId } });
  showResult('testModeResult', true, 'Test Target Saved ✓');
});

// ============================================================
// DASHBOARD
// ============================================================
async function refreshDash() {
  await checkStatus();
  await syncAutoReply();
  loadDashLogs();
  loadMemoryStats();
}

document.getElementById('btnRefreshDash').addEventListener('click', refreshDash);
document.getElementById('btnOpenMessenger').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.facebook.com/messages/' });
});

document.getElementById('btnEmergencyStop').addEventListener('click', async () => {
  autoReplyOn = false;
  updateToggleUI();
  await bg({ type: 'setAutoReply', enabled: false });
  refreshDash();
});

async function loadDashLogs() {
  const logs = await bg({ type: 'getAllLogs', limit: 15 });
  const el = document.getElementById('dashLogs');
  if (!Array.isArray(logs) || logs.length === 0) {
    el.innerHTML = '<div class="empty" style="padding:10px"><div>No logs yet</div></div>';
    return;
  }
  el.innerHTML = logs.slice().reverse().map(renderLogItem).join('');
}

function renderLogItem(l) {
  const level = l.level === 'error' ? 'error'
    : (l.level === 'warn' || l.level === 'warning') ? 'warn'
      : l.level === 'success' ? 'success' : 'info';
  const src = l.type || '';
  return `<div class="log-item ${level}">
    <span class="log-time">${fmtTime(l.created_at)}</span>
    <span class="log-src">[${esc(src)}]</span>
    <span class="log-msg">${esc(l.action || l.msg || '')}</span>
    ${l.details ? `<div style="color:#475569;font-size:10px;margin-top:2px">${esc(l.details)}</div>` : ''}
  </div>`;
}

// ============================================================
// CHAT TAB
// ============================================================
async function loadConversations() {
  const convs = await bg({ type: 'getConversations' });
  const el = document.getElementById('convList');
  if (!Array.isArray(convs) || convs.length === 0) {
    el.innerHTML = '<div class="empty"><div class="icon">💬</div>No conversations yet<br><small style="color:#475569">เปิด Auto-Reply แล้วรับแชทใน Messenger</small></div>';
    return;
  }
  el.innerHTML = convs.map(c => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px;border-radius:6px;background:#1e293b;margin-bottom:6px">
      <div style="width:32px;height:32px;border-radius:50%;background:#3b82f6;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0;color:#fff">
        ${esc((c.fb_user_name || c.id || '?')[0]).toUpperCase()}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:12px">${esc(c.fb_user_name || c.id)}</div>
        <div style="font-size:10px;color:#64748b">${fmtTime(c.last_message_at)} · ${c.message_count || 0} messages</div>
      </div>
      <div style="font-size:10px;color:#475569">${esc(c.id)}</div>
    </div>
  `).join('');
}

document.getElementById('btnRefreshConvs').addEventListener('click', loadConversations);

document.getElementById('btnTestReply').addEventListener('click', async () => {
  const msg = document.getElementById('testMsg').value.trim();
  const convId = document.getElementById('testConvId').value.trim() || 'test-' + Date.now();
  const el = document.getElementById('testResult');
  if (!msg) { el.textContent = 'Please enter a message'; el.style.color = '#ef4444'; return; }
  el.textContent = 'Generating...'; el.style.color = '#60a5fa';
  const r = await bg({ type: 'chatReply', conversationId: convId, userName: 'Test', message: msg });
  if (r?.reply) { el.textContent = `AI (${r.source}): ${r.reply}`; el.style.color = '#22c55e'; }
  else { el.textContent = `Error: ${r?.error || 'No response from server'}`; el.style.color = '#ef4444'; }
});

// ============================================================
// PERSONAS TAB
// ============================================================
let editingPersonaId = null;
let personasCache = [];

async function loadPersonas() {
  const list = await bg({ type: 'getPersonas' });
  const el = document.getElementById('personaList');
  if (!Array.isArray(list) || list.length === 0) {
    el.innerHTML = '<div class="empty"><div class="icon">🧑‍🎤</div>No personas</div>';
    personasCache = [];
    return;
  }
  personasCache = list;
  el.innerHTML = list.map(p => {
    const traits = (() => { try { return JSON.parse(p.personality_traits || '[]').join(', '); } catch { return p.personality_traits || ''; } })();
    return `
    <div class="persona-card ${p.is_default ? 'default' : ''}" data-id="${esc(p.id)}">
      <div class="persona-head">
        <span class="persona-name">${esc(p.name)}</span>
        ${p.is_default ? '<span class="default-badge">DEFAULT</span>' : ''}
      </div>
      <div class="persona-desc">${esc(p.description || '')}${traits ? ` · ${esc(traits)}` : ''}</div>
      <div class="persona-actions">
        ${!p.is_default ? `<button class="btn btn-g btn-xs" data-action="setdefault" data-id="${esc(p.id)}">Set Default</button>` : ''}
        <button class="btn btn-p btn-xs" data-action="edit" data-id="${esc(p.id)}">Edit</button>
        ${!p.is_default ? `<button class="btn btn-r btn-xs" data-action="delete" data-id="${esc(p.id)}">Delete</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

// Event delegation for persona list (CSP-safe, no inline onclick)
document.getElementById('personaList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;

  if (action === 'setdefault') {
    await bg({ type: 'setDefaultPersona', id });
    loadPersonas();
  }
  if (action === 'delete') {
    if (!confirm('Delete this persona?')) return;
    await bg({ type: 'deletePersona', id });
    loadPersonas();
  }
  if (action === 'edit') {
    const p = personasCache.find(x => x.id === id);
    if (p) openPersonaForm(p);
  }
});

function openPersonaForm(p) {
  editingPersonaId = p ? p.id : null;
  document.getElementById('personaFormTitle').textContent = p ? 'Edit Persona' : 'New Persona';
  document.getElementById('pfId').value = p?.id || '';
  document.getElementById('pfName').value = p?.name || '';
  document.getElementById('pfDesc').value = p?.description || '';
  document.getElementById('pfPrompt').value = p?.system_prompt || '';
  document.getElementById('pfStyle').value = p?.speaking_style || 'casual-thai';
  document.getElementById('pfLang').value = p?.language || 'th';
  const traits = (() => { try { return JSON.parse(p?.personality_traits || '[]').join(', '); } catch { return p?.personality_traits || ''; } })();
  document.getElementById('pfTraits').value = traits;
  document.getElementById('pfTemp').value = p?.temperature || 0.7;
  document.getElementById('pfTokens').value = p?.max_tokens || 500;
  document.getElementById('personaForm').style.display = 'block';
  document.getElementById('personaForm').scrollIntoView({ behavior: 'smooth' });
}

document.getElementById('btnAddPersona').addEventListener('click', () => openPersonaForm(null));

document.getElementById('btnCancelPersona').addEventListener('click', () => {
  document.getElementById('personaForm').style.display = 'none';
  editingPersonaId = null;
});

document.getElementById('btnSavePersona').addEventListener('click', async () => {
  const data = {
    name: document.getElementById('pfName').value.trim(),
    description: document.getElementById('pfDesc').value.trim(),
    system_prompt: document.getElementById('pfPrompt').value.trim(),
    speaking_style: document.getElementById('pfStyle').value,
    language: document.getElementById('pfLang').value,
    personality_traits: JSON.stringify(
      document.getElementById('pfTraits').value.split(',').map(s => s.trim()).filter(Boolean)
    ),
    temperature: parseFloat(document.getElementById('pfTemp').value) || 0.7,
    max_tokens: parseInt(document.getElementById('pfTokens').value) || 500,
  };
  if (!data.name || !data.system_prompt) { showResult('personaSaveResult', false, 'Name and System Prompt are required'); return; }
  const r = editingPersonaId
    ? await bg({ type: 'updatePersona', id: editingPersonaId, data })
    : await bg({ type: 'createPersona', data });
  if (r?.success) {
    showResult('personaSaveResult', true, 'Saved!');
    document.getElementById('personaForm').style.display = 'none';
    editingPersonaId = null;
    loadPersonas();
  } else {
    showResult('personaSaveResult', false, r?.error || 'Save failed');
  }
});

// ============================================================
// BOT AI PERSONA (file-based: AGENTS/IDENTITY/SOUL/TOOLS)
// ============================================================
let botPersonaData = { agents: '', identity: '', soul: '', tools: '' };
let activeBotFile = 'agents';

async function loadBotPersona() {
  document.getElementById('botPersonaText').placeholder = 'Loading...';
  document.getElementById('botPersonaText').value = '';
  const data = await bg({ type: 'getBotPersona' });
  if (!data) {
    showResult('botPersonaResult', false, 'โหลดไม่ได้');
    return;
  }
  botPersonaData = {
    agents: data.agents || '',
    identity: data.identity || '',
    soul: data.soul || '',
    tools: data.tools || '',
  };
  document.getElementById('botPersonaText').value = botPersonaData[activeBotFile];
  document.getElementById('botPersonaText').placeholder = '';
  document.getElementById('botPersonaResult').textContent = '';
}

// Tab switching
document.getElementById('botPersonaTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.stab');
  if (!tab) return;
  // Save current content before switching
  botPersonaData[activeBotFile] = document.getElementById('botPersonaText').value;
  // Switch tab
  activeBotFile = tab.dataset.file;
  document.querySelectorAll('#botPersonaTabs .stab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  document.getElementById('botPersonaText').value = botPersonaData[activeBotFile];
});

// Save button
document.getElementById('btnSaveBotPersona').addEventListener('click', async () => {
  // Save current textarea into cache first
  botPersonaData[activeBotFile] = document.getElementById('botPersonaText').value;
  showResult('botPersonaResult', true, '...');
  const r = await bg({ type: 'saveBotPersona', data: botPersonaData });
  if (r?.success) {
    showResult('botPersonaResult', true, '✅ Saved');
  } else {
    showResult('botPersonaResult', false, r?.error || 'Save failed');
  }
});

// Reload button
document.getElementById('btnReloadBotPersona').addEventListener('click', loadBotPersona);

// ============================================================
// Q&A TAB
// ============================================================
async function loadQA() {
  const list = await bg({ type: 'getQA' });
  const el = document.getElementById('qaList');
  if (!Array.isArray(list) || list.length === 0) {
    el.innerHTML = '<div class="empty"><div class="icon">🗂️</div>No Q&A pairs yet</div>';
    return;
  }
  el.innerHTML = list.map(q => `
    <div class="qa-row" style="${q.is_active ? '' : 'opacity:0.5'}" data-id="${q.id}">
      <div>
        <div class="qa-pattern">${esc(q.question_pattern)}</div>
        <div style="font-size:10px;color:#475569">${esc(q.category || '')} · P${q.priority || 0}</div>
      </div>
      <div class="qa-answer">${esc(q.answer)}</div>
      <div style="display:flex;flex-direction:column;gap:3px;align-items:center">
        <span class="qa-type">${esc(q.match_type)}</span>
        <button class="btn btn-r btn-xs" data-action="delete" data-id="${q.id}">✕</button>
        <button class="btn btn-s btn-xs" data-action="toggle" data-id="${q.id}" data-active="${q.is_active}">${q.is_active ? 'Off' : 'On'}</button>
      </div>
    </div>
  `).join('');
}

// Event delegation for Q&A list (CSP-safe)
document.getElementById('qaList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;

  if (action === 'delete') {
    if (!confirm('Delete this Q&A?')) return;
    await bg({ type: 'deleteQA', id: parseInt(id) });
    loadQA();
  }
  if (action === 'toggle') {
    const current = btn.dataset.active === '1' || btn.dataset.active === 'true';
    await bg({ type: 'updateQA', id: parseInt(id), data: { is_active: !current } });
    loadQA();
  }
});

document.getElementById('btnRefreshQA').addEventListener('click', loadQA);
document.getElementById('btnAddQA').addEventListener('click', () => {
  document.getElementById('qaForm').style.display = 'block';
  document.getElementById('qaForm').scrollIntoView({ behavior: 'smooth' });
});
document.getElementById('btnCancelQA').addEventListener('click', () => {
  document.getElementById('qaForm').style.display = 'none';
});

document.getElementById('btnSaveQA').addEventListener('click', async () => {
  const data = {
    question_pattern: document.getElementById('qaPattern').value.trim(),
    answer: document.getElementById('qaAnswer').value.trim(),
    match_type: document.getElementById('qaType').value,
    priority: parseInt(document.getElementById('qaPriority').value) || 0,
    category: document.getElementById('qaCategory').value.trim() || null,
  };
  if (!data.question_pattern || !data.answer) { alert('Pattern and Answer are required'); return; }
  const r = await bg({ type: 'createQA', data });
  if (r?.success) {
    document.getElementById('qaForm').style.display = 'none';
    ['qaPattern', 'qaAnswer', 'qaCategory'].forEach(id => document.getElementById(id).value = '');
    loadQA();
  }
});

document.getElementById('btnTestQA').addEventListener('click', async () => {
  const q = document.getElementById('qaTestInput').value.trim();
  const el = document.getElementById('qaTestResult');
  if (!q) return;
  const r = await bg({ type: 'testQA', question: q });
  if (r?.match) {
    el.innerHTML = `<span class="result ok">Match (${esc(r.match_type)}): ${esc(r.answer)}</span>`;
  } else {
    el.innerHTML = `<span class="result err">No match → AI will respond</span>`;
  }
});

// ============================================================
// SETTINGS TAB — API Keys, Models, Load Models, Routing
// ============================================================
const PROVIDERS = [
  { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-4o-mini' },
  { id: 'gemini', label: 'Gemini', defaultModel: 'gemini-1.5-flash' },
  { id: 'minimax', label: 'MiniMax', defaultModel: 'abab6.5s-chat' },
  { id: 'openrouter', label: 'OpenRouter', defaultModel: 'openai/gpt-4o-mini' },
];
let settingsMap = {};

async function loadSettings() {
  const list = await bg({ type: 'getSettings' });
  if (!Array.isArray(list)) return;
  settingsMap = {};
  for (const s of list) settingsMap[s.key] = s.value;

  // Routing
  const rc = document.getElementById('routeChat');
  const rco = document.getElementById('routeContent');
  if (settingsMap['ai_task_chat_provider']) rc.value = settingsMap['ai_task_chat_provider'];
  if (settingsMap['ai_task_content_provider']) rco.value = settingsMap['ai_task_content_provider'];

  // Per-provider
  for (const p of PROVIDERS) {
    const modelEl = document.getElementById(`model-${p.id}`);
    const badge = document.getElementById(`badge-${p.id}`);
    const key = settingsMap[`ai_${p.id}_key`];
    const model = settingsMap[`ai_${p.id}_model`];
    if (model && modelEl) modelEl.value = model;
    if (badge) {
      badge.textContent = key ? 'Key set ✓' : 'Not set';
      badge.style.color = key ? '#22c55e' : '#ef4444';
    }
  }
}

// ---- Save + Test buttons for each provider ----
for (const p of PROVIDERS) {
  document.getElementById(`save-${p.id}`)?.addEventListener('click', async () => {
    const key = document.getElementById(`key-${p.id}`).value.trim();
    const model = document.getElementById(`model-${p.id}`).value.trim();
    const saves = [];
    if (key) saves.push(bg({ type: 'setSetting', key: `ai_${p.id}_key`, value: key }));
    if (model) saves.push(bg({ type: 'setSetting', key: `ai_${p.id}_model`, value: model }));
    if (saves.length === 0) { document.getElementById(`res-${p.id}`).textContent = 'Nothing to save'; return; }
    await Promise.all(saves);
    document.getElementById(`res-${p.id}`).innerHTML = '<span style="color:#22c55e">Saved ✓</span>';
    if (key) {
      document.getElementById(`badge-${p.id}`).textContent = 'Key set ✓';
      document.getElementById(`badge-${p.id}`).style.color = '#22c55e';
    }
    setTimeout(() => {
      const el = document.getElementById(`res-${p.id}`);
      if (el) el.textContent = '';
    }, 3000);
  });

  document.getElementById(`test-${p.id}`)?.addEventListener('click', async () => {
    const keyInput = document.getElementById(`key-${p.id}`).value.trim();
    const resEl = document.getElementById(`res-${p.id}`);
    resEl.textContent = 'Testing...'; resEl.style.color = '#60a5fa';
    const r = await bg({ type: 'testAI', provider: p.id, apiKey: keyInput || undefined });
    if (r?.success) { resEl.innerHTML = '<span style="color:#22c55e">OK ✓</span>'; }
    else { resEl.innerHTML = '<span style="color:#ef4444">Failed ✗</span>'; }
    setTimeout(() => { const el = document.getElementById(`res-${p.id}`); if (el) el.textContent = ''; }, 4000);
  });

  // ---- Load Models button ----
  document.getElementById(`loadmodels-${p.id}`)?.addEventListener('click', async () => {
    const btn = document.getElementById(`loadmodels-${p.id}`);
    const keyVal = document.getElementById(`key-${p.id}`).value.trim();
    const modelIn = document.getElementById(`model-${p.id}`);
    const selEl = document.getElementById(`modelsel-${p.id}`);

    btn.textContent = '⏳';
    btn.disabled = true;

    const r = await bg({ type: 'getAIModels', provider: p.id, apiKey: keyVal || undefined });

    btn.textContent = '⬇ Load';
    btn.disabled = false;

    const models = r?.models;
    if (!models || models.length === 0) {
      selEl.style.display = 'none';
      const resEl = document.getElementById(`res-${p.id}`);
      resEl.innerHTML = '<span style="color:#f59e0b">No models returned</span>';
      setTimeout(() => { if (resEl) resEl.textContent = ''; }, 3000);
      return;
    }

    // Populate select
    const currentModel = modelIn.value.trim() || settingsMap[`ai_${p.id}_model`] || '';
    selEl.innerHTML = `<option value="">— Select model —</option>` +
      models.map(m => {
        const val = typeof m === 'string' ? m : (m.id || m.name || m);
        const lbl = typeof m === 'string' ? m : (m.id || m.name || m);
        return `<option value="${esc(val)}" ${val === currentModel ? 'selected' : ''}>${esc(lbl)}</option>`;
      }).join('');

    selEl.style.display = 'block';
    selEl.focus();

    // Selecting from dropdown updates the text input
    selEl.onchange = () => {
      if (selEl.value) {
        modelIn.value = selEl.value;
      }
    };
  });
}

// ---- Bot Behavior settings ----
document.getElementById('btnSaveBotBehavior').addEventListener('click', async () => {
  const maxAgeDays = parseInt(document.getElementById('settingMaxDays').value) || 7;
  await bg({ type: 'saveFbaiState', updates: { maxAgeDays } });
  const el = document.getElementById('botBehaviorResult');
  el.innerHTML = '<span style="color:#22c55e">Saved ✓</span>';
  setTimeout(() => { el.innerHTML = ''; }, 3000);
});

document.getElementById('btnResetSession').addEventListener('click', async () => {
  if (!confirm('Reset bot session? จะล้าง queue และรายการที่ตอบไปแล้วทั้งหมด')) return;
  await bg({ type: 'saveFbaiState', updates: { queue: [], processed: [], mode: 'scanning', lastReplyTimes: {}, lastReplyTexts: {} } });
  const el = document.getElementById('botBehaviorResult');
  el.innerHTML = '<span style="color:#22c55e">Session reset ✓</span>';
  refreshDash();
  setTimeout(() => { el.innerHTML = ''; }, 3000);
});

// ---- Token budget ----
document.getElementById('btnSaveTokenBudget').addEventListener('click', async () => {
  const budget = parseInt(document.getElementById('settingDailyBudget').value) || 0;
  await bg({ type: 'saveFbaiState', updates: { dailyTokenBudget: budget } });
  const el = document.getElementById('tokenBudgetResult');
  el.innerHTML = '<span style="color:#22c55e">Saved ✓</span>';
  setTimeout(() => { el.innerHTML = ''; }, 3000);
  updateTokenDisplay();
});

document.getElementById('btnResetTokens').addEventListener('click', async () => {
  if (!confirm('Reset all token counters?')) return;
  await bg({ type: 'resetTokenUsage' });
  const el = document.getElementById('tokenBudgetResult');
  el.innerHTML = '<span style="color:#22c55e">Counters reset ✓</span>';
  setTimeout(() => { el.innerHTML = ''; }, 3000);
  updateTokenDisplay();
});

// ---- Save routing ----
document.getElementById('btnSaveRouting').addEventListener('click', async () => {
  const settings = {
    ai_task_chat_provider: document.getElementById('routeChat').value,
    ai_task_content_provider: document.getElementById('routeContent').value,
  };
  await bg({ type: 'setMultipleSettings', settings });
  showResult('routingResult', true, 'Routing saved!');
});

// ============================================================
// FB API TAB
// ============================================================
const FB_API_BASE = 'http://localhost:3000/api/fb-graph';

async function fbApi(path, options = {}) {
  try {
    const res = await fetch(`${FB_API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function loadFbApiStatus() {
  const status = await fbApi('/status');
  const statusEl = document.getElementById('fbApiStatus');
  const pageNameEl = document.getElementById('fbPageName');
  const pageIdEl = document.getElementById('fbPageId');

  if (status && !status.error) {
    statusEl.textContent = status.configured ? 'Connected' : 'Not configured';
    statusEl.className = 'sv ' + (status.configured ? 'on' : 'off');
    pageIdEl.textContent = status.pageId || 'Not set';

    if (status.configured) {
      const page = await fbApi('/page');
      pageNameEl.textContent = page?.name || status.pageId || '--';
    } else {
      pageNameEl.textContent = '--';
    }

    // Load config into form
    const settings = await bg({ type: 'getSettings' });
    if (Array.isArray(settings)) {
      const map = {};
      for (const s of settings) map[s.key] = s.value;
      if (map.fb_app_id) document.getElementById('fbAppId').value = map.fb_app_id;
      if (map.fb_page_id) document.getElementById('fbPageIdInput').value = map.fb_page_id;
      if (map.fb_verify_token) document.getElementById('fbVerifyToken').value = map.fb_verify_token;
      // Don't populate secrets for security
    }
  } else {
    statusEl.textContent = 'Server offline';
    statusEl.className = 'sv off';
  }
}

document.getElementById('btnFbRefresh')?.addEventListener('click', loadFbApiStatus);

document.getElementById('btnFbSaveConfig')?.addEventListener('click', async () => {
  const config = {
    appId: document.getElementById('fbAppId').value.trim(),
    appSecret: document.getElementById('fbAppSecret').value.trim() || undefined,
    pageAccessToken: document.getElementById('fbPageToken').value.trim() || undefined,
    pageId: document.getElementById('fbPageIdInput').value.trim(),
    verifyToken: document.getElementById('fbVerifyToken').value.trim(),
  };
  // Remove undefined values
  Object.keys(config).forEach(k => config[k] === undefined && delete config[k]);

  const r = await fbApi('/config', { method: 'POST', body: JSON.stringify(config) });
  if (r?.success) {
    showResult('fbConfigResult', true, 'Config saved!');
    loadFbApiStatus();
  } else {
    showResult('fbConfigResult', false, r?.error || 'Save failed');
  }
});

document.getElementById('btnFbTestToken')?.addEventListener('click', async () => {
  const token = document.getElementById('fbPageToken').value.trim();
  const r = await fbApi('/token/debug', {
    method: 'POST',
    body: JSON.stringify({ token: token || undefined }),
  });
  if (r?.error) {
    showResult('fbConfigResult', false, r.error);
  } else if (r?.is_valid !== undefined) {
    const exp = r.expires_at ? new Date(r.expires_at * 1000).toLocaleString('th-TH') : 'Never';
    showResult('fbConfigResult', r.is_valid, r.is_valid ? `Valid (expires: ${exp})` : 'Invalid token');
  } else {
    showResult('fbConfigResult', true, JSON.stringify(r).substring(0, 100));
  }
});

document.getElementById('btnFbExtendToken')?.addEventListener('click', async () => {
  const token = document.getElementById('fbPageToken').value.trim();
  if (!token) { showResult('fbConfigResult', false, 'Enter a token first'); return; }
  const r = await fbApi('/token/extend', {
    method: 'POST',
    body: JSON.stringify({ shortLivedToken: token }),
  });
  if (r?.accessToken) {
    document.getElementById('fbPageToken').value = r.accessToken;
    showResult('fbConfigResult', true, 'Extended! New token set above');
  } else {
    showResult('fbConfigResult', false, r?.error || 'Extension failed');
  }
});

document.getElementById('btnFbSubscribe')?.addEventListener('click', async () => {
  const r = await fbApi('/webhook/subscribe', { method: 'POST' });
  showResult('fbStatusResult', r?.success, r?.success ? 'Subscribed!' : 'Failed');
});

document.getElementById('btnFbSend')?.addEventListener('click', async () => {
  const to = document.getElementById('fbSendTo').value.trim();
  const msg = document.getElementById('fbSendMsg').value.trim();
  if (!to || !msg) { showResult('fbActionResult', false, 'Fill recipient & message'); return; }
  const r = await fbApi('/send', {
    method: 'POST',
    body: JSON.stringify({ recipientId: to, text: msg }),
  });
  if (r?.message_id) {
    showResult('fbActionResult', true, 'Sent! ID: ' + r.message_id);
    document.getElementById('fbSendMsg').value = '';
  } else {
    showResult('fbActionResult', false, r?.error || 'Send failed');
  }
});

document.getElementById('btnFbPost')?.addEventListener('click', async () => {
  const message = document.getElementById('fbPostContent').value.trim();
  const link = document.getElementById('fbPostLink').value.trim();
  if (!message) { showResult('fbActionResult', false, 'Enter post content'); return; }
  const r = await fbApi('/posts', {
    method: 'POST',
    body: JSON.stringify({ message, link: link || undefined }),
  });
  if (r?.id) {
    showResult('fbActionResult', true, 'Posted! ID: ' + r.id);
    document.getElementById('fbPostContent').value = '';
    document.getElementById('fbPostLink').value = '';
  } else {
    showResult('fbActionResult', false, r?.error || 'Post failed');
  }
});

document.getElementById('btnFbLoadPosts')?.addEventListener('click', async () => {
  const el = document.getElementById('fbPostsList');
  el.innerHTML = '<div style="color:#64748b;font-size:11px">Loading...</div>';
  const posts = await fbApi('/posts?limit=5');
  if (!Array.isArray(posts) || posts.length === 0) {
    el.innerHTML = '<div class="empty" style="padding:10px">No posts found</div>';
    return;
  }
  el.innerHTML = posts.map(p => `
    <div style="padding:8px;background:#0f172a;border:1px solid #334155;border-radius:6px;margin-bottom:6px;font-size:11px">
      <div style="color:#e2e8f0;margin-bottom:4px">${esc((p.message || '').substring(0, 120))}</div>
      <div style="color:#475569;font-size:10px">
        ${fmtTime(p.created_time)} ·
        ${p.likes?.summary?.total_count || 0} likes ·
        ${p.comments?.summary?.total_count || 0} comments ·
        ${p.shares?.count || 0} shares
      </div>
    </div>
  `).join('');
});

document.getElementById('btnFbLoadConvs')?.addEventListener('click', async () => {
  const el = document.getElementById('fbConvsList');
  el.innerHTML = '<div style="color:#64748b;font-size:11px">Loading...</div>';
  const convs = await fbApi('/conversations?limit=10');
  if (!Array.isArray(convs) || convs.length === 0) {
    el.innerHTML = '<div class="empty" style="padding:10px">No conversations found</div>';
    return;
  }
  el.innerHTML = convs.map(c => {
    const participants = (c.participants?.data || []).map(p => p.name || p.id).join(', ');
    return `
    <div style="padding:8px;background:#0f172a;border:1px solid #334155;border-radius:6px;margin-bottom:6px;font-size:11px">
      <div style="color:#e2e8f0;font-weight:600">${esc(participants)}</div>
      <div style="color:#94a3b8;margin-top:2px">${esc(c.snippet || '')}</div>
      <div style="color:#475569;font-size:10px;margin-top:2px">
        ${fmtTime(c.updated_time)} · ${c.message_count || 0} messages
        ${c.unread_count ? ` · <span style="color:#f59e0b">${c.unread_count} unread</span>` : ''}
      </div>
    </div>`;
  }).join('');
});

// ============================================================
// MEMORY STATS
// ============================================================
async function loadMemoryStats() {
  if (!serverOk) return;
  try {
    const convs = await bg({ type: 'getConversations' });
    const dMemConvs = document.getElementById('dMemConvs');
    const dMemProfiles = document.getElementById('dMemProfiles');
    const dMemMsgs = document.getElementById('dMemMsgs');

    if (dMemConvs) {
      dMemConvs.textContent = Array.isArray(convs) ? convs.length + ' chats' : '0';
      dMemConvs.className = 'sv';
    }

    // Count profiles and messages from conversation data
    let totalMsgs = 0;
    let profileCount = 0;
    if (Array.isArray(convs)) {
      for (const c of convs) {
        totalMsgs += c.message_count || 0;
        if (c.summary) profileCount++;
      }
    }
    if (dMemProfiles) {
      dMemProfiles.textContent = profileCount + ' with summary';
      dMemProfiles.className = 'sv ' + (profileCount > 0 ? 'on' : '');
    }
    if (dMemMsgs) {
      dMemMsgs.textContent = totalMsgs.toLocaleString();
      dMemMsgs.className = 'sv';
    }
  } catch { }
}

document.getElementById('btnRefreshMemory')?.addEventListener('click', loadMemoryStats);

document.getElementById('btnWipeAllMemory')?.addEventListener('click', async () => {
  if (!confirm('Are you sure you want to delete all AI memory? This will reset all conversation history and customer profiles. This cannot be undone.')) return;

  const el = document.getElementById('memoryClearResult');
  if (el) { el.textContent = 'Clearing...'; el.style.color = '#f59e0b'; }

  await bg({ type: 'clearAllMemory' });

  if (el) { el.textContent = 'Memory Cleared ✓'; el.style.color = '#22c55e'; }
  setTimeout(() => { if (el) el.textContent = ''; }, 3000);

  loadMemoryStats();
});

// ============================================================
// AUTO-REFRESH every 15s on active tab
// ============================================================
setInterval(() => {
  if (currentTab === 'dash') { checkStatus(); loadDashLogs(); }
}, 15000);

// ============================================================
// INIT
// ============================================================
refreshDash();

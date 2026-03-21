const BASE = '/api';
const JWT_TOKEN_KEY = 'auth_jwt_token';
const ADMIN_USER_KEY = 'admin_user';
const ADMIN_PASSWORD_KEY = 'admin_password';
const PUBLIC_PATHS = new Set(['/status', '/fb/status', '/chat/reply', '/chat/stream', '/auth/login']);

function isLocalRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const host = (window.location.hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

// Use sessionStorage for sensitive credentials (cleared on tab close),
// localStorage only for non-sensitive preferences that should persist.
function getStoredToken(): string | null {
  try {
    return sessionStorage.getItem(JWT_TOKEN_KEY) || localStorage.getItem(JWT_TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

function setStoredToken(token: string): void {
  try {
    sessionStorage.setItem(JWT_TOKEN_KEY, token);
    // Migrate: remove from localStorage if still there
    try { localStorage.removeItem(JWT_TOKEN_KEY); } catch { /* ok */ }
  } catch {
    // ignore storage failures
  }
}

function clearStoredToken(): void {
  try {
    sessionStorage.removeItem(JWT_TOKEN_KEY);
    localStorage.removeItem(JWT_TOKEN_KEY);
  } catch {
    // ignore storage failures
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    // Passwords go to sessionStorage; username can stay in localStorage
    if (key === ADMIN_PASSWORD_KEY) {
      sessionStorage.setItem(key, value);
      try { localStorage.removeItem(key); } catch { /* ok */ }
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // ignore storage failures
  }
}

function safeStorageGet(key: string): string {
  try {
    // Try sessionStorage first for sensitive keys, then localStorage for migration
    if (key === ADMIN_PASSWORD_KEY || key === JWT_TOKEN_KEY) {
      return sessionStorage.getItem(key) || localStorage.getItem(key) || '';
    }
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function getAdminCredentials(): Array<{ username: string; password: string }> {
  const envUser = String((import.meta as any).env?.VITE_ADMIN_USER || '').trim();
  const envPass = String((import.meta as any).env?.VITE_ADMIN_PASSWORD || '').trim();
  const savedUser = String(safeStorageGet(ADMIN_USER_KEY)).trim();
  const savedPass = String(safeStorageGet(ADMIN_PASSWORD_KEY)).trim();

  const candidates = [
    { username: savedUser, password: savedPass },
    { username: envUser, password: envPass },
  ];

  // Local compatibility fallback:
  // built dashboard on localhost often has no injected VITE_* credentials.
  if ((import.meta as any).env?.DEV || isLocalRuntime()) {
    candidates.push({ username: 'admin', password: 'admin' });
  }

  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (!c.username || !c.password) return false;
    const key = `${c.username}\n${c.password}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

let tokenRefreshPromise: Promise<string | null> | null = null;
let promptedForCredentials = false;
let authPrimePromise: Promise<string | null> | null = null;
let authPrimed = false;

async function tryLoginWithCredential(cred: { username: string; password: string }): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: cred.username, password: cred.password }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.token) return null;
    setStoredToken(data.token);
    safeStorageSet(ADMIN_USER_KEY, cred.username);
    safeStorageSet(ADMIN_PASSWORD_KEY, cred.password);
    return data.token as string;
  } catch {
    return null;
  }
}

function promptCredentialInput(): { username: string; password: string } | null {
  if (typeof window === 'undefined') return null;
  if (!isLocalRuntime()) return null;
  if (promptedForCredentials) return null;
  promptedForCredentials = true;

  const username = window.prompt('Dashboard login username', safeStorageGet(ADMIN_USER_KEY) || 'admin');
  if (!username) return null;
  const password = window.prompt(`Password for ${username}`, '');
  if (password === null) return null;

  const user = String(username).trim();
  const pass = String(password).trim();
  if (!user || !pass) return null;
  return { username: user, password: pass };
}

async function tryAcquireToken(): Promise<string | null> {
  if (tokenRefreshPromise) return tokenRefreshPromise;

  tokenRefreshPromise = (async () => {
    for (const cred of getAdminCredentials()) {
      const token = await tryLoginWithCredential(cred);
      if (token) return token;
    }

    // Last-resort local fallback: ask once for credentials and remember them.
    const manualCred = promptCredentialInput();
    if (manualCred) {
      const token = await tryLoginWithCredential(manualCred);
      if (token) return token;
    }

    return null;
  })();

  try {
    return await tokenRefreshPromise;
  } finally {
    tokenRefreshPromise = null;
  }
}

function isProtectedPath(path: string): boolean {
  const cleanPath = path.split('?')[0] || path;
  return !PUBLIC_PATHS.has(cleanPath);
}

async function primeAuthToken(path: string, retryOnAuthFailure: boolean): Promise<string | null> {
  if (!retryOnAuthFailure || !isProtectedPath(path)) {
    return getStoredToken();
  }

  const stored = getStoredToken();
  if (authPrimed && stored) {
    return stored;
  }

  // If prime was attempted but no token is available, allow future retries.
  if (authPrimed && !stored) {
    authPrimed = false;
  }

  if (!authPrimePromise) {
    authPrimePromise = (async () => {
      try {
        // Proactively refresh once at boot for protected calls.
        // This avoids first-hit 401 bursts from stale JWTs after server restart.
        await tryAcquireToken();
        const token = getStoredToken();
        authPrimed = !!token;
        return token;
      } finally {
        authPrimePromise = null;
      }
    })();
  }

  return authPrimePromise;
}

/** Default request timeout in milliseconds (30 seconds) */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

async function request(path: string, options?: RequestInit & { timeoutMs?: number }, retryOnAuthFailure = true) {
  const headers = new Headers(options?.headers || {});
  const bodyIsPresent = options?.body !== undefined && options?.body !== null;
  const isFormDataBody = typeof FormData !== 'undefined' && options?.body instanceof FormData;
  if (bodyIsPresent && !isFormDataBody && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let token = await primeAuthToken(path, retryOnAuthFailure);
  if (!token) token = getStoredToken();

  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  // Timeout via AbortController — prevents hung requests from blocking the UI
  const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const existingSignal = options?.signal;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // If caller already provided a signal, chain it
  if (existingSignal) {
    existingSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err?.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms: ${path}`);
    }
    throw err;
  }
  clearTimeout(timeoutId);

  if ((res.status === 401 || res.status === 403) && retryOnAuthFailure) {
    clearStoredToken();
    authPrimed = false;
    const refreshed = await tryAcquireToken();
    if (refreshed) {
      return request(path, options, false);
    }
  }

  if (!res.ok) {
    const message = await res.text().catch(() => '');
    throw new Error(`API error: ${res.status}${message ? ` - ${message}` : ''}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return null;
  }
  return res.json();
}

export interface UploadedFilePayload {
  originalName: string;
  type: string;
  mimeType: string;
  sizeKB: number;
  hasBase64: boolean;
  contentPreview: string;
}

export interface UploadFileResult {
  success: boolean;
  file: UploadedFilePayload;
  geminiPart?: {
    type: string;
    mimeType?: string;
    dataLength?: number;
    textLength?: number;
  };
}

export const api = {
  // Status
  getStatus: () => request('/status'),
  getLogs: (limit = 100) => request(`/logs?limit=${limit}`),

  // Facebook
  fbLogin: (email: string, password: string) =>
    request('/fb/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  fbStatus: () => request('/fb/status'),

  // Settings
  getSettings: () => request('/settings'),
  setSetting: (key: string, value: string) =>
    request('/settings', { method: 'POST', body: JSON.stringify({ key, value }) }),
  setSettingsBulk: (settings: Record<string, string>) =>
    request('/settings', { method: 'POST', body: JSON.stringify(settings) }),

  // AI (legacy)
  testAI: (provider: string, apiKey: string) =>
    request('/ai/test', { method: 'POST', body: JSON.stringify({ provider, apiKey }) }),
  getAIModels: (provider: string, apiKey: string) =>
    request('/ai/models', { method: 'POST', body: JSON.stringify({ provider, apiKey }) }),
  generatePostContent: (topic: string, style: string) =>
    request('/ai/generate-post', { method: 'POST', body: JSON.stringify({ topic, style }) }),

  // Provider Registry (NEW - dynamic provider management)
  getProviders: () => request('/providers'),
  getProvider: (id: string) => request(`/providers/${id}`),
  getProviderModels: (id: string) => request(`/providers/${id}/models`),
  setProviderKey: (id: string, key: string) =>
    request(`/providers/${id}/key`, { method: 'POST', body: JSON.stringify({ key }) }),
  deleteProviderKey: (id: string) =>
    request(`/providers/${id}/key`, { method: 'DELETE' }),
  testProvider: (id: string) =>
    request(`/providers/${id}/test`, { method: 'POST' }),
  getProvidersByCategory: (category: string) =>
    request(`/providers/category/${category}`),
  addProvider: (data: Record<string, any>) =>
    request('/providers', { method: 'POST', body: JSON.stringify(data) }),
  updateProvider: (id: string, data: Record<string, any>) =>
    request(`/providers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  removeProvider: (id: string) =>
    request(`/providers/${id}`, { method: 'DELETE' }),
  toggleProvider: (id: string, enabled?: boolean) =>
    request(`/providers/${id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) }),

  // Personas
  getPersonas: () => request('/personas'),
  createPersona: (data: any) =>
    request('/personas', { method: 'POST', body: JSON.stringify(data) }),
  updatePersona: (id: string, data: any) =>
    request(`/personas/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  setDefaultPersona: (id: string) =>
    request(`/personas/${id}/default`, { method: 'POST' }),
  deletePersona: (id: string) =>
    request(`/personas/${id}`, { method: 'DELETE' }),

  // Q&A
  getQAPairs: () => request('/qa'),
  createQAPair: (data: any) =>
    request('/qa', { method: 'POST', body: JSON.stringify(data) }),
  updateQAPair: (id: number, data: any) =>
    request(`/qa/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteQAPair: (id: number) =>
    request(`/qa/${id}`, { method: 'DELETE' }),
  testQA: (question: string) =>
    request('/qa/test', { method: 'POST', body: JSON.stringify({ question }) }),

  // Posts
  getPosts: () => request('/posts'),
  createPost: (data: any) =>
    request('/posts', { method: 'POST', body: JSON.stringify(data) }),
  deletePost: (id: number) =>
    request(`/posts/${id}`, { method: 'DELETE' }),

  // Comment Watches
  getCommentWatches: () => request('/comments/watches'),
  addCommentWatch: (data: any) =>
    request('/comments/watches', { method: 'POST', body: JSON.stringify(data) }),
  deleteCommentWatch: (id: number) =>
    request(`/comments/watches/${id}`, { method: 'DELETE' }),

  // Conversations
  getConversations: () => request('/conversations'),
  getConversationMessages: (convId: string) => request(`/conversations/${convId}/messages`),

  // Bot Personas (file-based: AGENTS.md / IDENTITY.md / SOUL.md / TOOLS.md)
  getAllBotPersonas: () => request('/bot-personas'),
  getBotPersona: (platform: string) => request(`/bot-personas/${platform}`),
  saveBotPersona: (platform: string, data: { agents?: string; identity?: string; soul?: string; tools?: string }) =>
    request(`/bot-personas/${platform}`, { method: 'PUT', body: JSON.stringify(data) }),

  // Agent Monitor
  getAgentRuns: (limit = 1000) => request(`/agent/runs?limit=${limit}`),
  clearAgentRuns: () => request('/agent/runs', { method: 'DELETE' }),
  getAgentActive: () => request('/agent/active'),
  getAgentStats: () => request('/agent/stats'),
  getSystemTopology: () => request('/system/topology'),
  getSystemAgents: () => request('/system/agents'),
  getSystemPlugins: () => request('/system/plugins'),

  // Usage Tracking
  getUsageSummary: (hours = 24) => request(`/usage/summary?hours=${hours}`),
  getUsageHourly: (hours = 24) => request(`/usage/hourly?hours=${hours}`),

  // Provider Health
  getProviderHealth: () => request('/providers/health/all'),
  triggerHealthCheck: () => request('/providers/health/check', { method: 'POST' }),

  // OAuth Detection
  scanOAuth: () => request('/providers/oauth/scan', { method: 'POST' }),
  registerOAuthProvider: (credential: any) => request('/providers/oauth/register', { method: 'POST', body: JSON.stringify(credential) }),
  refreshOAuthToken: (providerId: string) => request(`/providers/oauth/refresh/${providerId}`, { method: 'POST' }),

  // Agent Routing
  getAgentConfig: () => request('/config'),
  setAgentConfig: (config: { autoRouting?: boolean, routes?: Record<string, { provider: string; modelName: string }> }) =>
    request('/config', { method: 'POST', body: JSON.stringify(config) }),

  // Swarm / Multi-Agent Orchestration
  getSwarmStatus: () => request('/swarm/status'),
  getSwarmStats: () => request('/swarm/stats'),
  getSwarmSpecialists: () => request('/swarm/specialists'),
  getSwarmTasks: (params?: { status?: string; platform?: string; specialist?: string; batchId?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.platform) qs.set('platform', params.platform);
    if (params?.specialist) qs.set('specialist', params.specialist);
    if (params?.batchId) qs.set('batchId', params.batchId);
    if (typeof params?.limit === 'number') qs.set('limit', String(params.limit));
    const query = qs.toString();
    return request(`/swarm/tasks${query ? '?' + query : ''}`);
  },
  getSwarmTask: (id: string) => request(`/swarm/tasks/${id}`),
  getSwarmBatches: (limit = 50) => request(`/swarm/batches?limit=${limit}`),
  getSwarmBatch: (id: string) => request(`/swarm/batches/${id}`),
  getSwarmLaneMetrics: () => request('/swarm/lane-metrics'),
  getSwarmBatchFailures: (batchId: string) => request(`/swarm/batches/${batchId}/failures`),
  swarmPreflight: (data?: { specialists?: string[]; minHealthyLanes?: number }) =>
    request('/swarm/preflight', { method: 'POST', body: JSON.stringify(data ?? {}) }),
  getSwarmHealth: () => request('/swarm/health'),
  getRuntimeControls: () => request('/system/runtime-controls'),
  orchestrateJarvisBatch: (data: {
    objective: string;
    fromPlatform?: string;
    fromChatId?: string;
    initiatorId?: string;
    multipass?: boolean;
    tasks?: Array<{
      title: string;
      specialist: string;
      message: string;
      taskType?: string;
      dependsOn?: number[];
      priority?: number;
      timeout?: number;
      maxRetries?: number;
    }>;
  }) => request('/swarm/jarvis/orchestrate', { method: 'POST', body: JSON.stringify(data) }),

  // Terminal backends
  getTerminalBackends: (refresh = false) => request(`/terminal/backends${refresh ? '?refresh=1' : ''}`),

  // MeetingRoom (Roundtable)
  startMeeting: (data: { objective: string; maxRounds?: number; timeoutPerCliMs?: number }) =>
    request('/swarm/meeting/start', { method: 'POST', body: JSON.stringify(data) }),
  getMeeting: (id: string) => request(`/swarm/meeting/${id}`),
  getMeetings: () => request('/swarm/meetings'),

  // Memory Viewer
  getMemoryChats: () => request('/memory/chats'),
  getMemory: (chatId: string) => request(`/memory/${encodeURIComponent(chatId)}`),
  clearMemory: (chatId: string) =>
    request(`/memory/${encodeURIComponent(chatId)}`, { method: 'DELETE' }),

  // Tool Registry
  getTools: (params?: { category?: string; platform?: string; q?: string }) => {
    const qs = new URLSearchParams();
    if (params?.category) qs.set('category', params.category);
    if (params?.platform) qs.set('platform', params.platform);
    if (params?.q) qs.set('q', params.q);
    const query = qs.toString();
    return request(`/tools${query ? '?' + query : ''}`);
  },
  getToolCategories: () => request('/tools/categories'),
  getToolDefaults: () => request('/tools/defaults'),

  // Bot Registry
  getBots: (platform?: string) => request(`/bots${platform ? '?platform=' + platform : ''}`),
  getBot: (id: string) => request(`/bots/${id}`),
  createBot: (data: { id: string; name: string; platform: string; credentials?: Record<string, string>; persona_id?: string; enabled_tools?: string[]; config?: Record<string, unknown> }) =>
    request('/bots', { method: 'POST', body: JSON.stringify(data) }),
  updateBot: (id: string, data: Record<string, unknown>) =>
    request(`/bots/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  getBotModels: (id: string) => request(`/bots/${id}/models`),
  setBotModel: (id: string, data: { taskType?: string; provider?: string | null; modelName?: string; autoRouting?: boolean }) =>
    request(`/bots/${id}/models`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteBot: (id: string) =>
    request(`/bots/${id}`, { method: 'DELETE' }),
  toggleBot: (id: string) =>
    request(`/bots/${id}/toggle`, { method: 'POST' }),
  getBotTools: (id: string) => request(`/bots/${id}/tools`),
  setBotTools: (id: string, tools: string[]) =>
    request(`/bots/${id}/tools`, { method: 'PUT', body: JSON.stringify({ tools }) }),
  getBotPlatforms: () => request('/bots/platforms'),

  // File upload
  uploadFile: (file: File): Promise<UploadFileResult> => {
    const form = new FormData();
    form.append('file', file);
    return request('/files/upload', { method: 'POST', body: form });
  },

  // System Health (new)
  getHealthz: () => fetch('/healthz').then(r => r.json()).catch(() => ({ status: 'error' })),
  getReadyz: () => fetch('/readyz').then(r => r.json()).catch(() => ({ status: 'error' })),
  getDetailedHealth: () => request('/health/detailed'),

  // Goals (new)
  getGoals: (chatId: string, status?: string) => request(`/goals?chatId=${chatId}${status ? '&status=' + status : ''}`),
  createGoal: (data: { chatId: string; title: string; description?: string; priority?: number; subGoals?: Array<{title: string}> }) =>
    request('/goals', { method: 'POST', body: JSON.stringify(data) }),
  updateSubGoal: (data: { goalId: string; subGoalId: string; status: string }) =>
    request(`/goals/${data.goalId}/subgoals/${data.subGoalId}`, { method: 'PATCH', body: JSON.stringify({ status: data.status }) }),
  deleteGoal: (goalId: string) => request(`/goals/${goalId}`, { method: 'DELETE' }),
  
  // Self-Upgrade (new)
  getUpgradeStatus: () => request('/upgrade/status'),
  getUpgradeProposals: (status?: string, type?: string, limit = 50) => {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (type) qs.set('type', type);
    if (limit) qs.set('limit', String(limit));
    const query = qs.toString();
    return request(`/upgrade/proposals${query ? '?' + query : ''}`);
  },
  updateUpgradeProposalStatus: (id: number, status: string) =>
    request(`/upgrade/proposals/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  deleteUpgradeProposal: (id: number) =>
    request(`/upgrade/proposals/${id}`, { method: 'DELETE' }),
  triggerUpgradeScan: () =>
    request('/upgrade/scan', { method: 'POST' }),
  updateUpgradeConfig: (config: { intervalMs?: number, idleThresholdMs?: number }) =>
    request('/upgrade/config', { 
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    }),
  toggleUpgradePaused: (paused: boolean) =>
    request('/upgrade/toggle', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused })
    }),
  implementUpgradeProposal: (id: number) =>
    request(`/upgrade/implement/${id}`, { method: 'POST', timeoutMs: 600000 }),
  implementAllApprovedProposals: () =>
    request(`/upgrade/implement-all`, { method: 'POST', timeoutMs: 600000 }),
  notifyUpgradeActivity: () =>
    request('/upgrade/activity', { method: 'POST' }),
  getUpgradeProposalDiff: (id: number) =>
    request(`/upgrade/proposals/${id}/diff`),
  getUpgradeProposalLog: (id: number) =>
    request(`/upgrade/proposals/${id}/log`),
};

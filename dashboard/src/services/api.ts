const BASE = '/api';

async function request(path: string, options?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
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

  // AI
  testAI: (provider: string, apiKey: string) =>
    request('/ai/test', { method: 'POST', body: JSON.stringify({ provider, apiKey }) }),
  getAIModels: (provider: string, apiKey: string) =>
    request('/ai/models', { method: 'POST', body: JSON.stringify({ provider, apiKey }) }),
  generatePostContent: (topic: string, style: string) =>
    request('/ai/generate-post', { method: 'POST', body: JSON.stringify({ topic, style }) }),

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
  getAgentRuns: (limit = 50) => request(`/agent/runs?limit=${limit}`),
  getAgentActive: () => request('/agent/active'),
  getAgentStats: () => request('/agent/stats'),

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
  deleteBot: (id: string) =>
    request(`/bots/${id}`, { method: 'DELETE' }),
  toggleBot: (id: string) =>
    request(`/bots/${id}/toggle`, { method: 'POST' }),
  getBotTools: (id: string) => request(`/bots/${id}/tools`),
  setBotTools: (id: string, tools: string[]) =>
    request(`/bots/${id}/tools`, { method: 'PUT', body: JSON.stringify({ tools }) }),
  getBotPlatforms: () => request('/bots/platforms'),
};

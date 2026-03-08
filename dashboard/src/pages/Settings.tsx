import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { Settings as SettingsIcon, Key, Brain, Globe, Save, CheckCircle, XCircle, Loader2, RefreshCw, AlertTriangle } from 'lucide-react';

interface Props {
  status: { browser: boolean; loggedIn: boolean; chatBot: boolean; commentBot: boolean };
  emit: (event: string, data?: any) => void;
  on: (event: string, handler: (...args: any[]) => void) => () => void;
}

export function Settings({ status, emit, on }: Props) {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, boolean>>({});
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [fbEmail, setFbEmail] = useState('');
  const [fbPassword, setFbPassword] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [fbMessage, setFbMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  useEffect(() => { loadSettings(); }, []);

  // Listen for login result from server
  useEffect(() => {
    const unsub1 = on('fb:loginResult', (data: { success: boolean; message?: string }) => {
      setLoggingIn(false);
      if (data.success) {
        setFbMessage({ type: 'success', text: data.message || 'Login successful!' });
      } else {
        setFbMessage({ type: 'error', text: data.message || 'Login failed' });
      }
    });
    const unsub2 = on('error', (data: { message: string }) => {
      setLoggingIn(false);
      setFbMessage({ type: 'error', text: data.message });
    });
    return () => { unsub1(); unsub2(); };
  }, [on]);

  async function loadSettings() {
    try {
      const data = await api.getSettings();
      const map: Record<string, string> = {};
      if (Array.isArray(data)) {
        data.forEach((s: any) => { map[s.key] = s.value; });
      } else {
        Object.assign(map, data);
      }
      setSettings(map);
      setFbEmail(map['fb_email'] || '');
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  }

  function updateSetting(key: string, value: string) {
    setSettings(prev => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      for (const [key, value] of Object.entries(settings)) {
        await api.setSetting(key, value);
      }
    } catch {}
    setSaving(false);
  }

  async function handleTestAI(provider: string) {
    setTesting(provider);
    try {
      const keyMap: Record<string, string> = {
        openai: 'ai_openai_key',
        gemini: 'ai_gemini_key',
        minimax: 'ai_minimax_key',
        openrouter: 'ai_openrouter_key',
      };
      const result = await api.testAI(provider, settings[keyMap[provider]] || '');
      setTestResults(prev => ({ ...prev, [provider]: result.success }));
    } catch {
      setTestResults(prev => ({ ...prev, [provider]: false }));
    }
    setTesting(null);
  }

  async function handleLoadModels(provider: string) {
    try {
      const keyMap: Record<string, string> = {
        openai: 'ai_openai_key',
        gemini: 'ai_gemini_key',
        minimax: 'ai_minimax_key',
        openrouter: 'ai_openrouter_key',
      };
      const result = await api.getAIModels(provider, settings[keyMap[provider]] || '');
      setModels(prev => ({ ...prev, [provider]: result.models }));
    } catch {}
  }

  async function handleFbLogin() {
    if (!fbEmail || !fbPassword) return;
    setLoggingIn(true);
    setFbMessage({ type: 'info', text: 'Launching browser and logging in...' });
    try {
      await api.setSetting('fb_email', fbEmail);
      emit('fb:login', { email: fbEmail, password: fbPassword });
      // Timeout fallback in case server never responds
      setTimeout(() => {
        setLoggingIn(prev => {
          if (prev) {
            setFbMessage({ type: 'error', text: 'Login timed out - check server terminal for errors' });
          }
          return false;
        });
      }, 60000); // 60 second timeout
    } catch (e: any) {
      setLoggingIn(false);
      setFbMessage({ type: 'error', text: `Error: ${e.message}` });
    }
  }

  const aiProviders = [
    { id: 'openai', name: 'OpenAI', keyField: 'ai_openai_key', modelField: 'ai_openai_model', placeholder: 'sk-...' },
    { id: 'gemini', name: 'Google Gemini', keyField: 'ai_gemini_key', modelField: 'ai_gemini_model', placeholder: 'AIza...' },
    { id: 'minimax', name: 'MiniMax', keyField: 'ai_minimax_key', modelField: 'ai_minimax_model', placeholder: 'eyJ...' },
    { id: 'openrouter', name: 'OpenRouter', keyField: 'ai_openrouter_key', modelField: 'ai_openrouter_model', placeholder: 'sk-or-...' },
  ];

  const taskTypes = [
    { id: 'chat', name: 'Chat Bot', desc: 'Messenger replies' },
    { id: 'content', name: 'Content Creator', desc: 'Auto-post content' },
    { id: 'comment', name: 'Comment Reply', desc: 'Comment responses' },
    { id: 'summary', name: 'Summarizer', desc: 'Conversation summary' },
  ];

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <h2 className="text-2xl font-bold text-white">Settings</h2>

      {/* Facebook Account */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
          <Globe className="w-4 h-4 text-blue-400" /> Facebook Account
        </h3>
        <div className="flex items-center gap-2 mb-2">
          <span className={`w-2 h-2 rounded-full ${status.loggedIn ? 'bg-green-400' : 'bg-gray-600'}`} />
          <span className="text-xs text-gray-400">
            {status.loggedIn ? 'Logged in' : status.browser ? 'Browser running, not logged in' : 'Browser not started'}
          </span>
        </div>

        {/* Login message */}
        {fbMessage && (
          <div className={`p-3 rounded-lg text-xs flex items-center gap-2 ${
            fbMessage.type === 'success' ? 'bg-green-500/10 text-green-400 border border-green-500/20' :
            fbMessage.type === 'error' ? 'bg-red-500/10 text-red-400 border border-red-500/20' :
            'bg-blue-500/10 text-blue-400 border border-blue-500/20'
          }`}>
            {fbMessage.type === 'success' && <CheckCircle className="w-4 h-4 shrink-0" />}
            {fbMessage.type === 'error' && <AlertTriangle className="w-4 h-4 shrink-0" />}
            {fbMessage.type === 'info' && <Loader2 className="w-4 h-4 shrink-0 animate-spin" />}
            {fbMessage.text}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Email / Phone</label>
            <input
              value={fbEmail}
              onChange={e => setFbEmail(e.target.value)}
              placeholder="your@email.com"
              className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Password</label>
            <input
              type="password"
              value={fbPassword}
              onChange={e => setFbPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleFbLogin}
            disabled={loggingIn || !fbEmail || !fbPassword}
            className="px-4 py-2 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 text-xs font-medium border border-blue-500/30 disabled:opacity-50 flex items-center gap-2"
          >
            {loggingIn && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {loggingIn ? 'Logging in...' : 'Login to Facebook'}
          </button>
          <span className="text-[10px] text-gray-600">
            Browser will open automatically. First login may require 2FA.
          </span>
        </div>
      </div>

      {/* AI Providers */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
          <Key className="w-4 h-4 text-yellow-400" /> AI Providers
        </h3>

        {aiProviders.map(provider => (
          <div key={provider.id} className="bg-gray-800/50 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-gray-300">{provider.name}</p>
              <div className="flex items-center gap-2">
                {testResults[provider.id] !== undefined && (
                  testResults[provider.id]
                    ? <CheckCircle className="w-4 h-4 text-green-400" />
                    : <XCircle className="w-4 h-4 text-red-400" />
                )}
                <button
                  onClick={() => handleTestAI(provider.id)}
                  disabled={testing === provider.id || !settings[provider.keyField]}
                  className="px-2 py-1 text-[10px] bg-gray-700 text-gray-300 rounded hover:bg-gray-600 disabled:opacity-50"
                >
                  {testing === provider.id ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Test'}
                </button>
                <button
                  onClick={() => handleLoadModels(provider.id)}
                  disabled={!settings[provider.keyField]}
                  className="px-2 py-1 text-[10px] bg-gray-700 text-gray-300 rounded hover:bg-gray-600 disabled:opacity-50"
                >
                  <RefreshCw className="w-3 h-3 inline" /> Models
                </button>
              </div>
            </div>
            <input
              value={settings[provider.keyField] || ''}
              onChange={e => updateSetting(provider.keyField, e.target.value)}
              placeholder={provider.placeholder}
              type="password"
              className="w-full px-3 py-1.5 text-xs bg-gray-900 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
            />
            {models[provider.id] && (
              <select
                value={settings[provider.modelField] || ''}
                onChange={e => updateSetting(provider.modelField, e.target.value)}
                className="w-full px-3 py-1.5 text-xs bg-gray-900 border border-gray-700 rounded-lg text-gray-200"
              >
                <option value="">Select model...</option>
                {models[provider.id].map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            )}
          </div>
        ))}
      </div>

      {/* Task → AI Routing */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
          <Brain className="w-4 h-4 text-purple-400" /> AI Task Routing
        </h3>
        <p className="text-xs text-gray-500">Choose which AI provider handles each task type.</p>

        <div className="space-y-3">
          {taskTypes.map(task => (
            <div key={task.id} className="flex items-center gap-3">
              <div className="w-32">
                <p className="text-xs text-gray-300">{task.name}</p>
                <p className="text-[10px] text-gray-600">{task.desc}</p>
              </div>
              <select
                value={settings[`ai_task_${task.id}_provider`] || ''}
                onChange={e => updateSetting(`ai_task_${task.id}_provider`, e.target.value)}
                className="flex-1 px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200"
              >
                <option value="">Default (first available)</option>
                {aiProviders.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <input
                value={settings[`ai_task_${task.id}_model`] || ''}
                onChange={e => updateSetting(`ai_task_${task.id}_model`, e.target.value)}
                placeholder="Model (optional)"
                className="w-40 px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
              />
            </div>
          ))}
        </div>
      </div>

      {/* General Settings */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
          <SettingsIcon className="w-4 h-4 text-gray-400" /> General
        </h3>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Chat Reply Delay (ms)</label>
            <input
              type="number"
              value={settings['chat_reply_delay'] || '2000'}
              onChange={e => updateSetting('chat_reply_delay', e.target.value)}
              className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Comment Reply Delay (ms)</label>
            <input
              type="number"
              value={settings['comment_reply_delay'] || '5000'}
              onChange={e => updateSetting('comment_reply_delay', e.target.value)}
              className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Browser Headless</label>
            <select
              value={settings['browser_headless'] || 'false'}
              onChange={e => updateSetting('browser_headless', e.target.value)}
              className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200"
            >
              <option value="false">No (show browser)</option>
              <option value="true">Yes (hidden)</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Max Conversation Memory</label>
            <input
              type="number"
              value={settings['max_memory_messages'] || '20'}
              onChange={e => updateSetting('max_memory_messages', e.target.value)}
              className="w-full px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>
      </div>

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-6 py-2.5 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 text-sm font-medium border border-blue-500/30 disabled:opacity-50"
        >
          <Save className="w-4 h-4" /> {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  );
}

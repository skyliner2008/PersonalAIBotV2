import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Globe, Loader2, CheckCircle, AlertTriangle,
} from 'lucide-react';
import { useToast } from '../../components/Toast';
import { api } from '../../services/api';

interface Props {
  status: { browser: boolean; loggedIn: boolean; chatBot: boolean; commentBot: boolean };
  emit: (event: string, data?: any) => void;
  on: (event: string, handler: (...args: any[]) => void) => () => void;
}

export function FacebookSettings({ status, emit, on }: Props) {
  const { addToast } = useToast();
  const [fbEmail, setFbEmail] = useState('');
  const [fbPassword, setFbPassword] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [fbMessage, setFbMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const loginTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const loadInitialEmail = async () => {
      try {
        const data = await api.getSettings();
        const map: Record<string, string> = {};
        if (Array.isArray(data)) {
          data.forEach((s: any) => { map[s.key] = s.value; });
        } else {
          Object.assign(map, data);
        }
        setFbEmail(map['fb_email'] || '');
      } catch (e) {
        console.error('Failed to load settings:', e);
      }
    };
    loadInitialEmail();
  }, []);

  useEffect(() => {
    const unsub1 = on('fb:loginResult', (data: { success: boolean; message?: string }) => {
      setLoggingIn(false);
      if (loginTimeoutRef.current) clearTimeout(loginTimeoutRef.current);
      if (data.success) {
        setFbMessage({ type: 'success', text: data.message || 'Login successful!' });
      } else {
        setFbMessage({ type: 'error', text: data.message || 'Login failed' });
      }
    });
    const unsub2 = on('error', (data: { message: string }) => {
      setLoggingIn(false);
      if (loginTimeoutRef.current) clearTimeout(loginTimeoutRef.current);
      setFbMessage({ type: 'error', text: data.message });
    });
    return () => {
      unsub1();
      unsub2();
      if (loginTimeoutRef.current) clearTimeout(loginTimeoutRef.current);
    };
  }, [on]);

  const handleFbLogin = useCallback(async () => {
    if (!fbEmail || !fbPassword) return;
    setLoggingIn(true);
    setFbMessage({ type: 'info', text: 'Launching browser and logging in...' });
    try {
      await api.setSetting('fb_email', fbEmail);
      emit('fb:login', { email: fbEmail, password: fbPassword });
      if (loginTimeoutRef.current) clearTimeout(loginTimeoutRef.current);
      loginTimeoutRef.current = setTimeout(() => {
        setLoggingIn(prev => {
          if (prev) setFbMessage({ type: 'error', text: 'Login timed out - check server terminal for errors' });
          return false;
        });
      }, 60000);
    } catch (e: any) {
      setLoggingIn(false);
      setFbMessage({ type: 'error', text: `Error: ${e.message}` });
    }
  }, [fbEmail, fbPassword, emit]);

  return (
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
  );
}

import React, { useState, useEffect, ReactNode } from 'react';
import { useSocket } from './hooks/useSocket';
import { api } from './services/api';
import { ToastProvider } from './components/Toast';
import { Dashboard } from './pages/Dashboard';
import { Settings } from './pages/Settings';
import { ChatMonitor } from './pages/ChatMonitor';
import { PostManager } from './pages/PostManager';
import { PersonaEditor } from './pages/PersonaEditor';
import { QADatabase } from './pages/QADatabase';
import { AgentMonitor } from './pages/AgentMonitor';
import { MemoryViewer } from './pages/MemoryViewer';
import { AgentManager } from './pages/AgentManager';
import { ToolManager } from './pages/ToolManager';
import { JarvisCall } from './pages/JarvisCall';
import { MultiAgent } from './pages/MultiAgent';
import { SystemHealth } from './pages/SystemHealth';
import { TaskQueueMonitor } from './pages/TaskQueueMonitor';
import { GoalTracker } from './pages/GoalTracker';
import SelfUpgrade from './pages/SelfUpgrade';
import {
  LayoutDashboard, MessageCircle, FileEdit, User, Database,
  Settings as SettingsIcon, Wifi, WifiOff, Bot, Brain, Activity, Wrench, Users, GitBranch, PhoneCall,
  ListTodo, Target, Dna
} from 'lucide-react';

type Page = 'dashboard' | 'jarvis-call' | 'multi-agent' | 'chat' | 'posts' | 'persona' | 'qa' | 'settings' | 'agent-monitor' | 'memory' | 'agents' | 'tools' | 'system-health' | 'task-queue' | 'goal-tracker' | 'self-upgrade';

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

class ErrorBoundary extends React.Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('React Error Boundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-screen bg-gray-950">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-red-400 mb-2">Something went wrong</h1>
            <p className="text-gray-400 mb-4">{this.state.error?.message || 'An unexpected error occurred'}</p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default function App() {
  const { connected, emit, on } = useSocket();
  const [page, setPage] = useState<Page>(() => {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = String(params.get('page') || '').trim().toLowerCase();
    const pathname = String(window.location.pathname || '/').toLowerCase();

    // Jarvis Call — standalone full-screen (mobile-friendly)
    if (pathname === '/call') return 'jarvis-call';
    if (fromQuery === 'jarvis-call') return 'jarvis-call';
    if (fromQuery === 'jarvis') return 'jarvis-call';
    if (fromQuery === 'jarvis-hub') return 'jarvis-call';
    if (fromQuery === 'multi-agent') return 'multi-agent';
    if (fromQuery === 'agents') return 'agents';
    if (fromQuery === 'tools') return 'tools';
    if (fromQuery === 'agent-monitor') return 'agent-monitor';
    if (fromQuery === 'memory') return 'memory';
    if (fromQuery === 'chat') return 'chat';
    if (fromQuery === 'posts') return 'posts';
    if (fromQuery === 'persona') return 'persona';
    if (fromQuery === 'qa') return 'qa';
    if (fromQuery === 'settings') return 'settings';
    if (fromQuery === 'system-health') return 'system-health';
    if (fromQuery === 'task-queue') return 'task-queue';
    if (fromQuery === 'goal-tracker') return 'goal-tracker';
    if (fromQuery === 'self-upgrade') return 'self-upgrade';
    return 'dashboard';
  });
  const [status, setStatus] = useState({
    browser: false,
    loggedIn: false,
    chatBot: false,
    commentBot: false,
  });

  useEffect(() => {
    api.getStatus().then(setStatus).catch((err) => {
      console.error('Failed to fetch initial status:', err);
    });
  }, []);

  useEffect(() => {
    const unsub1 = on('browser:status', (data: any) =>
      setStatus(s => ({ ...s, browser: data.running })));
    const unsub2 = on('chatbot:status', (data: any) =>
      setStatus(s => ({ ...s, chatBot: data.active })));
    const unsub3 = on('commentbot:status', (data: any) =>
      setStatus(s => ({ ...s, commentBot: data.active })));
    const unsub4 = on('fb:loginResult', (data: any) =>
      setStatus(s => ({ ...s, loggedIn: data.success })));
    return () => { unsub1(); unsub2(); unsub3(); unsub4(); };
  }, [on]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (page === 'jarvis-call') {
      url.pathname = '/call';
      url.searchParams.delete('page');
    } else if (page === 'dashboard') {
      url.pathname = '/';
      url.searchParams.delete('page');
    } else {
      url.pathname = '/';
      url.searchParams.set('page', page);
    }
    window.history.replaceState({}, '', `${url.pathname}${url.search}`);
  }, [page]);

  const navItems: { id: Page; label: string; icon: any }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'agents', label: 'Agent Manager', icon: Users },
    { id: 'jarvis-call', label: 'Jarvis Call', icon: PhoneCall },
    { id: 'multi-agent', label: 'Meeting Room', icon: GitBranch },
    { id: 'tools', label: 'Tool Manager', icon: Wrench },
    { id: 'agent-monitor', label: 'Agent Monitor', icon: Activity },
    { id: 'system-health', label: 'System Health', icon: Activity },
    { id: 'task-queue', label: 'Task Queue', icon: ListTodo },
    { id: 'goal-tracker', label: 'Goal Tracker', icon: Target },
    { id: 'self-upgrade', label: 'Self-Upgrade', icon: Dna },
    { id: 'memory', label: 'Memory Viewer', icon: Brain },
    { id: 'chat', label: 'Chat Bot', icon: MessageCircle },
    { id: 'posts', label: 'Auto Post', icon: FileEdit },
    { id: 'persona', label: 'Persona', icon: User },
    { id: 'qa', label: 'Q&A', icon: Database },
    { id: 'settings', label: 'Settings', icon: SettingsIcon },
  ];

  // Jarvis Call — standalone full-screen page (no sidebar, mobile-friendly)
  if (page === 'jarvis-call') {
    return (
      <ErrorBoundary>
        <ToastProvider>
          <JarvisCall />
        </ToastProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <ToastProvider>
      <div className="flex h-screen bg-gray-950">
        {/* Sidebar */}
        <aside className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col">
        {/* Logo */}
        <div className="p-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
              <Bot className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-white">AI Agent Hub</h1>
              <p className="text-[10px] text-purple-500 font-medium">v2.0 Agentic</p>
            </div>
          </div>
        </div>

        {/* Status indicators */}
        <div className="px-3 py-2 space-y-1 border-b border-gray-800">
          <StatusPill label="Server" active={connected} />
          <StatusPill label="Browser" active={status.browser} />
          <StatusPill label="Facebook" active={status.loggedIn} />
          <StatusPill label="Chat Bot" active={status.chatBot} />
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-2 space-y-1">
          {navItems.map(item => (
            <button
              key={item.id}
              onClick={() => setPage(item.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-all ${page === item.id
                  ? 'bg-blue-600/20 text-blue-400 font-medium'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                }`}
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </button>
          ))}
        </nav>

        {/* Connection status */}
        <div className="p-3 border-t border-gray-800">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            {connected ? <Wifi className="w-3 h-3 text-green-500" /> : <WifiOff className="w-3 h-3 text-red-500" />}
            {connected ? 'Connected' : 'Disconnected'}
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        {page === 'dashboard' && <Dashboard status={status} emit={emit} on={on} />}
        {page === 'agents' && <AgentManager />}
        {page === 'multi-agent' && <MultiAgent on={on} />}
        {page === 'tools' && <ToolManager />}
        {page === 'agent-monitor' && <AgentMonitor on={on} />}
        {page === 'system-health' && <SystemHealth />}
        {page === 'task-queue' && <TaskQueueMonitor />}
        {page === 'goal-tracker' && <GoalTracker />}
        {page === 'self-upgrade' && <SelfUpgrade />}
        {page === 'memory' && <MemoryViewer />}
        {page === 'chat' && <ChatMonitor status={status} emit={emit} on={on} />}
        {page === 'posts' && <PostManager />}
        {page === 'persona' && <PersonaEditor />}
        {page === 'qa' && <QADatabase />}
        {page === 'settings' && <Settings status={status} emit={emit} on={on} />}
      </main>
      </div>
      </ToastProvider>
    </ErrorBoundary>
  );
}

function StatusPill({ label, active }: { label: string; active: boolean }) {
  return (
    <div className="flex items-center justify-between text-xs px-1">
      <span className="text-gray-500">{label}</span>
      <span className={`flex items-center gap-1 ${active ? 'text-green-400' : 'text-gray-600'}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-green-400 animate-pulse' : 'bg-gray-600'}`} />
        {active ? 'ON' : 'OFF'}
      </span>
    </div>
  );
}

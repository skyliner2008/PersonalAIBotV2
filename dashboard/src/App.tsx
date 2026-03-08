import { useState, useEffect } from 'react';
import { useSocket } from './hooks/useSocket';
import { api } from './services/api';
import { Dashboard } from './pages/Dashboard';
import { Settings } from './pages/Settings';
import { ChatMonitor } from './pages/ChatMonitor';
import { PostManager } from './pages/PostManager';
import { PersonaEditor } from './pages/PersonaEditor';
import { QADatabase } from './pages/QADatabase';
import { BotPersonas } from './pages/BotPersonas';
import { AgentMonitor } from './pages/AgentMonitor';
import { MemoryViewer } from './pages/MemoryViewer';
import { AgentManager } from './pages/AgentManager';
import { ToolManager } from './pages/ToolManager';
import { WebCLI } from './pages/WebCLI';
import {
  LayoutDashboard, MessageCircle, FileEdit, User, Database,
  Settings as SettingsIcon, Wifi, WifiOff, Bot, Cpu, Brain, Activity, Wrench, Users, Terminal
} from 'lucide-react';

type Page = 'dashboard' | 'cli' | 'chat' | 'posts' | 'persona' | 'bot-personas' | 'qa' | 'settings' | 'agent-monitor' | 'memory' | 'agents' | 'tools';

export default function App() {
  const { connected, emit, on } = useSocket();
  const [page, setPage] = useState<Page>('dashboard');
  const [status, setStatus] = useState({
    browser: false,
    loggedIn: false,
    chatBot: false,
    commentBot: false,
  });

  useEffect(() => {
    api.getStatus().then(setStatus).catch(() => { });
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

  const navItems: { id: Page; label: string; icon: any; section?: string }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'agents', label: 'Agent Manager', icon: Users },
    { id: 'tools', label: 'Tool Manager', icon: Wrench },
    { id: 'agent-monitor', label: 'Agent Monitor', icon: Activity },
    { id: 'memory', label: 'Memory Viewer', icon: Brain },
    { id: 'cli', label: 'Web CLI Terminal', icon: Terminal },
    { id: 'chat', label: 'Chat Bot', icon: MessageCircle },
    { id: 'posts', label: 'Auto Post', icon: FileEdit },
    { id: 'persona', label: 'Persona', icon: User },
    { id: 'bot-personas', label: 'Bot Personas', icon: Cpu },
    { id: 'qa', label: 'Q&A', icon: Database },
    { id: 'settings', label: 'Settings', icon: SettingsIcon },
  ];

  return (
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
        {page === 'tools' && <ToolManager />}
        {page === 'agent-monitor' && <AgentMonitor />}
        {page === 'memory' && <MemoryViewer />}
        {page === 'cli' && <WebCLI />}
        {page === 'chat' && <ChatMonitor status={status} emit={emit} on={on} />}
        {page === 'posts' && <PostManager />}
        {page === 'persona' && <PersonaEditor />}
        {page === 'bot-personas' && <BotPersonas />}
        {page === 'qa' && <QADatabase />}
        {page === 'settings' && <Settings status={status} emit={emit} on={on} />}
      </main>
    </div>
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

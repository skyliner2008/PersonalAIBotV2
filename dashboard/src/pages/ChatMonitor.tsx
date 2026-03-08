import { useState, useEffect, useRef } from 'react';
import { api } from '../services/api';
import { MessageCircle, Send, User, Bot, RefreshCw, Search } from 'lucide-react';

interface Props {
  status: { browser: boolean; loggedIn: boolean; chatBot: boolean; commentBot: boolean };
  emit: (event: string, data?: any) => void;
  on: (event: string, handler: (...args: any[]) => void) => () => void;
}

export function ChatMonitor({ status, emit, on }: Props) {
  const [conversations, setConversations] = useState<any[]>([]);
  const [selectedConv, setSelectedConv] = useState<string | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load conversations
  useEffect(() => {
    loadConversations();
    const interval = setInterval(loadConversations, 10000);
    return () => clearInterval(interval);
  }, []);

  // Listen for real-time chat events
  useEffect(() => {
    const unsub = on('chatbot:sentReply', (data: any) => {
      loadConversations();
      if (selectedConv) loadMessages(selectedConv);
    });
    return unsub;
  }, [on, selectedConv]);

  // Auto-scroll messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function loadConversations() {
    try {
      const data = await api.getConversations();
      setConversations(data);
    } catch {}
  }

  async function loadMessages(convId: string) {
    try {
      const data = await api.getConversationMessages(convId);
      setMessages(data);
    } catch {}
  }

  function selectConversation(convId: string) {
    setSelectedConv(convId);
    loadMessages(convId);
  }

  const filtered = conversations.filter(c =>
    !search || c.fb_user_name?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex h-[calc(100vh-64px)]">
      {/* Conversation List */}
      <div className="w-80 border-r border-gray-800 flex flex-col">
        <div className="p-3 border-b border-gray-800">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
              <MessageCircle className="w-4 h-4 text-blue-400" /> Conversations
            </h3>
            <button onClick={loadConversations} className="text-gray-500 hover:text-gray-300">
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {filtered.length === 0 && (
            <p className="text-gray-600 text-xs text-center py-8">No conversations yet</p>
          )}
          {filtered.map(conv => (
            <button
              key={conv.id}
              onClick={() => selectConversation(conv.id)}
              className={`w-full text-left px-3 py-3 border-b border-gray-800/50 hover:bg-gray-800/50 transition ${
                selectedConv === conv.id ? 'bg-blue-500/10 border-l-2 border-l-blue-500' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center shrink-0">
                  <User className="w-4 h-4 text-gray-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm text-gray-200 truncate">{conv.fb_user_name || 'Unknown'}</p>
                  <p className="text-[10px] text-gray-500">
                    {conv.message_count} messages · {new Date(conv.last_message_at).toLocaleDateString('th-TH')}
                  </p>
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Chat Bot Control */}
        <div className="p-3 border-t border-gray-800">
          <button
            onClick={() => emit(status.chatBot ? 'chatbot:stop' : 'chatbot:start')}
            disabled={!status.loggedIn}
            className={`w-full py-2 rounded-lg text-xs font-medium transition ${
              !status.loggedIn ? 'bg-gray-800 text-gray-600 cursor-not-allowed' :
              status.chatBot
                ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30'
                : 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30'
            }`}
          >
            {status.chatBot ? '⏹ Stop Chat Bot' : '▶ Start Chat Bot'}
          </button>
        </div>
      </div>

      {/* Message View */}
      <div className="flex-1 flex flex-col bg-gray-950">
        {!selectedConv ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-gray-600">
              <MessageCircle className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Select a conversation to view messages</p>
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="px-4 py-3 border-b border-gray-800 bg-gray-900/50">
              <p className="text-sm font-medium text-gray-200">
                {conversations.find(c => c.id === selectedConv)?.fb_user_name || 'Chat'}
              </p>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-auto p-4 space-y-3">
              {messages.map((msg, i) => (
                <div key={i} className={`flex gap-2 ${msg.role === 'assistant' ? '' : 'flex-row-reverse'}`}>
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                    msg.role === 'assistant' ? 'bg-blue-500/20' : 'bg-gray-700'
                  }`}>
                    {msg.role === 'assistant' ? <Bot className="w-3.5 h-3.5 text-blue-400" /> : <User className="w-3.5 h-3.5 text-gray-400" />}
                  </div>
                  <div className={`max-w-[70%] px-3 py-2 rounded-xl text-sm ${
                    msg.role === 'assistant'
                      ? 'bg-blue-500/10 text-gray-200 rounded-tl-sm'
                      : 'bg-gray-800 text-gray-300 rounded-tr-sm'
                  }`}>
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                    <p className="text-[10px] text-gray-600 mt-1">
                      {new Date(msg.timestamp).toLocaleTimeString('th-TH')}
                    </p>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

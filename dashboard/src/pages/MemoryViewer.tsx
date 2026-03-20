import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { Brain, Archive, BookOpen, User, Trash2, ChevronRight, Search, RefreshCw } from 'lucide-react';

interface ChatSummary {
  chat_id: string;
  episodeCount: number;
  lastSeen: string;
}

interface CoreBlock {
  label: string;
  value: string;
}

interface MemoryMessage {
  role: string;
  content: string;
  timestamp?: number;
}

interface ArchivalItem {
  id: number;
  fact: string;
  created_at: string;
}

interface PaginatedArchival {
  items: ArchivalItem[];
  total: number;
  limit: number;
  offset: number;
}

interface MemoryData {
  chatId: string;
  stats: { workingCount: number; archivalCount: number; coreCount: number };
  core: { text: string; blocks: CoreBlock[] };
  working: MemoryMessage[];
  archival: PaginatedArchival | ArchivalItem[];
  episodeCount: number;
}

/** Normalize archival — handles both legacy array and new paginated format */
function normalizeArchival(archival: PaginatedArchival | ArchivalItem[]): PaginatedArchival {
  if (Array.isArray(archival)) {
    return { items: archival, total: archival.length, limit: archival.length, offset: 0 };
  }
  return archival;
}

/** Extract items from paginated or raw array response */
function extractItems<T>(data: any): T[] {
  if (Array.isArray(data)) return data;
  if (data?.items && Array.isArray(data.items)) return data.items;
  return [];
}

export function MemoryViewer() {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [selectedChat, setSelectedChat] = useState<string | null>(null);
  const [memory, setMemory] = useState<MemoryData | null>(null);
  const [activeTab, setActiveTab] = useState<'core' | 'working' | 'archival'>('core');
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    api.getMemoryChats().then((data) => setChats(extractItems(data))).catch((err) => {
      console.error('Failed to load memory chats:', err);
    });
  }, []);

  const loadMemory = async (chatId: string) => {
    setLoading(true);
    setSelectedChat(chatId);
    try {
      const data = await api.getMemory(chatId);
      setMemory(data);
    } catch (err) {
      console.error('Failed to load memory:', err);
      setMemory(null);
    }
    finally { setLoading(false); }
  };

  const handleDelete = async () => {
    if (!selectedChat || !confirm(`ลบ memory ทั้งหมดของ ${selectedChat}?`)) return;
    setDeleting(true);
    try {
      await api.clearMemory(selectedChat);
      setMemory(null);
      setSelectedChat(null);
      const updated = await api.getMemoryChats();
      setChats(extractItems(updated));
    } catch (err) {
      console.error('Failed to delete memory:', err);
      alert('ลบไม่สำเร็จ');
    }
    finally { setDeleting(false); }
  };

  const filteredChats = chats.filter(c =>
    c.chat_id.toLowerCase().includes(search.toLowerCase())
  );

  const fmtDate = (s: string) => {
    if (!s) return '—';
    try { return new Date(s).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch { return s; }
  };

  return (
    <div className="p-6 space-y-4">
      <div>
        <h2 className="text-2xl font-bold text-white flex items-center gap-2">
          <Brain className="w-6 h-6 text-green-400" /> Memory Viewer
        </h2>
        <p className="text-sm text-gray-500 mt-1">ดู/จัดการ 4-layer memory ของแต่ละ chat</p>
      </div>

      <div className="flex gap-6 h-[calc(100vh-200px)]">
        {/* Chat list */}
        <div className="w-60 shrink-0 bg-gray-900 rounded-xl border border-gray-800 flex flex-col">
          <div className="p-3 border-b border-gray-800">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                className="w-full bg-gray-800 text-sm text-gray-200 rounded-lg pl-8 pr-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                placeholder="ค้นหา chat..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
          </div>
          <div className="flex-1 overflow-auto p-2 space-y-1">
            {filteredChats.length === 0 && (
              <p className="text-gray-600 text-xs text-center py-8">ยังไม่มีข้อมูล memory</p>
            )}
            {filteredChats.map(chat => (
              <button
                key={chat.chat_id}
                onClick={() => loadMemory(chat.chat_id)}
                className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all ${
                  selectedChat === chat.chat_id
                    ? 'bg-blue-600/20 border border-blue-500/30 text-blue-300'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="truncate font-mono text-xs flex-1">{chat.chat_id}</span>
                  <ChevronRight className="w-3 h-3 shrink-0 text-gray-600" />
                </div>
                <div className="text-[10px] text-gray-600 mt-0.5">
                  {chat.episodeCount} episodes · {fmtDate(chat.lastSeen)}
                </div>
              </button>
            ))}
          </div>
          <div className="p-2 border-t border-gray-800">
            <button
              onClick={() => api.getMemoryChats().then((data) => setChats(extractItems(data)))}
              className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 py-1.5"
            >
              <RefreshCw className="w-3 h-3" /> Refresh
            </button>
          </div>
        </div>

        {/* Memory Detail */}
        <div className="flex-1 bg-gray-900 rounded-xl border border-gray-800 flex flex-col min-w-0">
          {!selectedChat ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center text-gray-600">
                <Brain className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p>เลือก chat เพื่อดู memory</p>
              </div>
            </div>
          ) : loading ? (
            <div className="flex-1 flex items-center justify-center">
              <RefreshCw className="w-6 h-6 text-gray-600 animate-spin" />
            </div>
          ) : !memory ? (
            <div className="flex-1 flex items-center justify-center text-gray-600">ไม่พบข้อมูล</div>
          ) : (
            <>
              {/* Header */}
              <div className="p-4 border-b border-gray-800 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-white font-mono">{memory.chatId}</h3>
                  <div className="flex gap-4 mt-1 text-xs text-gray-500">
                    <span>🧠 Core: {memory.core.blocks.length} blocks</span>
                    <span>💬 Working: {memory.working.length} msgs</span>
                    <span>📦 Archival: {normalizeArchival(memory.archival).total} facts</span>
                    <span>📝 Episodes: {memory.episodeCount}</span>
                  </div>
                </div>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 bg-red-900/20 hover:bg-red-900/30 border border-red-500/30 px-3 py-1.5 rounded-lg transition-all"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {deleting ? 'กำลังลบ...' : 'ลบทั้งหมด'}
                </button>
              </div>

              {/* Tabs */}
              <div className="flex gap-1 p-3 border-b border-gray-800">
                {([
                  { id: 'core', label: 'Core Memory', icon: User },
                  { id: 'working', label: 'Working Memory', icon: BookOpen },
                  { id: 'archival', label: 'Archival Facts', icon: Archive },
                ] as const).map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-all ${
                      activeTab === tab.id
                        ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                        : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
                    }`}
                  >
                    <tab.icon className="w-3.5 h-3.5" />
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Tab Content */}
              <div className="flex-1 overflow-auto p-4">
                {activeTab === 'core' && (
                  <div className="space-y-3">
                    {memory.core.blocks.length === 0 ? (
                      <p className="text-gray-600 text-sm text-center py-8">ยังไม่มี Core Memory</p>
                    ) : (
                      memory.core.blocks.map((block, i) => (
                        <div key={i} className="bg-gray-800/50 rounded-lg p-3 border border-gray-700/50">
                          <span className="text-xs font-semibold text-blue-400 uppercase tracking-wide">{block.label}</span>
                          <p className="text-sm text-gray-200 mt-1 whitespace-pre-wrap">{block.value}</p>
                        </div>
                      ))
                    )}
                    {memory.core.text && (
                      <div className="bg-gray-800/30 rounded-lg p-3 border border-gray-700/30">
                        <span className="text-xs text-gray-500">Raw Core Text</span>
                        <pre className="text-xs text-gray-400 mt-1 whitespace-pre-wrap font-mono">{memory.core.text}</pre>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'working' && (
                  <div className="space-y-2">
                    {memory.working.length === 0 ? (
                      <p className="text-gray-600 text-sm text-center py-8">ไม่มีข้อความใน Working Memory</p>
                    ) : (
                      memory.working.map((msg, i) => (
                        <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row' : 'flex-row-reverse'}`}>
                          <div className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${
                            msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-purple-600 text-white'
                          }`}>
                            {msg.role === 'user' ? 'U' : 'AI'}
                          </div>
                          <div className={`flex-1 max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                            msg.role === 'user'
                              ? 'bg-blue-900/20 border border-blue-700/20 text-blue-100'
                              : 'bg-gray-800 border border-gray-700 text-gray-200'
                          }`}>
                            <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {activeTab === 'archival' && (() => {
                  const arch = normalizeArchival(memory.archival);
                  return (
                    <div className="space-y-2">
                      {arch.items.length === 0 ? (
                        <p className="text-gray-600 text-sm text-center py-8">ยังไม่มี Archival Facts</p>
                      ) : (
                        <>
                          {arch.total > arch.items.length && (
                            <p className="text-xs text-gray-500 text-center">
                              แสดง {arch.items.length} จาก {arch.total} facts
                            </p>
                          )}
                          {arch.items.map((item) => (
                            <div key={item.id} className="flex gap-3 items-start bg-gray-800/40 rounded-lg p-3 border border-gray-700/40">
                              <Archive className="w-3.5 h-3.5 text-yellow-500 shrink-0 mt-0.5" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm text-gray-200">{item.fact}</p>
                                <p className="text-[10px] text-gray-600 mt-1">{fmtDate(item.created_at)}</p>
                              </div>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  );
                })()}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

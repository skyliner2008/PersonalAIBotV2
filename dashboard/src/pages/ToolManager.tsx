import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { Wrench, Search, Shield, AlertTriangle, Zap, Filter } from 'lucide-react';

interface ToolMeta {
  name: string;
  displayName: string;
  description: string;
  category: string;
  riskLevel: string;
  platforms: string[];
  tags: string[];
  enabledByDefault: boolean;
}

interface CategoryInfo {
  category: string;
  count: number;
}

const categoryIcons: Record<string, string> = {
  utility: '🔧',
  os: '💻',
  file: '📁',
  browser: '🌐',
  web: '🔍',
  memory: '🧠',
  communication: '💬',
  system: '🛠️',
};

const categoryLabels: Record<string, string> = {
  utility: 'Utility',
  os: 'OS Control',
  file: 'File Operations',
  browser: 'Browser',
  web: 'Web & Search',
  memory: 'Memory',
  communication: 'Communication',
  system: 'System / Management',
};

const riskBadge: Record<string, { bg: string; text: string; icon: any }> = {
  low: { bg: 'bg-green-900/40 border-green-800', text: 'text-green-400', icon: Zap },
  medium: { bg: 'bg-yellow-900/40 border-yellow-800', text: 'text-yellow-400', icon: AlertTriangle },
  high: { bg: 'bg-red-900/40 border-red-800', text: 'text-red-400', icon: Shield },
};

export function ToolManager() {
  const [tools, setTools] = useState<ToolMeta[]>([]);
  const [categories, setCategories] = useState<CategoryInfo[]>([]);
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterRisk, setFilterRisk] = useState<string>('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [t, c] = await Promise.all([
        api.getTools(),
        api.getToolCategories(),
      ]);
      setTools(t);
      setCategories(c);
    } catch (err) {
      console.error('Failed to load tools:', err);
    }
    setLoading(false);
  };

  const filtered = tools.filter(t => {
    if (filterCategory !== 'all' && t.category !== filterCategory) return false;
    if (filterRisk !== 'all' && t.riskLevel !== filterRisk) return false;
    if (search) {
      const q = search.toLowerCase();
      return t.name.includes(q) || t.displayName.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) || t.tags.some(tag => tag.includes(q));
    }
    return true;
  });

  const groupedByCategory = filtered.reduce<Record<string, ToolMeta[]>>((acc, t) => {
    if (!acc[t.category]) acc[t.category] = [];
    acc[t.category].push(t);
    return acc;
  }, {});

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <div className="text-gray-400 animate-pulse">Loading tools...</div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <Wrench className="w-6 h-6 text-purple-400" />
          Tool Manager
        </h1>
        <p className="text-sm text-gray-500 mt-1">เรียกดูและจัดการ Tools/Skills ทั้งหมดที่ Agent สามารถใช้ได้</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-center">
          <div className="text-2xl font-bold text-white">{tools.length}</div>
          <div className="text-xs text-gray-500">Total Tools</div>
        </div>
        {Object.entries(riskBadge).map(([level, style]) => {
          const count = tools.filter(t => t.riskLevel === level).length;
          return (
            <div key={level} className={`border rounded-xl p-3 text-center ${style.bg}`}>
              <div className={`text-2xl font-bold ${style.text}`}>{count}</div>
              <div className="text-xs text-gray-500 capitalize">{level} Risk</div>
            </div>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex gap-3 items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            className="w-full bg-gray-900 text-white pl-9 pr-3 py-2 rounded-lg text-sm border border-gray-700 focus:border-blue-500 outline-none"
            placeholder="ค้นหา tool..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select
          className="bg-gray-900 text-white px-3 py-2 rounded-lg text-sm border border-gray-700 outline-none"
          value={filterCategory}
          onChange={e => setFilterCategory(e.target.value)}
        >
          <option value="all">All Categories</option>
          {categories.map(c => (
            <option key={c.category} value={c.category}>
              {categoryLabels[c.category] || c.category} ({c.count})
            </option>
          ))}
        </select>
        <select
          className="bg-gray-900 text-white px-3 py-2 rounded-lg text-sm border border-gray-700 outline-none"
          value={filterRisk}
          onChange={e => setFilterRisk(e.target.value)}
        >
          <option value="all">All Risk Levels</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>

      {/* Tools grouped by category */}
      {Object.entries(groupedByCategory).map(([category, categoryTools]) => (
        <div key={category}>
          <h2 className="text-sm font-medium text-gray-400 mb-2 flex items-center gap-2">
            <span>{categoryIcons[category] || '📦'}</span>
            {categoryLabels[category] || category}
            <span className="text-gray-600">({categoryTools.length})</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {categoryTools.map(tool => {
              const risk = riskBadge[tool.riskLevel] || riskBadge.low;
              const RiskIcon = risk.icon;
              return (
                <div key={tool.name} className="bg-gray-900 border border-gray-800 rounded-lg p-3 hover:border-gray-700 transition-colors">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-white text-sm font-medium">{tool.displayName}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] border ${risk.bg} ${risk.text}`}>
                          <RiskIcon className="w-2.5 h-2.5 inline mr-0.5" />
                          {tool.riskLevel}
                        </span>
                        {tool.enabledByDefault && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-blue-900/40 text-blue-400 border border-blue-800">
                            default
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-1">{tool.description}</p>
                      <div className="flex flex-wrap gap-1 mt-2">
                        {tool.tags.map(tag => (
                          <span key={tag} className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-500 text-[10px]">
                            #{tag}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="text-[10px] text-gray-600 text-right whitespace-nowrap">
                      {tool.platforms.includes('all') ? 'All' : tool.platforms.join(', ')}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {filtered.length === 0 && (
        <div className="text-center py-16 text-gray-500">
          <Filter className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>ไม่พบ tool ที่ตรงกับตัวกรอง</p>
        </div>
      )}
    </div>
  );
}

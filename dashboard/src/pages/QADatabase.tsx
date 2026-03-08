import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { Database, Plus, Save, Trash2, Pencil, ToggleLeft, ToggleRight, Search, HelpCircle } from 'lucide-react';

export function QADatabase() {
  const [pairs, setPairs] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [search, setSearch] = useState('');
  const [testQuestion, setTestQuestion] = useState('');
  const [testResult, setTestResult] = useState<any | null>(null);

  const emptyForm = {
    question_pattern: '',
    answer: '',
    match_type: 'contains',
    category: '',
    priority: 0,
    is_active: true,
  };

  useEffect(() => { loadPairs(); }, []);

  async function loadPairs() {
    try {
      const data = await api.getQAPairs();
      setPairs(data);
    } catch {}
  }

  function startEdit(qa: any) {
    setEditing({ ...qa });
    setShowForm(true);
  }

  function startCreate() {
    setEditing({ ...emptyForm, id: null });
    setShowForm(true);
  }

  async function handleSave() {
    if (!editing) return;
    try {
      if (editing.id) {
        await api.updateQAPair(editing.id, editing);
      } else {
        await api.createQAPair(editing);
      }
      setShowForm(false);
      setEditing(null);
      loadPairs();
    } catch {}
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this Q&A pair?')) return;
    try {
      await api.deleteQAPair(id);
      loadPairs();
    } catch {}
  }

  async function handleToggle(id: number, current: boolean) {
    try {
      await api.updateQAPair(id, { is_active: !current });
      loadPairs();
    } catch {}
  }

  async function handleTest() {
    if (!testQuestion.trim()) return;
    try {
      const result = await api.testQA(testQuestion);
      setTestResult(result);
    } catch {
      setTestResult({ match: false });
    }
  }

  const filtered = pairs.filter(qa =>
    !search ||
    qa.question_pattern.toLowerCase().includes(search.toLowerCase()) ||
    qa.answer.toLowerCase().includes(search.toLowerCase()) ||
    qa.category?.toLowerCase().includes(search.toLowerCase())
  );

  const matchTypeLabels: Record<string, { label: string; color: string }> = {
    exact: { label: 'Exact', color: 'text-green-400 bg-green-400/10' },
    contains: { label: 'Contains', color: 'text-blue-400 bg-blue-400/10' },
    regex: { label: 'Regex', color: 'text-purple-400 bg-purple-400/10' },
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-white">Q&A Database</h2>
        <button
          onClick={startCreate}
          className="flex items-center gap-2 px-4 py-2 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 text-sm font-medium border border-blue-500/30"
        >
          <Plus className="w-4 h-4" /> Add Q&A
        </button>
      </div>

      {/* Test Section */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <p className="text-xs font-medium text-gray-400 mb-2 flex items-center gap-1">
          <HelpCircle className="w-3.5 h-3.5" /> Test Q&A Match
        </p>
        <div className="flex gap-2">
          <input
            value={testQuestion}
            onChange={e => setTestQuestion(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleTest()}
            placeholder="Type a question to test matching..."
            className="flex-1 px-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={handleTest}
            className="px-4 py-1.5 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 text-xs font-medium border border-blue-500/30"
          >
            Test
          </button>
        </div>
        {testResult && (
          <div className={`mt-2 p-2 rounded-lg text-xs ${testResult.match ? 'bg-green-500/10 text-green-400' : 'bg-gray-800 text-gray-500'}`}>
            {testResult.match
              ? `✅ Matched: "${testResult.answer?.substring(0, 100)}..." (${testResult.match_type}, priority: ${testResult.priority})`
              : '❌ No match found — AI will handle this question'
            }
          </div>
        )}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search Q&A pairs..."
          className="w-full pl-10 pr-4 py-2 text-sm bg-gray-900 border border-gray-800 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
        />
      </div>

      {/* Edit Form */}
      {showForm && editing && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-gray-300">
            {editing.id ? 'Edit Q&A Pair' : 'Create Q&A Pair'}
          </h3>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div>
              <label className="text-[10px] text-gray-500 uppercase mb-1 block">Match Type</label>
              <select
                value={editing.match_type}
                onChange={e => setEditing({ ...editing, match_type: e.target.value })}
                className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-200"
              >
                <option value="exact">Exact Match</option>
                <option value="contains">Contains</option>
                <option value="regex">Regex</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] text-gray-500 uppercase mb-1 block">Category</label>
              <input
                value={editing.category || ''}
                onChange={e => setEditing({ ...editing, category: e.target.value })}
                placeholder="e.g. pricing, shipping, hours"
                className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 uppercase mb-1 block">Priority</label>
              <input
                type="number"
                value={editing.priority}
                onChange={e => setEditing({ ...editing, priority: parseInt(e.target.value) || 0 })}
                className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">
              Question Pattern
              {editing.match_type === 'exact' && ' (must match exactly)'}
              {editing.match_type === 'contains' && ' (keyword to search for)'}
              {editing.match_type === 'regex' && ' (regular expression)'}
            </label>
            <input
              value={editing.question_pattern}
              onChange={e => setEditing({ ...editing, question_pattern: e.target.value })}
              placeholder={
                editing.match_type === 'exact' ? 'ราคาเท่าไหร่' :
                editing.match_type === 'contains' ? 'ราคา' :
                '(ราคา|price|cost)'
              }
              className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 font-mono"
            />
          </div>

          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Answer</label>
            <textarea
              value={editing.answer}
              onChange={e => setEditing({ ...editing, answer: e.target.value })}
              placeholder="The reply to send when this pattern matches"
              rows={4}
              className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 resize-none"
            />
          </div>

          <div className="flex gap-2 justify-end">
            <button onClick={() => { setShowForm(false); setEditing(null); }} className="px-4 py-1.5 text-xs text-gray-400 hover:text-gray-200">Cancel</button>
            <button
              onClick={handleSave}
              disabled={!editing.question_pattern || !editing.answer}
              className="px-4 py-1.5 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 text-xs font-medium border border-blue-500/30 disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5 inline mr-1" /> Save
            </button>
          </div>
        </div>
      )}

      {/* Q&A List */}
      <div className="space-y-2">
        {filtered.length === 0 && (
          <div className="text-center py-12 text-gray-600">
            <Database className="w-10 h-10 mx-auto mb-2 opacity-30" />
            <p className="text-sm">No Q&A pairs yet</p>
          </div>
        )}
        {filtered.map(qa => (
          <div
            key={qa.id}
            className={`bg-gray-900 rounded-lg border border-gray-800 p-3 ${!qa.is_active ? 'opacity-50' : ''}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${matchTypeLabels[qa.match_type]?.color}`}>
                    {matchTypeLabels[qa.match_type]?.label}
                  </span>
                  {qa.category && <span className="text-[10px] text-gray-500">{qa.category}</span>}
                  <span className="text-[10px] text-gray-600">P:{qa.priority}</span>
                </div>
                <p className="text-xs text-gray-300 font-mono mb-1">Q: {qa.question_pattern}</p>
                <p className="text-xs text-gray-400 line-clamp-2">A: {qa.answer}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => handleToggle(qa.id, qa.is_active)} className="p-1.5 text-gray-600 hover:text-gray-300">
                  {qa.is_active ? <ToggleRight className="w-4 h-4 text-green-400" /> : <ToggleLeft className="w-4 h-4" />}
                </button>
                <button onClick={() => startEdit(qa)} className="p-1.5 text-gray-600 hover:text-blue-400">
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => handleDelete(qa.id)} className="p-1.5 text-gray-600 hover:text-red-400">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <p className="text-[10px] text-gray-600 text-center">
        Q&A pairs are checked before AI — if a match is found, the predefined answer is used instead of calling AI.
        Priority: Exact → Contains → Regex. Higher priority number wins within each type.
      </p>
    </div>
  );
}

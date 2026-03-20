import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { UserCircle, Plus, Save, Trash2, Star, Pencil } from 'lucide-react';

export function PersonaEditor() {
  const [personas, setPersonas] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [showForm, setShowForm] = useState(false);

  const emptyForm = {
    name: '',
    description: '',
    system_prompt: '',
    personality_traits: ['friendly', 'helpful'],
    speaking_style: 'casual-thai',
    temperature: 0.7,
  };

  useEffect(() => { loadPersonas(); }, []);

  async function loadPersonas() {
    try {
      const data = await api.getPersonas();
      setPersonas(data);
    } catch {}
  }

  function startEdit(persona: any) {
    let traits = persona.personality_traits;
    if (typeof traits === 'string') {
      try {
        traits = JSON.parse(traits);
      } catch (err) {
        console.error('Failed to parse personality_traits:', err);
        traits = [];
      }
    }
    setEditing({
      ...persona,
      personality_traits: Array.isArray(traits) ? traits : [],
    });
    setShowForm(true);
  }

  function startCreate() {
    setEditing({ ...emptyForm, id: null });
    setShowForm(true);
  }

  async function handleSave() {
    if (!editing) return;
    try {
      const payload = {
        name: editing.name,
        description: editing.description,
        system_prompt: editing.system_prompt,
        personality_traits: editing.personality_traits,
        speaking_style: editing.speaking_style,
        temperature: editing.temperature,
      };

      if (editing.id) {
        await api.updatePersona(editing.id, payload);
      } else {
        await api.createPersona(payload);
      }
      setShowForm(false);
      setEditing(null);
      loadPersonas();
    } catch {}
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this persona?')) return;
    try {
      await api.deletePersona(id);
      loadPersonas();
    } catch {}
  }

  async function handleSetDefault(id: string) {
    try {
      await api.setDefaultPersona(id);
      loadPersonas();
    } catch {}
  }

  const traitOptions = [
    'friendly', 'helpful', 'professional', 'funny', 'sarcastic', 'caring',
    'enthusiastic', 'calm', 'witty', 'formal', 'casual', 'empathetic',
    'confident', 'humble', 'creative', 'analytical',
  ];

  const styleOptions = [
    { value: 'casual-thai', label: 'ภาษาไทยเป็นกันเอง' },
    { value: 'formal-thai', label: 'ภาษาไทยสุภาพ' },
    { value: 'casual-english', label: 'Casual English' },
    { value: 'formal-english', label: 'Formal English' },
    { value: 'mixed', label: 'Thai + English Mix' },
    { value: 'gen-z', label: 'Gen Z / Slang' },
  ];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-white">Persona</h2>
        <button
          onClick={startCreate}
          className="flex items-center gap-2 px-4 py-2 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 text-sm font-medium border border-blue-500/30"
        >
          <Plus className="w-4 h-4" /> New Persona
        </button>
      </div>

      {/* Edit Form */}
      {showForm && editing && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-gray-300">
            {editing.id ? 'Edit Persona' : 'Create Persona'}
          </h3>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <label className="text-[10px] text-gray-500 uppercase mb-1 block">Name</label>
              <input
                value={editing.name}
                onChange={e => setEditing({ ...editing, name: e.target.value })}
                placeholder="e.g. แอดมินเพจ, พี่หมี, Customer Support"
                className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 uppercase mb-1 block">Speaking Style</label>
              <select
                value={editing.speaking_style}
                onChange={e => setEditing({ ...editing, speaking_style: e.target.value })}
                className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-200"
              >
                {styleOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">Description</label>
            <input
              value={editing.description}
              onChange={e => setEditing({ ...editing, description: e.target.value })}
              placeholder="Short description of this persona"
              className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">System Prompt</label>
            <textarea
              value={editing.system_prompt}
              onChange={e => setEditing({ ...editing, system_prompt: e.target.value })}
              placeholder="Instructions for the AI persona..."
              rows={6}
              className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 resize-none font-mono"
            />
          </div>

          {/* Personality Traits */}
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-2 block">Personality Traits</label>
            <div className="flex flex-wrap gap-2">
              {traitOptions.map(trait => {
                const active = editing.personality_traits?.includes(trait);
                return (
                  <button
                    key={trait}
                    onClick={() => {
                      const traits = active
                        ? editing.personality_traits.filter((t: string) => t !== trait)
                        : [...(editing.personality_traits || []), trait];
                      setEditing({ ...editing, personality_traits: traits });
                    }}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium transition ${
                      active
                        ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                        : 'bg-gray-800 text-gray-500 border border-gray-700 hover:text-gray-300'
                    }`}
                  >
                    {trait}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Temperature */}
          <div>
            <label className="text-[10px] text-gray-500 uppercase mb-1 block">
              Temperature: {editing.temperature}
            </label>
            <input
              type="range"
              min="0"
              max="1.5"
              step="0.1"
              value={editing.temperature}
              onChange={e => setEditing({ ...editing, temperature: parseFloat(e.target.value) })}
              className="w-full accent-blue-500"
            />
            <div className="flex justify-between text-[10px] text-gray-600">
              <span>Precise (0)</span>
              <span>Creative (1.5)</span>
            </div>
          </div>

          <div className="flex gap-2 justify-end">
            <button onClick={() => { setShowForm(false); setEditing(null); }} className="px-4 py-1.5 text-xs text-gray-400 hover:text-gray-200">Cancel</button>
            <button
              onClick={handleSave}
              disabled={!editing.name || !editing.system_prompt}
              className="px-4 py-1.5 bg-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/30 text-xs font-medium border border-blue-500/30 disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5 inline mr-1" /> Save
            </button>
          </div>
        </div>
      )}

      {/* Persona Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {personas.map(persona => {
          let traits: string[] = [];
          if (typeof persona.personality_traits === 'string') {
            try {
              traits = JSON.parse(persona.personality_traits);
            } catch (err) {
              console.error('Failed to parse personality_traits:', err);
              traits = [];
            }
          } else if (Array.isArray(persona.personality_traits)) {
            traits = persona.personality_traits;
          }
          return (
            <div
              key={persona.id}
              className={`bg-gray-900 rounded-xl border p-4 ${
                persona.is_default ? 'border-blue-500/50' : 'border-gray-800'
              }`}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-10 h-10 rounded-full bg-gray-800 flex items-center justify-center">
                    <UserCircle className="w-6 h-6 text-gray-400" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-200 flex items-center gap-1">
                      {persona.name}
                      {persona.is_default && <Star className="w-3 h-3 text-yellow-400 fill-yellow-400" />}
                    </p>
                    <p className="text-[10px] text-gray-500">{persona.speaking_style}</p>
                  </div>
                </div>
                <div className="flex gap-1">
                  {!persona.is_default && (
                    <button
                      onClick={() => handleSetDefault(persona.id)}
                      title="Set as default"
                      className="p-1.5 text-gray-600 hover:text-yellow-400"
                    >
                      <Star className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button onClick={() => startEdit(persona)} className="p-1.5 text-gray-600 hover:text-blue-400">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  {!persona.is_default && (
                    <button onClick={() => handleDelete(persona.id)} className="p-1.5 text-gray-600 hover:text-red-400">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <p className="text-xs text-gray-400 mb-2 line-clamp-2">{persona.description}</p>
              <div className="flex flex-wrap gap-1">
                {traits.slice(0, 4).map((t: string) => (
                  <span key={t} className="px-2 py-0.5 rounded-full text-[10px] bg-gray-800 text-gray-400">
                    {t}
                  </span>
                ))}
                {traits.length > 4 && (
                  <span className="px-2 py-0.5 text-[10px] text-gray-500">+{traits.length - 4}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

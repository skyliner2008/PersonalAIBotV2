import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import {
  Target, Plus, ChevronDown, ChevronRight, CheckCircle2, Circle, X, BarChart3
} from 'lucide-react';

interface SubGoal {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
}

interface Goal {
  id: string;
  chatId: string;
  title: string;
  description?: string;
  priority: number;
  progress: number;
  status: 'active' | 'completed' | 'failed';
  subGoals: SubGoal[];
  createdAt: string;
  updatedAt: string;
}

interface GoalsResponse {
  success?: boolean;
  goals?: Goal[];
  stats?: {
    active?: number;
    completed?: number;
    total?: number;
    avgProgress?: number;
  };
}

type StatusTab = 'all' | 'active' | 'completed' | 'failed';

export function GoalTracker() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [stats, setStats] = useState<GoalsResponse['stats'] | null>(null);
  const [statusTab, setStatusTab] = useState<StatusTab>('all');
  const [expandedGoals, setExpandedGoals] = useState<Set<string>>(new Set());
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    priority: 3,
    subGoals: [''],
  });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const chatId = 'system';

  const fetchGoals = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.getGoals?.(chatId).catch(() => ({ goals: [], stats: null }));

      // Handle response format: { success, goals, stats }
      const goalsArray = data?.goals || (Array.isArray(data) ? data : []);
      setGoals(Array.isArray(goalsArray) ? goalsArray : []);

      // Use stats from response if available
      if (data?.stats) {
        setStats(data.stats);
      } else {
        // Compute stats locally as fallback
        const activeCount = goalsArray.filter((g: Goal) => g.status === 'active').length;
        const completedCount = goalsArray.filter((g: Goal) => g.status === 'completed').length;
        const avgProg = goalsArray.length > 0
          ? Math.round((goalsArray.reduce((sum: number, g: Goal) => sum + g.progress, 0) / goalsArray.length) * 10) / 10
          : 0;
        setStats({
          active: activeCount,
          completed: completedCount,
          total: goalsArray.length,
          avgProgress: avgProg,
        });
      }
    } catch (err) {
      console.error('Failed to fetch goals:', err);
      setGoals([]);
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGoals();
    const interval = setInterval(fetchGoals, 30000);
    return () => clearInterval(interval);
  }, [fetchGoals]);

  const filteredGoals = goals.filter(g => {
    if (statusTab === 'all') return true;
    return g.status === statusTab;
  });

  const toggleGoalExpand = (goalId: string) => {
    const newSet = new Set(expandedGoals);
    if (newSet.has(goalId)) {
      newSet.delete(goalId);
    } else {
      newSet.add(goalId);
    }
    setExpandedGoals(newSet);
  };

  const handleAddSubGoal = () => {
    setFormData(prev => ({
      ...prev,
      subGoals: [...prev.subGoals, ''],
    }));
  };

  const handleRemoveSubGoal = (index: number) => {
    setFormData(prev => ({
      ...prev,
      subGoals: prev.subGoals.filter((_, i) => i !== index),
    }));
  };

  const handleCreateGoal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.title.trim()) return;

    try {
      setSubmitting(true);
      const subGoals = formData.subGoals
        .map(sg => sg.trim())
        .filter(sg => sg)
        .map(title => ({ title }));

      await api.createGoal?.({
        chatId,
        title: formData.title,
        description: formData.description,
        priority: formData.priority,
        subGoals,
      });

      setFormData({
        title: '',
        description: '',
        priority: 3,
        subGoals: [''],
      });
      setShowCreateForm(false);
      fetchGoals();
    } catch (err) {
      console.error('Failed to create goal:', err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdateSubGoal = async (goalId: string, subGoalId: string, status: string) => {
    try {
      await api.updateSubGoal?.({
        goalId,
        subGoalId,
        status,
      });
      fetchGoals();
    } catch (err) {
      console.error('Failed to update sub-goal:', err);
    }
  };

  const handleDeleteGoal = async (goalId: string) => {
    try {
      await api.deleteGoal?.(goalId);
      fetchGoals();
    } catch (err) {
      console.error('Failed to delete goal:', err);
    }
  };

  const getProgressColor = (progress: number) => {
    if (progress < 30) return 'bg-red-600';
    if (progress < 70) return 'bg-amber-600';
    return 'bg-green-600';
  };

  const renderStars = (priority: number) => {
    return (
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map(i => (
          <span
            key={i}
            className={i <= priority ? 'text-amber-400' : 'text-gray-600'}
          >
            ★
          </span>
        ))}
      </div>
    );
  };

  if (loading && goals.length === 0) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Target className="w-6 h-6" />
            Goal Tracker
          </h1>
        </div>
        <div className="text-gray-400">Loading goals...</div>
      </div>
    );
  }

  const displayStats = stats || {
    active: goals.filter(g => g.status === 'active').length,
    completed: goals.filter(g => g.status === 'completed').length,
    total: goals.length,
    avgProgress: goals.length > 0
      ? Math.round((goals.reduce((sum, g) => sum + g.progress, 0) / goals.length) * 10) / 10
      : 0,
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Target className="w-6 h-6" />
          Goal Tracker
        </h1>
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          New Goal
        </button>
      </div>

      {/* Stats Bar */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <div className="text-gray-400 text-sm mb-2">Active Goals</div>
          <div className="text-3xl font-bold text-white">{displayStats.active ?? 0}</div>
        </div>
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <div className="text-gray-400 text-sm mb-2">Completed</div>
          <div className="text-3xl font-bold text-green-400">{displayStats.completed ?? 0}</div>
        </div>
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <div className="text-gray-400 text-sm mb-2">Average Progress</div>
          <div className="text-3xl font-bold text-blue-400">{displayStats.avgProgress ?? 0}%</div>
        </div>
      </div>

      {/* Create Goal Form */}
      {showCreateForm && (
        <div className="bg-gray-900 rounded-lg p-6 border border-blue-700 mb-6">
          <h2 className="text-lg font-semibold text-white mb-4">Create New Goal</h2>
          <form onSubmit={handleCreateGoal} className="space-y-4">
            <div>
              <label className="block text-sm text-gray-300 mb-2">Goal Title</label>
              <input
                type="text"
                value={formData.title}
                onChange={e => setFormData(prev => ({ ...prev, title: e.target.value }))}
                placeholder="Enter goal title..."
                className="w-full px-3 py-2 rounded-lg bg-gray-800 text-white border border-gray-700 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-300 mb-2">Description</label>
              <textarea
                value={formData.description}
                onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                placeholder="Enter goal description..."
                className="w-full px-3 py-2 rounded-lg bg-gray-800 text-white border border-gray-700 placeholder-gray-500 focus:border-blue-500 focus:outline-none h-20"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-300 mb-2">
                Priority (1-5): {renderStars(formData.priority)}
              </label>
              <input
                type="range"
                min="1"
                max="5"
                value={formData.priority}
                onChange={e => setFormData(prev => ({ ...prev, priority: parseInt(e.target.value) }))}
                className="w-full"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-300 mb-2">Sub-Goals</label>
              <div className="space-y-2">
                {formData.subGoals.map((subGoal, idx) => (
                  <div key={idx} className="flex gap-2">
                    <input
                      type="text"
                      value={subGoal}
                      onChange={e => {
                        const newSubGoals = [...formData.subGoals];
                        newSubGoals[idx] = e.target.value;
                        setFormData(prev => ({ ...prev, subGoals: newSubGoals }));
                      }}
                      placeholder={`Sub-goal ${idx + 1}...`}
                      className="flex-1 px-3 py-2 rounded-lg bg-gray-800 text-white border border-gray-700 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
                    />
                    {formData.subGoals.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveSubGoal(idx)}
                        className="px-3 py-2 rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600/40 transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={handleAddSubGoal}
                className="mt-2 px-3 py-2 rounded-lg bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors text-sm flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                Add Sub-Goal
              </button>
            </div>

            <div className="flex gap-2 pt-4">
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
              >
                {submitting ? 'Creating...' : 'Create Goal'}
              </button>
              <button
                type="button"
                onClick={() => setShowCreateForm(false)}
                className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Status Tabs */}
      <div className="flex gap-2 mb-6 border-b border-gray-800">
        {(['all', 'active', 'completed', 'failed'] as StatusTab[]).map(tab => (
          <button
            key={tab}
            onClick={() => setStatusTab(tab)}
            className={`px-4 py-2 font-medium border-b-2 transition-colors ${
              statusTab === tab
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-400 hover:text-gray-300'
            }`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Goals List */}
      {filteredGoals.length === 0 ? (
        <div className="bg-gray-900 rounded-lg p-8 text-center border border-gray-800">
          <Target className="w-12 h-12 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400 mb-3">No goals yet</p>
          <button
            onClick={() => setShowCreateForm(true)}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors inline-flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Create Your First Goal
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredGoals.map(goal => {
            const isExpanded = expandedGoals.has(goal.id);
            const completedSubGoals = goal.subGoals.filter(sg => sg.status === 'completed').length;

            return (
              <div key={goal.id} className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
                <button
                  onClick={() => toggleGoalExpand(goal.id)}
                  className="w-full p-4 flex items-start gap-3 hover:bg-gray-800/50 transition-colors text-left"
                >
                  <div className="mt-1">
                    {isExpanded ? (
                      <ChevronDown className="w-5 h-5 text-gray-400" />
                    ) : (
                      <ChevronRight className="w-5 h-5 text-gray-400" />
                    )}
                  </div>

                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-lg font-semibold text-white">{goal.title}</h3>
                      {renderStars(goal.priority)}
                    </div>

                    {goal.description && (
                      <p className="text-sm text-gray-400 mb-3">{goal.description}</p>
                    )}

                    <div className="flex items-center gap-3">
                      <div className="flex-1 max-w-xs h-2 bg-gray-800 rounded">
                        <div
                          className={`h-full rounded transition-all ${getProgressColor(goal.progress)}`}
                          style={{ width: `${Math.min(goal.progress, 100)}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-400">{goal.progress}%</span>
                    </div>

                    {goal.subGoals.length > 0 && (
                      <div className="text-xs text-gray-500 mt-2">
                        {completedSubGoals}/{goal.subGoals.length} sub-goals completed
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <span
                      className={`px-3 py-1 rounded text-xs font-medium ${
                        goal.status === 'active'
                          ? 'bg-blue-700 text-blue-100'
                          : goal.status === 'completed'
                            ? 'bg-green-700 text-green-100'
                            : 'bg-red-700 text-red-100'
                      }`}
                    >
                      {goal.status}
                    </span>
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-gray-800 px-4 py-4 bg-gray-800/30">
                    {goal.subGoals.length > 0 && (
                      <div className="mb-4">
                        <h4 className="text-sm font-semibold text-gray-300 mb-3">Sub-Goals</h4>
                        <div className="space-y-2">
                          {goal.subGoals.map(subGoal => (
                            <div
                              key={subGoal.id}
                              className="flex items-center gap-3 p-2 rounded hover:bg-gray-800/50 transition-colors"
                            >
                              <button
                                onClick={() => {
                                  const newStatus =
                                    subGoal.status === 'completed' ? 'pending' : 'completed';
                                  handleUpdateSubGoal(goal.id, subGoal.id, newStatus);
                                }}
                                className="flex-shrink-0 transition-colors"
                              >
                                {subGoal.status === 'completed' ? (
                                  <CheckCircle2 className="w-5 h-5 text-green-400" />
                                ) : (
                                  <Circle className="w-5 h-5 text-gray-600 hover:text-gray-400" />
                                )}
                              </button>
                              <span
                                className={`flex-1 text-sm ${
                                  subGoal.status === 'completed'
                                    ? 'text-gray-500 line-through'
                                    : 'text-gray-300'
                                }`}
                              >
                                {subGoal.title}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="flex gap-2 pt-4 border-t border-gray-700">
                      <button
                        onClick={() => handleDeleteGoal(goal.id)}
                        className="px-3 py-2 rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600/40 transition-colors text-sm flex items-center gap-2"
                      >
                        <X className="w-4 h-4" />
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

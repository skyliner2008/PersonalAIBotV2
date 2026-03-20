import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import {
  ListTodo, Clock, AlertTriangle, CheckCircle, XCircle, Filter, RefreshCw, Loader2,
  ChevronDown, ChevronRight
} from 'lucide-react';

interface Task {
  id: string;
  title?: string;
  batchId?: string;
  specialist: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  type?: string;
  priority?: number;
  result?: any;
  error?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

interface Batch {
  id: string;
  objective: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  assignments?: any[];
  progress?: {
    total?: number;
    queued?: number;
    processing?: number;
    completed?: number;
    failed?: number;
  };
  createdAt?: string;
  completedAt?: string;
}

type StatusFilter = 'all' | 'pending' | 'processing' | 'completed' | 'failed';

export function TaskQueueMonitor() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [specialistFilter, setSpecialistFilter] = useState<string>('all');
  const [expandedBatches, setExpandedBatches] = useState<Set<string>>(new Set());
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [specialists, setSpecialists] = useState<string[]>([]);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [tasksData, batchesData, specialistsData] = await Promise.all([
        api.getSwarmTasks?.().catch(() => ({})),
        api.getSwarmBatches?.().catch(() => ({})),
        api.getSwarmSpecialists?.().catch(() => ({ specialists: [] })),
      ]);

      // Extract tasks from response
      const tasksArray = tasksData?.tasks || tasksData || [];
      setTasks(Array.isArray(tasksArray) ? tasksArray : []);

      // Extract batches from response
      const batchesArray = batchesData?.batches || batchesData || [];
      setBatches(Array.isArray(batchesArray) ? batchesArray : []);

      // Extract and process specialists
      const specs = specialistsData?.specialists || [];
      setSpecialists(
        specs
          .map((s: any) => s.name || s.id)
          .filter((n: string) => n)
          .sort()
      );
    } catch (err) {
      console.error('Failed to fetch task data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const filteredTasks = tasks.filter(t => {
    if (statusFilter !== 'all' && t.status !== statusFilter) return false;
    if (specialistFilter !== 'all' && t.specialist !== specialistFilter) return false;
    return true;
  });

  const taskStats = {
    total: tasks.length,
    pending: tasks.filter(t => t.status === 'pending').length,
    processing: tasks.filter(t => t.status === 'processing').length,
    completed: tasks.filter(t => t.status === 'completed').length,
    failed: tasks.filter(t => t.status === 'failed').length,
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending':
        return 'bg-gray-700 text-gray-200';
      case 'processing':
        return 'bg-blue-700 text-blue-100 animate-pulse';
      case 'completed':
        return 'bg-green-700 text-green-100';
      case 'failed':
        return 'bg-red-700 text-red-100';
      default:
        return 'bg-gray-700 text-gray-200';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'pending':
        return Clock;
      case 'processing':
        return Loader2;
      case 'completed':
        return CheckCircle;
      case 'failed':
        return XCircle;
      default:
        return Clock;
    }
  };

  const getBatchProgress = (batch: Batch) => {
    const total = batch.progress?.total ?? 0;
    const completed = batch.progress?.completed ?? 0;
    return total > 0 ? (completed / total) * 100 : 0;
  };

  const toggleBatchExpand = (batchId: string) => {
    const newSet = new Set(expandedBatches);
    if (newSet.has(batchId)) {
      newSet.delete(batchId);
    } else {
      newSet.add(batchId);
    }
    setExpandedBatches(newSet);
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return 'N/A';
    try {
      return new Date(dateStr).toLocaleString();
    } catch {
      return dateStr;
    }
  };

  if (loading && tasks.length === 0) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <ListTodo className="w-6 h-6" />
            Task Queue Monitor
          </h1>
          <button
            disabled
            className="px-4 py-2 rounded-lg bg-blue-600/20 text-blue-400 disabled:opacity-50"
          >
            Loading...
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <ListTodo className="w-6 h-6" />
          Task Queue Monitor
        </h1>
        <button
          onClick={fetchData}
          className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors flex items-center gap-2"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
          <div className="text-xs text-gray-400">Total</div>
          <div className="text-2xl font-bold text-white">{taskStats.total}</div>
        </div>
        <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
          <div className="text-xs text-gray-400">Pending</div>
          <div className="text-2xl font-bold text-gray-300">{taskStats.pending}</div>
        </div>
        <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
          <div className="text-xs text-gray-400">Processing</div>
          <div className="text-2xl font-bold text-blue-400 animate-pulse">{taskStats.processing}</div>
        </div>
        <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
          <div className="text-xs text-gray-400">Completed</div>
          <div className="text-2xl font-bold text-green-400">{taskStats.completed}</div>
        </div>
        <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
          <div className="text-xs text-gray-400">Failed</div>
          <div className="text-2xl font-bold text-red-400">{taskStats.failed}</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-4 mb-6">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-400" />
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as StatusFilter)}
            className="px-3 py-2 rounded-lg bg-gray-800 text-gray-200 border border-gray-700 text-sm"
          >
            <option value="all">All Status</option>
            <option value="pending">Pending</option>
            <option value="processing">Processing</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </select>
        </div>

        <select
          value={specialistFilter}
          onChange={e => setSpecialistFilter(e.target.value)}
          className="px-3 py-2 rounded-lg bg-gray-800 text-gray-200 border border-gray-700 text-sm"
        >
          <option value="all">All Specialists</option>
          {specialists.map(spec => (
            <option key={spec} value={spec}>
              {spec}
            </option>
          ))}
        </select>
      </div>

      {/* Batches */}
      {batches.length > 0 && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-white mb-3">Batches ({batches.length})</h2>
          <div className="space-y-2">
            {batches.map(batch => {
              const isExpanded = expandedBatches.has(batch.id);
              const progress = getBatchProgress(batch);
              const progressColor =
                progress >= 100 ? 'bg-green-600' : progress > 0 ? 'bg-blue-600' : 'bg-gray-700';
              const completedCount = batch.progress?.completed ?? 0;
              const totalCount = batch.progress?.total ?? 0;
              const failedCount = batch.progress?.failed ?? 0;

              return (
                <div key={batch.id} className="bg-gray-900 rounded-lg border border-gray-800">
                  <button
                    onClick={() => toggleBatchExpand(batch.id)}
                    className="w-full p-4 flex items-center justify-between hover:bg-gray-800/50 transition-colors"
                  >
                    <div className="flex items-center gap-3 flex-1 text-left">
                      {isExpanded ? (
                        <ChevronDown className="w-5 h-5 text-gray-400" />
                      ) : (
                        <ChevronRight className="w-5 h-5 text-gray-400" />
                      )}
                      <div className="flex-1">
                        <div className="text-sm font-semibold text-white">
                          {batch.objective}
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          {completedCount}/{totalCount} completed
                          {failedCount > 0 && `, ${failedCount} failed`}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="w-32 h-2 bg-gray-800 rounded">
                        <div
                          className={`h-full rounded transition-all ${progressColor}`}
                          style={{ width: `${Math.min(progress, 100)}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-400 w-8 text-right">
                        {progress.toFixed(0)}%
                      </span>
                      <span className={`px-2 py-1 rounded text-xs font-medium ${getStatusColor(batch.status)}`}>
                        {batch.status}
                      </span>
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="px-4 pb-4 border-t border-gray-800">
                      <div className="text-xs text-gray-500 mb-3">
                        ID: {batch.id}
                        {batch.createdAt && (
                          <>
                            <br />
                            Created: {formatDate(batch.createdAt)}
                          </>
                        )}
                        {batch.completedAt && (
                          <>
                            <br />
                            Completed: {formatDate(batch.completedAt)}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Task Table */}
      <div>
        <h2 className="text-lg font-semibold text-white mb-3">
          Tasks ({filteredTasks.length})
        </h2>

        {filteredTasks.length === 0 ? (
          <div className="bg-gray-900 rounded-lg p-8 text-center border border-gray-800">
            <p className="text-gray-400">No tasks match the current filters</p>
          </div>
        ) : (
          <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 bg-gray-800/50">
                    <th className="px-4 py-3 text-left text-gray-400 font-medium">Task ID</th>
                    <th className="px-4 py-3 text-left text-gray-400 font-medium">Specialist</th>
                    <th className="px-4 py-3 text-left text-gray-400 font-medium">Status</th>
                    <th className="px-4 py-3 text-left text-gray-400 font-medium">Created</th>
                    <th className="px-4 py-3 text-left text-gray-400 font-medium">Tokens</th>
                    <th className="px-4 py-3 text-center text-gray-400 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTasks.map(task => {
                    const StatusIcon = getStatusIcon(task.status);
                    const inputTokens = task.tokenUsage?.inputTokens ?? 0;
                    const outputTokens = task.tokenUsage?.outputTokens ?? 0;
                    const totalTokens = inputTokens + outputTokens;
                    return (
                      <tr
                        key={task.id}
                        className="border-b border-gray-800 hover:bg-gray-800/50 transition-colors cursor-pointer"
                        onClick={() => setSelectedTask(task)}
                      >
                        <td className="px-4 py-3 text-gray-300 font-mono text-xs">
                          {task.id.substring(0, 8)}...
                        </td>
                        <td className="px-4 py-3 text-gray-300">{task.specialist}</td>
                        <td className="px-4 py-3">
                          <div className={`inline-flex items-center gap-2 px-2 py-1 rounded text-xs font-medium ${getStatusColor(task.status)}`}>
                            <StatusIcon className="w-3 h-3" />
                            {task.status}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-gray-400 text-xs">
                          {formatDate(task.createdAt)}
                        </td>
                        <td className="px-4 py-3 text-gray-400 text-xs">
                          {totalTokens > 0 ? totalTokens : '-'}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              setSelectedTask(task);
                            }}
                            className="px-2 py-1 rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/40 transition-colors text-xs"
                          >
                            Details
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Task Detail Panel */}
      {selectedTask && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 rounded-lg border border-gray-800 max-w-2xl w-full max-h-[80vh] overflow-y-auto">
            <div className="sticky top-0 flex items-center justify-between p-4 border-b border-gray-800 bg-gray-900">
              <h3 className="text-lg font-semibold text-white">Task Details</h3>
              <button
                onClick={() => setSelectedTask(null)}
                className="text-gray-400 hover:text-gray-200 transition-colors"
              >
                ✕
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div>
                <div className="text-xs text-gray-400 mb-1">Task ID</div>
                <div className="text-sm font-mono text-gray-300 break-all">{selectedTask.id}</div>
              </div>

              {selectedTask.batchId && (
                <div>
                  <div className="text-xs text-gray-400 mb-1">Batch ID</div>
                  <div className="text-sm font-mono text-gray-300 break-all">{selectedTask.batchId}</div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-xs text-gray-400 mb-1">Specialist</div>
                  <div className="text-sm text-gray-300">{selectedTask.specialist}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-400 mb-1">Status</div>
                  <div className={`inline-block px-2 py-1 rounded text-xs font-medium ${getStatusColor(selectedTask.status)}`}>
                    {selectedTask.status}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-xs text-gray-400 mb-1">Created At</div>
                  <div className="text-sm text-gray-300">
                    {formatDate(selectedTask.createdAt)}
                  </div>
                </div>
                {selectedTask.startedAt && (
                  <div>
                    <div className="text-xs text-gray-400 mb-1">Started At</div>
                    <div className="text-sm text-gray-300">
                      {formatDate(selectedTask.startedAt)}
                    </div>
                  </div>
                )}
              </div>

              {selectedTask.tokenUsage && (selectedTask.tokenUsage.inputTokens || selectedTask.tokenUsage.outputTokens) && (
                <div className="bg-gray-800 rounded p-3">
                  <div className="text-xs text-gray-400 mb-2 font-semibold">Token Usage</div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <div className="text-xs text-gray-500">Input</div>
                      <div className="text-sm font-mono text-gray-300">
                        {selectedTask.tokenUsage.inputTokens ?? 0}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500">Output</div>
                      <div className="text-sm font-mono text-gray-300">
                        {selectedTask.tokenUsage.outputTokens ?? 0}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-500">Total</div>
                      <div className="text-sm font-mono text-gray-300">
                        {(selectedTask.tokenUsage.inputTokens ?? 0) + (selectedTask.tokenUsage.outputTokens ?? 0)}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {selectedTask.error && (
                <div className="bg-red-900/20 border border-red-700 rounded p-3">
                  <div className="text-xs text-red-400 mb-2 font-semibold">Error</div>
                  <div className="text-sm text-red-300 break-words font-mono">
                    {selectedTask.error}
                  </div>
                </div>
              )}

              {selectedTask.result && (
                <div className="bg-green-900/20 border border-green-700 rounded p-3">
                  <div className="text-xs text-green-400 mb-2 font-semibold">Result</div>
                  <pre className="text-xs text-green-300 overflow-x-auto max-h-48">
                    {JSON.stringify(selectedTask.result, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

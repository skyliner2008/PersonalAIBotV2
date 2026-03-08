import { useState, useEffect, useRef } from 'react';
import { api } from '../services/api';
import {
  Activity, Cpu, Clock, Zap, CheckCircle, XCircle,
  ChevronDown, ChevronRight, RefreshCw, AlertCircle
} from 'lucide-react';

interface ToolCall {
  name: string;
  durationMs: number;
  success: boolean;
}

interface AgentRun {
  id: string;
  chatId: string;
  message: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  turns: number;
  toolCalls: ToolCall[];
  totalTokens: number;
  reply?: string;
  error?: string;
  taskType?: string;
}

interface AgentStats {
  totalRuns: number;
  activeRuns: number;
  avgDurationMs: number;
  avgTokens: number;
  totalToolCalls: number;
  uptime: number;
  memoryMB: number;
  heapUsedMB: number;
}

const TASK_COLORS: Record<string, string> = {
  general: 'text-gray-400 bg-gray-800',
  complex: 'text-purple-400 bg-purple-900/30',
  vision: 'text-pink-400 bg-pink-900/30',
  web_browser: 'text-blue-400 bg-blue-900/30',
  thinking: 'text-yellow-400 bg-yellow-900/30',
  code: 'text-green-400 bg-green-900/30',
  data: 'text-cyan-400 bg-cyan-900/30',
};

export function AgentMonitor() {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [stats, setStats] = useState<AgentStats | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = async () => {
    try {
      const [runsData, statsData] = await Promise.all([
        api.getAgentRuns(50),
        api.getAgentStats(),
      ]);
      setRuns(runsData);
      setStats(statsData);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    setLoading(true);
    fetchData().finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchData, 3000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh]);

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const fmtMs = (ms?: number) => ms === undefined ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString('th-TH');
  const fmtUptime = (s: number) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;

  // Aggregate tool usage
  const toolUsage: Record<string, number> = {};
  runs.forEach(r => r.toolCalls.forEach(tc => {
    toolUsage[tc.name] = (toolUsage[tc.name] || 0) + 1;
  }));
  const topTools = Object.entries(toolUsage).sort((a, b) => b[1] - a[1]).slice(0, 8);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-2">
            <Cpu className="w-6 h-6 text-purple-400" /> Agent Monitor
          </h2>
          <p className="text-sm text-gray-500 mt-1">Real-time agentic execution telemetry</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
              className="w-3.5 h-3.5 accent-purple-500"
            />
            Auto-refresh
          </label>
          <button
            onClick={() => { setLoading(true); fetchData().finally(() => setLoading(false)); }}
            className="p-2 rounded-lg bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700 transition-all"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Total Runs" value={stats.totalRuns} icon={Activity} color="text-blue-400" />
          <StatCard label="Active Runs" value={stats.activeRuns} icon={Zap} color={stats.activeRuns > 0 ? 'text-green-400' : 'text-gray-500'} pulse={stats.activeRuns > 0} />
          <StatCard label="Avg Duration" value={fmtMs(stats.avgDurationMs)} icon={Clock} color="text-yellow-400" />
          <StatCard label="Avg Tokens" value={stats.avgTokens.toLocaleString()} icon={Cpu} color="text-purple-400" />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Run List */}
        <div className="lg:col-span-2 bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
            <Activity className="w-4 h-4 text-blue-400" />
            Recent Runs
            {stats?.activeRuns ? (
              <span className="ml-auto flex items-center gap-1 text-xs text-green-400">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                {stats.activeRuns} active
              </span>
            ) : null}
          </h3>
          <div className="space-y-2 max-h-[520px] overflow-auto pr-1">
            {runs.length === 0 && (
              <p className="text-gray-600 text-sm text-center py-12">ยังไม่มีข้อมูล — รอการใช้งาน AI</p>
            )}
            {runs.map(run => (
              <div key={run.id} className={`rounded-lg border transition-all ${
                !run.endTime ? 'border-green-500/40 bg-green-500/5' : run.error ? 'border-red-500/30 bg-red-500/5' : 'border-gray-800 bg-gray-800/40'
              }`}>
                {/* Run Header */}
                <button
                  className="w-full flex items-center gap-3 p-3 text-left"
                  onClick={() => toggleExpand(run.id)}
                >
                  {!run.endTime ? (
                    <Zap className="w-4 h-4 text-green-400 animate-pulse shrink-0" />
                  ) : run.error ? (
                    <XCircle className="w-4 h-4 text-red-400 shrink-0" />
                  ) : (
                    <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-gray-500">{fmtTime(run.startTime)}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${TASK_COLORS[run.taskType || 'general'] || 'text-gray-400 bg-gray-800'}`}>
                        {run.taskType || 'general'}
                      </span>
                      <span className="text-xs text-gray-600 truncate max-w-[120px]">{run.chatId}</span>
                    </div>
                    <p className="text-sm text-gray-200 truncate mt-0.5">{run.message}</p>
                  </div>
                  <div className="shrink-0 text-right space-y-0.5">
                    <div className="flex items-center gap-3 text-xs text-gray-500">
                      <span>{run.turns}T</span>
                      <span>{run.toolCalls.length}🔧</span>
                      <span>{fmtMs(run.durationMs)}</span>
                    </div>
                    {expanded.has(run.id) ? <ChevronDown className="w-3.5 h-3.5 text-gray-600 ml-auto" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-600 ml-auto" />}
                  </div>
                </button>
                {/* Expanded detail */}
                {expanded.has(run.id) && (
                  <div className="px-4 pb-3 space-y-3 border-t border-gray-700/50">
                    {/* Tool calls */}
                    {run.toolCalls.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 mt-2 mb-1">Tools Used:</p>
                        <div className="flex flex-wrap gap-1.5">
                          {run.toolCalls.map((tc, i) => (
                            <span key={i} className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${
                              tc.success ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'
                            }`}>
                              {tc.name} ({fmtMs(tc.durationMs)})
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Reply preview */}
                    {run.reply && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 mb-1">Reply:</p>
                        <p className="text-xs text-gray-300 bg-gray-900 rounded p-2 max-h-24 overflow-auto">{run.reply}</p>
                      </div>
                    )}
                    {run.error && (
                      <div className="flex items-start gap-2 text-red-400 text-xs bg-red-900/20 rounded p-2">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        {run.error}
                      </div>
                    )}
                    {/* Token info */}
                    <div className="flex gap-4 text-xs text-gray-600">
                      <span>Tokens: {run.totalTokens.toLocaleString()}</span>
                      <span>Turns: {run.turns}</span>
                      {run.durationMs && <span>Duration: {fmtMs(run.durationMs)}</span>}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          {/* System Health */}
          {stats && (
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
                <Zap className="w-4 h-4 text-green-400" /> System Health
              </h3>
              <div className="space-y-2 text-sm">
                <HealthRow label="Uptime" value={fmtUptime(stats.uptime)} />
                <HealthRow label="RAM (RSS)" value={`${stats.memoryMB} MB`} warn={stats.memoryMB > 800} />
                <HealthRow label="Heap Used" value={`${stats.heapUsedMB} MB`} />
                <HealthRow label="Total Tool Calls" value={stats.totalToolCalls.toLocaleString()} />
              </div>
            </div>
          )}

          {/* Top Tools */}
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
              <Zap className="w-4 h-4 text-yellow-400" /> Top Tools
            </h3>
            {topTools.length === 0 ? (
              <p className="text-gray-600 text-xs text-center py-4">ยังไม่มีข้อมูล</p>
            ) : (
              <div className="space-y-2">
                {topTools.map(([name, count]) => {
                  const max = topTools[0][1];
                  return (
                    <div key={name}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-gray-300 font-mono truncate">{name}</span>
                        <span className="text-gray-500 shrink-0 ml-2">{count}x</span>
                      </div>
                      <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-purple-500 to-blue-500 rounded-full"
                          style={{ width: `${(count / max) * 100}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Task Type Distribution */}
          {runs.length > 0 && (
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-3">Task Distribution</h3>
              <div className="space-y-1.5">
                {Object.entries(
                  runs.reduce((acc, r) => {
                    const t = r.taskType || 'general';
                    acc[t] = (acc[t] || 0) + 1;
                    return acc;
                  }, {} as Record<string, number>)
                ).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
                  <div key={type} className="flex items-center gap-2 text-xs">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium min-w-[60px] text-center ${TASK_COLORS[type] || 'text-gray-400 bg-gray-800'}`}>
                      {type}
                    </span>
                    <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500/60 rounded-full"
                        style={{ width: `${(count / runs.length) * 100}%` }}
                      />
                    </div>
                    <span className="text-gray-500 w-6 text-right">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon: Icon, color, pulse }: {
  label: string; value: string | number; icon: any; color: string; pulse?: boolean;
}) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-500">{label}</span>
        <Icon className={`w-4 h-4 ${color} ${pulse ? 'animate-pulse' : ''}`} />
      </div>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

function HealthRow({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-gray-500">{label}</span>
      <span className={warn ? 'text-yellow-400 font-medium' : 'text-gray-300'}>{value}</span>
    </div>
  );
}

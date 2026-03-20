import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../services/api';
import {
  Activity, Cpu, Clock, Zap, CheckCircle, XCircle,
  ChevronDown, ChevronRight, RefreshCw, AlertCircle,
  DollarSign, BarChart3, Heart, HeartOff, Info, Server, Database, Layers, Trash2
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

interface UsageSummary {
  period: string;
  providers: {
    provider: string;
    totalRequests: number;
    totalErrors: number;
    totalTokens: number;
    avgDurationMs: number;
    estimatedCostUSD: number;
    lastUsed: string;
    avgTokensPerRequest: number;
    isCalculationValid: boolean;
  }[];
  taskBreakdown: Record<string, { requests: number; tokens: number }>;
  totalRequests: number;
  totalTokens: number;
  totalErrors: number;
  estimatedCostUSD: number;
  avgTokensPerRequest: number;
  isCalculationValid: boolean;
}

interface ProviderHealth {
  providerId: string;
  status: 'healthy' | 'degraded' | 'down' | 'disabled';
  consecutiveFailures: number;
  lastCheck: number;
  lastSuccess: number;
  responseTimeMs?: number;
  lastError?: string;
}

interface Props {
  on: (event: string, handler: (...args: any[]) => void) => () => void;
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

const HEALTH_COLORS: Record<string, string> = {
  healthy: 'text-green-400',
  degraded: 'text-yellow-400',
  down: 'text-red-400',
  disabled: 'text-gray-500',
};

export function AgentMonitor({ on }: Props) {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [stats, setStats] = useState<AgentStats | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [health, setHealth] = useState<Record<string, ProviderHealth>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'runs' | 'usage' | 'health' | 'about'>('runs');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [runsData, statsData, usageData, healthData] = await Promise.all([
        api.getAgentRuns(1000),
        api.getAgentStats(),
        api.getUsageSummary(24).catch(() => null),
        api.getProviderHealth().then((r: any) => r.health || {}).catch(() => ({})),
      ]);
      setRuns(runsData);
      setStats(statsData);
      if (usageData) setUsage(usageData);
      setHealth(healthData);
    } catch (err) {
      console.error('Failed to fetch agent data:', err);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchData().finally(() => setLoading(false));
  }, [fetchData]);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchData, 10000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh, fetchData]);

  // Real-time Socket.IO events from agent
  useEffect(() => {
    const unsubs = [
      on('agent:run:started', (data: any) => {
        setRuns(prev => [{
          id: data.runId,
          chatId: data.chatId,
          message: data.message,
          startTime: Date.now(),
          turns: 0,
          toolCalls: [],
          totalTokens: 0,
          taskType: data.taskType,
        }, ...prev].slice(0, 5000));
        setStats(s => s ? { ...s, activeRuns: s.activeRuns + 1 } : s);
      }),
      on('agent:tool:finished', (data: any) => {
        setRuns(prev => prev.map(r =>
          r.id === data.runId ? {
            ...r,
            toolCalls: [...r.toolCalls, { name: data.tool, durationMs: data.durationMs, success: data.success }]
          } : r
        ));
      }),
      on('agent:run:completed', (data: any) => {
        setRuns(prev => prev.map(r =>
          r.id === data.runId ? {
            ...r,
            endTime: Date.now(),
            durationMs: data.durationMs,
            turns: data.turns,
            totalTokens: data.totalTokens,
            reply: data.reply?.substring(0, 200),
          } : r
        ));
        setStats(s => s ? { ...s, activeRuns: Math.max(0, s.activeRuns - 1), totalRuns: s.totalRuns + 1 } : s);
      }),
      on('provider:health', (data: any) => {
        setHealth(prev => ({
          ...prev,
          [data.providerId]: {
            ...prev[data.providerId],
            providerId: data.providerId,
            status: data.status,
            responseTimeMs: data.responseTimeMs,
            lastCheck: Date.now(),
            lastError: data.error,
          }
        }));
      }),
      on('provider:disabled', (data: any) => {
        setHealth(prev => ({
          ...prev,
          [data.providerId]: {
            ...prev[data.providerId],
            providerId: data.providerId,
            status: 'down',
            consecutiveFailures: data.failures,
            lastError: data.reason,
            lastCheck: Date.now(),
          }
        }));
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, [on]);

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
  const fmtCost = (c: number) => c < 0.01 ? `$${c.toFixed(6)}` : `$${c.toFixed(4)}`;

  // Aggregate tool usage
  const toolUsage: Record<string, number> = {};
  runs.forEach(r => r.toolCalls.forEach(tc => {
    toolUsage[tc.name] = (toolUsage[tc.name] || 0) + 1;
  }));
  const topTools = Object.entries(toolUsage).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const handleClearRuns = async () => {
    if (!confirm('ยืนยันลบประวัติ Agent Runs ทั้งหมด?')) return;
    try {
      await api.clearAgentRuns();
      setRuns([]);
      setStats(s => s ? { ...s, totalRuns: 0, activeRuns: 0, avgDurationMs: 0, avgTokens: 0, totalToolCalls: 0 } : s);
    } catch (err) {
      console.error('Failed to clear runs:', err);
    }
  };

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
            onClick={handleClearRuns}
            className="p-2 rounded-lg bg-gray-800 text-red-500 hover:text-white hover:bg-red-600 transition-all flex items-center gap-1.5 text-xs font-medium"
            title="Clear History"
          >
            <Trash2 className="w-4 h-4" />
            Clear
          </button>
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
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <StatCard label="Total Runs" value={stats.totalRuns} icon={Activity} color="text-blue-400" />
          <StatCard label="Active Runs" value={stats.activeRuns} icon={Zap} color={stats.activeRuns > 0 ? 'text-green-400' : 'text-gray-500'} pulse={stats.activeRuns > 0} />
          <StatCard label="Avg Duration" value={fmtMs(stats.avgDurationMs)} icon={Clock} color="text-yellow-400" />
          <StatCard label="Avg Tokens" value={stats.avgTokens.toLocaleString()} icon={Cpu} color="text-purple-400" />
          <StatCard
            label="Est. Cost (24h)"
            value={usage ? fmtCost(usage.estimatedCostUSD) : '—'}
            icon={DollarSign}
            color="text-emerald-400"
          />
        </div>
      )}

      {/* Tab Selector */}
      <div className="flex gap-1 bg-gray-900 rounded-lg p-1 w-fit">
        {(['runs', 'usage', 'health', 'about'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-1.5 rounded-md text-sm transition-all ${
              activeTab === tab
                ? 'bg-blue-600 text-white font-medium'
                : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >
            {tab === 'runs' ? 'Agent Runs' : tab === 'usage' ? 'Usage & Cost' : tab === 'health' ? 'Provider Health' : 'System About'}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'runs' && (
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
                  {expanded.has(run.id) && (
                    <div className="px-4 pb-3 space-y-3 border-t border-gray-700/50">
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
      )}

      {/* Usage & Cost Tab */}
      {activeTab === 'usage' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Per-Provider Usage */}
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
            <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-blue-400" />
              Provider Usage (24h)
            </h3>
            {!usage || usage.providers.length === 0 ? (
              <p className="text-gray-600 text-xs text-center py-8">ยังไม่มีข้อมูลการใช้งาน</p>
            ) : (
              <div className="space-y-3">
                {usage.providers.map(p => (
                  <div key={p.provider} className="bg-gray-800/50 rounded-lg p-3 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-medium text-white">{p.provider}</span>
                      <span className="text-xs text-emerald-400 font-mono">{fmtCost(p.estimatedCostUSD)}</span>
                    </div>
                    <div className="grid grid-cols-4 gap-2 text-xs">
                      <div>
                        <span className="text-gray-500">Requests</span>
                        <p className="text-gray-200 font-medium">{p.totalRequests}</p>
                      </div>
                      <div>
                        <span className="text-gray-500">Tokens</span>
                        <p className="text-gray-200 font-medium">{(p.totalTokens || 0).toLocaleString()}</p>
                      </div>
                      <div>
                        <span className="text-gray-500">Avg Tokens</span>
                        <p className="text-purple-400 font-medium">{p.avgTokensPerRequest.toLocaleString()}</p>
                      </div>
                      <div>
                        <span className="text-gray-500">Avg Speed</span>
                        <p className="text-gray-200 font-medium">{fmtMs(p.avgDurationMs)}</p>
                      </div>
                    </div>
                    {/* Validation Status */}
                    <div className="flex justify-between items-center text-xs mt-1 pt-2 border-t border-gray-700/50">
                      <span className="text-gray-500">Token Cost Validation:</span>
                      {p.isCalculationValid ? (
                        <span className="text-green-400 flex items-center gap-1"><CheckCircle className="w-3 h-3" /> MATCH</span>
                      ) : (
                        <span className="text-yellow-400 flex items-center gap-1"><AlertCircle className="w-3 h-3" /> DIFF DETECTED</span>
                      )}
                    </div>
                    {p.totalErrors > 0 && (
                      <div className="text-xs text-red-400">
                        ⚠️ {p.totalErrors} errors ({Math.round(p.totalErrors / p.totalRequests * 100)}%)
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Task Breakdown */}
          <div className="space-y-4">
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-emerald-400" />
                Cost Summary (24h)
              </h3>
              {!usage ? (
                <p className="text-gray-600 text-xs text-center py-4">ยังไม่มีข้อมูล</p>
              ) : (
                <div className="space-y-3">
                  <div className="text-center py-3">
                    <p className="text-3xl font-bold text-emerald-400">{fmtCost(usage.estimatedCostUSD)}</p>
                    <p className="text-xs text-gray-500 mt-1">Estimated total cost</p>
                  </div>
                  <div className="grid grid-cols-4 gap-3 text-center">
                    <div className="bg-gray-800/50 rounded-lg p-2">
                      <p className="text-lg font-bold text-blue-400">{usage.totalRequests}</p>
                      <p className="text-[10px] text-gray-500">Requests</p>
                    </div>
                    <div className="bg-gray-800/50 rounded-lg p-2">
                      <p className="text-lg font-bold text-purple-400">{(usage.totalTokens || 0).toLocaleString()}</p>
                      <p className="text-[10px] text-gray-500">Total Tokens</p>
                    </div>
                    <div className="bg-gray-800/50 rounded-lg p-2 border border-purple-500/20">
                      <p className="text-lg font-bold text-purple-300">{(usage.avgTokensPerRequest || 0).toLocaleString()}</p>
                      <p className="text-[10px] text-gray-400">Avg Tokens/Req</p>
                    </div>
                    <div className="bg-gray-800/50 rounded-lg p-2">
                      <p className="text-lg font-bold text-red-400">{usage.totalErrors}</p>
                      <p className="text-[10px] text-gray-500">Errors</p>
                    </div>
                  </div>
                  <div className={`mt-3 p-2 rounded-lg text-xs flex justify-between items-center ${
                    usage.isCalculationValid ? 'bg-green-900/20 text-green-400 border border-green-500/30' : 'bg-yellow-900/20 text-yellow-400 border border-yellow-500/30'
                  }`}>
                    <span>System Database Token Integrity Check:</span>
                    <span className="font-bold">{usage.isCalculationValid ? 'PASS (100% MATCH)' : 'WARNING'}</span>
                  </div>
                </div>
              )}
            </div>

            {usage && Object.keys(usage.taskBreakdown).length > 0 && (
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
                <h3 className="text-sm font-semibold text-gray-300 mb-3">Task Breakdown</h3>
                <div className="space-y-2">
                  {Object.entries(usage.taskBreakdown).sort((a, b) => b[1].tokens - a[1].tokens).map(([task, data]) => (
                    <div key={task} className="flex items-center justify-between text-xs">
                      <span className={`px-1.5 py-0.5 rounded font-medium ${TASK_COLORS[task] || 'text-gray-400 bg-gray-800'}`}>
                        {task}
                      </span>
                      <div className="flex gap-4 text-gray-400">
                        <span>{data.requests} req</span>
                        <span>{(data.tokens || 0).toLocaleString()} tok</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Provider Health Tab */}
      {activeTab === 'health' && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-2">
            <Heart className="w-4 h-4 text-red-400" />
            Provider Health Status
          </h3>
          {Object.keys(health).length === 0 ? (
            <p className="text-gray-600 text-xs text-center py-8">
              ยังไม่มีข้อมูล Health Check — ระบบจะตรวจสอบทุก 5 นาที
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {Object.values(health).map((h: ProviderHealth) => (
                <div key={h.providerId} className={`rounded-lg border p-3 ${
                  h.status === 'healthy' ? 'border-green-500/30 bg-green-500/5' :
                  h.status === 'degraded' ? 'border-yellow-500/30 bg-yellow-500/5' :
                  h.status === 'down' ? 'border-red-500/30 bg-red-500/5' :
                  'border-gray-700 bg-gray-800/30'
                }`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-white">{h.providerId}</span>
                    {h.status === 'healthy' ? (
                      <Heart className="w-4 h-4 text-green-400" />
                    ) : h.status === 'down' ? (
                      <HeartOff className="w-4 h-4 text-red-400" />
                    ) : (
                      <AlertCircle className={`w-4 h-4 ${HEALTH_COLORS[h.status]}`} />
                    )}
                  </div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Status</span>
                      <span className={`font-medium ${HEALTH_COLORS[h.status]}`}>{h.status.toUpperCase()}</span>
                    </div>
                    {h.responseTimeMs !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">Response</span>
                        <span className="text-gray-300">{fmtMs(h.responseTimeMs)}</span>
                      </div>
                    )}
                    {h.consecutiveFailures > 0 && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">Failures</span>
                        <span className="text-red-400">{h.consecutiveFailures}x</span>
                      </div>
                    )}
                    {h.lastError && (
                      <p className="text-red-400/70 truncate mt-1" title={h.lastError}>
                        {h.lastError}
                      </p>
                    )}
                    {h.lastCheck > 0 && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">Last Check</span>
                        <span className="text-gray-400">{fmtTime(h.lastCheck)}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* System About Tab */}
      {activeTab === 'about' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
            <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <Info className="w-5 h-5 text-blue-400" />
              Project Specifications
            </h3>
            <div className="space-y-4">
              <div>
                <h4 className="text-sm font-medium text-gray-300 mb-1">Architecture Base</h4>
                <p className="text-xs text-gray-500">Node.js Express Backend with Socket.IO real-time communication. React (Vite) + Tailwind CSS Frontend. Designed for infinite agent scaling.</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-3">
                <div className="flex justify-between items-center text-sm border-b border-gray-700/50 pb-2 mb-2">
                  <span className="text-gray-400">Agentic Engine</span>
                  <span className="text-purple-400 font-medium">ReAct + Stateful Planning</span>
                </div>
                <div className="flex justify-between items-center text-sm border-b border-gray-700/50 pb-2 mb-2">
                  <span className="text-gray-400">Knowledge DB</span>
                  <span className="text-blue-400 font-medium">SQLite3 (On-Disk)</span>
                </div>
                <div className="flex justify-between items-center text-sm border-b border-gray-700/50 pb-2 mb-2">
                  <span className="text-gray-400">Provider Sync</span>
                  <span className="text-green-400 font-medium">Multi-Models (Gemini, GPT)</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-gray-400">Platform Scope</span>
                  <span className="text-orange-400 font-medium">FB, Line, TG, Web, CMD</span>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
            <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <Layers className="w-5 h-5 text-purple-400" />
              System Modules
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="border border-gray-800 bg-gray-800/30 rounded-lg p-3">
                <Server className="w-4 h-4 text-blue-400 mb-2" />
                <h4 className="text-sm font-medium text-gray-300">Tool Executor</h4>
                <p className="text-[10px] text-gray-500 mt-1">Handles bash, code, fetch tools in isolated context.</p>
              </div>
              <div className="border border-gray-800 bg-gray-800/30 rounded-lg p-3">
                <Database className="w-4 h-4 text-emerald-400 mb-2" />
                <h4 className="text-sm font-medium text-gray-300">Swarm Memory</h4>
                <p className="text-[10px] text-gray-500 mt-1">Shared state across platform nodes.</p>
              </div>
              <div className="border border-gray-800 bg-gray-800/30 rounded-lg p-3">
                <Activity className="w-4 h-4 text-pink-400 mb-2" />
                <h4 className="text-sm font-medium text-gray-300">Real-time Bus</h4>
                <p className="text-[10px] text-gray-500 mt-1">WebSocket broadcast array for live telemetry.</p>
              </div>
              <div className="border border-gray-800 bg-gray-800/30 rounded-lg p-3">
                <Cpu className="w-4 h-4 text-yellow-400 mb-2" />
                <h4 className="text-sm font-medium text-gray-300">Task Scheduler</h4>
                <p className="text-[10px] text-gray-500 mt-1">Auto-post + maintenance cron jobs.</p>
              </div>
            </div>
          </div>
        </div>
      )}
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

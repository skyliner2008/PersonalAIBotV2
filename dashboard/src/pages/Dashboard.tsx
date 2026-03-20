import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { Power, MessageCircle, FileEdit, MessageSquare, Activity, Clock, Cpu, Brain, Zap, TrendingUp } from 'lucide-react';

interface Props {
  status: { browser: boolean; loggedIn: boolean; chatBot: boolean; commentBot: boolean };
  emit: (event: string, data?: any) => void;
  on: (event: string, handler: (...args: any[]) => void) => () => void;
}

type RuntimeStatus = 'active' | 'degraded' | 'offline';

interface TopologyAgent {
  id: string;
  name: string;
  kind: string;
  status: RuntimeStatus;
  channels: string[];
  summonTargets: string[];
  details?: Record<string, unknown>;
}

interface TopologyPlugin {
  id: string;
  name: string;
  status: RuntimeStatus;
  details: Record<string, unknown>;
}

interface SystemTopology {
  generatedAt: string;
  architecture: {
    mode: string;
    coreAgents: number;
    pattern: string;
    facebookAutomationBoundary: {
      role: string;
      pluginId: string;
      note: string;
    };
  };
  agents: TopologyAgent[];
  plugins: TopologyPlugin[];
}

export function Dashboard({ status, emit, on }: Props) {
  const [logs, setLogs] = useState<any[]>([]);
  const [recentActivity, setRecentActivity] = useState<any[]>([]);
  const [agentStats, setAgentStats] = useState<any>(null);
  const [topology, setTopology] = useState<SystemTopology | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.getLogs(30).then(setLogs).catch((err) => {
        console.error('Failed to fetch logs:', err);
      }),
      api.getAgentStats().then(setAgentStats).catch((err) => {
        console.error('Failed to fetch agent stats:', err);
      }),
      api.getSystemTopology().then(setTopology).catch((err) => {
        console.error('Failed to fetch system topology:', err);
      })
    ]).finally(() => setLoading(false));

    const interval = setInterval(() => {
      api.getLogs(30).then(setLogs).catch((err) => {
        console.error('Failed to fetch logs:', err);
      });
      api.getAgentStats().then(setAgentStats).catch((err) => {
        console.error('Failed to fetch agent stats:', err);
      });
      api.getSystemTopology().then(setTopology).catch((err) => {
        console.error('Failed to fetch system topology:', err);
      });
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  // Listen for real-time events
  useEffect(() => {
    const unsub1 = on('chatbot:sentReply', (data: any) => {
      setRecentActivity(prev => [{ type: 'chat', ...data, time: new Date() }, ...prev].slice(0, 20));
    });
    const unsub2 = on('commentbot:replied', (data: any) => {
      setRecentActivity(prev => [{ type: 'comment', ...data, time: new Date() }, ...prev].slice(0, 20));
    });
    const unsub3 = on('post:status', (data: any) => {
      if (data.status === 'posted') {
        setRecentActivity(prev => [{ type: 'post', ...data, time: new Date() }, ...prev].slice(0, 20));
      }
    });
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [on]);

  const fmtMs = (ms?: number) => (ms === undefined ? '-' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <div className="text-gray-400 animate-pulse">Loading dashboard...</div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-2xl font-bold text-white">Dashboard</h2>

      {/* AI Agent Stats */}
      {agentStats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <MiniStat icon={TrendingUp} label="Total Runs" value={agentStats.totalRuns} color="text-blue-400" />
          <MiniStat icon={Zap} label="Active" value={agentStats.activeRuns} color={agentStats.activeRuns > 0 ? 'text-green-400' : 'text-gray-500'} pulse={agentStats.activeRuns > 0} />
          <MiniStat icon={Clock} label="Avg Duration" value={fmtMs(agentStats.avgDurationMs)} color="text-yellow-400" />
          <MiniStat icon={Cpu} label="Memory" value={`${agentStats.memoryMB}MB`} color={agentStats.memoryMB > 800 ? 'text-red-400' : 'text-purple-400'} />
        </div>
      )}

      {/* Unified Topology */}
      {topology && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
            <Brain className="w-4 h-4 text-cyan-400" />
            Unified Topology ({topology.architecture.pattern})
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {topology.agents.map((agent) => (
              <AgentRuntimeCard key={agent.id} agent={agent} />
            ))}
          </div>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
            {topology.plugins.map((plugin) => (
              <div key={plugin.id} className="rounded-lg border border-gray-800 bg-gray-800/40 px-3 py-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-gray-200">{plugin.name}</p>
                  <StatusBadge status={plugin.status} />
                </div>
                <p className="text-[11px] text-gray-500 mt-1">{plugin.id}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick Controls */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <ControlCard
          title="Browser"
          active={status.browser}
          icon={Power}
          onStart={() => emit('browser:start')}
          onStop={() => emit('browser:stop')}
        />
        <ControlCard
          title="Chat Bot"
          active={status.chatBot}
          icon={MessageCircle}
          onStart={() => emit('chatbot:start')}
          onStop={() => emit('chatbot:stop')}
          disabled={!status.loggedIn}
        />
        <ControlCard
          title="Comment Bot"
          active={status.commentBot}
          icon={MessageSquare}
          onStart={() => emit('commentbot:start')}
          onStop={() => emit('commentbot:stop')}
          disabled={!status.loggedIn}
        />
        <ControlCard
          title="Scheduler"
          active={false}
          icon={Clock}
          onStart={() => emit('scheduler:start')}
          onStop={() => emit('scheduler:stop')}
          disabled={!status.loggedIn}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Activity */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
            <Activity className="w-4 h-4 text-blue-400" /> Recent Activity
          </h3>
          <div className="space-y-2 max-h-80 overflow-auto">
            {recentActivity.length === 0 && (
              <p className="text-gray-600 text-sm text-center py-8">No activity yet. Start the bot!</p>
            )}
            {recentActivity.map((act, i) => (
              <div key={`${act.type}-${act.time?.getTime()}-${i}`} className="flex gap-2 text-xs p-2 bg-gray-800/50 rounded-lg">
                <span className={`shrink-0 ${act.type === 'chat' ? 'text-blue-400' : act.type === 'comment' ? 'text-green-400' : 'text-purple-400'}`}>
                  [{act.type}]
                </span>
                <span className="text-gray-400 truncate">
                  {act.type === 'chat' && `Replied: "${act.reply?.substring(0, 60)}..."`}
                  {act.type === 'comment' && `${act.commenter}: "${act.reply?.substring(0, 60)}..."`}
                  {act.type === 'post' && `Post published (ID: ${act.id})`}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* System Logs */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
            <FileEdit className="w-4 h-4 text-purple-400" /> System Logs
          </h3>
          <div className="space-y-1 max-h-80 overflow-auto font-mono text-[11px]">
            {logs.map((log, i) => (
              <div key={`${log.created_at}-${log.type}-${i}`} className={`flex gap-2 px-1 py-0.5 ${
                log.level === 'error' ? 'text-red-400' :
                log.level === 'success' ? 'text-green-400' :
                log.level === 'warning' ? 'text-yellow-400' : 'text-gray-500'
              }`}>
                <span className="text-gray-600 shrink-0">
                  {new Date(log.created_at).toLocaleTimeString('th-TH')}
                </span>
                <span className="text-purple-400 shrink-0">[{log.type}]</span>
                <span>{log.action}</span>
                {log.details && <span className="text-gray-600 truncate">{log.details}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function statusClasses(status: RuntimeStatus): string {
  switch (status) {
    case 'active':
      return 'text-green-300 bg-green-500/20 border-green-500/30';
    case 'degraded':
      return 'text-yellow-300 bg-yellow-500/20 border-yellow-500/30';
    default:
      return 'text-gray-300 bg-gray-700/30 border-gray-700';
  }
}

function StatusBadge({ status }: { status: RuntimeStatus }) {
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full border capitalize ${statusClasses(status)}`}>
      {status}
    </span>
  );
}

function AgentRuntimeCard({ agent }: { agent: TopologyAgent }) {
  const errorMsg = agent.details?.lastRuntimeError as string | undefined;
  return (
    <div className={`rounded-lg border ${agent.status === 'degraded' ? 'border-yellow-500/40 bg-yellow-500/5' : 'border-gray-800 bg-gray-800/40'} px-3 py-2`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-gray-200 truncate">{agent.name}</p>
        <StatusBadge status={agent.status} />
      </div>
      <p className="text-[11px] text-gray-500 mt-1">{agent.kind}</p>
      <p className="text-[11px] text-gray-400 mt-1">Channels: {agent.channels.join(', ') || '-'}</p>
      {agent.summonTargets.length > 0 && (
        <p className="text-[11px] text-blue-300 mt-1">Summon: {agent.summonTargets.join(', ')}</p>
      )}
      {agent.status === 'degraded' && errorMsg && (
        <p className="text-[11px] text-yellow-400/90 mt-1.5 leading-snug break-words line-clamp-3" title={errorMsg}>
          ⚠ {errorMsg.length > 120 ? errorMsg.slice(0, 120) + '…' : errorMsg}
        </p>
      )}
    </div>
  );
}

function MiniStat({ icon: Icon, label, value, color, pulse }: {
  icon: any; label: string; value: string | number; color: string; pulse?: boolean;
}) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 px-4 py-3 flex items-center gap-3">
      <Icon className={`w-5 h-5 shrink-0 ${color} ${pulse ? 'animate-pulse' : ''}`} />
      <div>
        <p className="text-xs text-gray-500">{label}</p>
        <p className={`text-base font-bold ${color}`}>{value}</p>
      </div>
    </div>
  );
}

function ControlCard({ title, active, icon: Icon, onStart, onStop, disabled }:
  { title: string; active: boolean; icon: any; onStart: () => void; onStop: () => void; disabled?: boolean }) {
  return (
    <div className={`p-4 rounded-xl border ${active ? 'bg-green-500/10 border-green-500/30' : 'bg-gray-900 border-gray-800'}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon className={`w-5 h-5 ${active ? 'text-green-400' : 'text-gray-500'}`} />
          <span className="text-sm font-medium text-gray-200">{title}</span>
        </div>
        <span className={`w-2 h-2 rounded-full ${active ? 'bg-green-400 animate-pulse' : 'bg-gray-600'}`} />
      </div>
      <button
        onClick={active ? onStop : onStart}
        disabled={disabled}
        className={`w-full py-1.5 rounded-lg text-xs font-medium transition-all ${
          disabled ? 'bg-gray-800 text-gray-600 cursor-not-allowed' :
          active
            ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30'
            : 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30'
        }`}
      >
        {active ? 'Stop' : 'Start'}
      </button>
    </div>
  );
}

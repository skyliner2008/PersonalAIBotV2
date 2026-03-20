import { useState, useEffect } from 'react';
import { api } from '../services/api';
import {
  Activity, Database, Cpu, HardDrive, Wifi, AlertTriangle, CheckCircle, XCircle, RefreshCw
} from 'lucide-react';

interface HealthData {
  status?: string;
  uptime?: number;
  uptimeHuman?: string;
  memory?: {
    heapUsed?: string;
    heapTotal?: string;
    rss?: string;
    external?: string;
  };
  nodeVersion?: string;
  queues?: {
    chat?: { pending: number; processing: number; completed: number; failed: number };
    webhook?: { pending: number; processing: number; completed: number; failed: number };
  };
  database?: {
    tables?: number;
    rows?: number;
  };
  timestamp?: string;
}

interface DetailedHealthData {
  status?: string;
  checks?: {
    process?: {
      uptime_seconds?: number;
      memory?: {
        heapUsed?: number;
        heapTotal?: number;
        rss?: number;
        external?: number;
        arrayBuffers?: number;
      };
      platform?: string;
      nodeVersion?: string;
    };
    database?: {
      status?: string;
      details?: { accessible?: boolean; tableCount?: number };
    };
    timestamp?: string;
  };
}

interface ProviderHealth {
  status: 'healthy' | 'degraded' | 'down' | 'disabled';
  consecutiveFailures?: number;
  lastCheck?: number;
  lastSuccess?: number;
  responseTimeMs?: number;
  lastError?: string;
}

interface SwarmHealthResponse {
  success?: boolean;
  health?: Array<{
    name: string;
    state?: string;
    activeCount?: number;
    totalCount?: number;
  }>;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; icon: string }> = {
  healthy: { bg: 'bg-green-900/20', text: 'text-green-400', icon: 'green' },
  degraded: { bg: 'bg-amber-900/20', text: 'text-amber-400', icon: 'amber' },
  down: { bg: 'bg-red-900/20', text: 'text-red-400', icon: 'red' },
  disabled: { bg: 'bg-gray-900/20', text: 'text-gray-400', icon: 'gray' },
  error: { bg: 'bg-red-900/20', text: 'text-red-400', icon: 'red' },
  ok: { bg: 'bg-green-900/20', text: 'text-green-400', icon: 'green' },
};

export function SystemHealth() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [detailedHealth, setDetailedHealth] = useState<DetailedHealthData | null>(null);
  const [providers, setProviders] = useState<Record<string, ProviderHealth>>({});
  const [swarmHealth, setSwarmHealth] = useState<SwarmHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const fetchData = async () => {
    try {
      setLoading(true);
      const [basicHealth, detailedData, providersData, swarmData] = await Promise.all([
        fetch('/health').then(r => r.json()).catch(() => null),
        api.getDetailedHealth?.().catch(() => null),
        api.getProviderHealth?.().catch(() => ({})),
        api.getSwarmHealth?.().catch(() => null),
      ]);

      setHealth(basicHealth || null);
      setDetailedHealth(detailedData || null);

      // Handle provider health wrapping — API returns {success, health: {providerId: {...}}}
      let providersList: Record<string, ProviderHealth> = {};
      if (providersData && typeof providersData === 'object') {
        // Unwrap from known response envelope keys
        const raw = providersData.health ?? providersData.providers ?? providersData;
        // Filter out non-provider wrapper keys (success, health, timestamp, etc.)
        const WRAPPER_KEYS = new Set(['success', 'health', 'providers', 'timestamp', 'error', 'message']);
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          for (const [key, val] of Object.entries(raw)) {
            if (!WRAPPER_KEYS.has(key) && val && typeof val === 'object' && 'status' in (val as any)) {
              providersList[key] = val as ProviderHealth;
            }
          }
        }
      }
      setProviders(providersList);
      setSwarmHealth(swarmData || null);
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Failed to fetch system health:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, []);

  const getStatusColor = (status: string) => STATUS_COLORS[status] || STATUS_COLORS.error;

  const getMemoryPercentage = () => {
    // Try detailed health first (bytes)
    if (detailedHealth?.checks?.process?.memory?.heapUsed && detailedHealth?.checks?.process?.memory?.heapTotal) {
      return (detailedHealth.checks.process.memory.heapUsed / detailedHealth.checks.process.memory.heapTotal) * 100;
    }
    // Fall back to basic health (strings like "50MB")
    if (health?.memory?.heapUsed && health?.memory?.heapTotal) {
      const used = parseMemoryString(health.memory.heapUsed);
      const total = parseMemoryString(health.memory.heapTotal);
      if (used !== null && total !== null) {
        return (used / total) * 100;
      }
    }
    return 0;
  };

  const parseMemoryString = (str?: string): number | null => {
    if (!str) return null;
    const match = str.match(/^([\d.]+)\s*([KMGT])?B$/i);
    if (!match) return null;

    let bytes = parseFloat(match[1]);
    const unit = match[2]?.toUpperCase();

    if (unit === 'K') bytes *= 1024;
    else if (unit === 'M') bytes *= 1024 * 1024;
    else if (unit === 'G') bytes *= 1024 * 1024 * 1024;
    else if (unit === 'T') bytes *= 1024 * 1024 * 1024 * 1024;

    return bytes;
  };

  const formatBytes = (bytes?: number | string) => {
    if (!bytes) return 'N/A';

    // Handle string format (from basic health)
    if (typeof bytes === 'string') {
      return bytes;
    }

    // Handle numeric format (from detailed health)
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIdx = 0;
    while (size >= 1024 && unitIdx < units.length - 1) {
      size /= 1024;
      unitIdx++;
    }
    return `${size.toFixed(1)} ${units[unitIdx]}`;
  };

  const formatUptime = (seconds: number) => {
    const sec = Math.floor(seconds % 60);
    const min = Math.floor((seconds / 60) % 60);
    const hrs = Math.floor((seconds / 3600) % 24);
    const days = Math.floor(seconds / 86400);

    if (days > 0) return `${days}d ${hrs}h`;
    if (hrs > 0) return `${hrs}h ${min}m`;
    if (min > 0) return `${min}m ${sec}s`;
    return `${sec}s`;
  };

  if (loading && !health) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-white">System Health</h1>
          <button
            onClick={fetchData}
            disabled
            className="px-4 py-2 rounded-lg bg-blue-600/20 text-blue-400 disabled:opacity-50"
          >
            <RefreshCw className="w-4 h-4 inline mr-2" />
            Loading...
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map(i => (
            <div key={i} className="bg-gray-900 rounded-lg p-4 animate-pulse">
              <div className="h-4 bg-gray-800 rounded w-1/2 mb-2" />
              <div className="h-6 bg-gray-800 rounded w-3/4" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const memoryPercent = getMemoryPercentage();
  const memoryColor = memoryPercent > 80 ? 'bg-red-600' : memoryPercent > 60 ? 'bg-amber-600' : 'bg-green-600';

  // Get memory values from either source
  const heapUsed = detailedHealth?.checks?.process?.memory?.heapUsed
    ? formatBytes(detailedHealth.checks.process.memory.heapUsed)
    : health?.memory?.heapUsed || 'N/A';
  const heapTotal = detailedHealth?.checks?.process?.memory?.heapTotal
    ? formatBytes(detailedHealth.checks.process.memory.heapTotal)
    : health?.memory?.heapTotal || 'N/A';
  const rss = detailedHealth?.checks?.process?.memory?.rss
    ? formatBytes(detailedHealth.checks.process.memory.rss)
    : health?.memory?.rss || 'N/A';

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Activity className="w-6 h-6" />
          System Health
        </h1>
        <div className="flex items-center gap-4">
          <div className="text-xs text-gray-500">
            Last updated: {lastRefresh.toLocaleTimeString()}
          </div>
          <button
            onClick={fetchData}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
        </div>
      </div>

      {/* System Overview */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <div className="text-gray-400 text-sm mb-2">Uptime</div>
          <div className="text-2xl font-bold text-white">
            {health?.uptime !== undefined ? formatUptime(health.uptime) : 'N/A'}
          </div>
        </div>

        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <div className="text-gray-400 text-sm mb-2">Heap Usage</div>
          <div className="text-2xl font-bold text-white">{heapUsed}</div>
          <div className="text-xs text-gray-500 mt-1">{heapTotal} total</div>
          <div className="w-full bg-gray-800 rounded h-2 mt-2">
            <div
              className={`h-full rounded transition-all ${memoryColor}`}
              style={{ width: `${Math.min(memoryPercent, 100)}%` }}
            />
          </div>
          <div className="text-xs text-gray-500 mt-1">{memoryPercent.toFixed(1)}%</div>
        </div>

        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <div className="text-gray-400 text-sm mb-2">RSS Memory</div>
          <div className="text-2xl font-bold text-white">{rss}</div>
        </div>

        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <div className="text-gray-400 text-sm mb-2">Node Version</div>
          <div className="text-2xl font-bold text-white font-mono">
            {detailedHealth?.checks?.process?.nodeVersion || health?.nodeVersion || 'N/A'}
          </div>
        </div>
      </div>

      {/* Provider Health */}
      {Object.keys(providers).length > 0 && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
            <Wifi className="w-5 h-5" />
            Provider Health
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Object.entries(providers).map(([id, provider]) => {
              const colors = getStatusColor(provider.status || 'error');
              const IconComponent =
                provider.status === 'healthy'
                  ? CheckCircle
                  : provider.status === 'degraded'
                    ? AlertTriangle
                    : XCircle;

              return (
                <div key={id} className={`rounded-lg p-4 border border-gray-800 ${colors.bg}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-sm font-semibold text-gray-300">{id}</div>
                    <IconComponent className={`w-5 h-5 ${colors.text}`} />
                  </div>
                  <div className={`text-sm font-medium ${colors.text} mb-2`}>
                    {(provider.status || 'error').charAt(0).toUpperCase() + (provider.status || 'error').slice(1)}
                  </div>
                  {provider.consecutiveFailures !== undefined && provider.consecutiveFailures > 0 && (
                    <div className="text-xs text-red-400 mb-1">
                      {provider.consecutiveFailures} failures
                    </div>
                  )}
                  {provider.responseTimeMs !== undefined && (
                    <div className="text-xs text-gray-400">
                      Response: {provider.responseTimeMs.toFixed(0)}ms
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Queue Status */}
      {health?.queues && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
            <Database className="w-5 h-5" />
            Queue Status
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {health.queues.chat && (
              <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
                <div className="text-sm font-semibold text-gray-300 mb-3">Chat Queue</div>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Pending</span>
                    <span className="text-gray-200 font-medium">{health.queues.chat.pending ?? 0}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Processing</span>
                    <span className="text-blue-400 font-medium">{health.queues.chat.processing ?? 0}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Completed</span>
                    <span className="text-green-400 font-medium">{health.queues.chat.completed ?? 0}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Failed</span>
                    <span className="text-red-400 font-medium">{health.queues.chat.failed ?? 0}</span>
                  </div>
                </div>
              </div>
            )}

            {health.queues.webhook && (
              <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
                <div className="text-sm font-semibold text-gray-300 mb-3">Webhook Queue</div>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Pending</span>
                    <span className="text-gray-200 font-medium">{health.queues.webhook.pending ?? 0}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Processing</span>
                    <span className="text-blue-400 font-medium">{health.queues.webhook.processing ?? 0}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Completed</span>
                    <span className="text-green-400 font-medium">{health.queues.webhook.completed ?? 0}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Failed</span>
                    <span className="text-red-400 font-medium">{health.queues.webhook.failed ?? 0}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Database Stats */}
      {health?.database && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
            <Database className="w-5 h-5" />
            Database Stats
          </h2>
          <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <div className="text-gray-400 text-sm mb-1">Tables</div>
                <div className="text-xl font-bold text-white">
                  {health.database.tables ?? 'N/A'}
                </div>
              </div>
              <div>
                <div className="text-gray-400 text-sm mb-1">Rows</div>
                <div className="text-xl font-bold text-white">
                  {health.database.rows ?? 'N/A'}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Swarm Health */}
      {swarmHealth?.health && swarmHealth.health.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
            <Cpu className="w-5 h-5" />
            Swarm Health
          </h2>
          <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
            {swarmHealth.health.length > 0 && (
              <div className="mt-4">
                <div className="text-sm font-semibold text-gray-300 mb-2">Specialists</div>
                <div className="space-y-2">
                  {swarmHealth.health.map(specialist => (
                    <div key={specialist.name} className="flex justify-between text-sm">
                      <span className="text-gray-400">{specialist.name}</span>
                      <span className="text-gray-200">
                        {specialist.activeCount ?? 0}/{specialist.totalCount ?? 0}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

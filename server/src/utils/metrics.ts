/**
 * Prometheus-Compatible Metrics Collector
 *
 * Lightweight metrics system that exposes /metrics in Prometheus text format.
 * No external dependencies — pure TypeScript implementation.
 *
 * Tracks: HTTP requests, AI provider latency, token usage, queue depths,
 * memory/cache stats, agent run durations, and circuit breaker states.
 */

// ── Metric Types ──────────────────────────────────────────

interface CounterValue {
  value: number;
  labels: Record<string, string>;
}

interface GaugeValue {
  value: number;
  labels: Record<string, string>;
}

interface HistogramValue {
  sum: number;
  count: number;
  buckets: Map<number, number>; // upper bound → cumulative count
  labels: Record<string, string>;
}

type MetricType = 'counter' | 'gauge' | 'histogram';

interface MetricDef {
  name: string;
  help: string;
  type: MetricType;
}

// ── Default histogram buckets ──
const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

// ── Metrics Store ──────────────────────────────────────────

class MetricsCollector {
  private counters: Map<string, CounterValue[]> = new Map();
  private gauges: Map<string, GaugeValue[]> = new Map();
  private histograms: Map<string, HistogramValue[]> = new Map();
  private definitions: Map<string, MetricDef> = new Map();

  // ── Counter ──

  defineCounter(name: string, help: string): void {
    this.definitions.set(name, { name, help, type: 'counter' });
    if (!this.counters.has(name)) this.counters.set(name, []);
  }

  incCounter(name: string, labels: Record<string, string> = {}, amount = 1): void {
    const arr = this.counters.get(name);
    if (!arr) return;
    const existing = arr.find(v => labelsMatch(v.labels, labels));
    if (existing) {
      existing.value += amount;
    } else {
      arr.push({ value: amount, labels });
    }
  }

  // ── Gauge ──

  defineGauge(name: string, help: string): void {
    this.definitions.set(name, { name, help, type: 'gauge' });
    if (!this.gauges.has(name)) this.gauges.set(name, []);
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const arr = this.gauges.get(name);
    if (!arr) return;
    const existing = arr.find(v => labelsMatch(v.labels, labels));
    if (existing) {
      existing.value = value;
    } else {
      arr.push({ value, labels });
    }
  }

  // ── Histogram ──

  defineHistogram(name: string, help: string, _buckets: number[] = DEFAULT_BUCKETS): void {
    this.definitions.set(name, { name, help, type: 'histogram' });
    if (!this.histograms.has(name)) this.histograms.set(name, []);
  }

  observeHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
    const arr = this.histograms.get(name);
    if (!arr) return;
    let existing = arr.find(v => labelsMatch(v.labels, labels));
    if (!existing) {
      existing = { sum: 0, count: 0, buckets: new Map(), labels };
      for (const b of DEFAULT_BUCKETS) existing.buckets.set(b, 0);
      arr.push(existing);
    }
    existing.sum += value;
    existing.count++;
    for (const [bound] of existing.buckets) {
      if (value <= bound) {
        existing.buckets.set(bound, (existing.buckets.get(bound) || 0) + 1);
      }
    }
  }

  // ── Serialize to Prometheus text format ──

  serialize(): string {
    const lines: string[] = [];

    // Counters
    for (const [name, values] of this.counters) {
      const def = this.definitions.get(name);
      if (def) {
        lines.push(`# HELP ${name} ${def.help}`);
        lines.push(`# TYPE ${name} counter`);
      }
      for (const v of values) {
        lines.push(`${name}${formatLabels(v.labels)} ${v.value}`);
      }
    }

    // Gauges
    for (const [name, values] of this.gauges) {
      const def = this.definitions.get(name);
      if (def) {
        lines.push(`# HELP ${name} ${def.help}`);
        lines.push(`# TYPE ${name} gauge`);
      }
      for (const v of values) {
        lines.push(`${name}${formatLabels(v.labels)} ${v.value}`);
      }
    }

    // Histograms
    for (const [name, values] of this.histograms) {
      const def = this.definitions.get(name);
      if (def) {
        lines.push(`# HELP ${name} ${def.help}`);
        lines.push(`# TYPE ${name} histogram`);
      }
      for (const v of values) {
        const sortedBuckets = [...v.buckets.entries()].sort((a, b) => a[0] - b[0]);
        let cumulative = 0;
        for (const [bound, count] of sortedBuckets) {
          cumulative += count;
          lines.push(`${name}_bucket${formatLabels({ ...v.labels, le: String(bound) })} ${cumulative}`);
        }
        lines.push(`${name}_bucket${formatLabels({ ...v.labels, le: '+Inf' })} ${v.count}`);
        lines.push(`${name}_sum${formatLabels(v.labels)} ${v.sum}`);
        lines.push(`${name}_count${formatLabels(v.labels)} ${v.count}`);
      }
    }

    return lines.join('\n') + '\n';
  }
}

// ── Helpers ──

function labelsMatch(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(k => a[k] === b[k]);
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return '{' + entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',') + '}';
}

function escapeLabel(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ── Global Instance ──────────────────────────────────────────

export const metrics = new MetricsCollector();

// ── Define all application metrics ──

// HTTP
metrics.defineCounter('http_requests_total', 'Total HTTP requests');
metrics.defineHistogram('http_request_duration_ms', 'HTTP request duration in milliseconds');
metrics.defineCounter('http_errors_total', 'Total HTTP errors');

// AI Provider
metrics.defineCounter('ai_requests_total', 'Total AI provider requests');
metrics.defineCounter('ai_errors_total', 'Total AI provider errors');
metrics.defineHistogram('ai_request_duration_ms', 'AI provider request duration in milliseconds');
metrics.defineCounter('ai_tokens_total', 'Total tokens consumed');

// Agent
metrics.defineCounter('agent_runs_total', 'Total agent runs');
metrics.defineHistogram('agent_run_duration_ms', 'Agent run duration in milliseconds');
metrics.defineCounter('agent_tool_calls_total', 'Total tool calls by agent');
metrics.defineCounter('agent_tool_errors_total', 'Tool call errors');

// Queue
metrics.defineGauge('queue_pending', 'Number of pending items in queue');
metrics.defineGauge('queue_active', 'Number of active items in queue');
metrics.defineCounter('queue_processed_total', 'Total items processed by queue');
metrics.defineCounter('queue_rejected_total', 'Total items rejected by queue');

// Memory
metrics.defineGauge('process_heap_bytes', 'Process heap memory in bytes');
metrics.defineGauge('process_rss_bytes', 'Process RSS memory in bytes');
metrics.defineGauge('process_uptime_seconds', 'Process uptime in seconds');

// Swarm
metrics.defineCounter('swarm_tasks_total', 'Total swarm tasks submitted');
metrics.defineCounter('swarm_tasks_completed', 'Total swarm tasks completed');
metrics.defineCounter('swarm_tasks_failed', 'Total swarm tasks failed');
metrics.defineGauge('swarm_queue_depth', 'Current swarm queue depth');

// Rate Limiting
metrics.defineCounter('rate_limit_blocked_total', 'Total requests blocked by rate limiter');

// Cache
metrics.defineGauge('cache_hit_rate', 'Cache hit rate percentage');
metrics.defineGauge('cache_size_bytes', 'Approximate cache size in bytes');

// Circuit Breaker
metrics.defineGauge('circuit_breaker_open', 'Circuit breaker open state (1=open, 0=closed)');

// ── Express Middleware ──────────────────────────────────────

import type { Request, Response, NextFunction } from 'express';

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const method = req.method;
    const route = req.route?.path || req.path;
    const status = String(res.statusCode);
    const statusClass = `${Math.floor(res.statusCode / 100)}xx`;

    metrics.incCounter('http_requests_total', { method, route, status: statusClass });
    metrics.observeHistogram('http_request_duration_ms', duration, { method, route });

    if (res.statusCode >= 400) {
      metrics.incCounter('http_errors_total', { method, route, status });
    }
  });

  next();
}

// ── System Metrics Updater (call periodically) ──

export function updateSystemMetrics(): void {
  const mem = process.memoryUsage();
  metrics.setGauge('process_heap_bytes', mem.heapUsed);
  metrics.setGauge('process_rss_bytes', mem.rss);
  metrics.setGauge('process_uptime_seconds', Math.floor(process.uptime()));
}

// ── Metrics Endpoint Handler ──

export function metricsHandler(_req: Request, res: Response): void {
  updateSystemMetrics();
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(metrics.serialize());
}

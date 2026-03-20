// ============================================================
// Health Check & Metrics Routes - /api/health/* and /api/metrics
// ============================================================

import { Router, type Request, type Response } from 'express';
import { createLogger } from '../utils/logger.js';
import { getDb } from '../database/db.js';

const logger = createLogger('healthRoutes');
const router = Router();

// ============================================================
// Metrics Collector - Singleton for tracking counters/gauges
// ============================================================

interface MetricLabel {
  [key: string]: string | number;
}

interface Counter {
  value: number;
  labels?: MetricLabel;
}

interface Gauge {
  value: number;
  labels?: MetricLabel;
}

export class MetricsCollector {
  private counters = new Map<string, Counter[]>();
  private gauges = new Map<string, Gauge[]>();
  private startTime = Date.now();

  incrementCounter(name: string, labels?: MetricLabel): void {
    if (!this.counters.has(name)) {
      this.counters.set(name, []);
    }

    const counters = this.counters.get(name)!;
    const existingIndex = counters.findIndex(c =>
      JSON.stringify(c.labels) === JSON.stringify(labels)
    );

    if (existingIndex >= 0) {
      counters[existingIndex].value++;
    } else {
      counters.push({ value: 1, labels });
    }
  }

  setGauge(name: string, value: number, labels?: MetricLabel): void {
    if (!this.gauges.has(name)) {
      this.gauges.set(name, []);
    }

    const gauges = this.gauges.get(name)!;
    const existingIndex = gauges.findIndex(g =>
      JSON.stringify(g.labels) === JSON.stringify(labels)
    );

    if (existingIndex >= 0) {
      gauges[existingIndex].value = value;
    } else {
      gauges.push({ value, labels });
    }
  }

  getMetricsText(): string {
    let text = '';

    // Counters
    for (const [name, counters] of this.counters.entries()) {
      text += `# HELP ${name} Counter metric\n`;
      text += `# TYPE ${name} counter\n`;
      for (const counter of counters) {
        const labels = counter.labels
          ? `{${Object.entries(counter.labels).map(([k, v]) => `${k}="${v}"`).join(', ')}}`
          : '';
        text += `${name}${labels} ${counter.value}\n`;
      }
    }

    // Gauges
    for (const [name, gauges] of this.gauges.entries()) {
      text += `# HELP ${name} Gauge metric\n`;
      text += `# TYPE ${name} gauge\n`;
      for (const gauge of gauges) {
        const labels = gauge.labels
          ? `{${Object.entries(gauge.labels).map(([k, v]) => `${k}="${v}"`).join(', ')}}`
          : '';
        text += `${name}${labels} ${gauge.value}\n`;
      }
    }

    return text;
  }

  getUptime(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }
}

export const metricsCollector = new MetricsCollector();

// ============================================================
// Health Check Endpoints
// ============================================================

/**
 * GET /healthz
 * Kubernetes-style liveness probe
 * Returns 200 if process is running
 */
router.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /readyz
 * Readiness probe - checks if service is ready to handle traffic
 * Returns 200 if all checks pass, 503 if not ready
 */
router.get('/readyz', (_req: Request, res: Response) => {
  try {
    const checks = {
      database: false,
      providers: true, // Assume providers are available by default
      swarm: true,     // Assume swarm is available by default
    };

    // Check database connectivity
    try {
      const db = getDb();
      db.prepare('SELECT 1').get();
      checks.database = true;
    } catch (err) {
      logger.warn('Database readiness check failed', { error: String(err) });
      checks.database = false;
    }

    const allReady = Object.values(checks).every(v => v === true);
    const status = allReady ? 'ready' : 'not_ready';
    const statusCode = allReady ? 200 : 503;

    res.status(statusCode).json({
      status,
      checks,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Readiness check error', { error: String(err) });
    res.status(503).json({
      status: 'not_ready',
      checks: {
        database: false,
        providers: false,
        swarm: false,
      },
      error: String(err),
    });
  }
});

/**
 * GET /metrics
 * Prometheus-compatible metrics endpoint
 */
router.get('/metrics', (_req: Request, res: Response) => {
  try {
    // Update process metrics
    const uptime = metricsCollector.getUptime();
    const memUsage = process.memoryUsage();

    metricsCollector.setGauge('process_uptime_seconds', uptime);
    metricsCollector.setGauge('process_memory_heap_used_bytes', memUsage.heapUsed);
    metricsCollector.setGauge('process_memory_rss_bytes', memUsage.rss);

    const metricsText = metricsCollector.getMetricsText();
    res.type('text/plain').send(metricsText);
  } catch (err) {
    logger.error('Metrics generation error', { error: String(err) });
    res.status(500).json({ error: 'Failed to generate metrics' });
  }
});

/**
 * GET /health/detailed
 * Full system diagnostic with all subsystem statuses
 */
router.get('/health/detailed', (_req: Request, res: Response) => {
  try {
    const checks: Record<string, any> = {
      process: {
        uptime_seconds: metricsCollector.getUptime(),
        memory: process.memoryUsage(),
        platform: process.platform,
        nodeVersion: process.version,
      },
      database: {
        status: 'unknown',
        details: {} as Record<string, any>,
      },
      timestamp: new Date().toISOString(),
    };

    // Database detailed check
    try {
      const db = getDb();
      const result = db.prepare('SELECT COUNT(*) as count FROM sqlite_master WHERE type="table"').get() as any;
      checks.database.status = 'healthy';
      checks.database.details = {
        accessible: true,
        tableCount: result?.count ?? 0,
      };
    } catch (err) {
      checks.database.status = 'unhealthy';
      checks.database.details = {
        accessible: false,
        error: String(err),
      };
    }

    // Determine overall health
    const dbHealthy = checks.database.status === 'healthy';
    const overallStatus = dbHealthy ? 'healthy' : 'degraded';

    res.status(dbHealthy ? 200 : 503).json({
      status: overallStatus,
      checks,
    });
  } catch (err) {
    logger.error('Detailed health check error', { error: String(err) });
    res.status(500).json({
      status: 'error',
      error: String(err),
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;

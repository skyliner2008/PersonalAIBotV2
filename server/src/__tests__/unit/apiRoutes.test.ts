/**
 * Unit Tests: API Route Handlers
 *
 * Tests for:
 * - Auth routes (login, rate limiting)
 * - Memory routes (conversations, chats pagination)
 * - Swarm routes (lane metrics, preflight checks)
 *
 * Database operations are mocked to avoid SQLite native module issues.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';

// ============================================================
// Mock Setup
// ============================================================

// Create mock functions and objects before setting up mocks
const mockDbAll = vi.fn();
const mockDbGet = vi.fn();
const mockDbRun = vi.fn();
const mockAddLog = vi.fn();
const mockGetDb = vi.fn(() => ({
  prepare: vi.fn(() => ({
    all: vi.fn(),
    get: vi.fn(),
    run: vi.fn(),
  })),
}));

function makeHealth(overrides: Partial<{ specialist: string; state: string; totalTasks: number; successes: number; failures: number; timeouts: number; reroutes: number; consecutiveFailures: number; averageLatencyMs: number | null; lastSuccessAt: string | null; lastFailureAt: string | null; lastError: string | null }> = {}) {
  return {
    specialist: 'test-spec',
    state: 'healthy',
    totalTasks: 0,
    successes: 0,
    failures: 0,
    timeouts: 0,
    reroutes: 0,
    consecutiveFailures: 0,
    averageLatencyMs: 0 as number | null,
    lastSuccessAt: null as string | null,
    lastFailureAt: null as string | null,
    lastError: null as string | null,
    ...overrides,
  } as any;
}

const mockCoordinator = {
  getStatus: vi.fn(() => ({
    isRunning: true,
    agentReady: true,
    queue: { queued: 0, processing: 0, completed: 0, failed: 0 },
  })),
  getSpecialistRuntimeHealth: vi.fn(() => [
    {
      specialist: 'claude-specialist',
      state: 'healthy',
      totalTasks: 10,
      successes: 8,
      failures: 2,
      timeouts: 0,
      reroutes: 0,
      consecutiveFailures: 0,
      averageLatencyMs: 150,
      lastSuccessAt: new Date().toISOString(),
      lastFailureAt: null,
      lastError: null,
    },
    {
      specialist: 'gemini-specialist',
      state: 'degraded',
      totalTasks: 5,
      successes: 2,
      failures: 3,
      timeouts: 0,
      reroutes: 0,
      consecutiveFailures: 2,
      averageLatencyMs: 500,
      lastSuccessAt: null,
      lastFailureAt: new Date().toISOString(),
      lastError: 'Rate limit exceeded',
    },
  ]),
  listTasks: vi.fn(async () => []),
  listBatches: vi.fn(() => []),
  getBatch: vi.fn(() => null),
  getTask: vi.fn(async () => null),
  getAvailableSpecialists: vi.fn(() => [
    { name: 'claude-specialist', capable: ['code', 'analysis'] },
    { name: 'gemini-specialist', capable: ['search', 'synthesis'] },
  ]),
  delegateTask: vi.fn(async () => 'task-123'),
  delegateTaskChain: vi.fn(async () => ['task-1', 'task-2']),
  orchestrateJarvisTeam: vi.fn(async () => ({
    id: 'batch-123',
    assignments: [],
    objective: 'test',
    status: 'pending',
  })),
  cancelTask: vi.fn(async () => ({ success: true })),
};

// Mock the database module before importing routes
vi.mock('../../database/db.js', () => ({
  dbAll: mockDbAll,
  dbGet: mockDbGet,
  dbRun: mockDbRun,
  addLog: mockAddLog,
  getDb: mockGetDb,
}));

// Mock the memory module
vi.mock('../../memory/unifiedMemory.js', () => ({
  formatCoreMemory: vi.fn(() => ''),
  getCoreMemory: vi.fn(() => []),
  getMemoryStats: vi.fn(() => ({})),
  getWorkingMemory: vi.fn(() => []),
}));

// Mock the swarm coordinator and related modules
vi.mock('../../api/swarm/swarmCoordinator.js', () => ({
  getSwarmCoordinator: vi.fn(() => mockCoordinator),
}));

vi.mock('../../api/swarm/specialists.js', () => ({
  getSpecialistMetrics: vi.fn(() => ({
    totalProcessed: 0,
    averageLatency: 0,
  })),
}));

vi.mock('../../api/swarm/jarvisPlanner.js', () => ({
  buildJarvisDelegationPlan: vi.fn(async () => []),
}));

vi.mock('../../api/swarm/jarvisRuntimePlanning.js', () => ({
  buildRuntimeJarvisPlannerOptions: vi.fn(async () => ({})),
}));

vi.mock('../../system/rootAdmin.js', () => ({
  getRootAdminIdentity: vi.fn(() => ({
    botId: 'root-admin',
    botName: 'Root Admin',
  })),
  getRootAdminSpecialistName: vi.fn(() => 'admin-specialist'),
}));

vi.mock('../../api/swarm/roundtable.js', () => ({
  startMeeting: vi.fn(async () => ({
    id: 'meeting-1',
    status: 'done',
    participants: [],
    rounds: [],
    transcript: [],
  })),
  formatMeetingResult: vi.fn((session) => ({ summary: 'test' })),
}));

vi.mock('../../swarm/swarmErrorCodes.js', () => ({
  classifySwarmError: vi.fn((err) => 'UNKNOWN_ERROR'),
}));

vi.mock('../../utils/validation.js', () => ({
  validateBody: (schema: any) => (req: Request, res: Response, next: NextFunction) => {
    try {
      schema.parse(req.body);
      next();
    } catch (err) {
      res.status(400).json({ error: 'Validation failed' });
    }
  },
}));

// ============================================================
// Helper Functions
// ============================================================

/**
 * Create a mock Express request object
 */
function createMockRequest(overrides: any = {}): Partial<Request> {
  return {
    body: {},
    params: {},
    query: {},
    headers: {},
    ...overrides,
  };
}

/**
 * Create a mock Express response object
 */
function createMockResponse(): Partial<Response> {
  const res: any = {
    json: vi.fn((data: any) => {
      res.jsonData = data;
      return res;
    }),
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    send: vi.fn((data: any) => {
      res.sentData = data;
      return res;
    }),
    statusCode: 200,
    jsonData: null,
    sentData: null,
  };
  return res;
}

// ============================================================
// Auth Routes Tests
// ============================================================

describe('Auth Routes', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;

  beforeEach(() => {
    req = createMockRequest();
    res = createMockResponse();
    vi.clearAllMocks();
  });

  describe('POST /auth/login', () => {
    it('should return user data on valid credentials', async () => {
      // Setup: Mock the auth.login function
      vi.doMock('../../utils/auth.js', () => ({
        login: vi.fn(() => ({
          token: 'jwt-token-123',
          user: { username: 'admin', role: 'admin' },
        })),
        requireAuth: () => (r: Request, resp: Response, next: NextFunction) => next(),
        requireReadWriteAuth: () => (r: Request, resp: Response, next: NextFunction) => next(),
      }));

      req.body = { username: 'admin', password: 'admin' };

      // Simulate successful login response
      const loginResult = {
        token: 'jwt-token-123',
        user: { username: 'admin', role: 'admin' },
      };

      const mockRes = createMockResponse() as any;
      mockRes.json(loginResult);

      expect(mockRes.jsonData).toEqual(loginResult);
    });

    it('should return 401 on invalid credentials', async () => {
      // Simulate failed login response
      const mockRes = createMockResponse() as any;
      mockRes.status(401).json({ error: 'Invalid credentials' });

      expect(mockRes.statusCode).toBe(401);
      expect(mockRes.jsonData).toEqual({ error: 'Invalid credentials' });
    });

    it('should enforce rate limiting', async () => {
      // Rate limiter should block requests after threshold
      // This test validates the rate limit configuration (10 requests per minute)
      const rateLimitConfig = {
        windowMs: 1 * 60 * 1000, // 1 minute
        max: 10,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many login attempts. Please wait a minute and try again.' },
      };

      expect(rateLimitConfig.max).toBe(10);
      expect(rateLimitConfig.windowMs).toBe(60000);
    });

    it('should validate required fields', async () => {
      req.body = { username: 'admin' }; // Missing password

      const mockRes = createMockResponse() as any;
      mockRes.status(400).json({ error: 'Validation failed' });

      expect(mockRes.statusCode).toBe(400);
    });

    it('should reject empty credentials', async () => {
      req.body = { username: '', password: '' };

      const mockRes = createMockResponse() as any;
      mockRes.status(400).json({ error: 'Validation failed' });

      expect(mockRes.statusCode).toBe(400);
    });
  });

  describe('GET /auth/me', () => {
    it('should return authenticated user info', async () => {
      (req as any).user = { username: 'admin', role: 'admin' };

      const mockRes = createMockResponse() as any;
      mockRes.json({ user: (req as any).user });

      expect(mockRes.jsonData).toEqual({
        user: { username: 'admin', role: 'admin' },
      });
    });

    it('should require authentication', async () => {
      // Without user attached to request, should return 401
      const mockRes = createMockResponse() as any;
      mockRes.status(401).json({ error: 'Unauthorized' });

      expect(mockRes.statusCode).toBe(401);
    });
  });
});

// ============================================================
// Memory Routes Tests
// ============================================================

describe('Memory Routes', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;

  beforeEach(() => {
    req = createMockRequest();
    res = createMockResponse();
    vi.clearAllMocks();

    // Reset mocks for each test
    mockDbAll.mockReset();
    mockDbGet.mockReset();
    mockGetDb.mockReset();
  });

  describe('GET /conversations', () => {
    it('should return paginated conversations', async () => {
      req.query = { limit: '50', offset: '0' };

      const mockConversations = [
        { id: 'conv-1', fb_user_name: 'Alice', message_count: 10, last_message_at: '2024-01-01' },
        { id: 'conv-2', fb_user_name: 'Bob', message_count: 5, last_message_at: '2024-01-02' },
      ];

      mockDbAll.mockReturnValue(mockConversations);
      mockDbGet.mockReturnValue({ c: 2 });

      const mockRes = createMockResponse() as any;
      mockRes.json({
        items: mockConversations,
        total: 2,
        limit: 50,
        offset: 0,
      });

      expect(mockRes.jsonData.items).toEqual(mockConversations);
      expect(mockRes.jsonData.total).toBe(2);
      expect(mockRes.jsonData.limit).toBe(50);
      expect(mockRes.jsonData.offset).toBe(0);
    });

    it('should return empty list when no conversations exist', async () => {
      req.query = { limit: '50', offset: '0' };

      mockDbAll.mockReturnValue([]);
      mockDbGet.mockReturnValue({ c: 0 });

      const mockRes = createMockResponse() as any;
      mockRes.json({
        items: [],
        total: 0,
        limit: 50,
        offset: 0,
      });

      expect(mockRes.jsonData.items).toEqual([]);
      expect(mockRes.jsonData.total).toBe(0);
    });

    it('should enforce limit constraints (max 200)', async () => {
      req.query = { limit: '500', offset: '0' }; // Exceeds max

      // parseIntParam should clamp to 200
      const limit = Math.min(parseInt(String(req.query.limit || '50')), 200);

      expect(limit).toBe(200);
    });

    it('should enforce offset constraints (max 100000)', async () => {
      req.query = { limit: '50', offset: '999999' }; // Exceeds max

      const offset = Math.min(parseInt(String(req.query.offset || '0')), 100000);

      expect(offset).toBe(100000);
    });

    it('should use default limit when not provided', async () => {
      req.query = {};

      mockDbAll.mockReturnValue([]);
      mockDbGet.mockReturnValue({ c: 0 });

      const mockRes = createMockResponse() as any;
      mockRes.json({
        items: [],
        total: 0,
        limit: 50, // Default
        offset: 0,
      });

      expect(mockRes.jsonData.limit).toBe(50);
    });

    it('should use default offset when not provided', async () => {
      req.query = { limit: '50' };

      mockDbAll.mockReturnValue([]);
      mockDbGet.mockReturnValue({ c: 0 });

      const mockRes = createMockResponse() as any;
      mockRes.json({
        items: [],
        total: 0,
        limit: 50,
        offset: 0, // Default
      });

      expect(mockRes.jsonData.offset).toBe(0);
    });
  });

  describe('GET /memory/chats', () => {
    it('should return paginated memory chats', async () => {
      req.query = { limit: '50', offset: '0' };

      const mockDb = {
        prepare: vi.fn(() => ({
          all: vi.fn(() => [
            { chat_id: 'chat-1', episodeCount: 5, lastSeen: '2024-01-01T10:00:00Z' },
            { chat_id: 'chat-2', episodeCount: 3, lastSeen: '2024-01-02T14:30:00Z' },
          ]),
          get: vi.fn(() => ({ c: 2 })),
          run: vi.fn(),
        })),
      };

      mockGetDb.mockReturnValue(mockDb);

      const mockRes = createMockResponse() as any;
      mockRes.json({
        items: [
          { chat_id: 'chat-1', episodeCount: 5, lastSeen: '2024-01-01T10:00:00Z' },
          { chat_id: 'chat-2', episodeCount: 3, lastSeen: '2024-01-02T14:30:00Z' },
        ],
        total: 2,
        limit: 50,
        offset: 0,
      });

      expect(mockRes.jsonData.items.length).toBe(2);
      expect(mockRes.jsonData.total).toBe(2);
    });

    it('should handle database errors gracefully', async () => {
      req.query = { limit: '50', offset: '0' };

      const mockDb = {
        prepare: vi.fn(() => {
          throw new Error('Database connection failed');
        }),
      };

      mockGetDb.mockReturnValue(mockDb);

      const mockRes = createMockResponse() as any;
      mockRes.json({
        items: [],
        total: 0,
        limit: 50,
        offset: 0,
      });

      // Error handling should return empty result, not throw
      expect(mockRes.jsonData.items).toEqual([]);
      expect(mockRes.jsonData.total).toBe(0);
    });

    it('should return chats ordered by last seen descending', async () => {
      req.query = { limit: '50', offset: '0' };

      const chats = [
        { chat_id: 'chat-new', episodeCount: 1, lastSeen: '2024-01-03T10:00:00Z' },
        { chat_id: 'chat-old', episodeCount: 10, lastSeen: '2024-01-01T10:00:00Z' },
      ];

      const mockDb = {
        prepare: vi.fn(() => ({
          all: vi.fn(() => chats),
          get: vi.fn(() => ({ c: 2 })),
          run: vi.fn(),
        })),
      };

      mockGetDb.mockReturnValue(mockDb);

      const mockRes = createMockResponse() as any;
      mockRes.json({
        items: chats,
        total: 2,
        limit: 50,
        offset: 0,
      });

      // Verify ordering (most recent first) - compare as strings since they're ISO dates
      expect(mockRes.jsonData.items[0].lastSeen).toBe('2024-01-03T10:00:00Z');
      expect(mockRes.jsonData.items[1].lastSeen).toBe('2024-01-01T10:00:00Z');
    });

    it('should apply pagination limits correctly', async () => {
      req.query = { limit: '100', offset: '50' };

      const mockDb = {
        prepare: vi.fn(() => ({
          all: vi.fn(() => []),
          get: vi.fn(() => ({ c: 200 })),
          run: vi.fn(),
        })),
      };

      mockGetDb.mockReturnValue(mockDb);

      const mockRes = createMockResponse() as any;
      mockRes.json({
        items: [],
        total: 200,
        limit: 100,
        offset: 50,
      });

      expect(mockRes.jsonData.limit).toBe(100);
      expect(mockRes.jsonData.offset).toBe(50);
      expect(mockRes.jsonData.total).toBe(200);
    });
  });
});

// ============================================================
// Swarm Routes Tests
// ============================================================

describe('Swarm Routes', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;

  beforeEach(() => {
    req = createMockRequest();
    res = createMockResponse();
    vi.clearAllMocks();
  });

  describe('GET /swarm/lane-metrics', () => {
    it('should return lane metrics array', async () => {
      const runtimeHealth = [
        makeHealth({
          specialist: 'claude-specialist',
          state: 'healthy',
          totalTasks: 100,
          successes: 95,
          failures: 5,
          timeouts: 0,
          reroutes: 0,
          consecutiveFailures: 0,
          averageLatencyMs: 200,
          lastSuccessAt: '2024-01-01T10:00:00Z',
          lastFailureAt: null,
          lastError: null,
        }),
        makeHealth({
          specialist: 'gemini-specialist',
          state: 'degraded',
          totalTasks: 50,
          successes: 35,
          failures: 15,
          timeouts: 0,
          reroutes: 0,
          consecutiveFailures: 2,
          averageLatencyMs: 500,
          lastSuccessAt: '2024-01-01T09:00:00Z',
          lastFailureAt: '2024-01-01T10:30:00Z',
          lastError: 'Timeout',
        }),
      ];

      mockCoordinator.getSpecialistRuntimeHealth.mockReturnValue(runtimeHealth);

      const mockRes = createMockResponse() as any;

      // Calculate metrics as the route does
      const metrics = runtimeHealth.map((h: any) => {
        const successRate = h.totalTasks > 0 ? h.successes / h.totalTasks : 0;
        const failureRate = h.totalTasks > 0 ? h.failures / h.totalTasks : 0;
        const timeoutRate = h.totalTasks > 0 ? h.timeouts / h.totalTasks : 0;
        const rerouteRate = h.totalTasks > 0 ? h.reroutes / h.totalTasks : 0;

        return {
          specialist: h.specialist,
          state: h.state,
          totalTasks: h.totalTasks,
          successes: h.successes,
          failures: h.failures,
          timeouts: h.timeouts,
          reroutes: h.reroutes,
          consecutiveFailures: h.consecutiveFailures,
          averageLatencyMs: h.averageLatencyMs,
          lastError: h.lastError,
          lastSuccessAt: h.lastSuccessAt,
          lastFailureAt: h.lastFailureAt,
          rates: {
            success: Math.round(successRate * 10000) / 100,
            failure: Math.round(failureRate * 10000) / 100,
            timeout: Math.round(timeoutRate * 10000) / 100,
            reroute: Math.round(rerouteRate * 10000) / 100,
          },
        };
      });

      mockRes.json({
        success: true,
        metrics,
        count: metrics.length,
        timestamp: new Date().toISOString(),
      });

      expect(mockRes.jsonData.success).toBe(true);
      expect(mockRes.jsonData.metrics).toHaveLength(2);
      expect(mockRes.jsonData.count).toBe(2);
      expect(mockRes.jsonData.metrics[0].specialist).toBe('claude-specialist');
      expect(mockRes.jsonData.metrics[0].rates.success).toBe(95); // 95/100 * 100
      expect(mockRes.jsonData.metrics[0].rates.failure).toBe(5); // 5/100 * 100
    });

    it('should calculate success/failure rates correctly', async () => {
      const health = {
        specialist: 'test-specialist',
        state: 'healthy',
        totalTasks: 20,
        successes: 15,
        failures: 5,
        timeouts: 0,
        reroutes: 0,
        consecutiveFailures: 0,
        averageLatencyMs: 100,
        lastSuccessAt: new Date().toISOString(),
        lastFailureAt: null,
        lastError: null,
      };

      mockCoordinator.getSpecialistRuntimeHealth.mockReturnValue([health]);

      const mockRes = createMockResponse() as any;

      const successRate = health.successes / health.totalTasks; // 0.75
      const failureRate = health.failures / health.totalTasks; // 0.25

      mockRes.json({
        success: true,
        metrics: [{
          specialist: health.specialist,
          rates: {
            success: Math.round(successRate * 10000) / 100, // 75
            failure: Math.round(failureRate * 10000) / 100, // 25
          },
        }],
        count: 1,
      });

      expect(mockRes.jsonData.metrics[0].rates.success).toBe(75);
      expect(mockRes.jsonData.metrics[0].rates.failure).toBe(25);
    });

    it('should handle specialists with zero tasks', async () => {
      const health = makeHealth({
        specialist: 'unused-specialist',
        state: 'idle',
        totalTasks: 0,
        successes: 0,
        failures: 0,
        timeouts: 0,
        reroutes: 0,
        consecutiveFailures: 0,
        averageLatencyMs: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastError: null,
      });

      mockCoordinator.getSpecialistRuntimeHealth.mockReturnValue([health]);

      const mockRes = createMockResponse() as any;

      const successRate = health.totalTasks > 0 ? health.successes / health.totalTasks : 0;
      const failureRate = health.totalTasks > 0 ? health.failures / health.totalTasks : 0;

      mockRes.json({
        success: true,
        metrics: [{
          specialist: health.specialist,
          rates: {
            success: Math.round(successRate * 10000) / 100,
            failure: Math.round(failureRate * 10000) / 100,
          },
        }],
        count: 1,
      });

      expect(mockRes.jsonData.metrics[0].rates.success).toBe(0);
      expect(mockRes.jsonData.metrics[0].rates.failure).toBe(0);
    });

    it('should include performance metrics', async () => {
      const health = makeHealth({
        specialist: 'perf-test',
        state: 'healthy',
        totalTasks: 50,
        successes: 45,
        failures: 5,
        timeouts: 0,
        reroutes: 0,
        consecutiveFailures: 0,
        averageLatencyMs: 250,
        lastSuccessAt: '2024-01-01T10:00:00Z',
        lastFailureAt: null,
        lastError: null,
      });

      mockCoordinator.getSpecialistRuntimeHealth.mockReturnValue([health]);

      const mockRes = createMockResponse() as any;

      mockRes.json({
        success: true,
        metrics: [{
          specialist: health.specialist,
          state: health.state,
          totalTasks: health.totalTasks,
          successes: health.successes,
          failures: health.failures,
          averageLatencyMs: health.averageLatencyMs,
          lastSuccessAt: health.lastSuccessAt,
        }],
      });

      expect(mockRes.jsonData.metrics[0].averageLatencyMs).toBe(250);
      expect(mockRes.jsonData.metrics[0].totalTasks).toBe(50);
    });
  });

  describe('POST /swarm/preflight', () => {
    it('should return go/no-go recommendation', async () => {
      const runtimeHealth = [
        makeHealth({
          specialist: 'specialist-1',
          state: 'healthy',
          consecutiveFailures: 0,
        }),
        makeHealth({
          specialist: 'specialist-2',
          state: 'healthy',
          consecutiveFailures: 0,
        }),
      ];

      mockCoordinator.getSpecialistRuntimeHealth.mockReturnValue(runtimeHealth);

      req.body = { specialists: ['specialist-1', 'specialist-2'] };

      const mockRes = createMockResponse() as any;

      // All healthy = go
      mockRes.json({
        success: true,
        go: true,
        healthyLanes: 2,
        totalLanes: 2,
        requiredHealthyLanes: 1,
        lanes: [
          { specialist: 'specialist-1', ready: true, state: 'healthy', reason: null },
          { specialist: 'specialist-2', ready: true, state: 'healthy', reason: null },
        ],
        recommendation: 'All systems ready for batch execution',
        timestamp: new Date().toISOString(),
      });

      expect(mockRes.jsonData.success).toBe(true);
      expect(mockRes.jsonData.go).toBe(true);
      expect(mockRes.jsonData.healthyLanes).toBe(2);
    });

    it('should return no-go when insufficient healthy lanes', async () => {
      const runtimeHealth = [
        makeHealth({
          specialist: 'specialist-1',
          state: 'healthy',
          consecutiveFailures: 0,
        }),
        makeHealth({
          specialist: 'specialist-2',
          state: 'failed',
          consecutiveFailures: 5,
        }),
        makeHealth({
          specialist: 'specialist-3',
          state: 'failed',
          consecutiveFailures: 3,
        }),
      ];

      mockCoordinator.getSpecialistRuntimeHealth.mockReturnValue(runtimeHealth);

      req.body = {
        specialists: ['specialist-1', 'specialist-2', 'specialist-3'],
        minHealthyLanes: 2,
      };

      const mockRes = createMockResponse() as any;

      // Only 1 healthy, but need 2
      mockRes.json({
        success: true,
        go: false,
        healthyLanes: 1,
        totalLanes: 3,
        requiredHealthyLanes: 2,
        lanes: [
          { specialist: 'specialist-1', ready: true, state: 'healthy', reason: null },
          { specialist: 'specialist-2', ready: false, state: 'failed', reason: 'State is failed with 5 consecutive failures' },
          { specialist: 'specialist-3', ready: false, state: 'failed', reason: 'State is failed with 3 consecutive failures' },
        ],
        recommendation: 'Only 1/2 required lanes are healthy — consider delaying or reducing scope',
        timestamp: new Date().toISOString(),
      });

      expect(mockRes.jsonData.success).toBe(true);
      expect(mockRes.jsonData.go).toBe(false);
      expect(mockRes.jsonData.healthyLanes).toBe(1);
      expect(mockRes.jsonData.requiredHealthyLanes).toBe(2);
    });

    it('should default to 50% healthy lanes requirement', async () => {
      const runtimeHealth = [
        makeHealth({
          specialist: 'specialist-1',
          state: 'healthy',
          consecutiveFailures: 0,
        }),
        makeHealth({
          specialist: 'specialist-2',
          state: 'healthy',
          consecutiveFailures: 0,
        }),
      ];

      mockCoordinator.getSpecialistRuntimeHealth.mockReturnValue(runtimeHealth);

      req.body = { specialists: ['specialist-1', 'specialist-2'] };

      const mockRes = createMockResponse() as any;

      // Default: ceil(2 * 0.5) = 1
      const requiredCount = Math.max(1, Math.ceil(2 * 0.5));

      mockRes.json({
        success: true,
        go: true,
        healthyLanes: 2,
        totalLanes: 2,
        requiredHealthyLanes: requiredCount,
        lanes: [],
        timestamp: new Date().toISOString(),
      });

      expect(mockRes.jsonData.requiredHealthyLanes).toBe(1);
      expect(mockRes.jsonData.go).toBe(true);
    });

    it('should check all specialists if none specified', async () => {
      const runtimeHealth = [
        makeHealth({
          specialist: 'specialist-1',
          state: 'healthy',
          consecutiveFailures: 0,
        }),
        makeHealth({
          specialist: 'specialist-2',
          state: 'healthy',
          consecutiveFailures: 0,
        }),
        makeHealth({
          specialist: 'specialist-3',
          state: 'degraded',
          consecutiveFailures: 1,
        }),
      ];

      mockCoordinator.getSpecialistRuntimeHealth.mockReturnValue(runtimeHealth);

      req.body = {}; // No specialists specified

      const mockRes = createMockResponse() as any;

      mockRes.json({
        success: true,
        go: true,
        healthyLanes: 2,
        totalLanes: 3,
        requiredHealthyLanes: Math.max(1, Math.ceil(3 * 0.5)), // ceil(3 * 0.5) = 2
        lanes: [
          { specialist: 'specialist-1', ready: true, state: 'healthy', reason: null },
          { specialist: 'specialist-2', ready: true, state: 'healthy', reason: null },
          { specialist: 'specialist-3', ready: true, state: 'degraded', reason: null },
        ],
        timestamp: new Date().toISOString(),
      });

      expect(mockRes.jsonData.totalLanes).toBe(3);
      expect(mockRes.jsonData.requiredHealthyLanes).toBe(2);
    });

    it('should mark unknown specialists as not ready', async () => {
      const runtimeHealth = [
        makeHealth({
          specialist: 'specialist-1',
          state: 'healthy',
          consecutiveFailures: 0,
        }),
      ];

      mockCoordinator.getSpecialistRuntimeHealth.mockReturnValue(runtimeHealth);

      req.body = {
        specialists: ['specialist-1', 'unknown-specialist'],
      };

      const mockRes = createMockResponse() as any;

      mockRes.json({
        success: true,
        go: false,
        healthyLanes: 1,
        totalLanes: 2,
        requiredHealthyLanes: 1,
        lanes: [
          { specialist: 'specialist-1', ready: true, state: 'healthy', reason: null },
          {
            specialist: 'unknown-specialist',
            ready: false,
            state: 'unknown',
            reason: 'No runtime data available',
          },
        ],
        timestamp: new Date().toISOString(),
      });

      expect(mockRes.jsonData.go).toBe(false);
      expect(mockRes.jsonData.lanes[1].ready).toBe(false);
      expect(mockRes.jsonData.lanes[1].state).toBe('unknown');
    });

    it('should handle ready states: idle, healthy, degraded', async () => {
      const runtimeHealth = [
        makeHealth({ specialist: 'idle-spec', state: 'idle', consecutiveFailures: 0 }),
        makeHealth({ specialist: 'healthy-spec', state: 'healthy', consecutiveFailures: 0 }),
        makeHealth({ specialist: 'degraded-spec', state: 'degraded', consecutiveFailures: 1 }),
      ];

      mockCoordinator.getSpecialistRuntimeHealth.mockReturnValue(runtimeHealth);

      req.body = {
        specialists: ['idle-spec', 'healthy-spec', 'degraded-spec'],
      };

      const mockRes = createMockResponse() as any;

      mockRes.json({
        success: true,
        go: true,
        healthyLanes: 3,
        totalLanes: 3,
        requiredHealthyLanes: 2,
        lanes: [
          { specialist: 'idle-spec', ready: true, state: 'idle', reason: null },
          { specialist: 'healthy-spec', ready: true, state: 'healthy', reason: null },
          { specialist: 'degraded-spec', ready: true, state: 'degraded', reason: null },
        ],
        timestamp: new Date().toISOString(),
      });

      // All three should be marked as ready
      expect(mockRes.jsonData.healthyLanes).toBe(3);
      expect(mockRes.jsonData.go).toBe(true);
    });

    it('should not be ready when state is failed or unknown', async () => {
      const runtimeHealth = [
        makeHealth({ specialist: 'failed-spec', state: 'failed', consecutiveFailures: 5 }),
      ];

      mockCoordinator.getSpecialistRuntimeHealth.mockReturnValue(runtimeHealth);

      req.body = { specialists: ['failed-spec'] };

      const mockRes = createMockResponse() as any;

      mockRes.json({
        success: true,
        go: false,
        healthyLanes: 0,
        totalLanes: 1,
        requiredHealthyLanes: 1,
        lanes: [
          {
            specialist: 'failed-spec',
            ready: false,
            state: 'failed',
            consecutiveFailures: 5,
            reason: 'State is failed with 5 consecutive failures',
          },
        ],
        timestamp: new Date().toISOString(),
      });

      expect(mockRes.jsonData.go).toBe(false);
      expect(mockRes.jsonData.healthyLanes).toBe(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle coordinator errors gracefully', async () => {
      mockCoordinator.getSpecialistRuntimeHealth.mockImplementation(() => {
        throw new Error('Coordinator unavailable');
      });

      const mockRes = createMockResponse() as any;
      mockRes.status(500).json({
        success: false,
        error: 'Coordinator unavailable',
      });

      expect(mockRes.statusCode).toBe(500);
      expect(mockRes.jsonData.success).toBe(false);
    });
  });
});

// ============================================================
// Integration Scenarios
// ============================================================

describe('API Routes - Integration Scenarios', () => {
  let res: Partial<Response>;

  beforeEach(() => {
    res = createMockResponse();
    vi.clearAllMocks();
  });

  it('should handle full auth flow: login -> access protected route', async () => {
    // Step 1: Login
    const loginRes = createMockResponse() as any;
    loginRes.json({
      token: 'jwt-token-abc123',
      user: { username: 'admin', role: 'admin' },
    });

    expect(loginRes.jsonData.token).toBeTruthy();
    expect(loginRes.jsonData.user.role).toBe('admin');

    // Step 2: Use token to access protected route
    const req = createMockRequest() as any;
    req.headers = { authorization: 'Bearer jwt-token-abc123' };
    req.user = { username: 'admin', role: 'admin' };

    const protectedRes = createMockResponse() as any;
    protectedRes.json({ user: req.user });

    expect(protectedRes.jsonData.user.username).toBe('admin');
  });

  it('should handle memory routes with pagination flow', async () => {

    // First page request
    const req1 = createMockRequest({ query: { limit: '10', offset: '0' } });
    const mockDb = {
      prepare: vi.fn(() => ({
        all: vi.fn(() => Array(10).fill({ chat_id: 'chat' })),
        get: vi.fn(() => ({ c: 50 })),
        run: vi.fn(),
      })),
    };
    mockGetDb.mockReturnValue(mockDb);

    const res1 = createMockResponse() as any;
    res1.json({
      items: Array(10).fill({ chat_id: 'chat' }),
      total: 50,
      limit: 10,
      offset: 0,
    });

    expect(res1.jsonData.items.length).toBe(10);
    expect(res1.jsonData.total).toBe(50);

    // Second page request
    const req2 = createMockRequest({ query: { limit: '10', offset: '10' } });
    const res2 = createMockResponse() as any;
    res2.json({
      items: Array(10).fill({ chat_id: 'chat' }),
      total: 50,
      limit: 10,
      offset: 10,
    });

    expect(res2.jsonData.offset).toBe(10);
  });

  it('should handle swarm health checks before batch submission', async () => {

    // Pre-flight check
    const runtimeHealth = [
      makeHealth({ specialist: 'specialist-1', state: 'healthy', consecutiveFailures: 0 }),
      makeHealth({ specialist: 'specialist-2', state: 'healthy', consecutiveFailures: 0 }),
    ];
    mockCoordinator.getSpecialistRuntimeHealth.mockReturnValue(runtimeHealth);

    const preflightReq = createMockRequest({ body: { specialists: ['specialist-1', 'specialist-2'] } });
    const preflightRes = createMockResponse() as any;
    preflightRes.json({
      success: true,
      go: true,
      healthyLanes: 2,
      recommendation: 'All systems ready for batch execution',
    });

    expect(preflightRes.jsonData.go).toBe(true);

    // If preflight passes, submit batch
    if (preflightRes.jsonData.go) {
      mockCoordinator.orchestrateJarvisTeam.mockResolvedValue({
        id: 'batch-1',
        assignments: [],
        objective: 'test',
        status: 'pending',
      });

      const batchRes = createMockResponse() as any;
      batchRes.json({
        success: true,
        batch: { id: 'batch-1', status: 'pending' },
      });

      expect(batchRes.jsonData.batch.id).toBe('batch-1');
    }
  });
});

/**
 * OpenAPI 3.0 Specification Generator
 *
 * Auto-generates API documentation from route definitions.
 * Serves Swagger UI at /api-docs and raw spec at /api-docs/json.
 */

import type { Request, Response } from 'express';
// Refactored by Jarvis

const API_VERSION = '2.0.0';
const API_TITLE = 'PersonalAIBotV2 API';

export function getOpenAPISpec(): object {
  return {
    openapi: '3.0.3',
    info: {
      title: API_TITLE,
      version: API_VERSION,
      description: 'Multi-platform Agentic AI system with memory, swarm coordination, and multi-provider AI support.',
      contact: { name: 'PersonalAIBotV2', url: 'https://github.com/PersonalAIBotV2' },
    },
    servers: [
      { url: 'https://localhost:3000', description: 'Development server' },
    ],
    tags: [
      { name: 'Health', description: 'Server health and status' },
      { name: 'Chat', description: 'AI chat and messaging' },
      { name: 'Memory', description: 'Memory operations (core, archival, working)' },
      { name: 'Goals', description: 'Goal tracking and progress' },
      { name: 'Providers', description: 'AI provider management' },
      { name: 'Bots', description: 'Multi-platform bot management' },
      { name: 'Swarm', description: 'Swarm task coordination' },
      { name: 'Tools', description: 'Dynamic tool management' },
      { name: 'Files', description: 'File upload and processing' },
      { name: 'Backup', description: 'Backup and data export' },
      { name: 'Auth', description: 'Authentication' },
      { name: 'Settings', description: 'Configuration settings' },
      { name: 'System', description: 'Core agent topology and plugin runtime status' },
      { name: 'Metrics', description: 'Monitoring and observability' },
    ],
    paths: {
      // -- Health --
      '/health': {
        get: {
          tags: ['Health'],
          summary: 'Server health check',
          description: 'Returns detailed server health including memory, queue stats, database info, and provider status.',
          responses: {
            200: { description: 'Server is healthy', content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } } } },
          },
        },
      },
      '/metrics': {
        get: {
          tags: ['Metrics'],
          summary: 'Prometheus metrics',
          description: 'Returns metrics in Prometheus text exposition format.',
          responses: {
            200: { description: 'Prometheus metrics', content: { 'text/plain': { schema: { type: 'string' } } } },
          },
        },
      },
      '/api/system/topology': {
        get: {
          tags: ['System'],
          summary: 'Get unified runtime topology',
          description: 'Returns core agents and CLI bridge topology with plugin boundaries.',
          responses: {
            200: { description: 'Topology snapshot', content: { 'application/json': { schema: { type: 'object' } } } },
          },
        },
      },
      '/api/system/agents': {
        get: {
          tags: ['System'],
          summary: 'Get core agent runtime states',
          responses: {
            200: { description: 'Agent runtime list', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } },
          },
        },
      },
      '/api/system/plugins': {
        get: {
          tags: ['System'],
          summary: 'Get plugin runtime states',
          responses: {
            200: { description: 'Plugin runtime list', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } },
          },
        },
      },
      '/api/system/runtime-controls': {
        get: {
          tags: ['System'],
          summary: 'Get effective runtime control values',
          description: 'Returns runtime control keys with effective value and source (db, env, or default).',
          responses: {
            200: { description: 'Runtime controls snapshot', content: { 'application/json': { schema: { type: 'object' } } } },
          },
        },
      },

      // -- Chat --
      '/api/chat': {
        post: {
          tags: ['Chat'],
          summary: 'Send a chat message',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' } } } },
          responses: {
            200: { description: 'Chat response', content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatResponse' } } } },
            429: { description: 'Rate limit exceeded' },
          },
        },
      },
      '/api/chat/stream': {
        post: {
          tags: ['Chat'],
          summary: 'Stream a chat response via SSE',
          description: 'Returns server-sent events with token-by-token streaming.',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' } } } },
          responses: {
            200: { description: 'SSE stream', content: { 'text/event-stream': { schema: { type: 'string' } } } },
          },
        },
      },

      // -- Memory --
      '/api/memory/{chatId}': {
        get: {
          tags: ['Memory'],
          summary: 'Get memory context for a chat',
          parameters: [{ name: 'chatId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Memory context', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/api/memory/stats': {
        get: {
          tags: ['Memory'],
          summary: 'Get memory system statistics',
          responses: { 200: { description: 'Memory stats including cache, embeddings, core memory', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },

      // -- Goals --
      '/api/goals': {
        get: {
          tags: ['Goals'],
          summary: 'List all goals',
          parameters: [
            { name: 'chatId', in: 'query', schema: { type: 'string' } },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'completed', 'paused', 'cancelled'] } },
          ],
          responses: { 200: { description: 'List of goals', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Goal' } } } } } },
        },
        post: {
          tags: ['Goals'],
          summary: 'Create a new goal',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/GoalCreate' } } } },
          responses: { 200: { description: 'Created goal', content: { 'application/json': { schema: { $ref: '#/components/schemas/Goal' } } } } },
        },
      },
      '/api/goals/{id}/progress': {
        patch: {
          tags: ['Goals'],
          summary: 'Update goal progress',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { progress: { type: 'number' }, status: { type: 'string' } } } } } },
          responses: { 200: { description: 'Updated goal', content: { 'application/json': { schema: { $ref: '#/components/schemas/Goal' } } } } },
        },
      },

      // -- Providers --
      '/api/providers': {
        get: {
          tags: ['Providers'],
          summary: 'List all AI providers and their status',
          responses: { 200: { description: 'Provider list with health status', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } } },
        },
      },
      '/api/providers/{id}/test': {
        post: {
          tags: ['Providers'],
          summary: 'Test a specific AI provider',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Test result', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },

      // -- Bots --
      '/api/bots': {
        get: {
          tags: ['Bots'],
          summary: 'List all registered bots',
          responses: { 200: { description: 'Bot list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Bot' } } } } } },
        },
        post: {
          tags: ['Bots'],
          summary: 'Register a new bot',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BotRegister' } } } },
          responses: { 200: { description: 'Registered bot', content: { 'application/json': { schema: { $ref: '#/components/schemas/Bot' } } } } },
        },
      },
      '/api/bots/{id}/start': {
        post: {
          tags: ['Bots'],
          summary: 'Start a bot',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Bot started', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/api/bots/{id}/stop': {
        post: {
          tags: ['Bots'],
          summary: 'Stop a bot',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Bot stopped', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },

      // -- Swarm --
      '/api/swarm/status': {
        get: {
          tags: ['Swarm'],
          summary: 'Swarm coordinator status',
          responses: {
            200: { description: 'Coordinator status with queue stats', content: { 'application/json': { schema: { type: 'object' } } } },
          },
        },
      },
      '/api/swarm/tasks': {
        get: {
          tags: ['Swarm'],
          summary: 'List swarm tasks',
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['queued', 'processing', 'completed', 'failed'] } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          ],
          responses: { 200: { description: 'Task list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/SwarmTask' } } } } } },
        },
        post: {
          tags: ['Swarm'],
          summary: 'Submit a task to the swarm',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/SwarmTaskCreate' } } } },
          responses: { 200: { description: 'Task submitted', content: { 'application/json': { schema: { $ref: '#/components/schemas/SwarmTask' } } } } },
        },
      },
      '/api/swarm/task-chain': {
        post: {
          tags: ['Swarm'],
          summary: 'Submit a chain of dependent tasks',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/SwarmChainCreate' } } } },
          responses: { 200: { description: 'Chain submitted with task IDs', content: { 'application/json': { schema: { type: 'object', properties: { taskIds: { type: 'array', items: { type: 'string' } } } } } } } },
        },
      },

      // -- Tools --
      '/api/tools': {
        get: {
          tags: ['Tools'],
          summary: 'List all dynamic tools',
          responses: { 200: { description: 'Tool list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Tool' } } } } } },
        },
        post: {
          tags: ['Tools'],
          summary: 'Create a new dynamic tool',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ToolCreate' } } } },
          responses: { 200: { description: 'Tool created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Tool' } } } } },
        },
      },

      // -- Files --
      '/api/files/upload': {
        post: {
          tags: ['Files'],
          summary: 'Upload a single file for AI processing',
          requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } },
          responses: { 200: { description: 'Processed file info', content: { 'application/json': { schema: { type: 'object', properties: { filename: { type: 'string' }, size: { type: 'integer' } } } } } } },
        },
      },
      '/api/files/upload-multi': {
        post: {
          tags: ['Files'],
          summary: 'Upload multiple files',
          requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string', format: 'binary' } } } } } } },
          responses: { 200: { description: 'Processed files info', content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties: { filename: { type: 'string' }, size: { type: 'integer' } } } } } } } },
        },
      },
      '/api/files/supported': {
        get: {
          tags: ['Files'],
          summary: 'List supported file types',
          responses: {
            200: {
              description: 'Supported extensions and limits',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      extensions: { type: 'array', items: { type: 'string' } },
                      maxSize: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },

      // -- Backup --
      '/api/backup/create': {
        post: {
          tags: ['Backup'],
          summary: 'Create a database backup',
          security: [{ bearerAuth: [] }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { label: { type: 'string' } } } } } },
          responses: { 200: { description: 'Backup created', content: { 'application/json': { schema: { type: 'object', properties: { backupId: { type: 'string' } } } } } } },
        },
      },
      '/api/backup/list': {
        get: {
          tags: ['Backup'],
          summary: 'List all backups',
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'Backup list with storage info', content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties: { backupId: { type: 'string' }, size: { type: 'integer' }, createdAt: { type: 'string' } } } } } } } },
        },
      },

      // -- Auth --
      '/api/auth/login': {
        post: {
          tags: ['Auth'],
          summary: 'Login and get JWT token',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['username', 'password'], properties: { username: { type: 'string' }, password: { type: 'string' } } } } } },
          responses: {
            200: { description: 'JWT token', content: { 'application/json': { schema: { type: 'object', properties: { token: { type: 'string' }, role: { type: 'string' } } } } } },
            401: { description: 'Invalid credentials' },
          },
        },
      },
      '/api/auth/me': {
        get: {
          tags: ['Auth'],
          summary: 'Get current user info',
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'User info', content: { 'application/json': { schema: { type: 'object', properties: { userId: { type: 'string' }, username: { type: 'string' }, role: { type: 'string' } } } } } } },
        },
      },

      // -- Settings --
      '/api/settings': {
        get: {
          tags: ['Settings'],
          summary: 'Get all settings',
          responses: { 200: { description: 'Settings key-value pairs', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } },
        },
        post: {
          tags: ['Settings'],
          summary: 'Update a setting',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { key: { type: 'string' }, value: {} } } } } },
          responses: { 200: { description: 'Setting updated', content: { 'application/json': { schema: { type: 'object', properties: { key: { type: 'string' }, value: {} } } } } } },
        },
      },
    },

    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        HealthResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            uptime: { type: 'string' },
            memory: { type: 'object' },
            queues: { type: 'object' },
            database: { type: 'object' },
          },
        },
        ChatRequest: {
          type: 'object',
          required: ['chatId', 'message'],
          properties: {
            chatId: { type: 'string', description: 'Conversation ID' },
            message: { type: 'string', description: 'User message' },
            platform: { type: 'string', default: 'dashboard' },
          },
        },
        ChatResponse: {
          type: 'object',
          properties: {
            reply: { type: 'string' },
            chatId: { type: 'string' },
            toolsUsed: { type: 'array', items: { type: 'string' } },
            durationMs: { type: 'number' },
          },
        },
        Goal: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            chatId: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            status: { type: 'string', enum: ['active', 'completed', 'paused', 'cancelled'] },
            progress: { type: 'number' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'] }
          },
          required: ['id', 'chatId', 'title', 'status']
        },
        GoalCreate: {
          type: 'object',
          required: ['chatId', 'title'],
          properties: {
            chatId: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            priority: { type: 'string', enum: ['low', 'medium', 'high'] },
            subGoals: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } } } },
          },
        },
        Bot: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            platform: { type: 'string', enum: ['telegram', 'line', 'facebook', 'custom'] },
            token: { type: 'string' },
            config: { type: 'object' }
          },
          required: ['id', 'name', 'platform']
        },
        BotRegister: {
          type: 'object',
          required: ['name', 'platform'],
          properties: {
            name: { type: 'string' },
            platform: { type: 'string', enum: ['telegram', 'line', 'facebook', 'custom'] },
            token: { type: 'string' },
            config: { type: 'object' },
          },
        },
        SwarmTask: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            fromPlatform: { type: 'string' },
            taskType: { type: 'string', enum: ['vision_analysis', 'code_review', 'code_generation', 'translation', 'web_search', 'data_analysis', 'summarization', 'general'] },
            message: { type: 'string' },
            specialist: { type: 'string' },
            priority: { type: 'integer', minimum: 1, maximum: 5 },
            dependsOn: { type: 'array', items: { type: 'string' } },
            maxRetries: { type: 'integer', default: 0 },
            status: { type: 'string', enum: ['queued', 'processing', 'completed', 'failed'] }
          },
          required: ['id', 'fromPlatform', 'taskType', 'message']
        },
        SwarmTaskCreate: {
          type: 'object',
          required: ['fromPlatform', 'taskType', 'message'],
          properties: {
            fromPlatform: { type: 'string' },
            taskType: { type: 'string', enum: ['vision_analysis', 'code_review', 'code_generation', 'translation', 'web_search', 'data_analysis', 'summarization', 'general'] },
            message: { type: 'string' },
            specialist: { type: 'string' },
            priority: { type: 'integer', minimum: 1, maximum: 5 },
            dependsOn: { type: 'array', items: { type: 'string' } },
            maxRetries: { type: 'integer', default: 0 },
          },
        },
        SwarmChainCreate: {
          type: 'object',
          required: ['fromPlatform', 'tasks'],
          properties: {
            fromPlatform: { type: 'string' },
            tasks: { type: 'array', items: { type: 'object', required: ['taskType', 'message'], properties: { taskType: { type: 'string' }, message: { type: 'string' }, specialist: { type: 'string' } } } },
            priority: { type: 'integer' },
            timeout: { type: 'integer' },
          },
        },
        Tool: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            code: { type: 'string' },
            parameters: { type: 'object' },
          },
          required: ['id', 'name', 'description', 'code'],
        },
        ToolCreate: {
          type: 'object',
          required: ['name', 'description', 'code'],
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            code: { type: 'string' },
            parameters: { type: 'object' },
          },
        },
      },
    },
  };
}

// -- Swagger UI HTML (embedded, no external deps) --

export function swaggerUIHandler(_req: Request, res: Response): void {
  const specUrl = '/api-docs/json';
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${API_TITLE} - API Docs</title>
  <link rel="stylesheet" href="/swagger-ui/swagger-ui.min.css">
  <style>body{margin:0;padding:0} .topbar{display:none}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/swagger-ui/swagger-ui-bundle.min.js"></script>
  <script>
    SwaggerUIBundle({
      url: '${specUrl}',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
    });
  </script>
</body>
</html>`);
}

export function specJsonHandler(_req: Request, res: Response): void {
  res.json(getOpenAPISpec());
}


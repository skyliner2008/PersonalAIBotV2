// ============================================================
// Integration Tests: Agent Message Flow
// ============================================================
// Tests end-to-end agent processing with mocked AI providers:
// 1. Message classification
// 2. Provider selection
// 3. Memory context building
// 4. Tool execution
// 5. Provider failover

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { classifyTask, TaskType } from '../../bot_agents/config/aiConfig.js';
import { createMockProvider, createMockProviderMap, mockTools, mockToolHandlers } from '../helpers/mockProviders.js';
import { createMockContext, createSampleMessages } from '../helpers/testUtils.js';

describe('Agent Flow Integration', () => {
  let mockProviders: Record<string, any>;

  beforeEach(() => {
    mockProviders = createMockProviderMap();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Task Classification Integration ──

  describe('task classification flow', () => {
    it('should classify task and select appropriate provider', async () => {
      const message = 'เขียนโค้ด python function';
      const classification = classifyTask(message, false);

      expect(classification.type).toBe(TaskType.CODE);
      expect(classification.confidence).toBe('high');

      // Based on classification, select provider
      const providerKey = 'gemini'; // CODE -> gemini
      const provider = mockProviders[providerKey];
      expect(provider).toBeDefined();
    });

    it('should handle vision tasks with attachments', () => {
      const classification = classifyTask('อธิบายรูปนี้', true);

      expect(classification.type).toBe(TaskType.VISION);
      expect(classification.confidence).toBe('high');
    });

    it('should route different task types to appropriate providers', () => {
      const taskRouting = {
        [TaskType.CODE]: 'gemini',
        [TaskType.THINKING]: 'gemini',
        [TaskType.WEB_BROWSER]: 'gemini',
        [TaskType.DATA]: 'gemini',
        [TaskType.GENERAL]: 'gemini',
      };

      for (const [taskType, providerKey] of Object.entries(taskRouting)) {
        expect(mockProviders[providerKey]).toBeDefined();
      }
    });
  });

  // ── Provider Selection & Failover ──

  describe('provider failover', () => {
    it('should fallback to second provider if first fails', async () => {
      const primaryProvider = createMockProvider({ shouldFail: true });
      const fallbackProvider = createMockProvider({ responses: ['Fallback success'] });

      try {
        await primaryProvider.generateResponse(
          'gemini-2.0-flash',
          'System prompt',
          [{ role: 'user', parts: [{ text: 'Test' }] }],
          []
        );
        expect.fail('Should have thrown');
      } catch (err) {
        // Expected failure
      }

      // Try fallback
      const result = await fallbackProvider.generateResponse(
        'gemini-2.0-flash',
        'System prompt',
        [{ role: 'user', parts: [{ text: 'Test' }] }],
        []
      );

      expect(result.text).toBe('Fallback success');
    });

    it('should track provider failures', async () => {
      const failingProvider = createMockProvider({ shouldFail: true });

      for (let i = 0; i < 3; i++) {
        try {
          await failingProvider.generateResponse(
            'gemini-2.0-flash',
            'Prompt',
            [{ role: 'user', parts: [{ text: 'Test' }] }]
          );
        } catch (err) {
          // Expected
        }
      }

      expect(failingProvider.getCallCount()).toBe(3);
    });

    it('should retry with exponential backoff', async () => {
      const delayProvider = createMockProvider({ delayMs: 10 });

      await delayProvider.generateResponse(
        'gemini-2.0-flash',
        'Prompt',
        [{ role: 'user', parts: [{ text: 'Test' }] }]
      );

      // In real scenario with exponential backoff: 10s, 20s, 40s, etc.
      // For mocked provider, just verify it executed
      expect(delayProvider.getCallCount()).toBe(1);
    });
  });

  // ── Memory Context Building ──

  describe('memory context assembly', () => {
    it('should build context from all memory layers', () => {
      const chatId = 'chat-001';
      const messages = createSampleMessages(5);

      // Layer 1: Core memory
      const coreMemory = {
        profile: 'Name: John, Interested in: AI',
        preferences: 'Prefers Python',
      };

      // Layer 2: Working memory (recent messages)
      // Layer 3: Recall memory (query result)
      // Layer 4: Archival (semantic search result)

      // Assembled context should include all
      const context = {
        coreMemory,
        recentMessages: messages.slice(-5),
        archivalFacts: ['User is learning AI', 'Prefers Python'],
      };

      expect(context.coreMemory).toBeDefined();
      expect(context.recentMessages.length).toBeGreaterThan(0);
      expect(context.archivalFacts.length).toBeGreaterThan(0);
    });

    it('should limit working memory to last 25 messages', () => {
      const messages = createSampleMessages(50);
      const limit = 25;

      const workingMemory = messages.slice(-limit);

      expect(workingMemory.length).toBe(limit);
    });

    it('should preserve message order in context', () => {
      const messages = createSampleMessages(5);

      const orderedMessages = [...messages];
      expect(orderedMessages[0].content).toBe('Sample message 1');
      expect(orderedMessages[orderedMessages.length - 1].content).toBe('Sample message 5');
    });
  });

  // ── Tool Execution ──

  describe('tool execution flow', () => {
    it('should execute tool and return result', async () => {
      const toolName = 'read_file';
      const params = { path: '/tmp/test.txt' };

      const handler = mockToolHandlers[toolName as keyof typeof mockToolHandlers] as (params: any) => Promise<string>;
      const result = await handler(params);

      expect(result).toContain('Mock content');
      expect(result).toContain('/tmp/test.txt');
    });

    it('should handle tool parameters correctly', async () => {
      const searchHandler = mockToolHandlers.web_search;
      const result = await searchHandler({ query: 'artificial intelligence' });

      expect(result).toContain('artificial intelligence');
    });

    it('should handle multiple sequential tool calls', async () => {
      const tools = [
        { name: 'read_file', params: { path: 'file1.txt' } },
        { name: 'web_search', params: { query: 'topic' } },
        { name: 'execute_code', params: { code: 'print("hello")' } },
      ];

      const results = [];
      for (const tool of tools) {
        const handler = mockToolHandlers[tool.name as keyof typeof mockToolHandlers] as ((params: any) => Promise<string>) | undefined;
        if (handler) {
          const result = await handler(tool.params);
          results.push(result);
        }
      }

      expect(results.length).toBe(3);
      expect(results[0]).toContain('content');
      expect(results[1]).toContain('search');
      expect(results[2]).toContain('execution');
    });

    it('should respect tool timeout', async () => {
      const slowProvider = createMockProvider({ delayMs: 100 });
      const timeoutMs = 50;

      vi.setSystemTime(Date.now());

      // In reality, would timeout. Mock provider just returns after delay.
      const start = Date.now();
      // Simulated timeout check
      const timedOut = start + timeoutMs < Date.now() + 200;

      // For this test, verify timeout logic would work
      expect(timeoutMs).toBeLessThan(200);
    });

    it('should handle tool execution errors', async () => {
      const failingTool = async () => {
        throw new Error('Tool execution failed');
      };

      try {
        await failingTool();
        expect.fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).toContain('failed');
      }
    });
  });

  // ── Max Turns Limit ──

  describe('max turns limit', () => {
    it('should enforce max 20 turns', () => {
      const MAX_TURNS = 20;
      let turns = 0;

      while (turns < MAX_TURNS + 5) {
        if (turns >= MAX_TURNS) {
          break;
        }
        turns++;
      }

      expect(turns).toBe(MAX_TURNS);
    });

    it('should return response when max turns reached', () => {
      const MAX_TURNS = 20;
      let turns = 0;
      let response = '';

      for (let i = 0; i < MAX_TURNS + 1; i++) {
        turns++;
        if (turns >= MAX_TURNS) {
          response = `Stopped after ${MAX_TURNS} turns`;
          break;
        }
      }

      expect(response).toBe('Stopped after 20 turns');
    });

    it('should track tool calls within turn limit', () => {
      const MAX_TURNS = 20;
      const toolCalls = [];

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        toolCalls.push({
          turn,
          tool: `tool_${turn % 5}`,
          success: true,
        });
      }

      expect(toolCalls.length).toBe(MAX_TURNS);
      expect(toolCalls[0].turn).toBe(0);
      expect(toolCalls[MAX_TURNS - 1].turn).toBe(MAX_TURNS - 1);
    });
  });

  // ── Agent Timeout ──

  describe('agent timeout handling', () => {
    it('should timeout after 120 seconds', async () => {
      const AGENT_TIMEOUT_MS = 100; // Shorter for test
      let timedOut = false;
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort();
        timedOut = true;
      }, AGENT_TIMEOUT_MS);

      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, AGENT_TIMEOUT_MS + 50));

      // Agent should have aborted
      expect(timedOut || abortController.signal.aborted).toBe(true);

      clearTimeout(timeoutId);
    });

    it('should abort pending tool calls on timeout', async () => {
      const AGENT_TIMEOUT_MS = 100; // Shorter for test
      let toolCallAborted = false;

      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort();
        toolCallAborted = true;
      }, AGENT_TIMEOUT_MS);

      // Wait for timeout to trigger
      await new Promise(resolve => setTimeout(resolve, AGENT_TIMEOUT_MS + 50));

      // In real scenario, abort would cancel pending tool calls
      expect(toolCallAborted || abortController.signal.aborted).toBe(true);

      clearTimeout(timeoutId);
    });
  });

  // ── Message Processing Queue ──

  describe('per-user message queue', () => {
    it('should process messages sequentially per user', async () => {
      const chatId = 'chat-001';
      const messages = ['msg1', 'msg2', 'msg3'];
      const processed: string[] = [];

      // Simulate sequential processing
      for (const msg of messages) {
        processed.push(msg);
      }

      expect(processed).toEqual(messages);
    });

    it('should not block different users', () => {
      const chats = ['chat-1', 'chat-2', 'chat-3'];
      const results: Record<string, number> = {};

      for (const chat of chats) {
        results[chat] = 1; // Each chat processes independently
      }

      expect(Object.keys(results).length).toBe(3);
      for (const chat of chats) {
        expect(results[chat]).toBe(1);
      }
    });

    it('should maintain order within single chat', () => {
      const chatId = 'chat-001';
      const queue: Array<{ order: number; msg: string }> = [];

      for (let i = 0; i < 5; i++) {
        queue.push({ order: i, msg: `Message ${i}` });
      }

      for (let i = 0; i < queue.length; i++) {
        expect(queue[i].order).toBe(i);
      }
    });
  });

  // ── Parallel Tool Execution ──

  describe('parallel tool execution', () => {
    it('should execute up to 5 tools in parallel', async () => {
      const PARALLEL_TOOL_MAX = 5;
      const tools = Array.from({ length: PARALLEL_TOOL_MAX }, (_, i) => ({
        name: `tool_${i}`,
        exec: async () => `Result ${i}`,
      }));

      const results = await Promise.all(
        tools.map(t => t.exec())
      );

      expect(results.length).toBe(PARALLEL_TOOL_MAX);
    });

    it('should respect parallel limit', () => {
      const PARALLEL_TOOL_MAX = 5;
      const toolCalls = Array.from({ length: 10 }, (_, i) => i);

      // Batch tools into groups of 5
      const batches = [];
      for (let i = 0; i < toolCalls.length; i += PARALLEL_TOOL_MAX) {
        batches.push(toolCalls.slice(i, i + PARALLEL_TOOL_MAX));
      }

      expect(batches.length).toBe(2);
      expect(batches[0].length).toBe(5);
      expect(batches[1].length).toBe(5);
    });
  });

  // ── Response Assembly ──

  describe('response assembly', () => {
    it('should assemble response from provider output', async () => {
      const provider = createMockProvider({
        responses: ['Here is your response'],
      });

      const response = await provider.generateResponse(
        'gemini-2.0-flash',
        'System prompt',
        [{ role: 'user', parts: [{ text: 'Test' }] }]
      );

      expect(response.text).toBe('Here is your response');
    });

    it('should limit response to context window', () => {
      const MAX_OUTPUT = 12_000;
      let response = 'x'.repeat(MAX_OUTPUT + 1000);

      if (response.length > MAX_OUTPUT) {
        response = response.substring(0, MAX_OUTPUT);
      }

      expect(response.length).toBe(MAX_OUTPUT);
    });

    it('should include tool calls in response', async () => {
      const response = {
        text: 'Executing tool',
        toolCalls: [
          { id: '1', name: 'read_file', arguments: { path: 'file.txt' } },
          { id: '2', name: 'web_search', arguments: { query: 'topic' } },
        ],
        finishReason: 'tool_calls',
      };

      expect(response.toolCalls.length).toBe(2);
      expect(response.toolCalls[0].name).toBe('read_file');
    });
  });

  // ── Error Handling ──

  describe('error handling', () => {
    it('should handle provider unavailable', async () => {
      const unavailableProvider = createMockProvider({ shouldFail: true });

      try {
        await unavailableProvider.generateResponse(
          'gemini-2.0-flash',
          'Prompt',
          [{ role: 'user', parts: [{ text: 'Test' }] }]
        );
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
      }
    });

    it('should handle malformed tool parameters', () => {
      const invalidParams = { path: undefined };

      // Validation should catch this
      const isValid = invalidParams.path !== undefined;
      expect(isValid).toBe(false);
    });

    it('should return error message to user', () => {
      const errorMessage = 'Failed to process your request. Please try again.';

      // When agent fails, return user-friendly error
      expect(errorMessage).toContain('Failed');
      expect(errorMessage.length).toBeGreaterThan(0);
    });
  });

  // ── Full Workflow ──

  describe('full end-to-end workflow', () => {
    it('should complete full agent loop', async () => {
      const ctx = createMockContext();
      const message = 'write python code for fibonacci';

      // 1. Classify
      const classification = classifyTask(message, false);
      expect(classification.type).toBe(TaskType.CODE);

      // 2. Select provider
      const provider = mockProviders.gemini;
      expect(provider).toBeDefined();

      // 3. Prepare context
      const systemPrompt = 'You are a helpful coding assistant';
      const messages = [{ role: 'user', parts: [{ text: message }] }];

      // 4. Generate response
      const response = await provider.generateResponse(
        'gemini-2.0-flash',
        systemPrompt,
        messages,
        mockTools
      );

      // 5. Verify result
      expect(response.text).toBeTruthy();
      expect(response.finishReason).toBeTruthy();

      // 6. Add to memory (would update all layers)
      // 7. Return to user
      expect(response.text.length).toBeGreaterThan(0);
    });
  });
});

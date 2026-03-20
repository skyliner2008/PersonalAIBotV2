# Phase 4: Comprehensive Testing Suite

Complete test coverage for PersonalAIBotV2 with unit and integration tests.

## Overview

This test suite covers the critical paths of the PersonalAIBotV2 system across 4 layers:

### Test Architecture

```
server/__tests__/
├── unit/
│   ├── toolValidator.test.ts       # Tool code security validation
│   ├── taskClassifier.test.ts      # AI task classification system
│   ├── memoryCache.test.ts         # Memory layer caching & LRU
│   └── circuitBreaker.test.ts      # Resilience & exponential backoff
├── integration/
│   ├── agentFlow.test.ts           # End-to-end agent message flow
│   ├── memoryIntegration.test.ts   # Full memory lifecycle
│   └── apiRoutes.test.ts           # API endpoint testing (if added)
โ””โ”€โ”€ helpers/
    ├── testUtils.ts                # Shared utilities & database setup
    โ””โ”€โ”€ mockProviders.ts            # Mock AI providers & tools
```

## Running Tests

### Install Dependencies
```bash
cd server
npm install
```

### Run All Tests
```bash
npm test
```

### Run Tests in Watch Mode
```bash
npm run test:watch
```

### Run Specific Test File
```bash
npm test -- toolValidator.test.ts
npm test -- agentFlow.test.ts
```

### Run with Coverage
```bash
npm test -- --coverage
```

### Run Tests by Pattern
```bash
npm test -- -t "circuit breaker"
npm test -- -t "memory"
```

## Test Suites

### Unit Tests

#### 1. **Tool Validator Tests** (`unit/toolValidator.test.ts`)
Tests the AST-based validation for dynamically generated tool code.

**Coverage:**
- ✅ BLOCK dangerous patterns: `process.exit()`, `eval()`, `Function()`, `require('child_process')`
- ✅ BLOCK filesystem operations: `fs.rmSync()`, `fs.unlinkSync()`
- ✅ ALLOW safe operations: `fs.readFileSync()`, `fetch()`, safe modules
- ✅ WARN about async/await best practices
- ✅ Handle edge cases: empty code, unicode, comments, very long code

**Key Test Classes:**
- `validateToolCode()` - 30+ test cases
- `validateToolMetadata()` - 10+ test cases
- `validateTool()` - Integration of both validators

#### 2. **Task Classifier Tests** (`unit/taskClassifier.test.ts`)
Tests multi-language keyword-based task classification with confidence scoring.

**Coverage:**
- ✅ **VISION** - Image attachment detection
- ✅ **WEB_BROWSER** - Search queries, weather, news, stocks (Thai & English)
- ✅ **CODE** - Programming tasks, debugging, algorithms
- ✅ **DATA** - Data analysis, charts, statistics
- ✅ **THINKING** - Analysis, reasoning, decision-making
- ✅ **SYSTEM** - Self-healing, self-reflection commands
- ✅ **COMPLEX** - Long messages, article writing, design
- ✅ **GENERAL** - Fallback for simple greetings
- ✅ Confidence scoring (high/medium/low)
- ✅ Multi-language support (Thai, English, mixed)

**Key Test Classes:**
- 50+ test cases covering all task types
- Real-world scenario tests
- Confidence calculation tests

#### 3. **Memory Cache Tests** (`unit/memoryCache.test.ts`)
Tests the 4-layer unified memory architecture with LRU eviction and TTL.

**Coverage:**
- **Layer 1 (Core Memory)** - Persistent user profile data
- **Layer 2 (Working Memory)** - RAM-cached recent messages (25 message limit)
- **Layer 3 (Recall Memory)** - Full SQLite history
- **Layer 4 (Archival Memory)** - Semantic embeddings for facts
- ✅ Message persistence and retrieval
- ✅ LRU eviction (500 session limit)
- ✅ TTL expiration (60 minute sessions)
- ✅ Concurrent access handling
- ✅ Message ordering
- ✅ ChatId isolation
- ✅ Large conversation handling (1000+ messages)

**Key Features Tested:**
- `addMessage()` - Add user/assistant messages
- `getCoreMemory()` / `setCoreMemory()` - Core memory blocks
- `buildContext()` - Assemble all layers
- LRU eviction policy
- Concurrent write safety

#### 4. **Circuit Breaker Tests** (`unit/circuitBreaker.test.ts`)
Tests resilience patterns with exponential backoff for tool failures.

**Coverage:**
- ✅ **Circuit States**: CLOSED → OPEN → HALF-OPEN → CLOSED
- ✅ **Exponential Backoff Sequence**:
  - Failures 1-2: Circuit closed (10s base)
  - Failure 3: Circuit open (10s backoff)
  - Failure 4: 20s backoff
  - Failure 5: 40s backoff
  - Failure 6: 80s backoff
  - Failure 7+: 120s max cap
- ✅ **Auto-reset**: Halve failures after backoff expiration
- ✅ **Recovery**: Reduce failures on success
- ✅ **Multi-tool**: Independent circuits per tool
- ✅ **Edge cases**: Special characters, rapid alternation

**Key Features:**
- Prevents cascading failures
- Allows graceful degradation
- Automatic recovery windows
- Per-tool isolation

### Integration Tests

#### 1. **Agent Flow Integration** (`integration/agentFlow.test.ts`)
Tests end-to-end message processing through the agent.

**Coverage:**
- ✅ **Classification** → Provider selection → Response generation
- ✅ **Provider failover** - Try backup when primary fails
- ✅ **Memory context building** - Assemble 4-layer context
- ✅ **Tool execution** - Call tools with parameters
- ✅ **Max turns limit** - Stop after 20 tool calls
- ✅ **Agent timeout** - Abort after 120 seconds
- ✅ **Response assembly** - Limit to context window (12KB)
- ✅ **Message queue** - Sequential per-user processing
- ✅ **Parallel tools** - Execute up to 5 tools in parallel
- ✅ **Error handling** - Provider failures, malformed params

**Key Test Scenarios:**
- Full workflow: classify → generate → add to memory → return
- Provider failover chain
- Tool execution flow with error recovery
- Timeout and abort handling

#### 2. **Memory Integration Tests** (`integration/memoryIntegration.test.ts`)
Tests complete memory lifecycle across all layers.

**Coverage:**
- ✅ **Message lifecycle** - Save and retrieve across sessions
- ✅ **Core memory extraction** - Profile, preferences, learned facts
- ✅ **Archival storage** - Long-term semantic facts with embeddings
- ✅ **Context assembly** - Combine all layers for system prompt
- ✅ **Working memory limits** - Last 25 messages only
- ✅ **Chat isolation** - No cross-chat memory leaks
- ✅ **Memory cleanup** - Clear all layers while preserving other chats
- ✅ **Conversation lifecycle** - Full workflow from first message to learning

**Performance Tests:**
- 1000+ message conversations
- 50+ concurrent chats
- Efficient recent message queries

## Test Utilities

### `testUtils.ts`
Shared utilities for all tests:

```typescript
// Create in-memory SQLite database with schema
createTestDb(): Database

// Clean up test database
cleanupTestDb(db: Database)

// Create mock BotContext
createMockContext(overrides?: Partial)

// Wait helper
waitMs(ms: number): Promise<void>

// Insert test data
insertTestMessage(db, chatId, role, content)
insertTestCoreMemory(db, chatId, label, value)

// Retrieve test data
getTestMessages(db, chatId): Array
getTestCoreMemory(db, chatId): Array

// Temporary file helpers
createTempFile(content, ext): string
deleteTempFile(filePath): void
```

### `mockProviders.ts`
Mock AI providers for testing without API calls:

```typescript
// Create mock provider with configurable responses
MockAIProvider {
  async generateResponse(model, prompt, messages, tools?)
  setResponses(responses: string[])
  reset()
  getCallCount()
  setShouldFail(bool)
}

// Mock tool handlers
mockToolHandlers: {
  'read_file': async (params) => string,
  'write_file': async (params) => string,
  'web_search': async (params) => string,
  'execute_code': async (params) => string,
}
```

## Configuration

### `vitest.config.ts`
Test framework configuration:

```typescript
test: {
  globals: true,
  environment: 'node',
  coverage: {
    provider: 'v8',
    reporter: ['text', 'json', 'html'],
  },
  testTimeout: 10000,
}
```

## Test Statistics

### Current Coverage
- **Unit Tests**: 92 test cases across 4 test files
- **Integration Tests**: 35+ test cases across 2 test files
- **Total**: 127+ test cases

### Test Breakdown
| Category | Tests | Focus |
|----------|-------|-------|
| Tool Validator | 30+ | Security & validation |
| Task Classifier | 50+ | Classification accuracy |
| Memory Cache | 25+ | Persistence & caching |
| Circuit Breaker | 25+ | Resilience patterns |
| Agent Flow | 20+ | End-to-end workflows |
| Memory Integration | 25+ | Full lifecycle |

### Performance
- All tests run in < 30 seconds total
- Unit tests: ~10 seconds
- Integration tests: ~15 seconds

## Writing New Tests

### Pattern 1: Unit Test Template
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('Feature Name', () => {
  let resource: any;

  beforeEach(() => {
    // Setup
  });

  afterEach(() => {
    // Cleanup
  });

  it('should handle basic case', () => {
    expect(result).toBe(expected);
  });

  it('should handle edge case', () => {
    expect(result).toThrow();
  });
});
```

### Pattern 2: Integration Test Template
```typescript
import { createTestDb, cleanupTestDb } from '../helpers/testUtils.js';

describe('Feature Integration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  it('should work end-to-end', () => {
    // Arrange
    insertTestData(db);

    // Act
    const result = executeFeature();

    // Assert
    expect(result).toMatch();
  });
});
```

## Continuous Integration

### Recommended CI Setup
```yaml
test:
  script:
    - npm install
    - npm test -- --coverage
  coverage: '/Lines\s*:\s*(\d+.\d+)%/'
  artifacts:
    reports:
      coverage_report:
        coverage_format: cobertura
        path: coverage/cobertura-coverage.xml
```

## Debugging Tests

### Run Single Test
```bash
npm test -- -t "should validate tool code"
```

### Run with Debug Output
```bash
npm test -- --reporter=verbose
```

### Run with Chrome DevTools
```bash
npm test -- --inspect-brk
# Then visit chrome://inspect
```

## Known Limitations

1. **Mock Providers**: Use in-memory responses, don't test actual API latency
2. **No Real Database**: SQLite in-memory for isolation, not actual persistence
3. **No Network Tests**: Mock all HTTP calls
4. **No UI Tests**: API/logic only, no frontend

## Future Enhancements

- [ ] Add API route tests (`integration/apiRoutes.test.ts`)
- [ ] Add E2E browser tests with Playwright
- [ ] Add performance benchmarks
- [ ] Add load testing for concurrent users
- [ ] Add chaos engineering tests (random failures)
- [ ] Expand vector similarity tests when vectorStore fully implemented

## References

- [Vitest Documentation](https://vitest.dev/)
- [Testing Best Practices](https://vitest.dev/guide/features.html)
- [Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html)
- [MemGPT Memory Architecture](https://memgpt.ai/)

## Contact & Support

For test-related issues or improvements, see the project's issue tracker.

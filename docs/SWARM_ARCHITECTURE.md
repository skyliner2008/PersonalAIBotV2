# Swarm Coordination Architecture & Design

## System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MESSAGING PLATFORMS                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │   Telegram   │  │     LINE     │  │   Facebook   │               │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘               │
└─────────┼──────────────────┼─────────────────┼──────────────────────┘
          │                  │                 │
          └──────────────────┼─────────────────┘
                             │
                             โ–ผ
              ┌──────────────────────────┐
              │   Bot Agents (Manager)   │
              │  ┌────────────────────┐  │
              │  │  Agent Instance    │  │
              │  │  - processMessage  │  │
              │  │  - tool execution  │  │
              │  └────────────────────┘  │
              └──────────┬───────────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
         โ–ผ               โ–ผ               โ–ผ
    ┌─────────┐  ┌──────────────┐  ┌──────────┐
    │  Tools  │  │  Memories    │  │Evolution │
    │         │  │  (4-layer)   │  │ (Self)   │
    └─────────┘  └──────────────┘  └──────────┘
         │
         │ (includes delegate_task tool)
         │
         โ–ผ
┌──────────────────────────────────────────────┐
│        SWARM COORDINATION SYSTEM              │
├──────────────────────────────────────────────┤
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │     SwarmCoordinator                 │   │
│  │  ├─ delegateTask()                   │   │
│  │  ├─ processPendingTasks() [2s loop]  │   │
│  │  ├─ executeTask()                    │   │
│  │  └─ getStatus()                      │   │
│  └──────────────────────────────────────┘   │
│                      │                       │
│      ┌───────────────┼───────────────┐      │
│      │               │               │      │
│      ▼               ▼               ▼      │
│  ┌────────┐  ┌─────────────┐  ┌──────────┐ │
│  │ Queue  │  │ Specialist  │  │Processing│ │
│  │        │  │   Router    │  │ Engine   │ │
│  │ Tasks  │  │             │  │          │ │
│  │ Map    │  │ · vision    │  │ Result   │ │
│  │ +      │  │ · coder     │  │ tracking │ │
│  │ Stats  │  │ · research  │  │          │ │
│  │        │  │ · translator│  │ Error    │ │
│  │        │  │ · analyst   │  │ handling │ │
│  │        │  │ · general   │  │          │ │
│  └────────┘  └─────────────┘  └──────────┘ │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │    TaskQueue Implementation           │   │
│  │  ├─ enqueue(task)                    │   │
│  │  ├─ dequeue(specialist)              │   │
│  │  ├─ complete(taskId, result)         │   │
│  │  ├─ fail(taskId, error)              │   │
│  │  ├─ getStats()                       │   │
│  │  └─ cleanup() [1h interval]          │   │
│  └──────────────────────────────────────┘   │
│                                              │
└──────────────────────────────────────────────┘
         │               │
         │ (re-invokes)  │
         │               │
         โ–ผ               โ–ผ
    ┌─────────────────────────┐
    │   Specialized Agents    │
    │  ┌────────────────────┐ │
    │  │ Agent (shared AI)  │ │
    │  │ + BotContext       │ │
    │  │ + Specialist Mode  │ │
    │  └────────────────────┘ │
    │   Process with model:   │
    │  - Vision: gemini-2.0   │
    │  - Coder: gemini-2.5    │
    │  - Other: gemini-2.0    │
    └─────────────────────────┘
         │
         │ Results
         │
         โ–ผ
    ┌──────────────────┐
    │  Result Storage  │
    │  (in TaskQueue)  │
    │  - task.result   │
    │  - task.status   │
    │  - timestamps    │
    └──────────────────┘
         │
         │ via API
         │
         โ–ผ
┌──────────────────────────────────────────────┐
│         REST API ENDPOINTS                    │
├──────────────────────────────────────────────┤
│  GET    /api/swarm/status                    │
│  GET    /api/swarm/health                    │
│  GET    /api/swarm/stats                     │
│  GET    /api/swarm/tasks                     │
│  GET    /api/swarm/tasks/:id                 │
│  POST   /api/swarm/tasks                     │
│  GET    /api/swarm/specialists               │
└──────────────────────────────────────────────┘
         │
         │
         โ–ผ
    ┌─────────────┐
    │  Dashboard  │
    │  / Client   │
    └─────────────┘
```

## Component Interaction Flows

### Flow 1: Task Delegation

```
Agent receives user message
    ↓
Classifies as delegable (vision, code, etc)
    ↓
Calls: delegate_task(taskType, message, specialist?)
    ↓
SwarmToolHandlers.delegate_task()
    ├─ Validates inputs
    โ””โ”€ Calls: coordinator.delegateTask(ctx, taskType, payload, options)
    ↓
SwarmCoordinator.delegateTask()
    ├─ Calls: taskQueue.enqueue(taskData)
    โ””โ”€ Returns: taskId
    ↓
TaskQueue.enqueue()
    ├─ Generates unique taskId
    ├─ Sets status = 'queued'
    ├─ Stores in Map<id, task>
    โ””โ”€ Returns: taskId
    ↓
Tool returns to agent: taskId (immediate response)
    ↓
Agent waits for result: coordinator.waitForTaskResult(taskId, timeout)
    ↓
While loop polls: taskQueue.getStatus(taskId)
    ├─ Pending → wait 500ms
    ├─ Completed → return result
    ├─ Failed → return error
    └─ Timeout → return timeout error
    ↓
Agent processes result and responds to user
```

### Flow 2: Task Processing

```
ProcessingLoop (every 2 seconds)
    ↓
coordinator.processPendingTasks()
    ↓
Get tasks: taskQueue.listPending()
    ├─ Filter: status === 'queued' || 'processing'
    ├─ Sort: priority DESC, createdAt ASC
    โ””โ”€ Return: [task1, task2, ...]
    ↓
For each task:
    ├─ Skip if already processing
    ├─ Try:
    │   └─ executeTask(task)
    │       ├─ Find specialist:
    │       │   ├─ If specified: getSpecialistByName(name)
    │       │   └─ Else: findSpecialistForTask(taskType)
    │       ├─ Create execution context
    │       ├─ Call: agent.processMessage(chatId, message, ctx, timeout)
    │       │   └─ Agent processes with specialist's preferred model
    │       ├─ On success:
    │       │   ├─ taskQueue.complete(taskId, result)
    │       │   └─ Task status → 'completed'
    │       └─ On error/timeout:
    │           ├─ taskQueue.fail(taskId, error)
    │           └─ Task status → 'failed'
    โ””โ”€ Catch:
        โ””โ”€ Log error and mark task as failed
    ↓
Cleanup (every 1 hour):
    โ””โ”€ taskQueue.cleanup()
        ├─ Find tasks with status='completed'|'failed'
        ├─ Check: completedAt > 24 hours ago
        ├─ Delete from Map
        โ””โ”€ Log removed count
```

### Flow 3: API Query

```
User/Client makes request
    ↓
GET /api/swarm/tasks?specialist=vision&limit=10
    ↓
swarmRoutes handler
    โ””โ”€ Calls: coordinator.listTasks({specialist, limit})
    ↓
SwarmCoordinator.listTasks()
    โ””โ”€ Calls: taskQueue.listAll(filter)
    ↓
TaskQueue.listAll()
    ├─ Get all tasks from Map
    ├─ Filter by: status, platform, specialist
    ├─ Sort: descending by createdAt
    ├─ Slice: apply limit
    โ””โ”€ Return: [filtered tasks]
    ↓
Response: {success, tasks, count}
    ↓
Client receives JSON with task details
```

## Data Structure Hierarchy

### Task Object
```typescript
interface SwarmTask {
  id: string                          // task_timestamp_counter
  fromPlatform: 'telegram'|'line'|... // Origin platform
  fromChatId: string                  // Origin chat/bot ID
  toPlatform: 'swarm'                 // Always routes through swarm
  toSpecialist?: string               // Optional target specialist
  taskType: TaskType                  // vision, code, translate, etc
  payload: {
    message: string                   // Task description
    attachments?: [{...}]             // Images, files, etc
    context?: string                  // Additional context
  }
  status: 'queued'|'processing'|'completed'|'failed'
  result?: string                     // Specialist's response
  error?: string                      // Error message if failed
  createdAt: Date                     // Task creation
  completedAt?: Date                  // Completion time
  priority: number                    // 1=low, 3=normal, 5=high
  timeout: number                     // ms (120000 default)
  metadata?: Record<string, unknown>  // Debug info
}
```

### Specialist Object
```typescript
interface Specialist {
  name: string                        // 'vision', 'coder', etc
  description: string                 // Human-readable desc
  capabilities: TaskType[]            // Supported task types
  preferredModel: string              // 'gemini-2.0-flash', etc
  platform?: string|null              // null = all platforms
  isAvailable: () => boolean          // Current availability
  tags?: string[]                     // Search/filter tags
}
```

### Queue Statistics Object
```typescript
interface TaskQueueStats {
  queued: number                      // Awaiting processing
  processing: number                  // Currently executing
  completed: number                   // Successfully finished
  failed: number                      // Failed execution
  total: number                       // Total tracked
  avgProcessingTimeMs?: number        // Average duration
}
```

## Performance Characteristics

### Memory Usage
```
Per Task:
  - Task object: ~500 bytes base
  - Message string: variable (100-1000 bytes typical)
  - Result string: variable (100-5000 bytes typical)
  - Total per task: ~1 KB average

Queue Capacity (example):
  - 1000 tasks: ~1 MB
  - 10000 tasks: ~10 MB
  - 100000 tasks: ~100 MB

Note: Cleanup removes tasks > 24 hours old
```

### Processing Performance
```
Processing Loop:
  - Interval: 2 seconds
  - Per iteration: 10-100 ms (depends on pending count)
  - CPU impact: minimal (<1% typical)

Task Execution:
  - Queue time: <1 second typical
  - Processing time: 2-30 seconds (depends on task)
  - Timeout: 120 seconds (configurable)
```

### Throughput Estimates
```
Simple Tasks (e.g., translation):
  - Processing time: 2-5 seconds
  - Throughput: ~12 tasks per minute

Complex Tasks (e.g., data analysis):
  - Processing time: 10-30 seconds
  - Throughput: 2-6 tasks per minute

Mixed Workload:
  - Estimated: 5-10 tasks per minute
```

## Concurrency Model

### Single-Threaded Design
```
Node.js Event Loop:
  ├─ HTTP Request → API handler
  ├─ Task submission → Queue.enqueue() [sync]
  ├─ Processing Loop [async, every 2s]
  │   ├─ dequeue() [sync]
  │   ├─ agent.processMessage() [async, await]
  │   └─ result handling [sync]
  โ””โ”€ Cleanup [async, every 1h]

Safety:
  - No race conditions (single thread)
  - Safe Map operations
  - Async/await properly chained
```

### Task Isolation
```
Each task:
  ├─ Unique chatId: swarm_taskId
  ├─ Separate memory context
  ├─ Independent tool isolation
  โ””โ”€ No shared state except queue

Result: No cross-task contamination
```

## Error Recovery

### Task Failure Handling
```
If agent throws:
  ├─ Caught in try/catch
  ├─ taskQueue.fail(taskId, errorMsg)
  ├─ Task marked 'failed'
  ├─ Error stored in task.error
  โ””โ”€ Logged to console

If task times out:
  ├─ Promise.race with timeout
  ├─ Timer fires after timeout ms
  ├─ Promise rejected
  ├─ Caught in catch block
  ├─ taskQueue.fail(taskId, "Task timeout")
  โ””โ”€ Logged to console

No automatic retry (by design):
  - Prevents infinite loops
  - Explicit handling by caller
  - Future enhancement: optional retry
```

### Coordinator Failure Handling
```
If agent not initialized:
  โ””โ”€ processPendingTasks() returns early
  โ””โ”€ Logged warning

If specialist not found:
  โ””โ”€ taskQueue.fail(taskId, "No specialist")
  โ””โ”€ Logged error

If cleanup fails:
  โ””โ”€ Caught and logged
  โ””โ”€ Continues operation
```

## Scalability Paths

### Near-Term (Phase 2.1)
```
Current:
  ├─ In-memory queue
  ├─ Single processing loop
  ├─ Sequential task execution
  โ””โ”€ 24-hour archival

Enhancement:
  ├─ Add SQLite persistence
  ├─ Task retry mechanism
  ├─ Priority boosting
  โ””โ”€ Rate limiting per specialist
```

### Medium-Term (Phase 2.2)
```
Distributed:
  ├─ Message queue backend (Redis/RabbitMQ)
  ├─ Multiple worker processes
  ├─ Specialist instance pool
  ├─ Load balancing
  โ””โ”€ Cost optimization routing
```

### Long-Term (Phase 2.3)
```
Advanced Intelligence:
  ├─ Task dependency graphs
  ├─ Multi-agent collaboration
  ├─ Federated execution
  ├─ Learning from results
  โ””โ”€ Self-improving specialist selection
```

## Security Model

### Input Validation
```
Task Submission:
  ├─ taskType: enum validation
  ├─ message: length check (max 50KB)
  ├─ attachments: type check
  ├─ priority: range validation (1-5)
  โ””โ”€ timeout: range validation (1s-5min)
```

### Execution Isolation
```
Specialist Task:
  ├─ Unique chatId: swarm_taskId
  ├─ Custom BotContext
  ├─ No access to original bot state
  ├─ Result stored separately
  โ””โ”€ Original bot unchanged
```

### Result Security
```
Result Storage:
  ├─ Stored in in-memory queue only
  ├─ Available via authenticated API
  ├─ Cleared after 24 hours
  โ””โ”€ No persistence to disk (default)
```

## Testing Strategy

### Unit Tests
```
TaskQueue:
  ├─ enqueue/dequeue order
  ├─ Priority sorting
  ├─ Status transitions
  ├─ Cleanup functionality
  โ””โ”€ Stats calculation

Specialists:
  ├─ Capability matching
  ├─ Specialist lookup
  โ””โ”€ Metrics calculation
```

### Integration Tests
```
SwarmCoordinator:
  ├─ Task delegation
  ├─ Processing loop
  ├─ Result tracking
  ├─ Error handling
  โ””โ”€ Timeout behavior

API Endpoints:
  ├─ All CRUD operations
  ├─ Filtering and sorting
  ├─ Error responses
  โ””โ”€ Stats accuracy
```

### End-to-End Tests
```
Full Flow:
  ├─ Bot → delegate task
  ├─ Coordinator → process
  ├─ Specialist → execute
  ├─ Result → retrieve
  โ””โ”€ Validate correctness
```

### Load Tests
```
Scenarios:
  ├─ 100 concurrent tasks
  ├─ Mixed task types
  ├─ Various timeouts
  ├─ Error injection
  โ””โ”€ Memory monitoring
```

## Monitoring & Observability

### Logging
```
Levels: INFO, WARN, ERROR
Prefix: [SwarmCoordinator], [TaskQueue]
Examples:
  INFO: "Enqueued task: task_1234"
  INFO: "Completed task: task_1234 in 5230ms"
  WARN: "Task timeout: task_1234"
  ERROR: "Failed task: task_1234 — Error message"
```

### Metrics
```
Available via:
  - GET /api/swarm/status
  - GET /api/swarm/stats
  - GET /api/swarm/health

Metrics:
  ├─ Queue depth (queued, processing)
  ├─ Completion rate (completed, failed)
  ├─ Processing time (avg, min, max)
  ├─ Throughput (tasks/min)
  โ””โ”€ Specialist utilization
```

### Health Checks
```
GET /api/swarm/health returns:
  ├─ healthy: boolean
  ├─ running: boolean
  ├─ agentReady: boolean
  ├─ queueHealth: {...}
  โ””โ”€ timestamp
```

## Deployment Considerations

### Environment Requirements
```
Node.js: 18.x or higher
Memory: 512 MB minimum (2 GB recommended)
Disk: 100 MB for logs + artifacts
CPU: 1 core minimum (2+ recommended)
```

### Configuration
```
Environment Variables: None required
(Uses defaults from code)

Optional tuning:
  ├─ SWARM_PROCESSING_INTERVAL_MS
  ├─ SWARM_CLEANUP_INTERVAL_MS
  ├─ SWARM_ARCHIVAL_AGE_MS
  โ””โ”€ SWARM_MAX_TASK_SIZE_BYTES
```

### Graceful Shutdown
```
On SIGINT/SIGTERM:
  1. Stop accepting new requests
  2. Stop processing loop
  3. Stop cleanup interval
  4. Clear queue (tasks > 24h archived)
  5. Release agent resources
  6. Exit cleanly
```

---

This architecture is designed for:
✅ Simplicity (easy to understand)
✅ Reliability (no complex synchronization)
✅ Observability (detailed logging)
✅ Extensibility (clear upgrade paths)
✅ Performance (lightweight, efficient)
✅ Maintainability (well-documented)

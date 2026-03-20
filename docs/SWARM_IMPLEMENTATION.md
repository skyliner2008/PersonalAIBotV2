# Phase 2: Swarm Coordination System Implementation

## Overview

The Swarm Coordination system enables multi-agent communication across platforms, allowing bots to delegate tasks to specialist agents through an internal task queue. This enables efficient workload distribution and specialized handling of complex tasks.

## Architecture

### Core Components

1. **TaskQueue** (`src/swarm/taskQueue.ts`)
   - In-memory task queue with optional persistence
   - Priority-based task ordering
   - Task lifecycle management (queued → processing → completed/failed)
   - Automatic cleanup of old tasks (24+ hours)

2. **Specialists** (`src/swarm/specialists.ts`)
   - Pre-defined specialist agents with specific capabilities
   - Built-in specialists: vision, coder, researcher, translator, analyst, general
   - Task routing based on capability matching
   - Extensible specialist framework

3. **SwarmCoordinator** (`src/swarm/swarmCoordinator.ts`)
   - Main orchestration engine
   - Manages task delegation and execution
   - Periodic processing loop (every 2 seconds)
   - Handles task timeouts and error recovery
   - Graceful shutdown support

4. **SwarmTools** (`src/swarm/swarmTools.ts`)
   - AI agent tools for swarm interaction
   - `delegate_task`: Send work to specialists
   - `check_swarm_status`: Monitor queue and processing
   - `list_specialists`: View available capabilities

5. **SwarmRoutes** (`src/api/swarmRoutes.ts`)
   - REST API endpoints for swarm management
   - Task submission, monitoring, and statistics
   - Specialist listing and capability discovery

## Task Flow

```
1. Bot receives message → classifies task
2. If complex/delegable → calls delegate_task tool
3. Tool enqueues task with priority/timeout
4. SwarmCoordinator.processPendingTasks() picks up task
5. Routes to best-matching specialist
6. Executes with agent.processMessage()
7. Marks complete/failed, stores result
8. Result available via API for originator
```

## API Endpoints

### Status & Monitoring
- `GET /api/swarm/status` - Coordinator status and queue stats
- `GET /api/swarm/health` - Health check (running, agent ready)
- `GET /api/swarm/stats` - Detailed statistics (by type, specialist, etc)

### Task Management
- `GET /api/swarm/tasks` - List tasks (with filters: status, platform, specialist, limit)
- `GET /api/swarm/tasks/:id` - Get task details and result
- `POST /api/swarm/tasks` - Manually submit a task
- `POST /api/swarm/task/:id/cancel` - Cancel queued task (future enhancement)

### Specialist Management
- `GET /api/swarm/specialists` - List available specialists and capabilities

## AI Agent Tools

### delegate_task
Allows AI agents to delegate subtasks to specialists.

**Parameters:**
- `task_type` (required): vision_analysis, code_review, code_generation, translation, web_search, data_analysis, summarization, general
- `message` (required): Task description
- `specialist` (optional): Target specialist name (vision, coder, researcher, translator, analyst)
- `priority` (optional): low (1), normal (3), high (5) — default 3

**Response:**
```
✅ งานเสร็จแล้ว: [result]
❌ งานล้มเหลว: [error]
⏱️ งานยังรออยู่: [task_id]
```

### check_swarm_status
Monitor queue and processing statistics.

**Parameters:**
- `detail_level` (optional): summary (default) or detailed

**Response:**
- Task counts (queued, processing, completed, failed)
- Average processing time
- List of pending tasks
- Specialist availability

### list_specialists
View all available specialists and their capabilities.

**Response:**
List of specialists with descriptions, capabilities, and preferred models.

## Specialist Capabilities

| Specialist | Capabilities | Preferred Model |
|-----------|--------------|-----------------|
| vision | vision_analysis | gemini-2.0-flash |
| coder | code_review, code_generation | gemini-2.5-flash |
| researcher | web_search, summarization, data_analysis | gemini-2.0-flash |
| translator | translation | gemini-2.0-flash |
| analyst | data_analysis, summarization | gemini-2.5-flash |
| general | all types (fallback) | gemini-2.0-flash |

## Task Queue Features

### Priority System
- Tasks sorted by priority (5=highest, 1=lowest)
- Within same priority: FIFO (first in, first out)
- Default priority: 3 (normal)

### Timeout & Retry
- Default timeout: 120 seconds
- Customizable per task
- Failed tasks logged with error message
- No automatic retry (future enhancement)

### Cleanup
- Runs every 1 hour
- Removes completed/failed tasks older than 24 hours
- Keeps in-memory footprint manageable
- Archival data available for 24 hours

### Statistics
```typescript
interface TaskQueueStats {
  queued: number;        // Tasks waiting
  processing: number;    // Tasks being executed
  completed: number;     // Successfully completed
  failed: number;        // Failed execution
  total: number;         // Total tracked
  avgProcessingTimeMs?: number; // Average duration
}
```

## Integration Points

### In `src/index.ts`
1. Initialize SwarmCoordinator with agent instance:
```typescript
const swarmCoordinator = getSwarmCoordinator();
await swarmCoordinator.init(systemAgent);
```

2. Register swarm API routes:
```typescript
app.use('/api/swarm', swarmRoutes);
```

3. Shutdown on server termination:
```typescript
await swarmCoordinator.shutdown();
```

### In `src/bot_agents/tools/index.ts`
1. Import swarm tools:
```typescript
import { swarmToolDeclarations, getSwarmToolHandlers } from '../../swarm/swarmTools.js';
```

2. Add to tools array:
```typescript
...swarmToolDeclarations
```

3. Register handlers in getFunctionHandlers:
```typescript
Object.assign(handlers, getSwarmToolHandlers(ctx));
```

### In `src/bot_agents/registries/toolRegistry.ts`
Added tool metadata for swarm tools:
- delegate_task
- check_swarm_status
- list_specialists

## Usage Examples

### Example 1: Vision Analysis Task
```
User: "Analyze this image for me"
Bot: "I need detailed image analysis, let me delegate to a specialist"
Bot: calls delegate_task(
  task_type="vision_analysis",
  message="Analyze image and describe contents",
  specialist="vision"
)
Specialist: Processes image with gemini-2.0-flash
Result: "Image contains..."
Bot: Returns result to user
```

### Example 2: Code Review Task
```
User: "Review my code"
Bot: calls delegate_task(
  task_type="code_review",
  message="Review provided code and suggest improvements",
  specialist="coder",
  priority="high"
)
Specialist: Analyzes code
Result: Detailed review with suggestions
Bot: Returns to user
```

### Example 3: Research Task
```
User: "Find latest info on topic X"
Bot: calls delegate_task(
  task_type="web_search",
  message="Search for latest information on topic X",
  specialist="researcher"
)
Specialist: Performs web search via available tools
Result: Summary of findings
Bot: Returns to user
```

## Configuration

### Timeout Settings
- Agent timeout: 120 seconds (in agent.ts)
- Task timeout: 120 seconds (default, customizable)
- Processing loop interval: 2 seconds (in SwarmCoordinator)

### Cleanup Schedule
- Interval: 1 hour
- Archive age: 24 hours
- Automatic on init via `taskQueue.startCleanup()`

### Concurrency
- Processing loop handles one batch per interval
- Tasks processed sequentially within interval
- Parallel tool execution within agent limited by PARALLEL_TOOL_MAX

## Monitoring & Debugging

### Check Queue Status
```bash
curl http://localhost:3000/api/swarm/status
curl http://localhost:3000/api/swarm/stats
curl http://localhost:3000/api/swarm/health
```

### List Pending Tasks
```bash
curl "http://localhost:3000/api/swarm/tasks?status=queued&limit=10"
```

### Get Task Details
```bash
curl http://localhost:3000/api/swarm/tasks/{taskId}
```

### View Specialists
```bash
curl http://localhost:3000/api/swarm/specialists
```

## Error Handling

### Task Execution Errors
- Caught and logged with error message
- Task marked as 'failed' with error stored
- Result available via API
- Original requester can check status

### Timeout Errors
- Task exceeds timeout → marked failed
- Error: "Task execution timeout"
- Useful for long-running operations

### Coordinator Initialization Errors
- Logs to console and database
- API returns error responses
- Server continues running but without swarm

## Future Enhancements

### Phase 2.1 - Advanced Features
- [ ] Task cancellation for queued tasks
- [ ] Task priority boosting
- [ ] Retry mechanism with exponential backoff
- [ ] Task result notification callbacks
- [ ] Rate limiting per specialist
- [ ] SQLite persistence option
- [ ] Task scheduling (delayed execution)

### Phase 2.2 - Intelligence
- [ ] Cost optimization (route to cheapest model)
- [ ] Load balancing across specialist instances
- [ ] Dynamic specialist scaling
- [ ] Task dependency chains
- [ ] Batch task processing

### Phase 2.3 - Multi-Agent Collaboration
- [ ] Inter-specialist communication
- [ ] Hierarchical task decomposition
- [ ] Consensus-based decision making
- [ ] Federated learning across bots

## File Structure

```
server/src/
├── swarm/
│   ├── taskQueue.ts          # Task queue implementation
│   ├── specialists.ts         # Specialist definitions & routing
│   ├── swarmCoordinator.ts    # Main coordinator engine
│   └── swarmTools.ts          # AI tools for delegation
├── api/
│   └── swarmRoutes.ts         # REST API endpoints
├── bot_agents/
│   ├── tools/
│   │   └── index.ts           # (modified) Tool registration
│   └── registries/
│       └── toolRegistry.ts    # (modified) Tool metadata
โ””โ”€โ”€ index.ts                   # (modified) Initialization

public/
โ””โ”€โ”€ swarm-dashboard/           # (future) Dashboard UI
```

## Performance Considerations

### Memory Usage
- In-memory queue: ~1KB per task
- Cleanup runs every hour
- Recommended: monitor with /api/swarm/stats

### Processing Throughput
- Processing loop: every 2 seconds
- Per-interval: tasks processed sequentially
- Estimated throughput: 30 tasks/min (simple), 10 tasks/min (complex)

### Scalability Paths
1. Distribute specialists across multiple agents
2. Use message queue (Redis/RabbitMQ) instead of in-memory
3. Add task worker processes
4. Implement specialist instance pooling

## Security Considerations

1. **Task Validation**
   - Task type validated against allowed types
   - Message length checked
   - Timeout bounds enforced

2. **Specialist Isolation**
   - Each task runs in separate agent context
   - No cross-task data contamination
   - Results stored separately

3. **API Security**
   - Follows existing rate limiting
   - Inherits authentication from main API
   - No sensitive data in task payloads

## Testing

### Manual Testing Checklist
- [ ] Delegate task succeeds and returns ID
- [ ] Check status retrieves correct state
- [ ] Task completes and stores result
- [ ] Timeout triggers on long tasks
- [ ] Cleanup removes old tasks
- [ ] Multiple concurrent tasks work
- [ ] API endpoints return correct data
- [ ] Specialists available and routable

### Test Commands
```bash
# Submit task
curl -X POST http://localhost:3000/api/swarm/tasks \
  -H "Content-Type: application/json" \
  -d '{"fromPlatform":"telegram","taskType":"web_search","message":"test"}'

# Check status
curl http://localhost:3000/api/swarm/status

# List tasks
curl http://localhost:3000/api/swarm/tasks

# View specialists
curl http://localhost:3000/api/swarm/specialists
```

## Logs

All operations log to console with prefix `[SwarmCoordinator]` or `[TaskQueue]`:
```
[TaskQueue] Enqueued task: task_1234_1 (vision_analysis) from telegram
[SwarmCoordinator] Executing task task_1234_1 with specialist: vision
[SwarmCoordinator] Task completed: task_1234_1
```

## References

- Task Queue Implementation: `src/swarm/taskQueue.ts`
- Specialist Framework: `src/swarm/specialists.ts`
- Coordinator Engine: `src/swarm/swarmCoordinator.ts`
- Agent Tools: `src/swarm/swarmTools.ts`
- API Routes: `src/api/swarmRoutes.ts`
- Integration: `src/index.ts`, `src/bot_agents/tools/index.ts`

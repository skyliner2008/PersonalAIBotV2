# Swarm Coordination System - Quick Start Guide

## What is Swarm Coordination?

The Swarm system enables your AI bots to delegate complex tasks to specialized agent workers. Instead of handling everything themselves, bots can:
- Send a task to a vision specialist for image analysis
- Delegate code review to a coding specialist
- Request web searches from a research specialist
- Get translations from a translation specialist
- Offload data analysis to an analyst specialist

## How It Works

```
┌─────────────┐
│   User      │
└──────┬──────┘
       │ "Analyze this image"
       โ–ผ
┌─────────────────────┐
│  Telegram Bot       │
│  - Receives message │
│  - Delegates task   │
└──────┬──────────────┘
       │ delegate_task("vision_analysis", "image...")
       โ–ผ
┌──────────────────────┐
│  Swarm Coordinator   │
│  - Enqueues task     │
│  - Routes to Vision  │
└──────┬───────────────┘
       │
       โ–ผ
┌──────────────────────┐
│  Vision Specialist   │
│  - Analyzes image    │
│  - Returns analysis  │
└──────┬───────────────┘
       │ Result
       โ–ผ
┌──────────────────────┐
│  Telegram Bot        │
│  - Receives result   │
│  - Sends to user     │
└──────────────────────┘
```

## Getting Started

### 1. Check System Status

```bash
curl http://localhost:3000/api/swarm/health
```

Response:
```json
{
  "success": true,
  "healthy": true,
  "status": {
    "running": true,
    "agentReady": true,
    "queueHealth": {
      "processingCount": 0,
      "completedCount": 5
    }
  }
}
```

### 2. View Available Specialists

```bash
curl http://localhost:3000/api/swarm/specialists
```

Response:
```json
{
  "specialists": [
    {
      "name": "vision",
      "description": "Specializes in image analysis, OCR, visual understanding",
      "capabilities": ["vision_analysis"],
      "preferredModel": "gemini-2.0-flash"
    },
    {
      "name": "coder",
      "description": "Specializes in code review, debugging, code generation",
      "capabilities": ["code_review", "code_generation"],
      "preferredModel": "gemini-2.5-flash"
    },
    // ... more specialists
  ]
}
```

### 3. Submit a Task

```bash
curl -X POST http://localhost:3000/api/swarm/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "fromPlatform": "telegram",
    "taskType": "web_search",
    "message": "Find latest AI news for 2026",
    "specialist": "researcher",
    "priority": "normal"
  }'
```

Response:
```json
{
  "success": true,
  "taskId": "task_1234567890_1"
}
```

### 4. Check Task Status

```bash
curl http://localhost:3000/api/swarm/tasks/task_1234567890_1
```

Response:
```json
{
  "task": {
    "id": "task_1234567890_1",
    "status": "completed",
    "result": "Latest AI news for 2026 includes...",
    "createdAt": "2026-03-07T10:00:00.000Z",
    "completedAt": "2026-03-07T10:05:00.000Z"
  }
}
```

## Task Types

| Task Type | Specialist | Use Case | Example |
|-----------|-----------|----------|---------|
| vision_analysis | vision | Analyze images | "Describe what's in this photo" |
| code_review | coder | Review code quality | "Check this code for bugs" |
| code_generation | coder | Generate code | "Write a Python script for..." |
| translation | translator | Translate text | "Translate to Thai: ..." |
| web_search | researcher | Search the web | "Find info about..." |
| data_analysis | analyst | Analyze data | "What trends do you see?" |
| summarization | researcher | Summarize text | "Summarize this article" |
| general | general | Any task | Fallback option |

## Priority Levels

- **low** (1): Non-urgent background tasks
- **normal** (3): Standard processing (default)
- **high** (5): Urgent, process first

```bash
# Submit high-priority task
curl -X POST http://localhost:3000/api/swarm/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "fromPlatform": "telegram",
    "taskType": "code_review",
    "message": "Emergency bug fix review",
    "priority": "high"
  }'
```

## Using in Bots

When your AI bot receives a message, it can automatically delegate tasks:

```python
# User message: "Analyze this image"
# Bot decides: This needs vision analysis

Bot calls: delegate_task(
  task_type="vision_analysis",
  message="Analyze the provided image and describe contents in detail",
  specialist="vision"
)

# Result comes back automatically
Result: "Image contains a sunset over mountains..."
Bot sends to user: "Image contains a sunset..."
```

## Monitoring the Swarm

### See All Tasks

```bash
curl "http://localhost:3000/api/swarm/tasks?limit=20"
```

### Filter by Status

```bash
# Only pending tasks
curl "http://localhost:3000/api/swarm/tasks?status=queued"

# Only completed tasks
curl "http://localhost:3000/api/swarm/tasks?status=completed&limit=10"

# Only failed tasks
curl "http://localhost:3000/api/swarm/tasks?status=failed"
```

### Filter by Specialist

```bash
# Tasks handled by vision specialist
curl "http://localhost:3000/api/swarm/tasks?specialist=vision"
```

### Get Statistics

```bash
curl http://localhost:3000/api/swarm/stats
```

Response:
```json
{
  "stats": {
    "queue": {
      "queued": 2,
      "processing": 1,
      "completed": 45,
      "failed": 3,
      "avgProcessingTimeMs": 5234
    },
    "tasksByType": {
      "web_search": 15,
      "vision_analysis": 12,
      "code_review": 8
    },
    "tasksBySpecialist": {
      "researcher": 15,
      "vision": 12,
      "coder": 8
    }
  }
}
```

## Best Practices

### 1. Choose the Right Specialist

```javascript
// ✅ Good: Specific specialist for specific task
delegate_task(
  task_type="vision_analysis",
  specialist="vision"
)

// ❌ Avoid: Using general for specific tasks
delegate_task(
  task_type="vision_analysis",
  specialist="general"
)
```

### 2. Provide Clear Instructions

```javascript
// ✅ Good: Detailed, specific instruction
message="Analyze the image and identify: colors, objects, people, text, and overall mood"

// ❌ Avoid: Vague instruction
message="Look at this"
```

### 3. Set Appropriate Priority

```javascript
// ✅ Good: High priority for important tasks
delegate_task(task_type="...", priority="high")

// ✅ Good: Normal priority for standard tasks
delegate_task(task_type="...", priority="normal")

// ✅ Good: Low priority for background tasks
delegate_task(task_type="...", priority="low")
```

### 4. Handle Timeouts

Most tasks complete in 5-30 seconds. Set appropriate timeouts:

```javascript
// Long-running task
delegate_task(
  task_type="data_analysis",
  message="Analyze large dataset...",
  timeout=60000  // 60 seconds
)
```

## Troubleshooting

### Task Stuck in Queue

```bash
# Check status
curl http://localhost:3000/api/swarm/status

# Check that agent is ready
curl http://localhost:3000/api/swarm/health
```

### Task Failed

```bash
# Get error message
curl http://localhost:3000/api/swarm/tasks/task_id
# Check response.task.error field
```

### No Specialist Available

```bash
# Verify specialists are loaded
curl http://localhost:3000/api/swarm/specialists

# Check system health
curl http://localhost:3000/api/swarm/health
```

## Command Line Examples

### Submit and Wait (manual polling)

```bash
#!/bin/bash

# Submit task
RESPONSE=$(curl -s -X POST http://localhost:3000/api/swarm/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "fromPlatform": "telegram",
    "taskType": "web_search",
    "message": "What is the weather?"
  }')

TASK_ID=$(echo $RESPONSE | jq -r '.taskId')
echo "Task ID: $TASK_ID"

# Poll for completion
while true; do
  STATUS=$(curl -s http://localhost:3000/api/swarm/tasks/$TASK_ID)
  STATE=$(echo $STATUS | jq -r '.task.status')

  echo "Status: $STATE"

  if [ "$STATE" = "completed" ]; then
    RESULT=$(echo $STATUS | jq -r '.task.result')
    echo "Result: $RESULT"
    break
  elif [ "$STATE" = "failed" ]; then
    ERROR=$(echo $STATUS | jq -r '.task.error')
    echo "Error: $ERROR"
    break
  fi

  sleep 1
done
```

## Next Steps

1. **Monitor in Production**
   - Set up alerts for failed tasks
   - Track processing times
   - Monitor queue depth

2. **Optimize Specialists**
   - Adjust preferred models
   - Add custom specialists
   - Fine-tune capability routing

3. **Scale the System**
   - Add more specialist instances
   - Implement persistence layer
   - Distribute across multiple workers

## Support

For more detailed information, see:
- `/server/SWARM_IMPLEMENTATION.md` - Full technical documentation
- `/server/src/swarm/` - Source code with inline comments
- API endpoints return detailed error messages

## API Reference Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| /api/swarm/status | GET | Coordinator status |
| /api/swarm/health | GET | System health check |
| /api/swarm/stats | GET | Detailed statistics |
| /api/swarm/tasks | GET | List tasks (with filters) |
| /api/swarm/tasks/:id | GET | Get task details |
| /api/swarm/tasks | POST | Submit new task |
| /api/swarm/specialists | GET | List specialists |

All endpoints are fully functional and ready to use!

---
name: "Unified Bot Architecture (v2)"
description: "Complete architecture reference for PersonalAIBotV2 — Agentic AI Platform with multi-agent orchestration, 4-layer MemGPT memory, self-evolution engine, 40+ tools, and production hardening. Read this before any project work."
---

# PersonalAIBotV2 — Complete Architecture Reference

> **Last audited**: 2026-03-22  
> **Stack**: TypeScript, Express, Socket.IO, React+Vite, SQLite, Google GenAI SDK

This is the authoritative reference for `PersonalAIBotV2`. Read this document fully before making any changes to the project. It covers all subsystems, file locations, data flows, and operational details.

---

## 1. System Topology

Primary agents and channels:

- `Jarvis Root Admin` — orchestrator and final synthesizer
- `Gemini CLI Agent` — research + external context
- `Codex CLI Agent` — structured analysis + execution blueprint
- `Claude CLI Agent` — risk/quality gate
- `Facebook Extension` — automation plugin
- `LINE Bot` and `Telegram Bot` — user-facing messaging channels
- `Dashboard` — web-based admin UI (React + Vite + TailwindCSS)
- `Jarvis Terminal` — xterm.js web terminal via WebSocket

High-level message flow:

1. User message enters LINE/Telegram/Dashboard/Terminal.
2. Messaging bridge resolves normal mode or Boss mode (`@jarvis`, `@gemini`, `@codex`, `@claude`).
3. Unified memory reconstructs context (4 layers).
4. Agent classifies task → selects provider/model → executes agentic loop.
5. Result is normalized, token usage tracked, and response returned.
6. Background tasks: fact extraction, summarization, self-reflection.

---

## 2. Server Entry Point

**File**: `server/src/index.ts` (464 lines)

Startup sequence:

| Step | Process | Key Function/Module |
|------|---------|-------------------|
| 1 | Env validation | `configValidator.ts` (Zod-based) |
| 2 | Express setup | CORS, security headers, rate limiting, body parsing |
| 3 | DB init | `initDb()` → SQLite tables + `initUnifiedMemory()` → Vector Store |
| 4 | Provider system | `initRegistry()` → `ProviderFactory.initializeAll()` → `startHealthChecker()` |
| 5 | API routes | `registerHttpSurface()` → REST + WebSocket + Swagger UI (`/api-docs`) |
| 6 | Socket auth | `attachSocketAuth()` + `setupSocketHandlers()` |
| 7 | Terminal gateway | `setupTerminalGateway()` — xterm.js WebSocket, max 10 sessions, 1h idle timeout |
| 8 | Bot agents | `startBots()` → LINE + Telegram webhook adapters |
| 9 | Swarm coordinator | `getSwarmCoordinator().init()` + task queue event broadcasting via Socket.IO |
| 10 | Agent handler | Wire `systemAgent` to terminal `@agent` commands |
| 11 | Background jobs | `startIdleLoop()` + `startSubconsciousSleepJob()` |
| 12 | Graceful shutdown | SIGINT/SIGTERM → close HTTP, terminal, bots, swarm, queues, browser |

Security middleware stack:
- Global rate limit: 120 req/min API, 30 req/min AI
- Per-user rate limit: 10 AI chats/min, 5 content gen/min, 30 memory ops/min, 20 tool calls/min
- XSS/SQLi sanitizer middleware (excludes webhook paths)
- Security headers: X-Content-Type-Options, X-Frame-Options, X-XSS-Protection
- Socket auth token (localhost-only distribution)
- Request timeout: 120s
- Prometheus metrics at `/metrics`

---

## 3. Agent Class (Core AI Engine)

**File**: `server/src/bot_agents/agent.ts` (1,144 lines)

This is the heart of the system — an **Autonomous AI Agent** with ReAct-style planning.

### Processing Pipeline

1. **Task Classification** (`config/aiConfig.ts`) — classifies into: GENERAL, COMPLEX, CODE, DATA, THINKING, VISION, WEB_BROWSER, SYSTEM
2. **Provider Routing** — selects AI model per task type + per-bot override + health-aware failover
3. **Memory Context Build** — 4-layer context from `unifiedMemory.buildContext()`
4. **ReAct Planning** (for COMPLEX/CODE/DATA/THINKING, messages > 30 chars) — generates execution plan via lightweight model
5. **Persona + System Instruction** — loads persona config + bot identity + core memory + archival + learnings + goals + plan context
6. **Agentic Loop** — iterates LLM calls + tool execution until final text response (max turns per task type)
7. **Reviewer Gate** (optional) — cross-checks response quality before delivery
8. **Background Enrichment** (async) — archival extraction, core profile extraction, summarization, self-reflection

### Turn Limits per Task Type

| Task Type | Max Turns |
|-----------|-----------|
| GENERAL | 10 |
| SYSTEM | 5 |
| COMPLEX | 25 |
| CODE | 20 |
| DATA | 20 |
| THINKING | 25 |
| VISION | 8 |
| WEB_BROWSER | 15 |

### Failover Chain

Intra-provider (Gemini): `gemini-2.5-flash → gemini-2.5-flash-lite → gemini-2.0-flash → gemini-2.0-flash-lite → gemini-1.5-flash`

Cross-provider: cycles through `Agent.FALLBACK_CHAIN` (openai, openrouter, minimax)

### Safety Mechanisms

- Agent timeout: 120s (`AGENT_TIMEOUT_MS`)
- Tool timeout: 45s (`TOOL_TIMEOUT_MS`)
- Tool output truncation: 12,000 chars (`MAX_TOOL_OUTPUT`)
- Parallel tool max: 5 concurrent (`PARALLEL_TOOL_MAX`)
- Tool retry: max 2 retries with exponential backoff (800ms base)
- Circuit breaker per tool (auto-disable after repeated failures)
- Per-user message queue (prevents concurrent processing for same user)
- Consecutive error threshold: 3 → forces text response, abandons plan

### Key Dependencies

- `agentTelemetry.ts` — run tracking, circuit breaker, per-user queue
- `agentPhase2.ts` — reviewer gate, execution plan parsing, retryable error detection
- `config/aiConfig.ts` — task classification logic
- `config/configManager.ts` — runtime configuration
- `ai/personaManager.ts` — persona loading per platform

---

## 4. Unified Memory System (MemGPT-Inspired)

**File**: `server/src/memory/unifiedMemory.ts` (667 lines)

### 4-Layer Architecture

| Layer | Name | Storage | Purpose | Key Config |
|-------|------|---------|---------|------------|
| 1 | **Core Memory** | SQLite `core_memory` | User profile/facts — always in system prompt | Extracted every 15 messages |
| 2 | **Working Memory** | RAM cache (LRU) | Last N messages, fast access | TTL 60min, max 500 sessions, configurable message limit |
| 3 | **Recall Memory** | SQLite `episodes` | Full searchable chat history (text search) | LIKE query with keyword extraction |
| 4 | **Archival Memory** | SQLite `archival_memory` + Vector Store | Long-term facts with semantic embeddings | Max 200 facts/chat, similarity threshold 0.55, extracted every 5 messages |

### Token Budget

```
System Prompt:  2,000 tokens
Core Memory:    1,500 tokens
Summary:          500 tokens
Archival Facts: 2,000 tokens
History:        8,000 tokens
User Message:   2,000 tokens
─────────────────────────────
Total Budget:  16,000 tokens (~40K chars)
```

Token estimation: `Math.ceil(text.length / 2.5)` (Thai/English mix)

### Supporting Memory Modules

| Module | File | Purpose |
|--------|------|---------|
| Vector Store | `memory/vectorStore.ts` | HNSW index for fast semantic search, rebuild from SQLite |
| Embedding Provider | `memory/embeddingProvider.ts` | Gemini embedding with model-chain fallback, caching + batching |
| GraphRAG | `memory/graphMemory.ts` | Knowledge graph (nodes + edges) in SQLite |
| Conversation Summarizer | `memory/conversationSummarizer.ts` | Rolling summaries with provider-backed LLM |
| Plan Tracker | `memory/planTracker.ts` | Stateful plan management (create/update/close) |
| Goal Tracker | `memory/goalTracker.ts` | Active goal tracking per user |

### Archival Memory Features

- **Deduplication**: cosine similarity > 0.9 → update existing instead of inserting
- **Smart Pruning**: when exceeding 200 facts, delete shortest+oldest first (not pure FIFO)
- **Importance Scoring**: semantic similarity (70%) + recency (20%) + length bonus (10%)
- **Cache**: search results cached 1 hour per chatId+query

---

## 5. Multi-Agent Swarm Orchestration

### Swarm Coordinator

**File**: `server/src/swarm/swarmCoordinator.ts` (77,972 bytes — largest file in project)

- Manages batch delegation to specialist CLI agents
- Socket.IO event broadcasting for real-time dashboard updates
- Events: `swarm:task:created/started/completed/failed`, `swarm:batch:updated/completed`

### Jarvis Planner

**File**: `server/src/swarm/jarvisPlanner.ts` (928 lines)

Planning algorithm:

1. **Objective Mode Detection**: research / engineering / operations / general (keyword-based)
2. **Signal Analysis**: evaluates 10+ boolean signals (requiresExternalEvidence, requiresScenarioAnalysis, requiresImplementationPlan, requiresRiskReview, etc.)
3. **Complexity Scoring**: 0-8 scale, determines lane budget (1-5 lanes)
4. **Work Package Creation**: generates task-specific work packages based on signals
5. **Specialist Scoring**: `score = intentStrength×4 + modeBias×2 + capabilityFit×3 - loadPenalty×2.5 - healthPenalty`
6. **Assignment**: best specialist per work package, avoiding repeated assignment
7. **Delegation Message Generation**: builds task briefs per specialist with mode-specific rules

### CLI Specialist Profiles

| Specialist | Primary Capabilities | Intent Strengths | Best For |
|-----------|---------------------|-----------------|----------|
| **Gemini CLI** | web_search, translation, summarization, data_analysis | fact_gathering (5), scenario_mapping (4) | Research, evidence collection |
| **Codex CLI** | code_generation, data_analysis, summarization | structured_analysis (5), execution_blueprint (5) | Engineering, implementation planning |
| **Claude CLI** | code_review, data_analysis, summarization | risk_review (5), quality_gate (5) | Risk review, quality assurance |

### Boss Mode (LINE/Telegram)

- Summon: `@jarvis`, `@gemini`, `@codex`, `@claude`
- Activates per-user boss session via `messagingBridge.ts`
- `exit`/`quit`/`bye` leaves boss mode
- Shared conversation id: `boss_shared_<platform>_<userId>`
- CLI runtime hardening: npx fallback for Codex (`@openai/codex`) and Claude (`@anthropic-ai/claude-code`)

### Supporting Swarm Files

| File | Purpose |
|------|---------|
| `swarm/taskQueue.ts` | Priority-based task queue with event callbacks |
| `swarm/specialists.ts` | Specialist definitions and configurations |
| `swarm/swarmTools.ts` | Agent-callable swarm coordination tools |
| `swarm/workspace.ts` | Workspace management for swarm tasks |

---

## 6. AI Router

**File**: `server/src/ai/aiRouter.ts` (303 lines)

- **Multi-provider**: Gemini, OpenAI, OpenRouter, Minimax
- **Registry adapter pattern**: `RegistryAIProviderAdapter` wraps any provider into uniform `AIProvider` interface
- **Fallback chain**: tries providers in order: preferred → registry fallback → default chain → all enabled
- **Usage tracking**: records provider, model, task, tokens, duration, success/failure per call
- **Provider cache**: lazily creates and caches provider adapters

### Provider System Files

| File | Purpose |
|------|---------|
| `providers/registry.ts` | Provider registry with fallback order |
| `providers/providerFactory.ts` | Dynamic provider instantiation |
| `providers/agentRuntime.ts` | Runtime provider abstraction for Agent class |
| `providers/healthChecker.ts` | Periodic provider health monitoring |
| `providers/keyManager.ts` | Encrypted API key management |

---

## 7. Tools System

**File**: `server/src/bot_agents/tools/index.ts` (312 lines — registry and handlers)

### 40+ Tools by Category

| Category | Tools | File |
|----------|-------|------|
| **Utility** | `get_current_time`, `echo_message` | `tools/index.ts` |
| **OS Control** | `run_command`, `run_python`, `open_application`, `close_application`, `system_info`, `screenshot_desktop`, `clipboard_read`, `clipboard_write` | `tools/os.ts` |
| **File Ops** | `list_files`, `read_file_content`, `write_file_content`, `delete_file`, `send_file_to_chat` | `tools/file.ts` |
| **Browser** | `browser_navigate`, `browser_click`, `browser_type`, `browser_close` | `tools/browser.ts` |
| **Web/Search** | `web_search`, `read_webpage`, `mouse_click`, `keyboard_type` | `tools/limitless.ts` |
| **Media** | `generate_image`, `generate_speech`, `generate_video` | `tools/media_generation.ts` |
| **Office** | `read_document`, `create_document`, `edit_document`, `read_google_doc` | `tools/office_tools.ts` |
| **Memory** | `memory_search`, `memory_save` | `tools/index.ts` |
| **Cron Jobs** | `create_cron_job`, `list_cron_jobs`, `delete_cron_job` | `tools/cron_tools.ts` |
| **System Awareness** | `get_my_config`, `list_available_models`, `set_my_model`, `get_system_status` | `tools/system.ts` |
| **Self-Evolution** | `self_read_source`, `self_edit_persona`, `self_add_learning`, `self_view_evolution`, `self_reflect`, `self_heal` | `tools/evolution.ts` |
| **Swarm** | Swarm coordination tools | `swarm/swarmTools.ts` |
| **Planning** | Stateful plan tools (create, update, close plans) | `tools/planning.ts` |
| **Generative UI** | `render_ui` | `tools/ui.ts` |
| **Dynamic** | Hot-reloaded from `server/dynamic_tools/` directory | `tools/dynamicTools.ts` |

### Tool Execution Model

- **Parallel**: Read-only/safe tools run concurrently (max 5 batch)
- **Sequential**: Mutation tools (`browser_*`, `run_command`, `write_file_content`, `delete_file`, `run_python`, `mouse_click`, `keyboard_type`) run one-at-a-time
- **Sequential tools set**: `SEQUENTIAL_TOOLS` in `agent.ts`
- **Sandbox/Validator**: `tools/toolSandbox.ts` + `tools/toolValidator.ts`
- **Per-tool enabled filtering**: tools filtered by persona `enabledTools` + database bot config

---

## 8. Self-Evolution Engine

### Self-Upgrade System (Core)

**File**: `server/src/evolution/selfUpgrade.ts` (~1700 lines)

The autonomous code modification engine. Scans the codebase for bugs/improvements, proposes fixes, and implements them with multi-layer safety gates.

#### 9-Phase Implementation Pipeline

| Phase | Name | Description |
|-------|------|-------------|
| 1 | **Scan & Map** | LLM reads source files in batches of 3, identifies concrete bugs (confidence > 0.7), and simultaneously extracts architectural blueprints into `codebase_map` |
| 2 | **Filter** | Rejects non-source files (`.md`, `.txt`, `.css`, test files, docs) at scan and insert time |
| 3 | **Validate** | Pre-implementation gate: checks file exists, is production source, not in Protected Core |
| 4 | **Impact Analysis** | Static analysis of exported symbols → finds all caller files → assigns risk level (safe/moderate/high) |
| 5 | **Learning Feedback** | Queries Learning Journal for relevant past failures, semantic search by proposal title, same-file rejection history |
| 6 | **Planning** | LLM generates step-by-step implementation plan with risk assessment; can reject proposal before any code is written |
| 7 | **Implement** | Delegates to specialist agents (coder → reviewer → codex-cli → claude-cli fallback chain) with plan context injected |
| 8 | **TSC Verification** | Baseline comparison: captures pre-existing errors, only rejects on NEW compile errors introduced by the change |
| 9 | **Runtime Boot Test** | Spawns a child process on a test port, waits for `/health` endpoint to respond OK within 4 seconds |

#### Scan Filtering

- **SKIP_DIRS**: `node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`, `__tests__`, `test`, `docs`, `logs`
- **SCAN_EXTENSIONS**: `.ts`, `.tsx`, `.js`, `.jsx` only
- **SKIP_FILE_PATTERNS**: test/spec files, `.d.ts`, `README`, `CHANGELOG`, `REFACTORING`, `.example`
- **NON_SOURCE_PATTERNS** (insert gate): blocks `.md`, `.txt`, `.json`, `.css`, `.html`, `N/A`, `multiple_files`

#### Two-Mode Implementation

- **SINGLE-FILE mode** (risk = safe): Only primary file edited, strict "no signature changes" rule, injected with Second Brain context
- **MULTI-FILE mode** (risk = moderate/high): AI receives dependency map + second brain architectural blueprints + affected file previews, authorized to edit primary + all dependent files, 4-step process (Plan → Verify → Edit → Check)

#### Multi-File Backup & Rollback

- All target files (primary + dependents) backed up before implementation
- `rollbackAll()` atomically restores every file on any failure
- Boot Guardian breadcrumb saved for crash recovery
- Outer catch block also rolls back all tracked files

#### Learning Journal Integration

- Before implementation: queries `error_solutions`, `performance`, `tool_usage` learnings + semantic search
- Same-file rejection history injected into prompt
- On TSC/runtime failure: automatically records lesson with 0.8 confidence
- On success: records positive learning for pattern reinforcement

#### Planning Phase

- Uses `gemini-2.0-flash` for fast, cheap plan generation
- Plan includes: concrete steps with function/line references, files to edit, risk assessment
- `shouldProceed: false` → proposal rejected before any code changes
- Plan steps injected into implementation prompt as ordered checklist

#### Protected Core Files (Immortal Sandbox)

Cannot be auto-upgraded: `index.ts`, `config.ts`, `configValidator.ts`, `queue.js`, `database/db.ts`, `evolution/selfUpgrade.ts`, `evolution/selfReflection.ts`, `terminal/terminalGateway.ts`, `api/socketHandlers.ts`, `api/upgradeRoutes.ts`

#### Key Functions

| Function | Purpose |
|----------|---------|
| `startSelfUpgrade()` | Initialize idle-triggered scan loop |
| `scanAndPropose()` | Batch scan files → LLM analysis → insert proposals |
| `implementProposalById()` | Full 9-phase implementation pipeline |
| `analyzeImpact()` | Static cross-file dependency analysis |
| `createImplementationPlan()` | LLM-generated step-by-step plan |
| `buildUpgradeLearningContext()` | Query Learning Journal for relevant lessons |
| `runtimeBootTest()` | Spawn test server and hit /health |
| `verifyUpgrade()` | TSC baseline comparison |
| `captureBaselineErrors()` | Cache pre-existing compile errors |

### Boot Guardian

**File**: `server/src/bootGuardian.ts` (91 lines)

- Catches crashes within 15 seconds of startup
- Checks for recent upgrade breadcrumb (`latest_upgrade.json`)
- Auto-rollbacks the last change if crash detected post-upgrade

### Self-Reflection

**File**: `server/src/evolution/selfReflection.ts` (267 lines)

- Triggers every 25 completed agent runs (configurable)
- Analyzes: error patterns, performance, tool usage, model effectiveness
- Generates: findings, suggestions, auto-actions
- Optional LLM-powered deep analysis on last 20 runs
- Auto-actions: add learnings, log warnings

### Self-Healing

**File**: `server/src/evolution/selfHealing.ts` (189 lines)

- Detects 4 issue types: `high_error_rate`, `tool_failing`, `slow_model`, `memory_leak`
- Auto-fixes `slow_model` by switching to faster alternatives
- Runs health check every 100 agent runs

### Learning Journal

**File**: `server/src/evolution/learningJournal.ts` (207 lines)

- 6 categories: `user_patterns`, `tool_usage`, `error_solutions`, `prompt_improvements`, `performance`, `general`
- Vector-indexed for semantic search (Gemini embeddings + HNSW)
- Deduplication: exact match check before insert
- `buildLearningsContext()` — injects top 5 learnings into agent system prompt
- `searchLearnings()` — semantic search with vector store fallback to keyword search
- `applyLearning()` — increments usage count and boosts confidence

### Idle Loop

**File**: `server/src/evolution/idleLoop.ts` (127 lines)

- Proactive AI tasks when idle > 2 hours
- Background loop that performs maintenance and self-improvement tasks

### Subconscious Sleep

**File**: `server/src/scheduler/subconscious.ts` (200+ lines)

When idle > 2 hours (`IDLE_THRESHOLD_MS`), enters sleep mode:

1. **Phase 1**: Summarize conversations with 10+ unsummarized messages
2. **Phase 1.5**: Extract relational knowledge from recent summaries → GraphRAG
3. **Phase 2**: Prune raw messages older than 7 days (keep 50 most recent per conversation)

Check interval: 30 minutes. Wakes up immediately on any user activity (`pingActivity()`).

---

## 9. Terminal Gateway

**File**: `server/src/terminal/terminalGateway.ts` (69,828 bytes)

WebSocket-based terminal via xterm.js:
- PTY management (`ptyManager.ts`) — spawns real OS shells
- Command routing (`commandRouter.ts`) — boss mode commands
- Messaging bridge (`messagingBridge.ts`) — LINE/Telegram boss mode integration
- Admin tools (`adminTools.ts`) — terminal admin utilities
- Jarvis swarm intent detection (`jarvisSwarmIntent.ts`)
- Session management (`sessionManager.ts`)

---

## 10. Dashboard (Frontend)

**Tech**: React + Vite + TailwindCSS  
**Path**: `dashboard/src/`

### Pages (13 total)

| Page | File | Purpose |
|------|------|---------|
| Dashboard | `Dashboard.tsx` | System overview |
| Agent Manager | `AgentManager.tsx` (28KB) | Manage bot agents, enabled tools, models |
| Agent Monitor | `AgentMonitor.tsx` (34KB) | View agent run history, telemetry |
| Multi-Agent | `MultiAgent.tsx` (24KB) | Jarvis Inbox + 3-lane CLI cards |
| Jarvis Terminal | `JarvisTerminal.tsx` (28KB) | Web terminal (xterm.js) |
| Memory Viewer | `MemoryViewer.tsx` | View/search all memory layers |
| Chat Monitor | `ChatMonitor.tsx` | Real-time conversation viewer |
| Bot Personas | `BotPersonas.tsx` | Manage bot personas |
| Persona Editor | `PersonaEditor.tsx` | Edit persona details |
| Settings | `Settings.tsx` (72KB) | System config, API keys, dynamic providers, AES passwords |
| Post Manager | `PostManager.tsx` | Scheduled post management |
| Cron Manager | `CronManager.tsx` | Autonomous AI task scheduling (Cron) |
| QA Database | `QADatabase.tsx` | Q&A override management |
| Tool Manager | `ToolManager.tsx` | Dynamic tool management |

---

## 11. Database Schema

**Files**: `server/src/database/db.ts` (21KB) + `schema.sql` (268 lines)  
**Engine**: SQLite via `better-sqlite3`

### Tables (16+)

| Table | Purpose |
|-------|---------|
| `conversations` | Messenger threads (id, fb_user_id, summary, auto_reply) |
| `messages` | Per-conversation messages (role, content, FK → conversations) |
| `user_profiles` | Long-term user profiles (facts, preferences, tags) |
| `episodes` | Episodic memory for Telegram/LINE (chat_id, role, content) |
| `knowledge` | Semantic memory with embeddings |
| `core_memory` | Core Memory blocks (chat_id + block_label, always in context) |
| `archival_memory` | Archival facts with embeddings for semantic search |
| `knowledge_nodes` | GraphRAG entity nodes |
| `knowledge_edges` | GraphRAG relationship edges (source → target with weight) |
| `agent_plans` | Stateful plans (objective, steps_json, status) |
| `qa_pairs` | Q&A override database (pattern matching) |
| `personas` | Persona configurations |
| `scheduled_posts` | Scheduled social media posts |
| `cron_jobs` | Autonomous Agent scheduled tasks |
| `activity_logs` | System activity logs |
| `settings` | Key-value settings store (Contains Admin Password) |
| `api_keys` | Encrypted API key storage |
| `provider_config` | Runtime provider configuration |
| `processed_messages` | Message deduplication |
| `comment_watches` / `replied_comments` | Facebook comment automation |

Additional tables created at runtime:
- `usage_tracking` — token usage tracking
- `goal_*` — goal tracker tables
- `persistent_queue` — crash-safe message queue
- `codebase_map` — Second Brain architecture map (file_path, summary, exports, dependencies)
- Bot registry tables

---

## 12. Utility Modules

**Path**: `server/src/utils/` (19 files)

| Module | Purpose |
|--------|---------|
| `auth.ts` | JWT authentication |
| `logger.ts` | Winston-based logging with levels |
| `metrics.ts` | Prometheus metrics middleware |
| `rateLimiter.ts` | Per-user rate limiting |
| `sanitizer.ts` | XSS/SQLi/prototype pollution prevention |
| `cache.ts` | In-memory cache with TTL |
| `mutex.ts` | Per-key mutex for concurrent write protection |
| `errorHandler.ts` | Global error + 404 handlers |
| `usageTracker.ts` | Token usage tracking and reporting |
| `socketBroadcast.ts` | Global Socket.IO broadcast utility |
| `streamManager.ts` | SSE stream management |
| `persistentQueue.ts` | Crash-safe SQLite-backed queue |
| `backup.ts` | Database backup utilities |
| `retry.ts` | Generic retry helper |
| `validation.ts` | Input validation utilities |
| `fileProcessor.ts` | File processing for attachments |
| `approvalSystem.ts` | Human-in-the-loop approval |
| `geminiOAuth.ts` | Gemini OAuth flow |
| `webhookPaths.ts` | Webhook path detection for raw body capture |

---

## 13. Project File Structure

```
PersonalAIBotV2/
├── server/
│   ├── src/
│   │   ├── index.ts                      # Server entry point
│   │   ├── config.ts                     # App configuration
│   │   ├── configValidator.ts            # Zod-based env validation
│   │   ├── queue.ts                      # Chat + webhook queues
│   │   ├── utils.ts                      # Shared utilities
│   │   ├── crypto.ts                     # Encryption helpers
│   │   ├── cli.ts                        # CLI entry point
│   │   ├── ai/
│   │   │   ├── aiRouter.ts               # Multi-provider AI routing
│   │   │   ├── personaManager.ts         # Persona loading
│   │   │   ├── types.ts                  # AI type definitions
│   │   │   └── providers/                # AI provider implementations
│   │   ├── bot_agents/
│   │   │   ├── agent.ts                  # Main Agent class (1,144 lines)
│   │   │   ├── botManager.ts             # LINE/Telegram adapters
│   │   │   ├── agentTelemetry.ts         # Run tracking, circuit breaker
│   │   │   ├── agentPhase2.ts            # Reviewer gate, plan parsing
│   │   │   ├── types.ts                  # Agent type definitions
│   │   │   ├── config/                   # AI config, config manager
│   │   │   ├── providers/                # Bot provider base class
│   │   │   ├── registries/               # Bot registry
│   │   │   └── tools/                    # 40+ tool implementations
│   │   │       ├── index.ts              # Tool registry + handlers
│   │   │       ├── os.ts                 # OS control tools
│   │   │       ├── file.ts               # File operation tools
│   │   │       ├── browser.ts            # Browser automation
│   │   │       ├── limitless.ts          # Web search + HID tools
│   │   │       ├── system.ts             # System awareness tools
│   │   │       ├── evolution.ts          # Self-evolution tools
│   │   │       ├── planning.ts           # Stateful planning tools
│   │   │       ├── ui.ts                 # Generative UI tools
│   │   │       ├── dynamicTools.ts       # Hot-reload custom tools
│   │   │       ├── toolSandbox.ts        # Tool sandbox
│   │   │       └── toolValidator.ts      # Tool validation
│   │   ├── memory/
│   │   │   ├── unifiedMemory.ts          # 4-layer memory engine (667 lines)
│   │   │   ├── vectorStore.ts            # HNSW vector index
│   │   │   ├── embeddingProvider.ts      # Embedding with fallback
│   │   │   ├── graphMemory.ts            # GraphRAG knowledge graph
│   │   │   ├── conversationSummarizer.ts # Rolling summarization
│   │   │   ├── planTracker.ts            # Plan management
│   │   │   ├── goalTracker.ts            # Goal tracking
│   │   │   └── types.ts                  # Memory type definitions
│   │   ├── swarm/
│   │   │   ├── swarmCoordinator.ts       # Multi-agent orchestration (77KB)
│   │   │   ├── jarvisPlanner.ts          # Specialist scoring (928 lines)
│   │   │   ├── taskQueue.ts              # Priority task queue
│   │   │   ├── specialists.ts            # CLI specialist configs
│   │   │   ├── swarmTools.ts             # Swarm tools
│   │   │   └── workspace.ts              # Workspace management
│   │   ├── terminal/
│   │   │   ├── terminalGateway.ts        # xterm.js WebSocket (69KB)
│   │   │   ├── commandRouter.ts          # Command routing
│   │   │   ├── messagingBridge.ts        # LINE/Telegram bridge
│   │   │   ├── ptyManager.ts             # PTY management
│   │   │   ├── adminTools.ts             # Admin terminal tools
│   │   │   ├── sessionManager.ts         # Session management
│   │   │   └── jarvisSwarmIntent.ts      # Swarm intent detection
│   │   ├── evolution/
│   │   │   ├── selfUpgrade.ts            # 9-phase autonomous code upgrade (~1700 lines)
│   │   │   ├── selfReflection.ts         # Auto performance analysis
│   │   │   ├── selfHealing.ts            # Auto health checks
│   │   │   ├── learningJournal.ts        # Learning persistence + semantic search
│   │   │   └── idleLoop.ts              # Background idle tasks
│   │   ├── scheduler/
│   │   │   ├── scheduler.ts              # Cron-based scheduler
│   │   │   └── subconscious.ts           # Memory consolidation during sleep
│   │   ├── database/
│   │   │   ├── db.ts                     # SQLite via better-sqlite3
│   │   │   └── schema.sql                # 16+ tables definition
│   │   ├── providers/
│   │   │   ├── registry.ts               # Provider registry
│   │   │   ├── providerFactory.ts        # Dynamic provider loading
│   │   │   ├── agentRuntime.ts           # Runtime abstraction
│   │   │   ├── healthChecker.ts          # Health monitoring
│   │   │   └── keyManager.ts             # Encrypted key management
│   │   ├── api/
│   │   │   ├── routes.ts                 # Main API routes
│   │   │   ├── httpSurface.ts            # HTTP surface registration
│   │   │   ├── socketHandlers.ts         # Socket.IO handlers
│   │   │   ├── swarmRoutes.ts            # Swarm API endpoints
│   │   │   ├── providerRoutes.ts         # Provider API endpoints
│   │   │   ├── botsRouter.ts             # Bot management API
│   │   │   ├── systemRouter.ts           # System status API
│   │   │   ├── terminalRoutes.ts         # Terminal API
│   │   │   ├── toolsRouter.ts            # Tools API
│   │   │   ├── cronRoutes.ts             # Cron Jobs API
│   │   │   ├── liveVoice.ts              # WebRTC voice API
│   │   │   └── openapi.ts               # Swagger/OpenAPI spec
│   │   ├── system/
│   │   │   ├── agentTopology.ts          # JARVIS_ROOT_ADMIN config
│   │   │   └── pluginRegistry.ts         # Plugin system
│   │   ├── automation/
│   │   │   └── browser.ts               # Puppeteer browser automation
│   │   ├── config/                       # Runtime settings, security
│   │   ├── schemas/                      # Validation schemas
│   │   ├── facebook/                     # Facebook integration
│   │   └── utils/                        # 19 utility modules
│   ├── dynamic_tools/                    # Hot-reloadable custom tools
│   ├── personas/                         # Persona definition files
│   ├── data/                             # SQLite DB files
│   └── .env                              # Environment variables
├── dashboard/
│   ├── src/
│   │   ├── App.tsx                       # Main app with routing
│   │   ├── main.tsx                      # Vite entry
│   │   ├── pages/                        # 13 dashboard pages
│   │   ├── components/                   # Shared UI components
│   │   ├── hooks/                        # React hooks
│   │   ├── services/                     # API service layer
│   │   └── lib/                          # Utility libraries
│   ├── vite.config.ts
│   └── tailwind.config.js
├── fb-extension/                         # Facebook browser extension
├── docs/                                 # 26 documentation files
├── install.bat                           # Windows install script
├── start.bat                             # Windows start script
├── start_unified.bat                     # Unified start script
├── Dockerfile + docker-compose.yml       # Docker support
└── .agent/skills/                        # This skill file
```

---

## 14. Required Environment Variables

Minimum practical keys in `server/.env`:

```env
GEMINI_API_KEY=
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
TELEGRAM_BOT_TOKEN=
SOCKET_AUTH_TOKEN=
JWT_SECRET=
ADMIN_USER=admin
ADMIN_PASSWORD=admin
LOG_LEVEL=info
HTTP_CONSOLE_MODE=errors
SWARM_VERBOSE_LOGS=0
JARVIS_MULTIPASS=0
```

Optional:

```env
GEMINI_CLI_PATH=
CODEX_CLI_PATH=
CLAUDE_CLI_PATH=
GEMINI_EMBEDDING_MODEL=gemini-embedding-001
JARVIS_TERMINAL_DIRECT_MODE=1
SWARM_SKIP_REVIEWER_GATE=1
SWARM_SKIP_BACKGROUND_ENRICHMENT=1
STARTUP_COMPACT=1
```

---

## 15. Logging and Noise Reduction

- `LOG_LEVEL=info` (recommended)
- `HTTP_CONSOLE_MODE=errors` (suppresses 304, polling noise)
- `SWARM_VERBOSE_LOGS=0` (production)
- 304 and auth-bootstrap 401 suppressed in console
- Swarm pending-task logs only on count change
- Fallback discovery logs at debug level

---

## 16. Smoke Test Checklist

1. Login dashboard → verify protected endpoints return 200
2. Send LINE and Telegram message → verify bot response
3. Summon each boss mode → `@jarvis`, `@gemini`, `@codex`, `@claude`
4. Launch batch from Multi-Agent Center → verify 3 lanes receive work
5. Confirm per-lane token footer updates
6. Open Jarvis Terminal → run commands
7. Check Memory Viewer → verify 4-layer memory data
8. Verify server console is not flooded with noise

---

## 17. Known Limitations

- CLI token usage may be estimated when backend doesn't report exact counts
- First-run `npx` cold start slower for Codex/Claude
- Shared hybrid memory is compact by design; not full transcript replay
- Vector Store rebuild from SQLite can be slow for large databases
- Self-reflection requires 25+ runs to trigger
- Subconscious sleep requires 2+ hours of idle time
- Self-Upgrade runtime boot test adds ~5-10s per proposal (worth it for crash prevention)
- Self-Upgrade planning phase adds one extra LLM call per proposal (uses cheap gemini-2.0-flash)
- 10 pre-existing TSC errors in non-evolution files (baseline; does not block upgrades)

---

## 18. Implementation Snapshot (2026-03-13)

This snapshot records the latest production-facing fixes and where they live.
Use this section as the first read before continuing development in a new chat/team handoff.

### 18.1 Voice + Jarvis Identity Parity

- `server/src/api/socketHandlers.ts`
  - Added live function bridge `jarvis_agent_execute` for Gemini Live sessions.
  - Added queueing for voice tool calls per socket (`voiceAgentQueues`) to avoid race conditions.
  - Added key source diagnostics log (`resolveProviderApiKey`) with masked fingerprint.
- `server/src/api/liveVoice.ts`
  - Added function declaration/tool-response support for Gemini Live websocket setup.
  - Improved live model resolution with candidate ranking + fallback.

Outcome:
- Voice mode can delegate actions to Jarvis agent tools and return results into live conversation flow.

### 18.2 Voice Reliability Hardening

- `server/src/api/socketHandlers.ts`
  - Added timeout guard for voice tool bridge execution.
  - Added output truncation for large tool responses.
  - Added explicit rate-limit detection fallback message for voice flows.
- `server/src/bot_agents/agent.ts`
  - Added web-voice path optimizations (smaller turn budget, shorter timeout path, reduced optional background load).

Outcome:
- Lower timeout/flood risk and clearer fallback behavior during provider pressure.

### 18.3 Runtime-Tunable Controls (new)

- `server/src/config/runtimeSettings.ts`
  - Added safe DB-read wrapper so runtime settings do not crash if queried before DB init.
  - Added runtime keys (DB-first, env fallback):
    - `voice_tool_bridge_timeout_ms`
    - `voice_tool_bridge_output_max_chars`
    - `web_voice_agent_timeout_ms`
    - `web_voice_max_turns`
    - `web_voice_skip_reviewer_gate`
    - `web_voice_skip_background_enrichment`
    - `swarm_skip_reviewer_gate`
    - `swarm_skip_background_enrichment`
    - `agent_provider_rate_limit_cooldown_ms`
- `server/src/api/socketHandlers.ts`
  - Now reads bridge timeout/output caps from runtime settings (not env-only constants).
- `server/src/bot_agents/agent.ts`
  - Now reads web-voice limits, swarm/web-voice skip toggles, and provider cooldown from runtime settings.
- `server/src/api/systemRouter.ts`
  - Added `GET /api/system/runtime-controls` to inspect effective runtime control values and their source (`db|env|default`).

Outcome:
- Root admin can tune critical voice/swarm behavior from settings DB without redeploying env files.

### 18.4 Verification

- `server/src/__tests__/unit/runtimeSettings.test.ts`
  - Expanded coverage for new runtime keys.
  - Verified DB override precedence over env fallback.
  - Verified clamping and boolean parsing behavior.

Recommended quick validation after deploy:
1. Set `web_voice_max_turns=4` in settings and confirm shorter voice turns.
2. Set `agent_provider_rate_limit_cooldown_ms=30000` and confirm cooldown log reflects 30s.
3. Trigger live tool call and confirm timeout/output limits follow DB values.

### 18.5 Advanced Agentic Architecture & Autonomous Upgrader (2026-03-20)

- `server/src/bot_agents/tools/file.ts` & `index.ts`
  - Added **Surgical Tools**: `replace_code_block` allows targeted line-replacement instead of full-file overwrites.
- `server/src/swarm/workspace.ts`
  - Added **Forced Chain-of-Thought**: Prompts for Manager, Coder, and Reviewer now mandate `<think>` block generation before tool usage.
  - Added **Plan-Execute Separation**: Coder must output a structured plan before calling surgical tools.
- `server/src/evolution/selfUpgrade.ts`
  - Added **Environmental Feedback Loop**: Auto-runs `npx tsc --noEmit` after autonomous edits. Bootstraps auto-revert + feeds error back to the LLM if compilation breaks.
  - Upgraded **Autonomous Processing**: `implementPendingProposals` automatically pulls both `pending` and `approved` tasks inside the background loop.
  - Added crash recovery: Sweeps and reverts stuck `implementing` tasks back to `approved` on server boot.
- `server/src/api/upgradeRoutes.ts` & `dashboard/src/pages/SelfUpgrade.tsx`
  - Added **Auto-Upgrade UI Toggle**: Dashboard users can now Play/Pause the background self-upgrade loop manually via `/api/upgrade/toggle`.

Outcome:
- Agents are vastly smarter, safer, and capable of fully autonomous, self-correcting operations without human-in-the-loop intervention.

### 18.6 Immortal Core & Boot Guardian (Fail-Safe Systems)
- `server/src/bootGuardian.ts` ensures that a bad auto-upgrade rolls back automatically.
- Security hard-fail states push Telegram/LINE alerts immediately (`botManager.ts:broadcastToAdmins()`).

### 18.7 API Providers, Tool Amplification & Autonomous Cron (2026-03-22)
- **Universal Providers**: Rebuilt the API interface (`aiRouter.ts`) to be provider-agnostic. Media generators (Voice, Image, Video) now proxy through `RestApiProvider` allowing generic endpoints (Cloudflare, Replicate, Fal.ai) without backend code updates.
- **Office Document Intelligence**: Added `office_tools.ts` (`pdf-parse`, `mammoth`, `xlsx`). Agents can natively parse, create, and accurately mutate specific row data in `.xlsx/.csv` and read Public Google Docs.
- **Admin Security**: Removed local `.env` admin locks. `admin/admin` acts as an absolute fallback which sets the AES-256 database password on first boot directly from the Dashboard.
- **Autonomous Cron Scheduling**: 
  - Backend: `scheduler.ts` executes a headless agentic loop based on dynamic `cron_jobs`.
  - Frontend: `CronManager.tsx` deployed for Admin oversight.
  - Agentive Control: `cron_tools.ts` grants the AI tools to schedule/cancel its own tasks naturally through chat requests.

---

- `server/src/index.ts` & `server/src/bootGuardian.ts`
  - Added **Boot Guardian**: Intercepts `uncaughtException` during server startup. If a botched AI edit crashes the server globally, it automatically reverts the file using a pre-edit breadcrumb (`data/upgrade_history`), marks the DB proposal as `rejected`, and cleanly exits to prevent a permanent `nodemon` crash loop.
- `server/src/evolution/selfUpgrade.ts`
  - Added **Protected Core Sandbox**: Hardcoded critical system files (e.g., `selfUpgrade.ts`, config handlers) into `PROTECTED_CORE_FILES` to outright reject and abort AI modifications targeting the architecture that sustains it.

Outcome:
- The server is protected against catastrophic AI code mutilation via auto-reverting syntax failsafes.

### 18.7 Cognitive Self-Upgrade Architecture (Phase 5 - 6)

- `server/src/bot_agents/tools/file.ts` & `index.ts`
  - Added **`search_codebase` (Global Explorer)**: Exposes grep-like functionality so the AI can globally discover import dependencies before blindly deleting or renaming exports.
  - Augmented **`read_file_content`**: Forced the tool to emit strictly numbered lines (`1: code...`) to ensure the agent calculates target offsets with 100% precision.
- `server/src/evolution/selfUpgrade.ts`
  - Added **Trauma Memory Injection**: Dynamically queries `fb-agent.db` for the 5 most recent failed AI edits. These compiler crash logs are injected directly into the Swarm Coordinator's master prompt as `[🚨 CRITICAL TRAUMA MEMORY 🚨]`, halting recurrent hallucination loops.
  - Added **Hardened Rule Prompts**: Mandates that the AI *must* write an architectural `<think>` block and invoke `search_codebase` before interacting with the surgical editor tool.

Outcome:
- The `jarvis_self_upgrade` autonomous agent now "looks before it leaps," acting with human-like analytical caution.

### 18.8 Deep System Audit (2026-03-22)

- **9-Phase Self-Upgrade Pipeline**: Verified that `implementProposalById` strictly enforces the 9 phases, including pre-validation, trauma memory injection, and strict runtime/syntax verifications. 
- **Multi-File Rollback Resilience**: Verified `bootGuardian.ts` and `selfUpgrade.ts` successfully map, backup, and restore N overlapping file paths identically in memory and on disk if a multi-file dependency implementation fails at any layer.
- **Tuning and Flow Validation**: Verified `idleLoop.ts` strict 2-hour idle threshold and `selfReflection.ts` 25-run triggering baseline.
- **Outcome**: The AI evolution loop is officially hardened for full background multi-file operations with zero risk of irreversible, environment-breaking code corruption.

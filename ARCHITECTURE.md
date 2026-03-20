# Terminal Module Architecture

## Module Overview

The terminal module in PersonalAIBotV2 provides comprehensive terminal session management with support for multiple session types and CLI backends.

```
┌─────────────────────────────────────────────────────────────┐
│                    terminalGateway.ts (628 lines)           │
│              Socket.IO Terminal Session Orchestrator        │
│                                                              │
│  Core Responsibilities:                                     │
│  - Socket.IO event handling (create, input, close)         │
│  - Terminal session lifecycle management                   │
│  - PTY process management                                  │
│  - Command routing and execution                           │
│  - Session persistence & timeout handling                 │
└─────────────────────────────────────────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            │               │               │
            ▼               ▼               ▼
    ┌───────────────┐ ┌────────────────┐ ┌───────────────────┐
    │   PTYManager  │ │ SessionManager │ │ CommandRouter     │
    │               │ │                │ │                   │
    │ - createPTY   │ │ - createSession│ │ - routeCommand    │
    │ - detectShell │ │ - getSession   │ │ - getBackends     │
    │ - spawnCLI    │ │ - closeSession │ │ - getCLIConfig    │
    └───────────────┘ └────────────────┘ └───────────────────┘
                            │
            ┌───────────────┼───────────────┬─────────────────┐
            │               │               │                 │
            ▼               ▼               ▼                 ▼
    ┌───────────────┐ ┌─────────────┐ ┌──────────────┐ ┌──────────────┐
    │cliInitializer │ │CliMemory    │ │SwarmLane     │ │TerminalUtils │
    │(NEW - 149)    │ │Manager      │ │Manager       │ │              │
    │               │ │             │ │              │ │- normalizeOut│
    │- isCliType    │ │- prepMemory │ │-persistent   │ │- extractUsage│
    │- isCLIAvail   │ │- persistMem │ │ lanes        │ │              │
    │- spawnCli     │ │             │ │              │ │              │
    │- wrapNodePty  │ │             │ │              │ │              │
    │- getErrorMsg  │ │             │ │              │ │              │
    └───────────────┘ └─────────────┘ └──────────────┘ └──────────────┘
```

## Detailed Module Responsibilities

### terminalGateway.ts (628 lines)
**Purpose:** Main orchestrator for terminal sessions via Socket.IO

**Key Functions:**
- `setupTerminalGateway()` - Initialize terminal gateway on Socket.IO server
- `shutdownTerminalGateway()` - Graceful shutdown of all sessions
- `executeCommand()` - Programmatic command execution (REST API)
- `executeCommandDetailed()` - Command execution with token metadata
- `setAgentHandler()` - Register agent handler for @agent commands

**Socket.IO Events Handled:**
- `terminal:create` - Create a new session (shell, agent, or CLI)
- `terminal:input` - Send input to session
- `terminal:resize` - Resize terminal
- `terminal:close` - Close session
- `terminal:list` - List sessions

**Internal Workflow:**
1. Create terminal session (shell/agent/CLI type)
2. Spawn appropriate process (PTY or node-pty CLI)
3. Attach I/O handlers for bidirectional communication
4. Route input commands to appropriate backends
5. Clean up on session close or disconnect

### cliInitializer.ts (NEW - 149 lines)
**Purpose:** Focused CLI process initialization and configuration

**Exported Functions:**
- `isCliSessionType(type)` - Type guard: checks if type ends with '-cli'
- `isCLIAvailable(sessionType)` - Check if CLI backend is configured & available
- `spawnCliProcess(type, cols, rows, cwd)` - Spawn CLI with proper environment
- `wrapNodePtyProcess(ptyProc)` - Wrap node-pty IPty → PTYProcess interface
- `getCliInitErrorMessage(sessionType, err)` - Generate helpful error hints

**Key Benefits:**
- Encapsulates all CLI-specific initialization logic
- Handles environment configuration (TERM, FORCE_COLOR, etc.)
- Provides helpful error messages with setup hints
- Manages node-pty ↔ PTYProcess interface translation
- Centralizes CLI availability checking

### SessionManager
**Purpose:** Manage terminal session state and lifecycle

**Responsibilities:**
- Track active sessions (shell, agent, CLI)
- Create/destroy sessions
- Handle idle timeouts
- Limit concurrent sessions

### PTYManager
**Purpose:** Process and pseudo-terminal abstraction

**Responsibilities:**
- Create PTY processes using child_process.spawn
- Detect system shell (bash, zsh, powershell, etc.)
- Handle terminal I/O and signaling

### CommandRouter
**Purpose:** Route commands to appropriate backends

**Backends:**
- `shell` - System shell execution (disabled for REST API)
- `agent` - AI agent handler (@agent prefix)
- `meta` - Built-in meta commands (@help, @backends)
- CLI backends - Dynamic `*-cli` (gemini-cli, claude-cli, codex-cli)

### CliMemoryManager
**Purpose:** CLI conversation context persistence

**Responsibilities:**
- Prepare prompt memory for CLI commands
- Persist command history to conversation store
- Manage conversation context

### SwarmLaneManager
**Purpose:** Persistent PTY lanes for swarm-mode execution

**Responsibilities:**
- Maintain persistent connections for swarm mode
- Handle command timeouts and recovery
- Clean up idle lanes

### TerminalUtils
**Purpose:** CLI output normalization and token usage tracking

**Responsibilities:**
- Normalize CLI output across backends
- Extract token usage from CLI responses
- Handle escape code cleanup

## Session Types

### 1. Shell Sessions
- **Type:** `'shell'`
- **Process:** Native PTY (child_process.spawn)
- **Use Case:** Interactive terminal via Web UI
- **Execution:** Line-buffered command mode (no real TTY)

### 2. Agent Sessions
- **Type:** `'agent'`
- **Process:** No PTY (command mode)
- **Use Case:** AI agent command routing
- **Execution:** Calls registered agent handler function

### 3. CLI Sessions
- **Type:** `'<name>-cli'` (e.g., 'claude-cli', 'gemini-cli')
- **Process:** node-pty IPty for CLI tool
- **Use Case:** Direct CLI tool access (Claude, Gemini, Codex)
- **Execution:** Interactive PTY or piped input/output

## Data Flow

### Command Execution Flow
```
User Input
    │
    ▼
terminalGateway.executeCommand()
    │
    ▼
routeCommand() → Determine backend
    │
    ├─→ @help/@backends → executeCommandInternal() → meta response
    │
    ├─→ @agent → agentHandler() → Agent response
    │
    ├─→ shell → cpExec() → Shell output
    │
    └─→ *-cli → cliInitializer.spawnCliProcess()
            │
            ▼
        node-pty spawn
            │
            ▼
        buildCliArgs() + getCliEnv()
            │
            ▼
        runCliCommand()
            │
            ▼
        normalizeCliOutput()
            │
            ▼
        extractCliTokenUsage()
            │
            ▼
        persistCliMemory() [if persistent]
            │
            ▼
        Return CommandExecutionResult
```

## Module Dependencies

**cliInitializer** imports:
- `node-pty` - Native PTY spawning
- `commandRouter` - CLI config lookup
- `ptyManager` - PTYProcess type
- `logger` - Logging

**terminalGateway** imports:
- `cliInitializer` - CLI initialization
- `sessionManager` - Session lifecycle
- `ptyManager` - PTY creation
- `commandRouter` - Command routing
- `cliMemoryManager` - Conversation persistence
- `swarmLaneManager` - Persistent lanes
- `cliCommandExecutor` - CLI arg building
- `terminalUtils` - Output normalization

## Type Safety

All modules use strict TypeScript with proper types:
- `SessionType` - Union of 'shell' | 'agent' | `${string}-cli`
- `PTYProcess` - Interface for process abstraction
- `CommandExecutionResult` - Typed command output with metadata
- `BackendType` - Union of available backends

## Performance Characteristics

- **Memory:** ~2-5MB per active session (including PTY buffers)
- **CPU:** Minimal when idle; event-driven architecture
- **Concurrency:** Limited by `maxSessions` option (default: 10)
- **Timeout:** Idle sessions cleaned after `idleTimeoutMs` (default: 3600000ms)

## Future Enhancements

1. **Voice Handler Module:** Extract audio/voice logic
2. **Meta Command Handler:** Extract @help, @backends, etc.
3. **Session Lifecycle Manager:** Extract PTY lifecycle management
4. **Persistent Sessions:** Database-backed session recovery
5. **Session Sharing:** Allow multiple users to share a session
6. **Playback:** Record and replay terminal sessions

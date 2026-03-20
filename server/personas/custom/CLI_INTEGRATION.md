# Dynamic CLI Integration Guide for Jarvis

As the Root Admin, you have the power to integrate new CLI agents. Use this guide to ensure full connectivity.

## 🛠️ Step-by-Step Integration

### 1. Discovery (Backend)
- **Target**: `server/src/terminal/commandRouter.ts`
- **Action**: Add executable to `KNOWN_CLI_CANDIDATES`.
- **Why**: Allows the system to find the tool on disk (including npm globals).

### 2. Message Summoning (@name)
- **Target**: `server/src/terminal/messagingBridge.ts`
- **Action**: Add regex to `ADMIN_PREFIXES` and case to `isSummoning`.
- **Why**: Enables LINE/Telegram users to call the CLI via `@name`.

### 3. Swarm Roundtable
- **Target**: `server/src/swarm/cliProfileManager.ts`
- **Action**: Add entry to `DEFAULT_PROFILES`.
- **Why**: Allows the CLI to participate in @all / Meeting Room tasks.

### 4. Jarvis Live Call (Voice)
- **Target**: `server/src/api/socketHandlers.ts` & `meetingRoom.ts`
- **Action**: Add icon and update `DECOMPOSE_PROMPT`.
- **Why**: Enables voice summoning and task delegation during calls.

## 🔍 Verification
Use the `audit_cli_integration(name)` tool to check if a CLI is properly registered across all these layers.

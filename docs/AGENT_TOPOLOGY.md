# Agent Topology (Unified Bot v2)

This project runs with a fixed core topology:

- 4 main agents
- 1 CLI bridge agent

## Core Agents

1. FB Extension  
   Controls the Facebook automation extension as a plugin boundary.

2. LINE Bot  
   Handles communication with end users over LINE.

3. Telegram Bot  
   Handles communication with end users over Telegram.

4. Jarvis Root Admin  
   Root system administrator agent. Can summon into LINE and Telegram contexts.

5. Agent Gemini CLI  
   CLI bridge connected to Gemini OAuth flow. Can summon into LINE and Telegram contexts.

## Plugin Boundary

Facebook automation is treated as a plugin and should remain isolated from
transport-specific bot concerns (LINE/Telegram). Runtime plugin status is exposed by:

- `GET /api/system/plugins`
- `GET /api/system/topology`

## Runtime Introspection

The server exposes core runtime topology APIs:

- `GET /api/system/agents`
- `GET /api/system/plugins`
- `GET /api/system/topology`

These endpoints are intended for dashboard health views and ops diagnostics.

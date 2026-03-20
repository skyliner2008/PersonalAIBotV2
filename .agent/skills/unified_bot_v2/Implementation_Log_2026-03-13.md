---
name: "Implementation Log 2026-03-13"
description: "Detailed handover log for recent Jarvis voice/tool/runtime hardening and next development actions."
---

# Implementation Log - 2026-03-13

## Scope

This log captures the latest high-impact backend changes for:

- Jarvis live voice behavior
- Tool execution bridge in live mode
- Runtime safety controls moved from static env to DB-first settings

## What Changed

### 1. Live Voice -> Jarvis Tool Bridge

Files:
- `server/src/api/liveVoice.ts`
- `server/src/api/socketHandlers.ts`

Changes:
- Added Gemini Live function-declaration support and tool-response channel.
- Added `jarvis_agent_execute` bridge so live voice can delegate to `@agent` execution.
- Added per-socket queueing to serialize voice tool calls and avoid overlap.

Why:
- Keep voice mode and chat/agent mode consistent in capability.

### 2. Voice Reliability + Quota Pressure Handling

Files:
- `server/src/api/socketHandlers.ts`
- `server/src/bot_agents/agent.ts`

Changes:
- Added voice bridge timeout and output cap guards.
- Added rate-limit signal detection on both thrown errors and returned text.
- Added web-voice path limits for faster response and fewer cascading failures.

Why:
- Prevent long hangs and noisy failure loops when provider capacity is throttled.

### 3. Provider Key Source Diagnostics

Files:
- `server/src/config/settingsSecurity.ts`
- `server/src/api/socketHandlers.ts`

Changes:
- Added key resolver metadata (`source`, `envVar`) and masked key fingerprint logging.
- Live voice startup now logs where Gemini key came from (DB or env).

Why:
- Debug key-source mismatches quickly without exposing sensitive values.

### 4. Runtime Settings Expansion (DB-first, env fallback)

Files:
- `server/src/config/runtimeSettings.ts`
- `server/src/api/socketHandlers.ts`
- `server/src/bot_agents/agent.ts`
- `server/src/api/systemRouter.ts`
- `server/src/__tests__/unit/runtimeSettings.test.ts`

New runtime keys:
- `voice_tool_bridge_timeout_ms`
- `voice_tool_bridge_output_max_chars`
- `web_voice_agent_timeout_ms`
- `web_voice_max_turns`
- `web_voice_skip_reviewer_gate`
- `web_voice_skip_background_enrichment`
- `swarm_skip_reviewer_gate`
- `swarm_skip_background_enrichment`
- `agent_provider_rate_limit_cooldown_ms`

Behavior:
- DB settings take precedence.
- Env values act as fallback.
- Defaults are used when both are missing.
- Safe get wrapper prevents crashes if queried before DB initialization.
- New runtime inspector endpoint: `GET /api/system/runtime-controls`.

## Validation

Automated:
- Updated `server/src/__tests__/unit/runtimeSettings.test.ts` with coverage for:
  - Default values
  - Env fallback
  - DB-over-env precedence
  - Boolean parsing
  - Numeric clamping

Manual suggested:
1. Set `web_voice_max_turns` in dashboard settings and confirm max turns drop.
2. Set `voice_tool_bridge_timeout_ms` to a small value and verify timeout path.
3. Force rate limit and confirm cooldown duration follows `agent_provider_rate_limit_cooldown_ms`.

## Next Implementation Targets

1. Add dedicated dashboard form for runtime voice/safety keys.
2. Add effective runtime inspector endpoint showing value source (`db|env|default`).
3. Add Jarvis preflight planner to decide dynamic lane count by complexity and health.
4. Add cancellation policy to stop redundant lane work once sufficient evidence is complete.

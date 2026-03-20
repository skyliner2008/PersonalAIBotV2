---
name: "Self-Evolving Architecture (v3)"
description: "Operational architecture reference for self-healing, provider routing, swarm orchestration, and security hardening in PersonalAIBotV2."
---

# Self-Evolving Architecture (v3)

This document tracks the production architecture for the self-evolving backend.
It replaces older corrupted/mojibake text and should be kept as a clean source of truth.

## 1. Core Engine

Main file: `server/src/bot_agents/agent.ts`

Key capabilities:

- Multi-provider routing and fallback.
- Task classification and model selection.
- Tool orchestration with safety checks.
- Circuit breaker and retry handling.
- Token/latency telemetry.
- Per-user queue to avoid race conditions.

## 2. Memory Stack

Main files:

- `server/src/memory/unifiedMemory.ts`
- `server/src/memory/vectorStore.ts`
- `server/src/memory/embeddingProvider.ts`

Memory behavior:

- Working and recall memory for near-term context.
- Archival semantic memory for long-term retrieval.
- Hybrid summary injection for boss CLI sessions.

## 3. Evolution and Maintenance

Main files:

- `server/src/evolution/idleLoop.ts`
- `server/src/evolution/selfReflection.ts`
- `server/src/evolution/selfHealing.ts`
- `server/src/scheduler/subconscious.ts`

Behavior:

- Idle-triggered maintenance loops.
- Reflection and health-check cycle.
- Periodic consolidation tasks.

## 4. Terminal and Boss CLI Layer

Main files:

- `server/src/terminal/commandRouter.ts`
- `server/src/terminal/terminalGateway.ts`
- `server/src/terminal/messagingBridge.ts`
- `server/src/terminal/ptyManager.ts`

Implemented behavior:

- Summon modes: `@jarvis`, `@gemini`, `@codex`, `@claude`.
- Shared hybrid memory across Gemini/Codex/Claude boss sessions.
- CLI fallback support for Codex/Claude via `npx`.
- Output normalization to remove startup/event noise.

## 5. Multi-Agent Swarm Layer

Main files:

- `server/src/swarm/jarvisPlanner.ts`
- `server/src/swarm/swarmCoordinator.ts`
- `server/src/swarm/taskQueue.ts`
- `server/src/api/swarmRoutes.ts`

Behavior:

- Jarvis decomposes objective into specialized tasks.
- Delegates to Gemini/Codex/Claude lanes.
- Tracks queue lifecycle and task dependencies.
- Produces final Jarvis synthesis.

Recent hardening:

- Optional multipass per batch (`multipass` request flag).
- Reduced swarm log spam (pending-count change logging).
- Sanitized delegated outputs before batch summary.

## 6. Dashboard Integration

Main files:

- `dashboard/src/pages/MultiAgent.tsx`
- `dashboard/src/services/api.ts`

Current UX model:

- Left: Batches inbox
- Right: three lane chat cards (Gemini, Codex, Claude)
- Token stats per lane (prompt/completion/reported/estimated)

## 7. Security and Runtime Controls

Main areas:

- Auth middleware and route protection
- Path/command safety boundaries
- Rate limiting and timeout guards
- Structured error handling

Recommended runtime baseline:

```env
LOG_LEVEL=info
HTTP_CONSOLE_MODE=errors
SWARM_VERBOSE_LOGS=0
JARVIS_MULTIPASS=0
```

Runtime-tunable keys (DB `settings` table, env fallback):

- `voice_tool_bridge_timeout_ms`
- `voice_tool_bridge_output_max_chars`
- `web_voice_agent_timeout_ms`
- `web_voice_max_turns`
- `web_voice_skip_reviewer_gate`
- `web_voice_skip_background_enrichment`
- `swarm_skip_reviewer_gate`
- `swarm_skip_background_enrichment`
- `agent_provider_rate_limit_cooldown_ms`

These keys are consumed in:
- `server/src/config/runtimeSettings.ts`
- `server/src/api/socketHandlers.ts`
- `server/src/bot_agents/agent.ts`

Operational impact:
- Root admin can tune live voice latency/safety and provider cooldown behavior without env redeploy.
- DB values override env values by design.

## 8. Maintenance Rule

When architecture-level behavior changes (routing, memory, swarm orchestration, security, dashboard operations), update this document in the same change set.

Required update checklist:

1. What changed
2. Why it changed
3. Operational impact
4. Config flags / migration notes
5. Validation method


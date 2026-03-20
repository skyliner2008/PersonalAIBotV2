---
name: "Future Development Roadmap (Unified Bot vNext)"
description: "Practical roadmap for the next iteration after multi-agent center and boss CLI stabilization."
---

# Future Development Roadmap

This roadmap starts from the current baseline:

- Multi-agent center is live.
- Jarvis delegates to Gemini/Codex/Claude lanes.
- Shared hybrid memory across boss CLIs is active.
- Core dashboard and channel bots are stable.

## Phase 1 - Reliability and Observability (High Priority)

Goals:

- Remove remaining false-positive warnings and noisy logs.
- Improve root-cause debugging for CLI failures.
- Track quality and latency per agent lane.

Planned work:

1. Add per-lane metrics endpoints (success rate, retries, timeout ratio).
2. Add structured error codes for swarm task failure reasons.
3. Add dashboard "failure drilldown" view from batch -> task -> raw error.
4. Add capped raw-output snapshots for debug (not shown in normal UI).

Exit criteria:

- Operators can identify any failed task cause in under 30 seconds.
- No recurring console spam under normal polling.

## Phase 2 - Smarter Jarvis Scheduling

Goals:

- Improve task distribution quality and reduce overloading one CLI.
- Enable adaptive follow-up when one lane completes earlier.

Planned work:

1. Add dynamic lane score using historical success and latency.
2. Add "work stealing" to reassign queued follow-ups to faster available lane.
3. Add objective complexity detector to auto-enable/disable multipass.
4. Add guardrail to prevent overscheduling tasks to a single specialist.

Exit criteria:

- Token and runtime distribution across lanes becomes balanced.
- Measurable drop in single-lane overload cases.

## Phase 3 - Shared Memory Quality Upgrade

Goals:

- Keep hybrid memory compact but more accurate across long projects.
- Reduce context drift when switching between CLIs.

Planned work:

1. Add memory confidence tags (high, medium, stale).
2. Add topic-scoped memory segments per objective id.
3. Add automatic summary pruning by recency and relevance.
4. Add conflict detection when CLIs provide contradictory outputs.

Exit criteria:

- Better continuity with lower prompt size.
- Fewer repeated clarifications across lane switches.

## Phase 4 - Orchestration Safety and Governance

Goals:

- Make multi-agent execution safer for file/system operations.
- Add explicit approval checkpoints for high-risk actions.

Planned work:

1. Add task risk classification (`safe`, `review`, `approval_required`).
2. Add approval queue UI for destructive operations.
3. Add immutable audit trail per batch and per file operation.
4. Add per-agent tool policy templates.

Exit criteria:

- High-risk actions cannot run without explicit approval.
- Full traceability for every orchestrated action.

## Phase 5 - UX and Workflow Expansion

Goals:

- Turn Multi-Agent Center into a daily control room.
- Make Jarvis chat-command integration first-class.

Planned work:

1. Add "command templates" (research, coding, review, incident mode).
2. Add live batch timeline view (chat-style but timeline-aware).
3. Add one-click replay for failed task with edited prompt.
4. Add channel report delivery (LINE/Telegram summary cards).

Exit criteria:

- Operators can run full objective cycle without leaving dashboard/chat.
- Recovery from failed batches becomes one-click.

## Suggested Execution Order

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5

## Notes

- Keep `JARVIS_MULTIPASS=0` as default baseline for cost control.
- Enable multipass per batch only when objective complexity requires it.
- Prefer data-driven tuning over static routing assumptions.

## Current In-Progress (started 2026-03-13)

Track: Runtime Control Convergence (Voice + Swarm)

Completed in this start step:

1. Moved critical voice/safety knobs from env-only to runtime settings (DB-first).
2. Added safe fallback behavior if runtime settings are read before DB init.
3. Added tests to prevent regression in settings precedence and clamping.

Next concrete implementation steps:

1. Add dedicated dashboard form sections for these runtime keys (avoid manual raw key editing).
2. Add live runtime inspector endpoint that returns effective values (`source=db|env|default`).
3. Add batch preflight health gate so Jarvis can decide lane count dynamically (1 lane for simple ask, 2-3 lanes for complex objectives).
4. Add preemptive lane cancellation + takeover policy to reduce token waste when equivalent work is already completed by a healthy lane.


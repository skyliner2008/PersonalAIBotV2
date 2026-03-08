---
name: "Self-Evolving Architecture (v3)"
description: "Documentation of the Self-Evolution Engine, Smart Routing, Multi-Provider System, Web CLI, and Future Roadmap implemented in PersonalAIBotV2."
---

# 🧬 Self-Evolving AI Architecture (v3)

This skill documents the revolutionary upgrade to `PersonalAIBotV2` made on March 6, 2026. The system evolved from a unified memory bot into a **Self-Aware, Self-Healing, and Self-Evolving AI Agent**.

## 1. System Overview & Capabilities

The codebase is split into highly modular components that interact to form a conscious loop:

### 🧠 The Core Engine (`bot_agents/agent.ts`)
- **Multi-Provider Support:** Seamlessly routes between `gemini`, `openai`, and `minimax` via `baseProvider.ts` interfaces.
- **Smart Task Classification (`aiConfig.ts`):** Analyzes the user's prompt using keyword scoring and determines the `TaskType` (General, Complex, Vision, Code, System, etc.). If confidence is low, it falls back to a safer model.
- **ReAct Planning:** For complex tasks (>30 chars), the agent generates a quick execution plan before taking action, saving tokens and preventing loops.
- **Web CLI Integration:** Direct interface via the React Main Dashboard (`WebCLI.tsx`), bypassing external APIs for rapid testing and internal control.

### 🧬 The Self-Evolution Engine (`evolution/`)
The AI no longer just answers questions; it monitors its own existence.
1. **Self-Reflection (`selfReflection.ts`):** After every 50 runs, the AI scans its own logs, analyzing token usage, tool failures, and error rates to extract "insights" and propose fixes.
2. **Learning Journal (`learningJournal.ts`):** A permanent SQLite table where the AI records insights (e.g., "User prefers short code snippets", "The mouse_click tool is unstable on this OS"). These learnings are injected into the top of the system prompt every time it boots.
3. **Self-Healing (`selfHealing.ts`):** A cron-job runs every 15 minutes. If it detects a model is timing out, it automatically updates the `ai_routing_config.json` to switch to a backup provider. If memory leaks occur, it triggers Node garbage collection.
4. **Proactive Idle Loop (`idleLoop.ts`):** Check the database every hour. If no human has spoken to the AI in 2 hours, it spins up an internal background task to execute housekeeping (like analyzing logs, summarizing news, or performing self_heal).

### 🛠️ Tool Ecosystem (`bot_agents/tools/`)
Tools are heavily categorized and controlled by the `persona/TOOLS.md` file:
- **System Tools:** `get_my_config`, `get_session_stats`, `get_recent_errors`.
- **Evolution Tools:** `self_read_source`, `self_edit_persona`, `self_add_learning`, `self_view_evolution`, `self_reflect`, `self_heal`.
- **OS/Limitless Tools:** `run_command`, `mouse_click`, `browser_navigate`.

---

## 2. Overlap & Integration Analysis

During the review of the v3 architecture, several integration points and intentional overlaps were identified:

*   **TaskType.WEB vs `web_search` Tool:** 
    *   *Overlap:* Both do web searching.
    *   *Integration:* If the classifier detects `TaskType.WEB` (e.g., "เช็คราคาหุ้น"), `agent.ts` automatically runs a DuckDuckGo search *before* calling the LLM, injecting the answer immediately. The `web_search` tool is reserved for when the AI is midway through a complex ReAct loop and realizes it needs more info.
*   **System Tools vs Evolution Tools:**
    *   System tools are **Read-Only** awareness (checking stats). Evolution tools imply **Write/Mutate** actions (`self_heal`, `self_edit_persona`), thus carrying a higher risk level and requiring strict path validation.
*   **ConfigManager vs BotRegistry:**
    *   `botRegistry.ts` manages *platform connections* (Telegram tokens, LINE secrets) and bot lifecycles.
    *   `configManager.ts` manages *AI routing* (which LLM model handles which TaskType). They operate independently but are both visualized on the dashboard.

---

## 3. Improvements Implemented (March 6, 2026)

1. **Task Classification Tuning:** Fixed a bug where "เช็คสุขภาพระบบ" (Check System Health) triggered a Web Search. Created `TaskType.SYSTEM` with high-scoring keywords to correctly route self-maintenance commands.
2. **Web CLI Dashboard:** Created `POST /api/cli/chat` and built a React-based terminal component (`WebCLI.tsx`) integrated into the Main Dashboard's `App.tsx` routing. This allows developers to chat directly with the bot, bypassing Telegram/LINE infrastructure.
3. **Foreign Key Constraint Fix:** Solved a crash in the Web CLI by ensuring the `web_dashboard` user session is upserted into the SQLite database before the Agent attempts to save memories.
4. **Tool Registry Synchronization:** Added all 6 evolution tools to the internal `toolRegistry.ts` and enabled them across all platform `TOOLS.md` files.
5. **Idle Loop Check:** Added the `idleLoop.ts` script to run via `setInterval` within `index.ts`. Transforms the system from reactive to proactive—executing silent side-work after 2 hours of silence.
6. **Tool Sync Fix (DB + Persona):** Fixed an issue where the Agent Manager dashboard's tool selections (saved to SQLite) were ignored in favor of `TOOLS.md`. `agent.ts` now dynamically merges `personaConfig.enabledTools` with `botInstance.enabled_tools` at runtime, allowing Telegram and LINE bots to use Self-Evolution tools enabled via the dashboard.

---

## 4. Future Development Plan (Roadmap)

Based on the architectural review, the following steps are recommended for the next phase of development:

### Phase 1: Auto-Tool Generation (Code Writing)
*   **Goal:** Allow the AI to write completely new tools (TypeScript modules) and dynamically register them into `tools/index.ts` without human intervention.
*   **Security:** Requires a strict AST-validator and sandbox execution environment.

### Phase 2: Swarm Coordination (Multi-Agent Comms)
*   **Goal:** Allow bots on different platforms to pass tasks. If the Telegram bot receives an image but is configured to use a cheaper text-only model, it should pass the payload to the "Vision Specialist" bot via internal memory queues.

### Phase 3: Advanced Vector Memory
*   **Goal:** Migrate the `learning_journal` and `archival_memory` from basic SQLite cosine similarity to a lightweight dedicated vector engine (like ChromaDB or embedded LanceDB). This will allow for cross-referencing past errors with current stack traces effortlessly.

---

## 5. Maintenance Protocol 🚨

**CRITICAL RULE FOR ALL AI AGENTS:** 
This Skill Document (`Self_Evolving_Architecture_v3.md`) is the single source of truth for the system's architecture. 

**EVERY TIME** a core file is modified, a new tool is added, or a structural improvement is made to the project, the AI Agent operating on the repository **MUST** proactively update this file to reflect the new changes under the "Improvements Implemented" or "System Overview" sections. Failure to do so will result in knowledge fragmentation.

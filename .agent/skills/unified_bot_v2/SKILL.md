---
name: "Unified Bot Architecture (v2)"
description: "Documentation of the Unified Memory System, File-Based Personas, and Limitless Tools implemented in PersonalAIBotV2."
---

# 🤖 Unified Bot Architecture (v2)

This skill documents the major architectural enhancements made to `PersonalAIBotV2` on March 3, 2026. The goal was to unify the separated Facebook, Telegram, and LINE logic into a centralized, highly efficient architecture inspired by MemGPT and OpenClaw.

## 1. Unified 4-Layer Memory System (`server/src/memory/unifiedMemory.ts`)
The bots previously struggled with high token usage (over 5,000 tokens per request) and separate memory handlers. They now share a unified engine:

*   **Layer 1: Core Memory (System Prompt):** Persistent facts and profiles about the user, auto-extracted and stored in `core_memory`. Always present (~200 tokens).
*   **Layer 2: Working Memory (RAM):** The last 5 recent messages stored directly in Node.js RAM for instantaneous context (~300 tokens).
*   **Layer 3: Recall Memory (SQLite):** The full history of the conversation, stored in the `messages` table for retrieval.
*   **Layer 4: Archival Memory (Embeddings):** Key facts are extracted, vectorized using `gemini-embedding-001`, and stored in `archival_memory`. They are queried via Cosine Similarity rather than dumping the whole chat history into the LLM.

**Impact:** Token usage dropped from ~5,000 to ~800-1,200 tokens per request, significantly reducing API costs while improving intelligence.

## 2. File-Based Personas (OpenClaw-style)
Moved away from hardcoding the persona in the database into a Markdown file system. 
Path: `server/personas/[platform_name]/`

Each bot now dynamically hot-reloads its personality from:
*   `AGENTS.md`: Role and Objective.
*   `IDENTITY.md`: Speaking rules, strict formatting, and personality quirks.
*   `SOUL.md`: Core psychological traits.
*   `TOOLS.md`: The exact, explicit list of Tools the agent is authorized to use.

## 3. Limitless Tools & Native OS Capabilities
Added powerful Native capabilities to bridge the AI into a "Limitless" mode, configurable via `TOOLS.md`.

*   **OS Control (`mouse_click`, `keyboard_type`):** Powered by `pyautogui`, an agent (e.g., Telegram) can now natively move the mouse and type keys on the host machine.
*   **Web Search (`web_search`):** A fast HTTP fetch using `duckduckgo-lite` to allow the AI to rapidly scout the internet for up-to-date real-time context.
*   **LINE Media Server (`/media`):** Created a static router serving local files over HTTP on port 3000, allowing the LINE bot to translate local Windows Paths into URLs that the LINE API can download and send to users.

## How to Configure
To change how a bot behaves (e.g., stopping FB-Extension from using an emoji), simply edit `server/personas/fb-extension/IDENTITY.md` and save. The bot will automatically inject the new rules on the next message without needing to restart the server.

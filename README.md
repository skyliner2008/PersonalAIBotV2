<div align="center">
  <h1>🤖 PersonalAIBotV2</h1>
  <p><strong>Advanced Agentic AI Platform with Multi-Agent Swarm Orchestration, 4-Layer Memory, and Autonomous Self-Evolution</strong></p>

  <p>
    <img src="https://img.shields.io/badge/TypeScript-5.7-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/Node.js-22.x-43853D?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js" />
    <img src="https://img.shields.io/badge/React-19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB" alt="React" />
    <img src="https://img.shields.io/badge/SQLite-3-07405E?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite" />
    <img src="https://img.shields.io/badge/Google_Gemini-Primary_AI-4285F4?style=for-the-badge&logo=google&logoColor=white" alt="Gemini" />
    <img src="https://img.shields.io/badge/Playwright-Browser_Automation-2EAD33?style=for-the-badge&logo=playwright&logoColor=white" alt="Playwright" />
  </p>
</div>

---

## 🌟 Overview

**PersonalAIBotV2** คือแพลตฟอร์ม AI ส่วนตัวแบบ Self-Hosted ที่ออกแบบมาเพื่อทำงานคล้าย **Jarvis** ใน Iron Man โดยรวมความสามารถของ Conversational AI, Multi-Agent Orchestration, Memory Engine ระดับสูง และ Self-Evolution เข้าไว้ด้วยกัน

ระบบสามารถ:
- รับคำสั่งผ่าน **LINE, Telegram, Web Dashboard และ Terminal**
- วิเคราะห์ intent และ route งานซับซ้อนไปยัง **Swarm of AI Agents**
- **จำทุกการสนทนาตลอดชาติ** ด้วย 4-Layer Memory + Vector Embeddings
- **แก้โค้ดตัวเองได้** พร้อมระบบ rollback ป้องกันการพัง
- **Automate Facebook** ตอบแชท/คอมเมนต์/โพสต์อัตโนมัติ

---

## 🛠️ Tech Stack

| ด้าน | เทคโนโลยี | เวอร์ชัน |
|------|-----------|---------|
| **Runtime** | Node.js | 22.x |
| **Language** | TypeScript | 5.7 |
| **API Framework** | Express.js | 4.21 |
| **Real-time** | Socket.IO | 4.8 |
| **Database** | SQLite (better-sqlite3) | 12.6 |
| **Frontend** | React + Vite | 19 / 6.0 |
| **Styling** | TailwindCSS | 3.4 |
| **Terminal UI** | xterm.js | 6.0 |
| **AI Primary** | Google Gemini | gemini-2.0-flash / 2.5-flash |
| **AI Secondary** | OpenAI | SDK 6.25 |
| **AI CLI** | Gemini CLI, Codex CLI, Claude CLI | - |
| **Browser Automation** | Playwright (Chromium) | 1.49 |
| **LINE Bot** | @line/bot-sdk | 10.6 |
| **Telegram Bot** | Telegraf | 4.16.3 |
| **Validation** | Zod | 3.24 |
| **Logging** | Winston + daily rotate | 3.17 |
| **Encryption** | AES-256-GCM (Node crypto) | built-in |
| **PTY Terminal** | node-pty | 1.1 |

---

## 🚀 Key Architectural Features

### 🧠 4-Layer MemGPT-Inspired Memory

Memory engine ที่ออกแบบมาให้คุม context ให้อยู่ภายใน **16,000 token budget** โดยไม่สูญเสียบริบทสำคัญ:

| Layer | ชื่อ | Storage | หน้าที่ |
|-------|------|---------|---------|
| 1 | **Core Memory** | SQLite `core_memory` | ข้อมูลผู้ใช้, preferences, facts สำคัญ — โหลดทุก message |
| 2 | **Working Memory** | In-RAM LRU Cache | 5–10 ข้อความล่าสุด สำหรับ context ทันที |
| 3 | **Recall Memory** | SQLite `episodes` | ทุกบทสนทนาเก่า ค้นหาด้วย keyword |
| 4 | **Archival Memory** | SQLite + HNSW Vector + GraphRAG | Long-term facts + semantic search + knowledge graph |

- **Embeddings**: Gemini-based vector embeddings พร้อม HNSW index
- **Dedup**: Cosine similarity > 0.9 ตัด duplicate อัตโนมัติ
- **GraphRAG**: เก็บ entity relationships สำหรับ complex reasoning

### 🤖 Multi-Agent Swarm Coordinator

แทนที่จะใช้ single prompt, งานซับซ้อนถูก decompose และส่งต่อ agent ที่เหมาะสม:

```
User Request
    ↓
Jarvis Planner → Goal Decomposition → Subtasks
    ↓
Specialist Dispatch
    ├── Gemini Expert   → Research, วิเคราะห์, web search
    ├── Codex Expert    → เขียนโค้ด, software architecture
    └── Claude Expert   → Quality assurance, risk analysis
    ↓
Collaboration Protocol (agents รีไฟน์งานกันเอง)
    ↓
Reviewer Gate → ตรวจสอบก่อนส่งผลลัพธ์
```

แต่ละ Expert รันใน **persistent CLI "lane"** ที่ maintain state ข้ามหลาย turns

### ⚡ Self-Evolution Engine (9-Phase Pipeline)

ระบบ autonomous ที่เรียนรู้และพัฒนาตัวเองได้ — ทำงานเหมือน developer จริง: วิเคราะห์ impact ก่อนแก้, วางแผนก่อนลงมือ, เรียนรู้จากความผิดพลาด

```
Scan → Filter → Validate → Impact Analysis → Learning Feedback → Planning → Implement → TSC Check → Runtime Boot Test
```

| Phase | รายละเอียด |
|-------|-----------|
| **Scan & Map** | LLM อ่าน source files ค้นหา concrete bugs ด้วย confidence > 0.7 พร้อมกับสกัดโครงสร้างไฟล์ (exports/dependencies) เก็บลง `codebase_map` ให้เป็น Second Brain ทันที |
| **Impact Analysis** | วิเคราะห์ exported symbols → หา caller files ทั้งหมด → กำหนด risk level (safe/moderate/high) |
| **Learning Feedback** | ดึงบทเรียนจาก Learning Journal (semantic search + same-file rejection history) inject เข้า prompt |
| **Planning** | LLM วางแผนทีละ step ก่อน implement — สามารถ reject proposal ตั้งแต่ขั้นวางแผนถ้าเสี่ยงเกินไป |
| **Implement** | Specialist agents (coder → reviewer → codex → claude) ทำตาม plan ทั้ง single-file และ multi-file mode |
| **TSC Baseline** | เปรียบเทียบ compile errors ก่อน/หลัง — reject เฉพาะ NEW errors (ไม่โดน false reject จาก pre-existing errors) |
| **Runtime Boot Test** | ลองบูท server จริงบน test port → ตรวจ `/health` endpoint ภายใน 4 วินาที |

- **Multi-File Mode**: เมื่อ risk = moderate/high, AI ได้รับ dependency map + affected file previews, แก้ได้หลายไฟล์พร้อมกัน
- **Atomic Rollback**: backup ทุกไฟล์ก่อนแก้, rollback ทั้งหมดถ้าล้มเหลว (TSC, runtime, หรือ specialist fail)
- **Positive/Negative Learning**: บันทึกทั้งความสำเร็จและความล้มเหลวเข้า Learning Journal อัตโนมัติ

### 🛡️ Boot Guardian & Immortal Core

- **Boot Guardian** (`bootGuardian.ts`) — ดัก Node.js crash ภายใน 15 วินาทีหลัง startup, auto-rollback ถ้าพบ upgradeক্ষেপ breadcrumb
- **Immortal Core Sandbox** — 10 ไฟล์ core system ถูก hardcode ป้องกัน AI แก้ไข (`index.ts`, `config.ts`, `db.ts`, `selfUpgrade.ts` ฯลฯ)
- **Circuit Breaker** — แต่ละ AI provider มี circuit breaker แยก ป้องกัน cascading failure
- **Provider Fallback** — Gemini → OpenAI → Custom CLI อัตโนมัติ

### ⏰ Autonomous Cron Jobs & Self-Scheduling

ระบบสามารถลุกขึ้นมาทำงานเองโดยไม่ต้องมีคนสั่งผ่านแชท โดยใช้ AI เป็นผู้จัดการตารางเวลาตัวเอง:

- **Headless Execution**: ตั้ง Cron Expression (เช่น `0 8 * * *`) แล้วแนบ AI Prompt. เมื่อถึงเวลา ระบบจะรัน Agentic Loop แบบเบื้องหลัง (Background) แล้วส่งผลลัพธ์ผ่าน Webhook กลับไปยัง LINE/Telegram โดยตรง
- **Agent Self-Scheduling Tools**: AI สามารถสร้างตารางงานให้ตัวเองได้จากคำสั่งเสียง/แชท (เช่น "สรุปข่าวทุก 8 โมงให้หน่อย" → AI จะรัน `create_cron_job()`)
- **Admin Dashboard**: หน้าต่างจัดการตารางเวลาแบบ Visual (ดู/แก้ไข/หยุดชั่วคราว) ข้อมูลทั้งหมดบันทึกลง SQLite `cron_jobs`

---

## 🏗️ System Topology

```mermaid
graph TD
    User([User: LINE / Telegram / Dashboard / Terminal]) --> Bridge[Messaging Bridge]

    subgraph "Security Layer"
        Bridge --> Auth[JWT Auth + Rate Limiter]
        Auth --> Sanitize[Input Sanitization + Zod Validation]
    end

    subgraph "Core Orchestration"
        Sanitize --> Classify[Task Classifier\ngeneral/vision/code/data/complex/thinking]
        Classify --> Memory[(4-Layer Memory\nCore / Working / Recall / Archival)]
        Classify --> AIRouter[AI Provider Router]
        AIRouter --> AgentLoop[ReAct Agent Loop]
    end

    subgraph "Swarm Agents (Optional)"
        AgentLoop --> JarvisPlanner[Jarvis Planner\nGoal Decomposition]
        JarvisPlanner --> GeminiCLI[Gemini Expert\nResearch & Fast Compute]
        JarvisPlanner --> CodexCLI[Codex Expert\nCode & Architecture]
        JarvisPlanner --> ClaudeCLI[Claude Expert\nQuality & Safety Review]
    end

    subgraph "Tools & Automation (40+)"
        AgentLoop --> OSTools[OS & File Control]
        AgentLoop --> WebTools[Playwright & Web Search]
        AgentLoop --> EvoTools[Self-Evolution & Code Edit]
        AgentLoop --> FBTools[Facebook Automation]
    end

    subgraph "Background Services"
        Memory --> SubConscious[Subconscious Sleep Cycle]
        SubConscious --> Consolidate[Memory Consolidation + GraphRAG]
        AgentLoop --> SelfHeal[Self-Healing + Reflection]
    end
```

---

## 💻 Dashboard & Administration

React 19 + Vite + TailwindCSS dashboard มีหน้าดังนี้:

| หน้า | หน้าที่ |
|------|---------|
| **Home** | Dashboard overview, system status |
| **Settings** | ตั้งค่า AI provider, routing, API keys, bot behavior |
| **Jarvis Call** | Voice/audio interface พร้อม recording |
| **Swarm Monitor** | Real-time visualization ของ agent tasks |
| **Jarvis Terminal** | Full xterm.js terminal ใน browser (shell/agent/CLI mode) |
| **Memory Viewer** | ดู/แก้ไข Core Memory, Archival Memory, Vector Store |
| **Personas** | จัดการ AI personality profiles |
| **Logs** | Activity logs, error logs, audit trail |

---

## 🗄️ Database Schema (SQLite — 16+ Tables)

| Table | หน้าที่ |
|-------|---------|
| `conversations` | Thread การสนทนาทั้งหมด |
| `messages` | ประวัติ chat (indexed by conversation + timestamp) |
| `user_profiles` | Core facts, preferences ต่อผู้ใช้ (JSON) |
| `core_memory` | Memory blocks แบบ key-value ต่อ chat |
| `episodes` | Working memory — ทุก message เก่า (indexed) |
| `archival_memory` | Long-term facts + Gemini embedding BLOB |
| `knowledge` | Semantic facts (parallel semantic store) |
| `api_keys` | Encrypted credential storage (AES-256-GCM) |
| `qa_pairs` | Q&A override rules (exact/contains/regex) |
| `personas` | AI personality profiles (JSON traits) |
| `scheduled_posts` | Facebook posts ที่รอส่ง |
| `cron_jobs` | ตารางเวลางาน Agent อัตโนมัติ (AI Self-Scheduling) |
| `comment_watches` | Facebook posts ที่รอ auto-reply comment |
| `replied_comments` | Dedup — comment ที่ตอบไปแล้ว |
| `activity_logs` | Audit trail ทุก action |
| `settings` | Key-value system configuration |
| `upgrade_proposals` | Proposals จาก Self-Upgrade scan (title, description, file_path, status, priority, affected_files, impact_analysis) |
| `codebase_map` | แผนที่โครงสร้างโค้ดประดุจสมองที่ 2 (Second Brain) — เก็บ summary, exports, dependencies ทุกรอบการสแกน |
| `evolution_log` | บันทึกประวัติ self-upgrade/heal/reflect ทุกครั้ง |
| `learning_journal` | Persistent learnings (6 categories, confidence, times_applied, vector-indexed) |
| `processed_messages` | Message dedup cache (ป้องกัน double-process) |

---

## 🔌 API Endpoints (50+)

### Authentication
```
GET  /api/auth/socket-token   → Socket.IO auth token (localhost only)
POST /api/auth/login           → JWT login
POST /api/auth/logout          → Clear session
```

### AI & Chat
```
POST /api/chat                → Send message (triggers full agentic loop)
POST /api/chat/stream          → Streaming response (public)
POST /api/ai/test              → Test AI providers
GET  /api/ai/models            → List available models
GET  /api/config               → AI routing config
POST /api/config               → Update routing config
```

### Memory & Conversations
```
GET  /api/memory/core          → Core memory blocks
POST /api/memory/core/:block   → Update core memory
GET  /api/memory/conversations → List conversations
GET  /api/memory/search        → Semantic search archival memory
```

### Personas & Q&A
```
GET/POST/PUT/DELETE /api/personas      → CRUD personas
GET/PUT             /api/bot-personas/:platform → Bot identity files
GET/POST/PUT/DELETE /api/qa            → CRUD Q&A rules
POST                /api/qa/test       → Test Q&A pattern
```

### Dynamic Tools
```
GET/POST/DELETE /api/dynamic-tools         → Manage hot-reloadable tools
POST            /api/dynamic-tools/:name/test → Test tool
POST            /api/dynamic-tools/refresh    → Hot-reload all tools
```

### Facebook & Automation
```
POST /api/fb/login             → Facebook login (email/password via Playwright)
GET  /api/fb/status            → Check login status
GET/POST/DELETE /api/posts     → Scheduled posts
GET/POST/DELETE /api/comments/watches → Comment auto-reply rules
```

### Swarm & Batch
```
GET  /api/swarm/tasks          → List swarm tasks
POST /api/swarm/batch          → Submit batch task
GET  /api/swarm/batch/:id      → Batch status
POST /api/swarm/approve        → Approve pending task
```

### Automation & API Providers
```
GET/POST/PUT/DELETE /api/cron-jobs     → Manage AI scheduled tasks
GET/POST/PUT/DELETE /api/providers     → Dynamic AI Provider management
```

### System & Admin
```
GET  /api/status               → Bot/browser/chat monitor status
GET  /api/system/health        → Full system health
POST /api/system/restart       → Restart server
POST /api/system/upgrade       → Trigger self-upgrade
GET  /metrics                  → Prometheus metrics
GET  /api-docs                 → Swagger UI (OpenAPI)
```

### Terminal (Socket.IO events)
```
terminal:create   → Create shell / agent / CLI session
terminal:input    → Send input to PTY session
terminal:resize   → Resize terminal window
terminal:close    → Close session
terminal:list     → List active sessions
```

---

## 🛠️ Dynamic Tools Registry (40+)

ระบบ tools ที่รองรับ parallel execution สำหรับ read-only และ sequential สำหรับ mutations:

| หมวด | Tools |
|------|-------|
| **OS & File** | `run_command`, `run_python`, `read_file_content`, `replace_code_block`, `search_codebase` |
| **Browser** | `mouse_click`, `keyboard_type`, `screenshot_desktop`, `fetch_url` |
| **Web** | `google_search`, `extract_table` |
| **Media** | `generate_image`, `generate_speech`, `generate_video` (Provider Agnostic) |
| **Office** | `read_document`, `create_document`, `edit_document`, `read_google_doc` (PDF, Word, Excel, CSV) |
| **Cron Jobs** | `create_cron_job`, `list_cron_jobs`, `delete_cron_job` (AI Self-Scheduling) |
| **Dynamic** | Hot-reloadable JSON-defined tools จาก `server/dynamic_tools/` |

---

## 📱 Platform Integrations

### LINE Messenger
- Webhook-based message handling
- Configurable bot persona ต่อ platform (`personas/line/`)
- Support multitype messages (text, image, sticker)

### Telegram
- Long-polling via Telegraf
- Bot persona แยกต่างหาก (`personas/telegram/`)
- Inline commands support

### Facebook Automation (Playwright)
- Auto-login ด้วย email/password (พร้อม cookie persistence)
- **Chat Monitor** — ตรวจ inbox และตอบ message อัตโนมัติ
- **Comment Bot** — watch posts และตอบ comment ด้วย AI
- **Post Scheduler** — generate content + โพสต์ตามเวลาที่กำหนด
- Anti-detection: random typing delays (30–80ms/char), random reply delays (3–15s)

### Jarvis Terminal (Web)
- xterm.js + FitAddon สำหรับ responsive terminal
- 3 session modes:
  - `shell` — OS terminal ตรงๆ
  - `agent` — AI agent ด้วย full toolset
  - `cli` — Gemini / Codex / Claude CLI

---

## 🔒 Security

| Feature | รายละเอียด |
|---------|-----------|
| **Authentication** | JWT token สำหรับ dashboard + Socket.IO token |
| **Encryption** | AES-256-GCM สำหรับ API keys ใน database |
| **Rate Limiting** | 10 AI chats/min, 5 generations/min per user |
| **Input Validation** | Zod schema validation บน POST/PUT ทุกตัว |
| **ReDoS Protection** | ทดสอบ regex patterns ก่อน save (50ms timeout) |
| **Admin Resilience** | รหัสผ่านผู้ดูแลระบบถูกเข้ารหัส AES-256 ลง SQLite โดยตรง (ไม่ถูกล็อคจาก env อีกต่อไป) |
| **Crash Alerts** | หาก Puppeteer พังหรือเกิด Fatal Error ระบบจะส่งแจ้งเตือนด่วนผ่าน Telegram/LINE ให้ Admin ทันที |
| **CORS** | Whitelist: localhost:3000, 5173, 5174 |
| **Security Headers** | CSP, HSTS, X-Frame-Options, X-Content-Type-Options |
| **Sanitization** | XSS/injection prevention ทุก input |
| **Boot Guardian** | Rollback อัตโนมัติถ้า AI แก้โค้ดแล้วพัง |

---

## ⚙️ Quick Start

### Prerequisites
- Node.js v22.x
- npm หรือ yarn
- Google Gemini API Key (required)
- LINE / Telegram token (optional)

### Installation

**Windows:**
```bat
git clone https://github.com/your-repo/PersonalAIBotV2.git
cd PersonalAIBotV2
install.bat
```

**Linux / macOS:**
```bash
git clone https://github.com/your-repo/PersonalAIBotV2.git
cd PersonalAIBotV2
npm install
cd server && npm install && npm run build
cd ../dashboard && npm install && npm run build
```

**Docker:**
```bash
docker-compose up -d
```

### Configuration

สร้างไฟล์ `server/.env` จาก template:
```bash
cp server/.env.example server/.env
```

ตั้งค่าที่จำเป็น:
```env
# Server
PORT=3000
NODE_ENV=production

# Authentication (REQUIRED)
JWT_SECRET=your_32_char_random_secret_here
ADMIN_USER=admin
ADMIN_PASSWORD=your_secure_password
ENCRYPTION_KEY=your_32_char_encryption_key_here

# AI Provider (REQUIRED — at least one)
GEMINI_API_KEY=your_gemini_api_key

# Messaging Platforms (optional)
LINE_CHANNEL_ACCESS_TOKEN=your_line_token
LINE_CHANNEL_SECRET=your_line_secret
TELEGRAM_BOT_TOKEN=your_telegram_token

# Socket.IO Auth (optional but recommended for production)
SOCKET_AUTH_TOKEN=your_socket_token

# Behavior Flags
LOG_LEVEL=info
STARTUP_COMPACT=1           # Cleaner startup output
SWARM_VERBOSE_LOGS=0        # Debug swarm (0=off)
JARVIS_MULTIPASS=0          # Multi-pass planning (costs tokens)
HEADLESS=false              # Show browser during automation
```

### Launch

**Windows:**
```bat
start_unified.bat
```

**Linux / macOS:**
```bash
# Start server
cd server && npm start

# Start dashboard (separate terminal)
cd dashboard && npm run preview
```

**Docker:**
```bash
docker-compose up
```

Dashboard จะเปิดที่ `http://localhost:3000`

---

## 📁 Project Structure

```
PersonalAIBotV2/
├── server/
│   ├── src/
│   │   ├── index.ts                 # Main entry point
│   │   ├── bootGuardian.ts          # Crash recovery & rollback
│   │   ├── api/                     # Express routes + Socket handlers
│   │   ├── ai/                      # AI routing + Persona manager
│   │   ├── swarm/                   # Multi-agent orchestration
│   │   │   ├── swarmCoordinator.ts  # Core orchestrator
│   │   │   ├── jarvisPlanner.ts     # ReAct goal planner (928 lines)
│   │   │   ├── specialists.ts       # Agent role definitions
│   │   │   └── roundtable.ts        # Multi-agent collaboration
│   │   ├── memory/                  # 4-layer memory engine
│   │   │   ├── unifiedMemory.ts     # Orchestrator (930 lines)
│   │   │   ├── embeddingProvider.ts # Gemini embeddings + HNSW
│   │   │   ├── graphMemory.ts       # GraphRAG knowledge graph
│   │   │   └── vectorStore.ts       # HNSW vector index
│   │   ├── bot_agents/              # Core agent loop + 40+ tools
│   │   │   ├── agent.ts             # Main agent loop
│   │   │   └── tools/               # Tool implementations
│   │   ├── terminal/                # Jarvis Terminal Gateway
│   │   ├── evolution/               # Self-evolution (9-phase pipeline)
│   │   │   ├── selfUpgrade.ts      # Core upgrade engine (~1700 lines)
│   │   │   ├── selfReflection.ts   # Performance analysis
│   │   │   ├── selfHealing.ts      # Auto health checks
│   │   │   └── learningJournal.ts  # Persistent learning + semantic search
│   │   ├── automation/              # Facebook Playwright automation
│   │   ├── database/                # SQLite schema + migrations
│   │   ├── providers/               # AI provider adapters
│   │   └── utils/                   # Auth, logger, rate limiter
│   └── package.json
│
├── dashboard/                       # React 19 + Vite frontend
│   └── src/
│       ├── pages/                   # Home, Settings, Terminal, Memory...
│       ├── components/              # Toast, XTerminal, GenerativeUI
│       └── services/api.ts          # REST + Socket.IO client
│
├── personas/                        # Bot identity files
│   ├── line/                        # LINE bot persona
│   ├── telegram/                    # Telegram bot persona
│   └── facebook/                    # Facebook bot persona
│
├── data/                            # Runtime data (gitignored)
│   ├── fb-agent.db                  # SQLite database
│   ├── cookies/                     # Browser session cookies
│   └── uploads/                     # User uploaded files
│
├── docs/                            # 20+ documentation files
├── ai_routing_config.json           # AI model routing config
├── docker-compose.yml               # Docker deployment
├── Dockerfile                       # Container image
├── install.bat                      # Windows installer
├── start.bat                        # Start script
└── start_unified.bat                # Unified launcher
```

---

## 📊 AI Routing Configuration

ระบบ route งานแต่ละ type ไปยัง model ที่เหมาะสมอัตโนมัติ (`ai_routing_config.json`):

```json
{
  "autoRouting": true,
  "routes": {
    "general":  { "provider": "gemini", "model": "gemini-2.0-flash" },
    "vision":   { "provider": "gemini", "model": "gemini-2.0-flash" },
    "web":      { "provider": "gemini", "model": "gemini-2.0-flash" },
    "code":     { "provider": "gemini", "model": "gemini-2.5-flash" },
    "data":     { "provider": "gemini", "model": "gemini-2.5-flash" },
    "complex":  { "provider": "gemini", "model": "gemini-2.5-flash" },
    "thinking": { "provider": "gemini", "model": "gemini-2.5-flash" },
    "system":   { "provider": "gemini", "model": "gemini-2.0-flash-lite" }
  }
}
```

สามารถ override ต่อ bot ได้ด้วย `botOverrides` section

---

## 📚 Documentation

| ไฟล์ | รายละเอียด |
|------|-----------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design overview |
| [docs/SWARM_ARCHITECTURE.md](docs/SWARM_ARCHITECTURE.md) | Multi-agent swarm details |
| [docs/PHASE_3_VECTOR_MEMORY.md](docs/PHASE_3_VECTOR_MEMORY.md) | 4-layer memory implementation |
| [docs/PROJECT_SYSTEM_HANDBOOK.md](docs/PROJECT_SYSTEM_HANDBOOK.md) | Comprehensive system handbook |
| [docs/IMPLEMENTATION_CHECKLIST.md](docs/IMPLEMENTATION_CHECKLIST.md) | Boot Guardian & infrastructure protections |
| [.agent/skills/unified_bot_v2/SKILL.md](.agent/skills/unified_bot_v2/SKILL.md) | Authoritative system design manifest |

---

## ⚠️ Known Limitations & Areas for Improvement

- **Test Coverage**: ~13% — swarmCoordinator และ terminalGateway ยังขาด unit tests
- **Large Files**: `swarmCoordinator.ts` และ `terminalGateway.ts` ควร refactor ต่อไป
- **Type Safety**: มี ~239 occurrences ของ `any` type ที่ควรแก้ไข
- **Memory Pagination**: Working memory load ยังไม่มี pagination
- **Credentials**: ไม่ควร fallback ไปใช้ default JWT_SECRET ใน production

---

<div align="center">
  <i>"I am Jarvis. What are we building today, sir?"</i>
  <br/><br/>
  <sub>Built with ❤️ — PersonalAIBotV2 v2.0 | Last updated: March 2026</sub>
</div>

# Config Key Classification

This file defines the recommended source of truth for configuration keys in `PersonalAIBotV2`.

## Policy

- `ENV only`: root secrets, deployment/runtime knobs, OS/runtime-discovered paths.
- `DB plain`: non-secret settings that admins should adjust from the dashboard.
- `DB encrypted`: secrets/tokens/API keys that the app should manage from the dashboard.

## Important Rules

- Keep exactly one source of truth per key.
- `CRED_SECRET`, `ENCRYPTION_KEY`, `JWT_SECRET`, and other root secrets must never be stored in the DB they protect.
- Admin/user passwords should ideally be stored as password hashes, not reversible encryption.
  - Until auth is refactored, treat them as `DB encrypted` if dashboard-managed.
- Provider secrets should converge on the encrypted credential-store pattern:
  - `provider_key_<providerId>`

## ENV Only

| Key / Pattern | Reason |
| --- | --- |
| `NODE_ENV` | Deployment/runtime mode. |
| `PORT` | Process/network binding. |
| `STARTUP_COMPACT` | Startup log mode for the process. |
| `HEADLESS` | Browser automation runtime behavior. |
| `SLOW_MO` | Browser automation runtime behavior. |
| `RATE_LIMIT_WINDOW_MS` | Infra/security policy, usually set per deployment. |
| `RATE_LIMIT_MAX` | Infra/security policy, usually set per deployment. |
| `LOG_LEVEL` | Process logging behavior. |
| `HTTP_CONSOLE_MODE` | Process logging behavior. |
| `SWARM_VERBOSE_LOGS` | Operational debug flag. |
| `JARVIS_MULTIPASS` | Runtime feature flag/orchestration mode. |
| `DYNAMIC_TOOLS_DIR` | Filesystem path, deployment-specific. |
| `PTY_SHELL_PATH` | Filesystem path, deployment-specific. |
| `GEMINI_CLI_PATH` | External executable path. |
| `GEMINI_CLI_BIN` | External executable path. |
| `JARVIS_EXTRA_CLIS` | External executable registry/path override. |
| `PUBLIC_URL` | Deployment URL/public reverse-proxy setting. |
| `AUTH_DISABLED` | Break-glass auth switch. Should not be DB-editable. |
| `JWT_SECRET` | Root auth secret. |
| `ENCRYPTION_KEY` | Root encryption key. |
| `CRED_SECRET` | Root secret for credential store encryption. |
| `SOCKET_AUTH_TOKEN` | Transport-level shared secret. |
| `APPDATA` | OS-provided environment. |
| `USERPROFILE` | OS-provided environment. |
| `COMSPEC` | OS-provided environment. |
| `SHELL` | OS-provided environment. |
| `LANG` | OS-provided environment. |

## DB Plain

| Key / Pattern | Reason |
| --- | --- |
| `ai_task_<task>_provider` | Non-secret per-task routing. |
| `ai_task_<task>_model` | Non-secret per-task routing. |
| `ai_openai_model` | Non-secret provider model selection. |
| `ai_gemini_model` | Non-secret provider model selection. |
| `ai_minimax_model` | Non-secret provider model selection. |
| `ai_openrouter_model` | Non-secret provider model selection. |
| `ai_embedding_model` | Non-secret embedding model selection. |
| `ai_gemini_embedding_model` | Non-secret embedding model selection. |
| `ai_gemini-embedding_model` | Non-secret embedding model selection. Legacy alias to be unified. |
| `EMBEDDING_MODEL` | Non-secret embedding model override. Prefer replacing with DB key above. |
| `GEMINI_EMBEDDING_MODEL` | Non-secret embedding model override. Prefer replacing with DB key above. |
| `GEMINI_EMBEDDING_MODELS` | Non-secret embedding model chain. Prefer DB-managed list. |
| `GEMINI_EMBEDDING_FALLBACK_MODELS` | Non-secret embedding fallback chain. Prefer DB-managed list. |
| `fb_api_version` | Non-secret Facebook integration setting. |
| `fb_app_id` | Public app identifier. |
| `fb_page_id` | Public page identifier. |
| `fb_page_name` | Display metadata. |
| `fb_email` | Account identifier; not a secret by itself. |
| `admin_telegram_ids` | Admin allowlist; dashboard-managed. |
| `admin_line_ids` | Admin allowlist; dashboard-managed. |
| `ADMIN_TELEGRAM_IDS` | Env fallback only. Prefer `admin_telegram_ids` in DB. |
| `ADMIN_LINE_IDS` | Env fallback only. Prefer `admin_line_ids` in DB. |
| `ADMIN_USER` | Non-secret username. |
| `VIEWER_USER` | Non-secret username. |

## DB Encrypted

| Key / Pattern | Reason |
| --- | --- |
| `provider_key_<providerId>` | Canonical encrypted secret storage pattern. |
| `ai_openai_key` | Secret API key. Migrate from plain `settings` to encrypted store. |
| `ai_gemini_key` | Secret API key. Migrate from plain `settings` to encrypted store. |
| `ai_minimax_key` | Secret API key. Migrate from plain `settings` to encrypted store. |
| `ai_openrouter_key` | Secret API key. Migrate from plain `settings` to encrypted store. |
| `fb_app_secret` | Secret credential. |
| `fb_page_access_token` | Secret token. |
| `fb_verify_token` | Secret webhook verification token. |
| `fb_password` | Secret credential. |
| `ADMIN_PASSWORD` | Secret password. Prefer storing as password hash in future. |
| `VIEWER_PASSWORD` | Secret password. Prefer storing as password hash in future. |
| `GEMINI_API_KEY` | Secret provider key. |
| `OPENAI_API_KEY` | Secret provider key. |
| `MINIMAX_API_KEY` | Secret provider key. |
| `OPENROUTER_API_KEY` | Secret provider key. |
| `ANTHROPIC_API_KEY` | Secret provider key. |
| `BRAVE_SEARCH_API_KEY` | Secret provider key. |
| `CEREBRAS_API_KEY` | Secret provider key. |
| `COHERE_API_KEY` | Secret provider key. |
| `DEEPSEEK_API_KEY` | Secret provider key. |
| `ELEVENLABS_API_KEY` | Secret provider key. |
| `FAL_KEY` | Secret provider key. |
| `FIREWORKS_API_KEY` | Secret provider key. |
| `GOOGLE_CLOUD_API_KEY` | Secret provider key. |
| `GROQ_API_KEY` | Secret provider key. |
| `HYPERBOLIC_API_KEY` | Secret provider key. |
| `MISTRAL_API_KEY` | Secret provider key. |
| `PERPLEXITY_API_KEY` | Secret provider key. |
| `REPLICATE_API_TOKEN` | Secret provider key. |
| `SAMBANOVA_API_KEY` | Secret provider key. |
| `SERPAPI_API_KEY` | Secret provider key. |
| `SERPER_API_KEY` | Secret provider key. |
| `STABILITY_API_KEY` | Secret provider key. |
| `TAVILY_API_KEY` | Secret provider key. |
| `TOGETHER_API_KEY` | Secret provider key. |
| `XAI_API_KEY` | Secret provider key. |
| `TELEGRAM_BOT_TOKEN` | Secret platform token. |
| `LINE_CHANNEL_ACCESS_TOKEN` | Secret platform token. |
| `LINE_CHANNEL_SECRET` | Secret platform token. |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | Secret platform token. |
| `FB_PAGE_ACCESS_TOKEN` | Legacy secret platform token. Unify with encrypted Facebook token storage. |
| `FB_APP_SECRET` | Legacy secret credential. Unify with encrypted Facebook secret storage. |
| `FB_VERIFY_TOKEN` | Legacy secret credential. Unify with encrypted Facebook secret storage. |
| `DISCORD_BOT_TOKEN` | Secret platform token. |
| `SLACK_BOT_TOKEN` | Secret platform token. |

## Legacy / Duplicate Keys To Consolidate

| Current Keys | Recommendation |
| --- | --- |
| `GEMINI_API_KEY`, `OPENAI_API_KEY`, `MINIMAX_API_KEY`, `OPENROUTER_API_KEY` and `ai_*_key` and `provider_key_<providerId>` | Converge on `provider_key_<providerId>` as the encrypted canonical store. Keep env only as bootstrap/import path. |
| `FB_PAGE_ACCESS_TOKEN` and `FACEBOOK_PAGE_ACCESS_TOKEN` and `fb_page_access_token` | Use one canonical encrypted Facebook page token entry. |
| `FB_APP_SECRET` and `fb_app_secret` | Use one canonical encrypted Facebook app secret entry. |
| `FB_VERIFY_TOKEN` and `fb_verify_token` | Use one canonical encrypted webhook verify token entry. |
| `ai_gemini_embedding_model`, `ai_gemini-embedding_model`, `ai_embedding_model`, `GEMINI_EMBEDDING_MODEL`, `EMBEDDING_MODEL` | Converge on one DB plain embedding model key plus one optional env bootstrap override. |
| `ADMIN_TELEGRAM_IDS` and `admin_telegram_ids` | Prefer DB plain with env as emergency fallback only. |
| `ADMIN_LINE_IDS` and `admin_line_ids` | Prefer DB plain with env as emergency fallback only. |

## Suggested Migration Order

1. Move provider/platform secrets to encrypted DB storage.
2. Keep root secrets in `.env` only.
3. Move model/routing/admin allowlists to DB plain.
4. Refactor auth passwords away from plaintext env usage to hashed DB-backed auth records.

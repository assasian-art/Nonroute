# Nonroute — PDR implementation plan

This plan is based on the supplied Product Requirements Document. The repository currently contains only a minimal README; there is no application code to patch yet. Build from a pinned, reviewed OmniRoute upstream baseline before layering custom behavior.

## Non-negotiable safety and deployment rules

- Never commit API keys, provider cookies, session cookies, or other credentials. Read secrets only from environment variables or the self-service dashboard's encrypted persistent store.
- The Groq brain key is read from `GROQ_API_KEY`; Cloudflare is the fallback only for Groq 429/auth failures. Do not log secret values.
- Arena/lmarena session traffic must bypass all proxy-pool code. Proxy pool stays disabled for the OpenCode Vercel relay too.
- Keep the existing `main` branch untouched during initial implementation. Work on `feature/pdr-foundation`; merge/deploy only after tests pass and the user approves.
- Do not claim production readiness until the deployed service is healthy and the user has personally tested it.

## Architecture and dependency order

### 0. Establish a reproducible OmniRoute baseline
- Pin the upstream OmniRoute version/commit and retain its license/notices.
- Confirm the runtime, build/start commands, supported extension points, existing auth model, and persistence paths.
- Keep provider-specific customizations in a clearly isolated module/patch set so upstream upgrades can be reviewed.
- CI gate: clean install, lint/typecheck, upstream baseline tests relevant to changed paths.

### 1. Durable storage before any stateful feature
- Select a durable production store (managed Postgres or a persistent mounted volume; never depend on an ephemeral container filesystem).
- Persist user tasks, provider connections, provider health/quota state, sticky-routing state, cookie metadata, and encrypted cookie/key material.
- Add schema migrations, atomic writes/transactions, backup creation, integrity checks, and documented restore procedure.
- Startup must fail safely if restore is needed; it must not silently initialize an empty database over a damaged store.
- Acceptance: restart/redeploy preserves connections and all user records; corruption test restores a known-good backup without overwriting a healthy database.

### 2. Provider adapters and keyless-first catalog
Register Pollinations classic and OpenAI-compatible modes, LLM7.io anonymous, Kilo, UncloseAI, DuckDuckGo AI Chat, and Puter.com AI as primary routes (not fallback-only providers). Add capability metadata, model discovery, quota tracking, health checks, image capability, and per-provider contract tests. Auto-discovery is opt-in and must not replace manually configured entries.

### 3. Cookie-based Arena provider + dashboard
- Accept raw Cookie header text and Cookie-Editor JSON; normalize both into a canonical cookie representation.
- Validate the lmarena cookie format by checking for `arena-auth-prod-v1.0=` and a decodable base64 payload, plus a live validation request where supported.
- Expose clear Valid/Invalid messages. Disable Save while invalid; a failed save must return an API error without crashing the dashboard.
- Encrypt stored cookies at rest; redact them from logs and API responses.
- Persist expiry metadata and schedule refresh five minutes before expiry where the provider permits refresh. Never attempt to fabricate a refresh when the upstream session cannot be renewed.
- Arena/lmarena traffic bypasses the proxy pool, including Cloudflare challenge handling.
- Acceptance: raw text and Cookie-Editor JSON parse tests; valid/invalid dashboard tests; restart persistence test; no cookie values in logs.

### 4. Fast combo router (no LLM call)
Choose from provider metadata and live state only: quota, health, model capability, image support, configured priority, sticky primary, and cooldown/failure counts. No LLM request may be made to choose a route.
- Keep the first healthy model sticky; fail over only after an upstream error or quota/limit response.
- Automatically fail back when the primary provider has recovered.
- Remove/quarantine a provider after five consecutive failures, with an auditable reason and recovery path.
- Acceptance: deterministic unit tests for quota, image capability, sticky selection, failover, failback, and five-failure quarantine.

### 5. Backend AI brain and user tasks
- Implement a project-scoped file agent with constrained read/write/edit tools; deny path traversal and writes outside the configured workspace.
- Add task CRUD API and a daily automation scheduler with durable task state, locking, retries, and idempotency.
- Use Groq as primary brain via `GROQ_API_KEY`; use Cloudflare only on Groq 429/auth errors. Other errors should be surfaced/retried according to policy rather than silently routed.
- Acceptance: filesystem boundary/security tests, task API tests, scheduler restart/retry tests, and mocked Groq/Cloudflare fallback tests.

### 6. OpenCode free-tier relay
Use a Vercel-hosted relay integration for the OpenCode free tier if permitted by its current documented interface. Proxy pool remains OFF. Keep relay credentials in environment variables; verify provider terms and current API shape before implementation.

### 7. Release and user acceptance
- Run all unit/integration/security tests before pushing.
- Deploy only from a tested commit. Configure secrets through Render environment settings, never repository files.
- Verify health endpoint, deploy status, error logs, persistent-store connectivity, and smoke-test OpenAI-compatible requests.
- Stop before announcing success; user personally tests every deploy and reports acceptance.
- Maintain a release checklist and rollback path for each deployment.

## Acceptance matrix

| Requirement | Required evidence |
| --- | --- |
| Persistent state | restart/redeploy integration test + backup/restore test |
| Keyless main providers | adapter contract tests + catalog priority assertion |
| Arena cookies | parser/validator/dashboard tests + proxy-bypass assertion |
| Smart routing | deterministic routing unit tests |
| Brain and task automation | fallback, API, scheduler, and filesystem sandbox tests |
| OpenCode relay | relay smoke test; proxy pool disabled assertion |
| Release safety | CI green, secrets scan, health/log checks, user acceptance |

## Open implementation constraints

- The actual Arena cookie value was not supplied in this PDR. Add it through the dashboard or a secret environment variable after the feature exists; never commit it.
- Durable storage must be chosen and provisioned before implementing persistent cookie/task/provider state. An ephemeral Render filesystem does not satisfy this PDR.
- Provider endpoints, authentication quirks, model lists, rate limits, and Cloudflare behavior must be verified against current provider documentation or live contract tests rather than guessed.

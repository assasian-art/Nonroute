# Nonroute

OmniRoute-based, OpenAI-compatible AI gateway customization project.

## Runtime status

The PDR implementation is in progress on `feature/pdr-foundation`. This branch includes the first application scaffold: PostgreSQL-backed state, deterministic provider routing primitives, cookie normalization/encryption, a project-scoped file-agent primitive, a self-service dashboard, and tests. It is not production-ready until provider endpoints are verified, all acceptance tests pass, and Render deployment is healthy.

## Local setup

- Node.js 22+
- PostgreSQL
- `DATABASE_URL`
- `ADMIN_TOKEN`
- `COOKIE_ENCRYPTION_KEY` (32-byte key as 64 hex characters or base64)
- Optional `GROQ_API_KEY`, `CLOUDFLARE_AI_BASE_URL`, and `CLOUDFLARE_AI_TOKEN`

Run `npm ci`, `npm test`, then `npm start`.

## Security and operations

- Never commit provider API keys or cookies.
- Arena/lmarena cookie values are encrypted at rest and never returned by the API.
- The cookie check validates the cookie format; it does not prove the upstream session is live.
- No proxy pool is used for cookie-based session checks.
- File-agent operations are constrained to `PROJECT_ROOT`.
- Render Blueprint includes a persistent disk and managed Postgres. Review pricing before applying; these resources can incur charges.
- Do not mark a release accepted until the user has personally tested the deployment.

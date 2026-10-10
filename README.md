# Nonroute

OmniRoute-based AI gateway customization project.

## Status

The repository is being prepared against the feature requirements in [PDR implementation plan](docs/PDR-IMPLEMENTATION-PLAN.md). The current branch is a planning/foundation branch; this is not yet a deployable production application.

## Security

- Never commit API keys or provider cookies.
- Configure `GROQ_API_KEY` and any provider credentials through the deployment platform's secret environment variables or the secured dashboard.
- Provider cookies must be encrypted at rest and redacted from logs.
- Cookie-based Arena/lmarena sessions must bypass the proxy pool.

## Development

The OmniRoute upstream baseline must be pinned and reviewed before custom adapters are integrated. Tests and a deployment smoke test are required before each release.

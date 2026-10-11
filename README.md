# Nonroute — OmniRoute on Render

This repository deploys the published **OmniRoute 3.8.52** runtime through a small Render-compatible Docker wrapper.

## Deployment

- Render workspace: Airouter
- Service: `nonroute-omniroute`
- Region: Singapore
- Branch: `feature/pdr-foundation`
- Docker image installs the pinned `omniroute@3.8.52` package and launches its CLI server.
- Auto-deploy is enabled for commits to the configured branch.

## Persistence (important)

OmniRoute stores its state in SQLite under `DATA_DIR` (configured here as `/var/data/omniroute`). **Render must mount a persistent disk at `/var/data`** for provider connections, settings, and login state to survive redeploys and instance replacement. Merely setting `DATA_DIR` does not make an ephemeral filesystem persistent. Review Render disk pricing before attaching it.

## Initial login

Set `INITIAL_PASSWORD` in the Render environment. It is an initialization value and is ignored after a password is stored in the database. Do not store it in this repository. The requested value is weak; replace it with a unique password before exposing the dashboard to the public internet.

## Security

Never commit provider keys, OAuth tokens, or cookies. Connect providers through the OmniRoute dashboard using credentials you control. Provider compatibility and upstream availability can change independently of this deployment.

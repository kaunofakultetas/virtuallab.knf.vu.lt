# virtual-proxmox-lab

A Proxmox-based virtual lab for practicing offensive security, red teaming, and penetration testing.

## Layout

One Compose stack. Exactly two containers touch the outside world: the endpoint
is the only door in, the exit is the only door out.

```
virtuallab.knf.vu.lt/
├── docker-compose.yml          the production stack
├── docker-compose.dev.yml      the development stack
├── runUpdateThisStack.sh       the production deploy
├── endpoint/                   INGRESS — Caddyfile + the image that bakes in vite/ and docs/
├── exit/                       EGRESS  — caddy-l4 SNI and port allowlist
├── backend/                    Node API and orchestrator
├── vite/                       React SPA, served from the endpoint image
├── docs/                       Docusaurus site, served from the endpoint image
├── fluentbit/                  optional log shipping to Loki
├── infra/                      host-side scripts the backend drives over SSH
├── scripts/                    operator scripts
├── virtual-lab-api-docs/       API collection
├── _DATA/                      runtime: PostgreSQL and deployment backups
└── _LOGS/                      runtime: endpoint access logs
```

Services and containers are all named `virtual-lab-*`. The exit also answers to
the short alias `exit`, which is the name the deployed `.env` uses.

## Setup

Refer to the [setup guide](./docs/content/setup/setup.md) for the setup instructions.

## Development

The development stack reuses credentials and Proxmox settings from `.env`.
Create an optional local override file only when your development endpoints
differ from the defaults:

```bash
cp .env.development.example .env.development
```

Then start PostgreSQL, the API with watch mode, and Vite with hot module reload:

```bash
docker compose -f docker-compose.dev.yml up
```

Open `http://localhost:5173`. Vite proxies `/api` to the backend, so browser
requests and cookies behave like the production same-origin setup. Source files
are bind-mounted; edits do not require image rebuilds.

Documentation is optional during normal application development:

```bash
docker compose -f docker-compose.dev.yml --profile docs up
```

Docusaurus is then available at `http://localhost:3001/docs/`. Stop the stack
with `Ctrl+C`; add `--remove-orphans` after topology changes, or run
`docker compose -f docker-compose.dev.yml down` separately.

## Production Deployment

Production deployment uses a committed, clean Git revision:

```bash
./runUpdateThisStack.sh
```

The script validates the Compose model, starts PostgreSQL if needed, writes a
compressed database backup under `_DATA/deployment-backups`, builds backend and
endpoint images tagged with the current Git SHA, applies `backend/schema.sql` in a
transaction, waits for Compose health checks, and runs an authenticated read-only
infrastructure reconciliation using the first configured admin account. It
updates services in place; it does not unconditionally stop the stack first or
follow logs indefinitely. At least one admin user must already exist.

If application startup fails, the previous backend and endpoint image IDs are
restored automatically when available. Database changes are not automatically
reversed; restore the backup named in the failure output after diagnosing the
failed schema or application revision. Keep `.env` and the configured Access
observer credential directory present on the deployment host.

For an explicitly disposable development environment whose checkout contains
operator overlays, `./runUpdateThisStack.sh --allow-dirty` performs the same
backup, schema, health, smoke-test, and rollback workflow with a uniquely tagged
rehearsal image. Never use that option for a production deployment.

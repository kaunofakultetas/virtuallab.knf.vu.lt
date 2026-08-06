# virtual-proxmox-lab

A Proxmox-based virtual lab for practicing offensive security, red teaming, and penetration testing.

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

Passwords can be hashed by running:

```bash
npm run hash-password -- --password "password123"
```

Create or reset a backend administrator by passing the password through the
environment:

```bash
read -s "ADMIN_PASSWORD?Admin password: "; printf '\n'
docker compose -f docker-compose.dev.yml exec \
	-e ADMIN_PASSWORD="$ADMIN_PASSWORD" \
	backend npm run create-admin -- --vu-id 12345678
unset ADMIN_PASSWORD
```

Replace `12345678` with the numeric VU ID. The command also promotes an existing
user with the same ID to `admin`.

Optional logging environment variables:

- `LOGGING_LOKI_URL`: when set, backend logs are also sent to Grafana Loki through the `pino-loki` transport (set this to your Loki host URL, e.g. `http://localhost:3100`).
- `LOGGING_LOKI_USER` / `LOGGING_LOKI_PASS`

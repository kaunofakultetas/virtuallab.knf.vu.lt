Passwords can be hashed by running:

```bash
npm run hash-password -- --password "password123"
```

Optional logging environment variables:

- `LOGGING_LOKI_URL`: when set, backend logs are also sent to Grafana Loki through the `pino-loki` transport (set this to your Loki host URL, e.g. `http://localhost:3100`).
  - Supports URLs with basic auth credentials (e.g. `https://user:pass@host/loki/api/v1/push`).

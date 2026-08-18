# ---- SPA build ----
FROM node:22-alpine AS vite-build
WORKDIR /app
COPY vite/package*.json ./
RUN npm ci
COPY vite/ ./
RUN npm run build

# ---- Docs build ----
FROM node:22-alpine AS docs-build
RUN apk add --no-cache git
WORKDIR /app
COPY docs/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY docs/ ./
RUN --mount=type=cache,target=/app/.docusaurus \
    --mount=type=cache,target=/app/node_modules/.cache \
    npm run build

# ---- Ingress ----
# There is no separate vite or docs service: both static sites are baked into
# the endpoint image, so the only door in also serves them.
FROM caddy:2-alpine
COPY --from=vite-build /app/dist /srv/frontend
COPY --from=docs-build /app/build /srv/docs
COPY endpoint/Caddyfile /etc/caddy/Caddyfile

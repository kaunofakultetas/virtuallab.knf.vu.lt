FROM node:22-alpine AS frontend-build
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine AS docs-build
RUN apk add --no-cache git
WORKDIR /app
COPY docs/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY docs/ ./
RUN --mount=type=cache,target=/app/.docusaurus \
    --mount=type=cache,target=/app/node_modules/.cache \
    npm run build

FROM caddy:2-alpine
COPY --from=frontend-build /app/dist /srv/frontend
COPY --from=docs-build /app/build /srv/docs
COPY Caddyfile /etc/caddy/Caddyfile
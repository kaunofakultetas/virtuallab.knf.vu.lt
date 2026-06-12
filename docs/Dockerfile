# ---- build stage ----
FROM node:20-alpine AS build
RUN apk add --no-cache git
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm install
COPY . .
RUN --mount=type=cache,target=/app/.docusaurus \
    --mount=type=cache,target=/app/node_modules/.cache \
    npm run build

# ---- serve stage ----
FROM caddy:2-alpine
COPY --from=build /app/build /srv/docs
COPY Caddyfile /etc/caddy/Caddyfile

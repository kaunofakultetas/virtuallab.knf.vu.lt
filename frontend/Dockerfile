# ---- Build stage ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM caddy:2-alpine
COPY --from=build /app/dist /app/dist
COPY Caddyfile /etc/caddy/Caddyfile
EXPOSE 80

# ---- Build stage ----
FROM node:22-alpine AS build
WORKDIR /app

# Install deps first for better layer caching
COPY package*.json ./
RUN npm ci

# Build the app
COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM nginx:1.27-alpine AS runtime

# SPA fallback config so React Router routes work on refresh
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

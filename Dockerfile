# =============================================================
# PersonalAIBotV2 — Multi-stage Docker Build
# Stage 1: Build Dashboard (React + Vite)
# Stage 2: Build Server (TypeScript)
# Stage 3: Production Runtime
# =============================================================

# ---- Stage 1: Build Dashboard ----
FROM node:22-alpine AS dashboard-build
WORKDIR /app/dashboard

COPY dashboard/package.json dashboard/package-lock.json* ./
RUN npm ci --ignore-scripts

COPY dashboard/ ./
RUN npm run build

# ---- Stage 2: Build Server ----
FROM node:22-alpine AS server-build
WORKDIR /app/server

COPY server/package.json server/package-lock.json* ./
RUN npm ci --ignore-scripts

COPY server/ ./
# Compile TypeScript (if tsconfig outputs to dist/)
RUN npx tsc --noEmit || true

# ---- Stage 3: Production Runtime ----
FROM node:22-alpine AS production

# Install Playwright dependencies for browser automation (optional)
# Uncomment if you need Facebook automation:
# RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
# ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
# ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Security: non-root user
RUN addgroup -g 1001 appgroup && \
    adduser -u 1001 -G appgroup -s /bin/sh -D appuser

WORKDIR /app

# Copy server with production deps only
COPY server/package.json server/package-lock.json* ./server/
WORKDIR /app/server
RUN npm ci --omit=dev --ignore-scripts 2>/dev/null || npm install --omit=dev --ignore-scripts

# Copy server source (tsx runs TypeScript directly)
COPY server/src/ ./src/
COPY server/tsconfig.json ./
COPY server/provider-registry.json* ./

# Copy built dashboard
COPY --from=dashboard-build /app/dashboard/dist/ /app/dashboard/dist/

# Create data directories
RUN mkdir -p /app/data /app/server/logs && \
    chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

WORKDIR /app/server

# Environment
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1

# Start with tsx (runs TypeScript directly, no build step needed)
CMD ["npx", "tsx", "src/index.ts"]

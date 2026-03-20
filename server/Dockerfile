# Multi-stage Dockerfile for PersonalAIBotV2
# 
# Stage 1: Build - Compile TypeScript to JavaScript
# Stage 2: Production - Run the compiled code

# ===================
# Stage 1: Build
# ===================
FROM node:22-alpine AS builder

# Install pnpm for faster dependency management
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./
COPY tsconfig.json ./

# Install dependencies
RUN pnpm install --frozen-lockfile --prod=false

# Copy source code
COPY src/ ./src/

# Build TypeScript
RUN pnpm run build

# ===================
# Stage 2: Production
# ===================
FROM node:22-alpine AS production

# Install production dependencies only
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod=true

# Copy built code from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/**/*.json ./src/
COPY --from=builder /app/src/**/*.png ./src/ 2>/dev/null || true
COPY --from=builder /app/src/**/*.ico ./src/ 2>/dev/null || true

# Create logs directory
RUN mkdir -p logs data

# Copy .env.example for reference
COPY .env.example ./

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start the application
CMD ["pnpm", "run", "start"]

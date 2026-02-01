# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src

RUN npm run db:generate
RUN npm run build

# Production stage
FROM node:22-alpine AS production

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built files and prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S relay -u 1001 -G nodejs

USER relay

ENV NODE_ENV=production

# Default command (override in docker-compose)
CMD ["node", "dist/ingress/server.js"]

FROM node:20-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 needs build tooling on first install; prebuilt binaries normally
# satisfy this for Debian x64/arm64. Installing build essentials as fallback.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS runner
ENV NODE_ENV=production
ENV PORT=3001
WORKDIR /app

# Add non-root user for safety
RUN groupadd -r app && useradd -r -g app -s /usr/sbin/nologin app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=app:app server.js db.js seed.js ./
COPY --chown=app:app public ./public
COPY --chown=app:app scripts ./scripts

# Persist DB + uploads in a volume
RUN mkdir -p /app/data && chown -R app:app /app

USER app
EXPOSE 3001

# Healthcheck hits /health (no auth needed there)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3001)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]

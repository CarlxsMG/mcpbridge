FROM oven/bun:1-alpine AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Run
FROM base
RUN apk add --no-cache tini
COPY --chown=bun:bun --from=deps /app/node_modules ./node_modules
COPY --chown=bun:bun package.json tsconfig.json ./
COPY --chown=bun:bun src ./src

ENV PORT=3000
EXPOSE 3000

USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "src/index.ts"]

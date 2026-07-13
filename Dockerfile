# BUN_VERSION must match .bun-version (the single source of truth CI reads via
# `bun-version-file`) — bump both together. The digest below is pinned to that
# exact tag (multi-arch manifest list digest, verified via
# https://hub.docker.com/v2/repositories/oven/bun/tags/1.3.11-alpine); a tag
# bump without a matching digest bump fails the pull loudly rather than
# silently building against a different image.
ARG BUN_VERSION=1.3.11
FROM oven/bun:${BUN_VERSION}-alpine@sha256:7ed9f74c326d1c260abe247ac423ccbf5ac92af62bb442d515d1f92f21e8ea9b AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Build the admin UI (Vue 3 SPA) into static assets
FROM base AS admin-ui-build
WORKDIR /app/admin-ui
COPY admin-ui/package.json admin-ui/bun.lock* ./
RUN bun install --frozen-lockfile
COPY admin-ui/ ./
RUN bun run build

# Run
FROM base
RUN apk add --no-cache tini
COPY --chown=bun:bun --from=deps /app/node_modules ./node_modules
COPY --chown=bun:bun package.json tsconfig.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun --from=admin-ui-build /app/admin-ui/dist ./admin-ui/dist

RUN mkdir -p /app/data && chown bun:bun /app/data

ENV PORT=3000
ENV DB_PATH=/app/data/mcp-bridge.db
EXPOSE 3000
VOLUME /app/data

USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:$PORT/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "src/index.ts"]

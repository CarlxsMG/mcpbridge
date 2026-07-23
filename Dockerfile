# BUN_VERSION must match .bun-version (the single source of truth CI reads via
# `bun-version-file`) — bump both together. The digest below is pinned to that
# exact tag (multi-arch manifest list digest, verified via
# https://hub.docker.com/v2/repositories/oven/bun/tags/1.3.11-alpine). Docker
# resolves `image:tag@digest` purely by digest, so the tag is not re-validated
# against it — bumping BUN_VERSION without also updating the digest silently
# keeps building the OLD image content under a now-misleading tag. The
# docker-publish.yml release workflow re-checks this before every publish (its
# "Assert pinned base-image digest matches the live tag" step) and fails a
# drifted release, but nothing catches it between releases — so still update
# both by hand when you bump.
ARG BUN_VERSION=1.3.11
FROM oven/bun:${BUN_VERSION}-alpine@sha256:7ed9f74c326d1c260abe247ac423ccbf5ac92af62bb442d515d1f92f21e8ea9b AS base

# Patch the OS packages the base image was built with. The digest pin above is
# deliberate and stays — it makes the Bun runtime reproducible — but it also
# freezes Alpine's package set at whatever that build snapshotted, so a zlib or
# musl CVE fixed upstream never reaches us no matter how long we wait. That is
# not hypothetical: it blocked the v1.1.0 image publish (fixable HIGH
# CVE-2026-22184 in zlib and CVE-2026-40200 in musl), because
# docker-publish.yml's Trivy step gates the release on fixable CRITICAL/HIGH.
# Upgrading here keeps the runtime pinned while letting security patches
# through — the one axis that should float. Runs in `base`, so every derived
# stage (deps, admin-ui-build, and the final runtime image) inherits it.
RUN apk --no-cache upgrade

WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lock* ./
# --ignore-scripts: the root `prepare` hook runs `lefthook install`, but lefthook
# is a devDependency (excluded by --production) and there's no .git here anyway,
# so the lifecycle script would fail the install. The deps stage only needs the
# runtime dependency tree, no lifecycle scripts.
RUN bun install --frozen-lockfile --production --ignore-scripts

# Build the admin UI (Vue 3 SPA) into static assets
FROM base AS admin-ui-build
# `bun run build` runs `vue-tsc -b`, and vue-tsc is a Node CLI that hooks the Vue
# language plugin into TypeScript. The oven/bun Alpine image ships no real Node —
# only a fallback shim at /usr/local/bun-node-fallback-bin/node — under which that
# plugin never registers `.vue` as a resolvable extension, so every `.vue` import
# failed with TS2307 and the image could not be built at all. It went unnoticed
# because a developer machine (and the GitHub runner) has real Node on PATH, so
# `bun run build` worked everywhere except inside this image. This stage is
# discarded after the build — only admin-ui/dist is copied into the final image —
# so nodejs adds nothing to what ships.
RUN apk add --no-cache nodejs
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

# Secure by default: NODE_ENV=production activates checkStartupGuards (rejects
# SESSION_COOKIE_SECURE=false, missing JWT audience, etc.), so a bare `docker run`
# with no compose/env can't silently boot in the relaxed development posture.
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/mcp-bridge.db
EXPOSE 3000
VOLUME /app/data

USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:$PORT/livez || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "src/index.ts"]

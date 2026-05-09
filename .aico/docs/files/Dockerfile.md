---
id: file_22f4724083ac53d3
kind: file
source_path: Dockerfile
title: "Dockerfile — Multi-Stage Bun/Alpine Production Container"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.776Z
---

# Dockerfile — Multi-Stage Bun/Alpine Production Container

**Path:** `Dockerfile`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Multi-stage Dockerfile for a Bun-based TypeScript application. Uses `oven/bun:1-alpine` as the shared base for minimal image size. A dedicated `deps` stage installs only production dependencies via `bun install --frozen-lockfile --production`, keeping the final image free of dev tooling. The final stage copies only the compiled modules, `package.json`, `tsconfig.json`, and the `src/` directory, then launches the app directly with `bun src/index.ts`. Runs as the unprivileged `bun` user and listens on port 3000 (configurable via `PORT` env var).

# Dockerfile

## Purpose
Defines a production-grade, multi-stage Docker image for a Bun-powered TypeScript application. The build is optimised for small image size and fast layer caching by separating dependency installation from the application runtime.

## Build Stages

### `base`
```dockerfile
FROM oven/bun:1-alpine AS base
WORKDIR /app
```
- Anchors on the official `oven/bun` image pinned to the `1-alpine` tag (latest Bun v1.x on Alpine Linux).
- Sets `/app` as the working directory for all subsequent stages.

### `deps`
```dockerfile
FROM base AS deps
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production
```
- Copies only the lock and manifest files so that Docker layer caching is invalidated **only** when dependencies change.
- `--frozen-lockfile` enforces reproducible installs (fails if `bun.lock` is out of sync).
- `--production` omits `devDependencies`, keeping `node_modules` lean.

### Final (unnamed)
```dockerfile
FROM base
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
ENV PORT=3000
EXPOSE 3000
USER bun
CMD ["bun", "src/index.ts"]
```
- Pulls only `node_modules` from the `deps` stage — the build toolchain and intermediate layers are discarded.
- Copies application source (`src/`) and TypeScript config (`tsconfig.json`) directly into the image; Bun transpiles TypeScript at runtime, so no explicit compile step is needed.
- `ENV PORT=3000` provides a runtime-overridable default port.
- `EXPOSE 3000` documents the listening port for orchestration tools (does not publish the port).
- `USER bun` drops privileges to the least-privilege built-in user, reducing the attack surface.
- `CMD` starts the app via `bun` directly — no shell wrapper — so the process receives signals cleanly.

## Key Flows
1. **Build**: `docker build .` executes `base` → `deps` → final stage.
2. **Dependency caching**: Re-builds only re-run `bun install` when `package.json` or `bun.lock` changes.
3. **Runtime**: Container starts, Bun JIT-transpiles `src/index.ts`, and the app binds to `$PORT`.

## Edge Cases & Gotchas
- `bun.lock*` glob handles the case where the lockfile is absent (first-time clones); in that case `--frozen-lockfile` will **fail** — a lockfile must be committed.
- `tsconfig.json` is copied to the final image because Bun respects path aliases and compiler options at runtime.
- Alpine's musl libc can cause issues with native Node addons — relevant if any dependency ships a `.node` binary.
- The `PORT` env var is declared but the application code in [[src/index.ts]] must actually read `process.env.PORT` for it to take effect.
- No `HEALTHCHECK` instruction is present; orchestrators will rely on liveness probes configured externally.

---

## References

### has_dep
- [other:oven/bun:1-alpine](../knowledge/deps/other-oven-bun-1-alpine.md)

### has_failure_mode
- [Unpinned Base Image Drift](../knowledge/failure-modes/unpinned-base-image-drift.md)
- [No Healthcheck — Silent Failures](../knowledge/failure-modes/no-healthcheck-silent-failures.md)
- [Native Addon musl Incompatibility](../knowledge/failure-modes/native-addon-musl-incompatibility.md)
- [PORT Env Var Not Read by App](../knowledge/failure-modes/port-env-var-not-read-by-app.md)
- [Missing or Stale Lockfile](../knowledge/failure-modes/missing-or-stale-lockfile.md)

### has_pattern
- [Exec-Form CMD](../knowledge/patterns/exec-form-cmd.md)
- [Dependency-Layer Separation](../knowledge/patterns/dependency-layer-separation.md)
- [Least-Privilege Process User](../knowledge/patterns/least-privilege-process-user.md)
- [Builder Pattern (Multi-Stage)](../knowledge/patterns/builder-pattern-multi-stage.md)

### references
- [package.json — mcp-rest-bridge Project Manifest](package.json.md)
- [TypeScript Compiler Configuration](tsconfig.json.md)
- [Application Entry Point — MCP REST Bridge Server](src--index.ts.md)

### uses_concept
- [Alpine Linux Base Image](../knowledge/concepts/alpine-linux-base-image.md)
- [Production Dependency Install](../knowledge/concepts/production-dependency-install.md)
- [Unprivileged Container User](../knowledge/concepts/unprivileged-container-user.md)
- [Frozen Lockfile Install](../knowledge/concepts/frozen-lockfile-install.md)
- [Multi-Stage Docker Build](../knowledge/concepts/multi-stage-docker-build.md)
- [Layer Cache Optimisation](../knowledge/concepts/layer-cache-optimisation.md)
- [Bun Runtime](../knowledge/concepts/bun-runtime.md)
- [Runtime TypeScript Transpilation](../knowledge/concepts/runtime-typescript-transpilation.md)

## Backlinks

### parent_of
- mcp-rest-bridge — Project Root





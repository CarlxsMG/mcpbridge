---
id: file_8ffcf1f1f146241c
kind: file
source_path: src/routes/docs.ts
title: "docs.ts — Swagger UI Route Registration"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.790Z
---

# docs.ts — Swagger UI Route Registration

**Path:** `src/routes/docs.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Registers the interactive API documentation route for an Express application. Reads and parses the OpenAPI specification from a sibling `openapi.yaml` file at startup using `import.meta.dirname` for ESM-compatible path resolution, then mounts Swagger UI at `/docs`. The spec is loaded synchronously once during route registration, not per request. This module exports a single side-effectful function `docsRoutes` that wires the documentation middleware into the provided Express app instance.

# `src/routes/docs.ts`

## Purpose

Provides a self-contained route registration function that serves an interactive Swagger UI documentation portal at `/docs`. The OpenAPI specification is loaded from disk once at registration time and served statically via `swagger-ui-express`.

## Exports

### `docsRoutes(app: Express): void`

Mounts Swagger UI middleware on the provided Express `app` instance.

**Flow:**
1. Resolves the absolute path to `../openapi.yaml` using `import.meta.dirname` (ESM-safe, avoids `__dirname`).
2. Reads the YAML file synchronously with `readFileSync`.
3. Parses the YAML string into a plain JavaScript object via `yaml.parse`.
4. Registers `swaggerUi.serve` and `swaggerUi.setup(spec)` as middleware on the `/docs` route.

## Key Behaviors

- **Eager loading**: The spec file is read and parsed synchronously at the moment `docsRoutes` is called, not lazily on first HTTP request. Any I/O or parse error surfaces at startup.
- **ESM path resolution**: Uses `import.meta.dirname` instead of `__dirname`, making this compatible with native ES modules (`"type": "module"` in `package.json`).
- **Static spec**: Changes to `openapi.yaml` after the server starts are not reflected without a restart.

## Gotchas

- The `openapi.yaml` path is relative to the compiled output location of this file (one level up: `../openapi.yaml`), not the TypeScript source root. Build output structure must be accounted for.
- `readFileSync` will throw synchronously if the file is missing or unreadable, crashing the server before it starts listening.

## Wikilinks

- [[openapi.yaml]] — the OpenAPI specification file loaded by this module
- [[Express]] — the web framework app instance passed in

---

## References

### has_dep
- [npm:swagger-ui-express](../knowledge/deps/npm-swagger-ui-express.md)
- [npm:yaml](../knowledge/deps/npm-yaml.md)
- [npm:express](../knowledge/deps/npm-express.md)

### has_failure_mode
- [Missing openapi.yaml at resolved path](../knowledge/failure-modes/missing-openapi-yaml-at-resolved-path.md)
- [Invalid YAML in spec file](../knowledge/failure-modes/invalid-yaml-in-spec-file.md)
- [ESM dirname unavailable](../knowledge/failure-modes/esm-dirname-unavailable.md)
- [Stale spec after file change](../knowledge/failure-modes/stale-spec-after-file-change.md)

### has_pattern
- [Startup-time Eager Loading](../knowledge/patterns/startup-time-eager-loading.md)
- [Route Registration Function](../knowledge/patterns/route-registration-function.md)

### uses_concept
- [Eager Spec Loading](../knowledge/concepts/eager-spec-loading.md)
- [docsRoutes](../knowledge/concepts/docsroutes.md)
- [Swagger UI](../knowledge/concepts/swagger-ui.md)
- [ESM Path Resolution](../knowledge/concepts/esm-path-resolution.md)
- [OpenAPI Specification](../knowledge/concepts/openapi-specification.md)

## Backlinks

### references
- [Application Entry Point — MCP REST Bridge Server](src--index.ts.md)

### parent_of
- [src/routes — Express Route Handlers for MCP Proxy Gateway](../dirs/src--routes.md)





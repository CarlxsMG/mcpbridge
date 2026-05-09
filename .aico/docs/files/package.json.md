---
id: file_7a830b33d09caeaf
kind: file
source_path: package.json
title: "package.json — mcp-rest-bridge Project Manifest"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.788Z
---

# package.json — mcp-rest-bridge Project Manifest

**Path:** `package.json`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Project manifest for `mcp-rest-bridge` (v1.0.0), a Bun-based TypeScript service that bridges REST APIs to the Model Context Protocol (MCP). Declares ESM module format and four npm scripts: hot-reload dev server, production start, Bun test runner, and TypeScript type-check. Runtime dependencies cover MCP SDK integration, OpenAPI/YAML spec parsing via Scalar, an Express 5 HTTP layer, and Swagger UI serving. Dev tooling includes Bun-native types and TypeScript 5.7. The combination of `@modelcontextprotocol/sdk` with `@scalar/openapi-parser` signals that REST API specs are ingested and exposed as MCP tool surfaces.

# package.json — mcp-rest-bridge Project Manifest

## Overview

Root package manifest for **`mcp-rest-bridge`**, a TypeScript project that acts as a translation layer between conventional REST/OpenAPI services and the [[Model Context Protocol (MCP)]]. The runtime is **Bun** (not Node), evidenced by the `bun --watch` dev script and the `bun-types` dev dependency.

---

## Module System

`"type": "module"` enforces native ES module semantics across all `.js` files. TypeScript source lives in `src/index.ts` as the declared entry point.

---

## Scripts

| Script | Command | Purpose |
|---|---|---|
| `dev` | `bun --watch src/index.ts` | Hot-reload development server |
| `start` | `bun src/index.ts` | Production start (no watch) |
| `test` | `bun test` | Bun's built-in test runner |
| `typecheck` | `tsc --noEmit` | Type validation without emit |

---

## Runtime Dependencies

| Package | Version | Role |
|---|---|---|
| `@modelcontextprotocol/sdk` | ^1.12.0 | Core MCP server/client primitives; tool registration |
| `@scalar/openapi-parser` | ^0.25.6 | Parse and dereference OpenAPI 3.x / Swagger specs |
| `@scalar/types` | ^0.7.5 | Shared TypeScript types for Scalar OpenAPI tooling |
| `express` | ^5.1.0 | HTTP server (Express 5 — async error handling built-in) |
| `swagger-ui-express` | ^5.0.1 | Serve interactive Swagger UI from parsed specs |
| `yaml` | ^2.7.1 | Parse YAML-formatted OpenAPI specs before passing to Scalar |

---

## Dev Dependencies

| Package | Role |
|---|---|
| `@types/express` | Express 5 type definitions |
| `@types/swagger-ui-express` | Type definitions for Swagger UI middleware |
| `bun-types` | Bun runtime global types (replaces `@types/node`) |
| `typescript` | TypeScript compiler (^5.7) |

---

## Architectural Signal

The co-presence of `@modelcontextprotocol/sdk` + `@scalar/openapi-parser` + `express` strongly implies the following flow:
1. OpenAPI/Swagger specs (JSON or YAML) are loaded and parsed at startup.
2. Parsed operations are registered as **MCP tools** via the SDK.
3. An Express 5 HTTP server exposes the MCP transport and/or a Swagger UI for spec inspection.

---

## Gotchas

- **Bun, not Node**: `bun-types` replaces `@types/node`. Scripts use `bun` directly — running with `node` or `npm start` in a Node environment will fail unless Bun is installed.
- **Express 5**: Breaking changes from Express 4 (async middleware error propagation, removed `res.json` quirks). Peer dependencies for `swagger-ui-express` may lag behind Express 5 officially.
- **ESM-only**: `"type": "module"` means all dynamic `require()` calls will throw; any CommonJS dependency must be imported via `createRequire` or compatible ESM wrappers.

---

## References

### has_dep
- [npm:bun-types](../knowledge/deps/npm-bun-types.md)
- [npm:@types/swagger-ui-express](../knowledge/deps/npm-types-swagger-ui-express.md)
- [npm:@scalar/types](../knowledge/deps/npm-scalar-types.md)
- [npm:swagger-ui-express](../knowledge/deps/npm-swagger-ui-express.md)
- [npm:typescript](../knowledge/deps/npm-typescript.md)
- [npm:yaml](../knowledge/deps/npm-yaml.md)
- [npm:@scalar/openapi-parser](../knowledge/deps/npm-scalar-openapi-parser.md)
- [npm:@modelcontextprotocol/sdk](../knowledge/deps/npm-modelcontextprotocol-sdk.md)
- [npm:express](../knowledge/deps/npm-express.md)
- [npm:@types/express](../knowledge/deps/npm-types-express.md)

### has_failure_mode
- [Node Runtime Incompatibility](../knowledge/failure-modes/node-runtime-incompatibility.md)
- [CommonJS Dependency Conflict](../knowledge/failure-modes/commonjs-dependency-conflict.md)
- [OpenAPI Spec Parse Failure](../knowledge/failure-modes/openapi-spec-parse-failure.md)
- [Type Drift Without Build Check in CI](../knowledge/failure-modes/type-drift-without-build-check-in-ci.md)
- [Express 5 / swagger-ui-express Peer Mismatch](../knowledge/failure-modes/express-5-swagger-ui-express-peer-mismatch.md)

### has_pattern
- [Native TypeScript Runtime (No Build Step)](../knowledge/patterns/native-typescript-runtime-no-build-step.md)
- [Protocol Bridge / Adapter](../knowledge/patterns/protocol-bridge-adapter.md)
- [Spec-Driven Tool Registration](../knowledge/patterns/spec-driven-tool-registration.md)

### references
- [Model Context Protocol (MCP)](../knowledge/concepts/model-context-protocol-mcp.md)
- [TypeScript Compiler Configuration](tsconfig.json.md)
- [Application Entry Point — MCP REST Bridge Server](src--index.ts.md)

### uses_concept
- [Express 5](../knowledge/concepts/express-5.md)
- [mcp-rest-bridge](../knowledge/concepts/mcp-rest-bridge.md)
- [OpenAPI Spec](../knowledge/concepts/openapi-spec.md)
- [Model Context Protocol (MCP)](../knowledge/concepts/model-context-protocol-mcp.md)
- [YAML Parser](../knowledge/concepts/yaml-parser.md)
- [Bun Runtime](../knowledge/concepts/bun-runtime.md)
- [Swagger UI](../knowledge/concepts/swagger-ui.md)
- [ES Module (ESM)](../knowledge/concepts/es-module-esm.md)

## Backlinks

### references
- [Dockerfile — Multi-Stage Bun/Alpine Production Container](Dockerfile.md)

### parent_of
- mcp-rest-bridge — Project Root





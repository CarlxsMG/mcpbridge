---
id: file_c0e1eb25ebbad10b
kind: file
source_path: tsconfig.json
title: "TypeScript Compiler Configuration"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.800Z
---

# TypeScript Compiler Configuration

**Path:** `tsconfig.json`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Root TypeScript configuration for the project. Targets ESNext for both language features and module format, using `bundler` module resolution suited for Bun/Vite-style build pipelines. Enables strict type-checking and ESModule interop. Source files are rooted at `./src` and compiled output is emitted to `./dist`. Bun runtime types are injected globally via `bun-types`. Only files under `src/` are included in compilation.

# tsconfig.json

## Purpose
Defines the TypeScript compiler options for the entire project. Acts as the single source of truth for how TypeScript source is type-checked and transpiled.

## Key Settings

| Option | Value | Effect |
|---|---|---|
| `target` | `ESNext` | Emit modern JS; no downlevelling of syntax |
| `module` | `ESNext` | Use native ES module syntax (`import`/`export`) |
| `moduleResolution` | `bundler` | Resolves modules the way bundlers (Bun, Vite, esbuild) do — supports package `exports`, extensionless imports |
| `strict` | `true` | Enables all strict type-checking flags (`noImplicitAny`, `strictNullChecks`, etc.) |
| `esModuleInterop` | `true` | Allows default imports from CommonJS modules |
| `outDir` | `./dist` | Compiled JS artifacts destination |
| `rootDir` | `./src` | Source root; mirrors directory structure into `outDir` |
| `types` | `["bun-types"]` | Injects Bun runtime globals (`Bun`, `fetch`, etc.) without needing explicit imports |

## Compilation Scope
Only files under `./src` are included (`"include": ["src"]`). Files outside this directory (e.g., scripts at the project root, test fixtures) are excluded from type-checking unless explicitly referenced.

## Gotchas
- `moduleResolution: "bundler"` requires an actual bundler (Bun, Vite, esbuild) at runtime — `tsc` alone cannot run the output correctly when using extensionless or `exports`-field imports.
- `bun-types` pollutes the global type scope with Bun-specific APIs; code depending on these types is not portable to Node.js without additional type shims.
- No `declaration` or `sourceMap` flags are set — type declarations and source maps are **not** emitted by default.

---

## References

### has_dep
- [npm:bun-types](../knowledge/deps/npm-bun-types.md)

### has_failure_mode
- [Bun-type pollution in portable code](../knowledge/failure-modes/bun-type-pollution-in-portable-code.md)
- [Runtime resolution mismatch](../knowledge/failure-modes/runtime-resolution-mismatch.md)
- [Missing source map / declaration files](../knowledge/failure-modes/missing-source-map-declaration-files.md)

### has_pattern
- [Bundler-aligned module resolution](../knowledge/patterns/bundler-aligned-module-resolution.md)
- [Strict-by-default type safety](../knowledge/patterns/strict-by-default-type-safety.md)

### references
- [bun-types](../knowledge/concepts/bun-types.md)

### uses_concept
- [strict mode](../knowledge/concepts/strict-mode.md)
- [ESNext target](../knowledge/concepts/esnext-target.md)
- [moduleResolution: bundler](../knowledge/concepts/moduleresolution-bundler.md)
- [bun-types](../knowledge/concepts/bun-types.md)
- [esModuleInterop](../knowledge/concepts/esmoduleinterop.md)

## Backlinks

### references
- [Dockerfile — Multi-Stage Bun/Alpine Production Container](Dockerfile.md)
- [package.json — mcp-rest-bridge Project Manifest](package.json.md)

### parent_of
- mcp-rest-bridge — Project Root





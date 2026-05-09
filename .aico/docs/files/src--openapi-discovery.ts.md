---
id: file_a625135a8c60c2e3
kind: file
source_path: src/openapi-discovery.ts
title: "OpenAPI Discovery — Dynamic REST Tool Extraction from OpenAPI Specs"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.792Z
---

# OpenAPI Discovery — Dynamic REST Tool Extraction from OpenAPI Specs

**Path:** `src/openapi-discovery.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Provides `discoverToolsFromOpenApi`, an async function that fetches, parses, dereferences, and maps an OpenAPI 3.x specification into an array of `RestToolDefinition` objects. Supports JSON and YAML specs, enforces a 5 MB size cap against DoS, filters operations by tag inclusion and operationId exclusion, skips `x-internal` operations, converts OpenAPI path templates (`{param}`) to Express-style (`:param`), and merges path-level and operation-level parameters with request body properties into a flat JSON Schema input schema. Falls back to auto-generated snake_case names when `operationId` is absent.

# `src/openapi-discovery.ts`

## Purpose

Dynamically discovers callable REST tools from a remote OpenAPI 3.x specification. The result is a list of [[RestToolDefinition]] objects that can be registered as agent tools without any hand-written configuration.

---

## Exports

| Symbol | Kind | Description |
|---|---|---|
| `discoverToolsFromOpenApi` | `async function` | Main entry point — fetches, parses, dereferences, and maps an OpenAPI spec to `RestToolDefinition[]` |

---

## Key Flow

```
fetch(openapiUrl)           ← timeout from config.openapiDiscoveryTimeoutMs
  │  size guard ≤ 5 MB (content-length header AND body text)
  ▼
JSON.parse ──fail──► parseYaml(text)
  ▼
dereference(parsed)        ← @scalar/openapi-parser resolves $ref chains
  │  throws on validation errors or missing paths
  ▼
extract serverUrl → basePath (first server, relative paths only)
  ▼
iterate schema.paths × HTTP methods
  │  skip: non-HTTP keys, null operations, x-internal, excludeOperations set
  │  filter: includeTags (any-match)
  ▼
buildInputSchema(operation, pathItem)
  │  merge pathItem.parameters + operation.parameters
  │  merge requestBody.content["application/json"].schema.properties
  │  mark required: explicit param.required OR param.in === "path"
  ▼
RestToolDefinition[]
```

---

## Filtering Logic

- **`includeTags`** — if provided and non-empty, an operation must carry at least one matching tag to be included (OR semantics).
- **`excludeOperations`** — a set of `operationId` strings to skip entirely.
- **`x-internal`** — any truthy value on the operation object silently drops that operation.

---

## Path Template Conversion

OpenAPI `{param}` syntax is converted to Express/REST-client `:param` style:

```ts
path.replace(/\{([^}]+)\}/g, ":$1")
```

The `basePath` is prepended only when the first server URL is a relative path (starts with `/`). Absolute server URLs (e.g., `https://api.example.com/v1`) are ignored — only the relative path prefix is used.

---

## Name Generation Fallback

When `operationId` is absent, `generateToolName` produces a deterministic snake_case name:

```
{method}_{segment1}_{segment2}_by_{paramName}
```

Example: `GET /users/{id}/posts` → `get_users_by_id_posts`

---

## Input Schema Construction (`buildInputSchema`)

1. Path-level `parameters` merged with operation-level `parameters` (operation wins on collision by list order).
2. Each parameter contributes: `type`, `description`, `enum`, `default`, `example`.
3. `requestBody.content["application/json"].schema.properties` keys are merged in flatly — no nesting.
4. `required` array: path parameters (`in === "path"`) are always required; explicit `param.required` flags also apply; `requestBody.required` array is appended.

---

## Gotchas

- **Content-length bypass**: The `content-length` header check runs first, but a server can omit or lie about it — the text-length check is the real guard.
- **YAML fallback is silent**: Any JSON parse error unconditionally falls through to YAML parsing; a malformed JSON file that happens to be valid YAML may parse unexpectedly.
- **Relative basePath only**: Absolute server URLs are silently dropped; tools will have paths without a host prefix.
- **Parameter collision**: Path-level and operation-level parameters with identical names are both pushed into the array — the last one wins in the `properties` map.
- **No body schema fallback**: Only `application/json` content type is read from `requestBody`; other content types (e.g., `multipart/form-data`) are silently ignored.
- **`$ref` errors surface as thrown**: Any dereference errors cause an immediate throw with joined messages.

---

## References

### has_dep
- [npm:yaml](../knowledge/deps/npm-yaml.md)
- [npm:@scalar/openapi-parser](../knowledge/deps/npm-scalar-openapi-parser.md)

### has_failure_mode
- [Spec Fetch Timeout](../knowledge/failure-modes/spec-fetch-timeout.md)
- [Non-JSON Request Body Ignored](../knowledge/failure-modes/non-json-request-body-ignored.md)
- [Absolute Server URL Discarded](../knowledge/failure-modes/absolute-server-url-discarded.md)
- [Invalid OpenAPI / Dereference Errors](../knowledge/failure-modes/invalid-openapi-dereference-errors.md)
- [Malformed JSON Parsed as YAML](../knowledge/failure-modes/malformed-json-parsed-as-yaml.md)
- [Parameter Name Collision](../knowledge/failure-modes/parameter-name-collision.md)
- [No Paths in Spec](../knowledge/failure-modes/no-paths-in-spec.md)
- [Spec Too Large](../knowledge/failure-modes/spec-too-large.md)

### has_pattern
- [Dual-Format Parse with Silent Fallback](../knowledge/patterns/dual-format-parse-with-silent-fallback.md)
- [Flat Schema Merging](../knowledge/patterns/flat-schema-merging.md)
- [Set-Based Exclusion Filter](../knowledge/patterns/set-based-exclusion-filter.md)
- [Dual-Layer Size Guard](../knowledge/patterns/dual-layer-size-guard.md)
- [Deterministic Fallback Naming](../knowledge/patterns/deterministic-fallback-naming.md)

### references
- [Application Configuration Module (src/config.ts)](src--config.ts.md)
- [src/types.ts — Core Domain Interfaces](src--types.ts.md)

### uses_concept
- [DoS Size Guard](../knowledge/concepts/dos-size-guard.md)
- [OpenAPI Spec Dereferencing](../knowledge/concepts/openapi-spec-dereferencing.md)
- [VALID_METHODS](../knowledge/concepts/valid-methods.md)
- [discoverToolsFromOpenApi](../knowledge/concepts/discovertoolsfromopenapi.md)
- [config.openapiDiscoveryTimeoutMs](../knowledge/concepts/config-openapidiscoverytimeoutms.md)
- [Tool Name Generation](../knowledge/concepts/tool-name-generation.md)
- [Path Template Conversion](../knowledge/concepts/path-template-conversion.md)
- [includeTags Filter](../knowledge/concepts/includetags-filter.md)
- [x-internal Extension](../knowledge/concepts/x-internal-extension.md)
- [excludeOperations Filter](../knowledge/concepts/excludeoperations-filter.md)
- [RestToolDefinition](../knowledge/concepts/resttooldefinition.md)
- [basePath Extraction](../knowledge/concepts/basepath-extraction.md)
- [Input Schema Construction](../knowledge/concepts/input-schema-construction.md)

## Backlinks

### references
- [Register Routes — Tool Registration & Schema Endpoint](src--routes--register.ts.md)

### parent_of
- [src — MCP REST Bridge: Full Application Root](../dirs/src.md)





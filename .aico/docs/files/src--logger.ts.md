---
id: file_666a741f954d37a7
kind: file
source_path: src/logger.ts
title: "Logger — Structured Dual-Format Log Emitter"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.786Z
---

# Logger — Structured Dual-Format Log Emitter

**Path:** `src/logger.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Thin logging utility that emits structured log entries to stdout/stderr. Reads `config.logFormat` at call time to switch between JSON mode (machine-parseable newline-delimited objects) and human-readable text mode (ISO-timestamp prefix + uppercased level). Supports three severity levels — info, warn, error — and an optional `meta` bag of arbitrary key-value pairs spread into the output. Errors are routed to `console.error`; all other levels use `console.log`. No external dependencies; configuration is sourced from the shared `config` module.

# `src/logger.ts`

## Purpose
Provides a single, centralized `log` function for the entire application. It abstracts away two output formats — JSON and human-readable text — controlled at runtime by `config.logFormat`, making the binary switchable without any call-site changes.

---

## Exports

### `log(level, message, meta?): void`
The sole export. Writes a log entry to the console.

| Parameter | Type | Description |
|-----------|------|-------------|
| `level` | `LogLevel` | Severity: `"info"`, `"warn"`, or `"error"` |
| `message` | `string` | Human-readable log message |
| `meta` | `Record<string, unknown>?` | Optional arbitrary metadata key-value pairs |

### `LogLevel` (type, unexported externally)
A union type `"info" | "warn" | "error"`. Not exported from the module — callers must use string literals.

---

## Key Flows

### JSON Format (`config.logFormat === "json"`)
```
{ "timestamp": "2026-05-07T12:00:00.000Z", "level": "info", "message": "...", ...meta }
```
- Meta keys are **spread directly** onto the top-level object — key collisions with `timestamp`, `level`, or `message` will silently overwrite them.
- Output is a single-line `JSON.stringify` — safe for log aggregators (e.g. Datadog, CloudWatch, Loki).

### Text Format (default)
```
[2026-05-07T12:00:00.000Z] [INFO] message {"key":"value"}
```
- Meta is appended as a JSON string preceded by a space.
- Level is uppercased via `.toUpperCase()`.

### Console Routing
| Level | Console method |
|-------|---------------|
| `"error"` | `console.error` |
| `"info"`, `"warn"` | `console.log` |

> ⚠️ **Gotcha:** `"warn"` is routed to `console.log`, not `console.warn`. This means warn-level messages go to stdout rather than stderr, which may surprise operators filtering by stream.

---

## Edge Cases & Gotchas

- **Meta key collision (JSON mode):** If `meta` contains keys `timestamp`, `level`, or `message`, the spread `{ timestamp, level, message, ...meta }` will overwrite the structured fields silently.
- **`warn` → stdout:** Counter-intuitively, only `"error"` reaches `stderr`. `"warn"` entries appear on stdout.
- **`config` read at call time:** `logFormat` is read on every invocation, not cached. Format can be changed mid-process if `config` is mutable.
- **No log-level filtering:** Every call results in output regardless of severity; there is no minimum level threshold.
- **No newline control:** `JSON.stringify` output is single-line; no pretty-printing option exists.

---

## Dependencies
- [[src/config.ts]] — provides `config.logFormat` to select output format.

---

## References

### has_failure_mode
- [Circular Reference in meta Throws](../knowledge/failure-modes/circular-reference-in-meta-throws.md)
- [Meta Key Collision Overwrites Structured Fields](../knowledge/failure-modes/meta-key-collision-overwrites-structured-fields.md)
- [No Minimum Level Filtering](../knowledge/failure-modes/no-minimum-level-filtering.md)
- [warn Level Emitted to stdout Instead of stderr](../knowledge/failure-modes/warn-level-emitted-to-stdout-instead-of-stderr.md)

### has_pattern
- [Runtime Format Switch](../knowledge/patterns/runtime-format-switch.md)
- [Single-Function Log Facade](../knowledge/patterns/single-function-log-facade.md)
- [Structured Metadata Spread](../knowledge/patterns/structured-metadata-spread.md)

### references
- [Application Configuration Module (src/config.ts)](src--config.ts.md)

### uses_concept
- [JSON Log Format](../knowledge/concepts/json-log-format.md)
- [LogLevel](../knowledge/concepts/loglevel.md)
- [config.logFormat](../knowledge/concepts/config-logformat.md)
- [Meta Bag](../knowledge/concepts/meta-bag.md)
- [Text Log Format](../knowledge/concepts/text-log-format.md)

## Backlinks

### references
- [Health Check Loop — Batched Client Liveness Monitor with Auto-Eviction](src--health.ts.md)
- [Application Entry Point — MCP REST Bridge Server](src--index.ts.md)
- [Application Configuration Module (src/config.ts)](src--config.ts.md)
- [src/proxy.ts — MCP Tool Call Proxy with Resilience](src--proxy.ts.md)
- [Introspection Routes — Admin Client Management Endpoints](src--routes--introspection.ts.md)
- [Register Routes — Tool Registration & Schema Endpoint](src--routes--register.ts.md)

### parent_of
- [src — MCP REST Bridge: Full Application Root](../dirs/src.md)





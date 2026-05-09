---
id: file_c9eff7e2a723bb1c
kind: file
source_path: src/__tests__/auth.test.ts
title: "Auth Middleware Test Suite (adminAuth & mcpAuth)"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.801Z
---

# Auth Middleware Test Suite (adminAuth & mcpAuth)

**Path:** `src/__tests__/auth.test.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Bun test suite for the `adminAuth` and `mcpAuth` Express middleware functions. Covers Bearer token validation, missing/malformed Authorization headers, wrong-key rejection, and the `AUTH_DISABLED` global bypass. Uses a live-ESM-object mutation strategy: because ESM imports share the same `config` reference, tests mutate `config` properties directly before each case and restore them after, avoiding any mock framework. Also validates the MCP backward-compatibility path where an empty `mcpApiKeys` array causes the middleware to pass all requests unconditionally.

# `src/__tests__/auth.test.ts`

## Purpose
Unit-tests the `adminAuth` and `mcpAuth` Express middleware exported from `[[src/middleware/auth.ts]]`. Exercises all branching paths: token acceptance, 401/403 rejection, and the global `authDisabled` bypass.

---

## Config Mutation Strategy
`auth.ts` imports `config` as a **live ESM binding** to the same object. Tests exploit this by mutating `config` properties in-place before each assertion, then calling `restoreConfig()` afterward. No mock framework (`vi.mock`, `jest.mock`, etc.) is needed.

```ts
(config as Record<string, unknown>).adminApiKeys = ["secret-key"];
config.authDisabled = false;
// ... run middleware ...
restoreConfig(); // resets to pre-test values
```

---

## Mock Helpers

| Helper | Returns | Purpose |
|---|---|---|
| `makeReq(headers)` | `Request` | Minimal Express request with only a `headers` bag |
| `makeRes()` | `MockRes` | Chainable `status()`/`json()` recorder; captures `_status` and `_body` |
| `makeNext()` | `{ fn, called }` | Wraps `NextFunction`; `called` flag indicates whether middleware passed through |

---

## `adminAuth` Test Cases

| Scenario | Expected Outcome |
|---|---|
| Valid `Bearer <key>` matching `adminApiKeys` | `next()` called, no response written |
| Missing `Authorization` header | HTTP 401, `error.code === "UNAUTHORIZED"` |
| Non-Bearer scheme (e.g. `Basic …`) | HTTP 401 |
| Token present but not in `adminApiKeys` | HTTP 403, `error.code === "FORBIDDEN"` |
| `authDisabled === true`, no header | `next()` called (bypass) |

---

## `mcpAuth` Test Cases

| Scenario | Expected Outcome |
|---|---|
| Valid `Bearer <key>` matching `mcpApiKeys` | `next()` called |
| `mcpApiKeys` is empty (backward compat) | `next()` called unconditionally, no token needed |
| Missing header, keys configured | HTTP 401 |
| Wrong token, keys configured | HTTP 403 |
| `authDisabled === true`, no header | `next()` called (bypass) |

---

## Key Flows

1. **Setup**: `beforeEach` snapshots current `config` values into module-level `original*` variables.
2. **Execution**: Each test mutates `config`, builds mock req/res/next, calls the middleware.
3. **Assertion**: Checks `next.called`, `res._status`, and optionally the structured error body.
4. **Teardown**: `restoreConfig()` called inline after the middleware invocation (not in `afterEach`) — relies on synchronous middleware execution.

---

## Gotchas

- **`restoreConfig()` placement**: Restoration happens *inside* each test after the middleware call but *before* assertions on some paths. This is safe only because the middleware is fully synchronous. Async middleware would require `afterEach`.
- **Type casting**: `config` properties typed as arrays are cast via `(config as Record<string, unknown>)` to allow direct assignment, indicating the `config` type definition marks those fields as readonly or narrowly typed.
- **`makeRes.setHeader`** is a no-op stub — tests do not verify response headers set by the middleware (e.g., `WWW-Authenticate`).
- **No `afterEach` guard**: If a test throws before `restoreConfig()`, subsequent tests may run with mutated config, causing false failures. Consider moving restoration to `afterEach`.

---

## References

### has_dep
- [npm:bun:test](../knowledge/deps/npm-bun-test.md)
- [npm:express](../knowledge/deps/npm-express.md)

### has_failure_mode
- [setHeader assertions absent](../knowledge/failure-modes/setheader-assertions-absent.md)
- [Async middleware would bypass restoreConfig](../knowledge/failure-modes/async-middleware-would-bypass-restoreconfig.md)
- [Config not restored on test throw](../knowledge/failure-modes/config-not-restored-on-test-throw.md)
- [Non-Bearer scheme not fully enumerated](../knowledge/failure-modes/non-bearer-scheme-not-fully-enumerated.md)

### has_pattern
- [Inline Teardown (restoreConfig after act)](../knowledge/patterns/inline-teardown-restoreconfig-after-act.md)
- [Minimal Mock Object Factory](../knowledge/patterns/minimal-mock-object-factory.md)
- [State-Recording Stub](../knowledge/patterns/state-recording-stub.md)
- [Live ESM Mutation for Config Testing](../knowledge/patterns/live-esm-mutation-for-config-testing.md)

### references
- [adminAuth](../knowledge/concepts/adminauth.md)
- [mcpAuth](../knowledge/concepts/mcpauth.md)
- [Application Configuration Module (src/config.ts)](src--config.ts.md)
- [Express Bearer Token Auth Middleware (Admin & MCP)](src--middleware--auth.ts.md)

### uses_concept
- [adminAuth](../knowledge/concepts/adminauth.md)
- [Bearer Token](../knowledge/concepts/bearer-token.md)
- [MCP backward compatibility](../knowledge/concepts/mcp-backward-compatibility.md)
- [Live ESM Object Mutation](../knowledge/concepts/live-esm-object-mutation.md)
- [MockRes](../knowledge/concepts/mockres.md)
- [mcpAuth](../knowledge/concepts/mcpauth.md)
- [restoreConfig](../knowledge/concepts/restoreconfig.md)
- [authDisabled bypass](../knowledge/concepts/authdisabled-bypass.md)
- [config](../knowledge/concepts/config.md)
- [makeNext](../knowledge/concepts/makenext.md)

## Backlinks

### parent_of
- [src/__tests__ — Unit Test Suite](../dirs/src--__tests__.md)





---
id: dir_25895871f4be0f30
kind: dir
source_path: src/__tests__
title: "src/__tests__ — Unit Test Suite"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.608Z
---

# src/__tests__ — Unit Test Suite

**Path:** `src/__tests__`  
**Kind:** `dir`  
**Model:** `sonnet`

> The `src/__tests__` directory holds the complete Bun unit test suite. Four modules cover distinct subsystems: `sanitize.test.ts` validates prompt-injection stripping, passthrough, 500-char truncation, and degenerate inputs; `circuit-breaker.test.ts` exercises the three-state machine (closed/open/half_open) with `Date.now` override for time simulation and per-test registry isolation; `auth.test.ts` tests Express middleware via live ESM object mutation, covering Bearer token validation, `AUTH_DISABLED` bypass, and MCP backward-compatibility; `registry.test.ts` covers registration lifecycle, name validation, 10 KB schema cap, composite key resolution, overwrite semantics, and unregistration cleanup. All suites reset shared state in `beforeEach` for hermetic isolation.

# src/__tests__ — Unit Test Suite

## Overview

All tests are written for the **Bun test runner**. The four suites collectively exercise every major cross-cutting concern of the server: input sanitization, resilience infrastructure, authentication middleware, and the tool/client registry.

---

## Test Modules

### `sanitize.test.ts`
Targets the `sanitizeToolDescription` utility from `sanitize.ts`.

| Contract | Detail |
|---|---|
| Clean passthrough | Benign descriptions returned unmodified (modulo whitespace trim) |
| Injection stripping | Removes `IMPORTANT:`, `ignore previous`, `act as`, markdown fences, etc. while preserving surrounding text |
| Truncation | Descriptions > 500 chars are cut to 500 with trailing `...` |
| Degenerate inputs | Empty strings, whitespace-only, all-pattern inputs handled without throwing |

---

### `circuit-breaker.test.ts`
Targets the `circuit-breaker` module's state machine and registry.

- **States covered:** `closed` → `open` → `half_open` → `closed` / `open`
- **Default threshold:** 3 failures to open
- **Time simulation:** `Date.now` override in `try/finally` blocks; `resetTimeoutMs = 30 000 ms`
- **Probe behaviour:** Half-open state allows a single probe request; failure re-opens
- **Isolation:** `removeCircuitBreaker` called in `beforeEach` to reset module-level registry

---

### `auth.test.ts`
Targets `adminAuth` and `mcpAuth` Express middleware.

- **Strategy:** Live ESM object mutation on the shared `config` reference — no mock framework required
- **Admin auth:** Bearer token validation, missing/malformed headers, wrong-key rejection
- **MCP auth:** Same token path plus backward-compatibility: empty `mcpApiKeys` array ⇒ unconditional pass
- **Bypass:** `AUTH_DISABLED` global flag skips all checks
- **Teardown:** Config properties restored after each case to prevent state bleed

---

### `registry.test.ts`
Targets the `registry` singleton.

| Area | Coverage |
|---|---|
| Name validation | Lowercase, max 63 chars, no leading hyphen — for both client and tool names |
| Schema size | `inputSchema` capped at 10 KB |
| Key resolution | Composite `clientName__toolName` lookup; `undefined` for unknowns |
| Overwrite | Re-registration fully replaces stale tool index entries |
| Unregistration | Client removal, tool index cleanup, boolean return value |
| Isolation | `beforeEach` unregisters all clients; no module reimport needed |

---

## Cross-Cutting Patterns

- **Hermetic isolation:** Every suite resets shared state (singleton, module registry, or config object) before each test — no test ordering dependencies.
- **No mock frameworks:** Preferred strategies are direct ESM object mutation (`auth`) and controlled `Date.now` override (`circuit-breaker`).
- **Runtime:** Bun test runner throughout; no Jest or Vitest dependencies.
## Domains

- `testing`
- `authentication`
- `security`
- `circuit-breaker`
- `registry`
- `middleware`
- `sanitization`


---

## Backlinks

### child_of
- [sanitize.test.ts — Test Suite for sanitizeToolDescription](../files/src--__tests__--sanitize.test.ts.md)
- [Circuit Breaker — Unit Test Suite](../files/src--__tests__--circuit-breaker.test.ts.md)
- [Auth Middleware Test Suite (adminAuth & mcpAuth)](../files/src--__tests__--auth.test.ts.md)
- [Registry Singleton — Unit Test Suite](../files/src--__tests__--registry.test.ts.md)

### parent_of
- [src — MCP REST Bridge: Full Application Root](src.md)





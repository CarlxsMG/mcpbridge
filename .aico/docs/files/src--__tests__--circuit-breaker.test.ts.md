---
id: file_7e4dcd2dcfc199ea
kind: file
source_path: src/__tests__/circuit-breaker.test.ts
title: "Circuit Breaker — Unit Test Suite"
run_id: 9e628494-d1e3-4ccc-a704-a37300cef0ce
generated_at: 2026-05-07T21:09:04.788Z
---

# Circuit Breaker — Unit Test Suite

**Path:** `src/__tests__/circuit-breaker.test.ts`  
**Kind:** `file`  
**Model:** `sonnet`  
**Generated:** `sonnet@item-doc/v1`

> Test suite for the [[circuit-breaker]] module, exercising all three states of the circuit breaker state machine: `closed`, `open`, and `half_open`. Covers default failure threshold (3), state transitions triggered by `recordFailure`/`recordSuccess`, time-based half-open transition (resetTimeoutMs = 30 000 ms), probe behaviour in half-open, and re-opening on failure during recovery. Uses `Date.now` override (try/finally) to simulate elapsed time without real delays. `removeCircuitBreaker` is called in `beforeEach` to isolate module-level registry state across tests.

# Circuit Breaker — Unit Test Suite

## Purpose
Validates the state machine logic of the [[circuit-breaker]] module via isolated unit tests. All tests run under [Bun's test runner](https://bun.sh/docs/cli/test).

## Imports & Setup
```ts
import { getCircuitBreaker, removeCircuitBreaker } from "../circuit-breaker.js";
```
The module maintains an internal `breakers` map keyed by client name. `removeCircuitBreaker(CLIENT)` is called in `beforeEach` to guarantee a fresh instance per test, preventing state leakage across suites.

## Test Groups

### Initial State
- Breaker starts in **`closed`** state.
- `canRequest()` returns `{ allowed: true }` when closed.

### Opens After Failure Threshold
- Default threshold is **3 consecutive failures**.
- Breaker remains `closed` at 1 and 2 failures; transitions to `open` exactly at 3.
- `canRequest()` returns `{ allowed: false }` when open.

### Custom Config
- Indirectly verifies the default threshold (3) because `getCircuitBreaker` uses module defaults; direct class instantiation is not exported.

### Half-Open Transition
- Default `resetTimeoutMs` is **30 000 ms**.
- Time travel is simulated by temporarily replacing `Date.now` with `() => realNow() + 31_000` inside a `try/finally` block to guarantee restoration.
- `getState()` re-evaluates elapsed time on each call, enabling this technique.
- `canRequest()` in `half_open` returns `{ allowed: true, timeout: <number> }`, indicating a probe is permitted with a deadline.

### Recovery
- `recordSuccess()` in `half_open` → transitions to `closed`.
- `recordFailure()` in `half_open` → immediately re-opens (`open`).
- `recordSuccess()` before threshold resets failure count to 0; subsequent failures must accumulate again from zero.

## Key Gotchas
- The `breakers` map is module-level singleton; tests that skip `removeCircuitBreaker` will share state.
- Private fields on the `CircuitBreaker` class prevent direct time or counter manipulation; `Date.now` override is the only available lever for time-based tests.
- Custom-config testing is constrained because the class constructor is not exported — only the factory `getCircuitBreaker` (which uses defaults) is available.

## Exports Tested
| Symbol | Role |
|--------|------|
| `getCircuitBreaker(name)` | Factory / registry lookup |
| `removeCircuitBreaker(name)` | Test-only cleanup; removes entry from internal map |
| `cb.getState()` | Returns `"closed" \| "open" \| "half_open"` |
| `cb.canRequest()` | Returns `{ allowed: boolean; timeout?: number }` |
| `cb.recordFailure()` | Increments failure count; may open circuit |
| `cb.recordSuccess()` | Resets count; closes circuit from half-open |

---

## References

### has_dep
- [npm:bun:test](../knowledge/deps/npm-bun-test.md)

### has_failure_mode
- [Cross-Test State Leakage](../knowledge/failure-modes/cross-test-state-leakage.md)
- [Private Field Access Limitation](../knowledge/failure-modes/private-field-access-limitation.md)
- [Date.now Not Restored on Assertion Error](../knowledge/failure-modes/date-now-not-restored-on-assertion-error.md)
- [Custom Config Untestable via Factory](../knowledge/failure-modes/custom-config-untestable-via-factory.md)

### has_pattern
- [Circuit Breaker State Machine](../knowledge/patterns/circuit-breaker-state-machine.md)
- [beforeEach Isolation via Named Keys](../knowledge/patterns/beforeeach-isolation-via-named-keys.md)
- [Date.now Monkey-Patch in try/finally](../knowledge/patterns/date-now-monkey-patch-in-try-finally.md)
- [Registry / Factory with Cleanup Hook](../knowledge/patterns/registry-factory-with-cleanup-hook.md)

### references
- [removeCircuitBreaker](../knowledge/concepts/removecircuitbreaker.md)
- [getCircuitBreaker](../knowledge/concepts/getcircuitbreaker.md)
- [CircuitBreaker](../knowledge/concepts/circuitbreaker.md)

### uses_concept
- [Circuit Breaker](../knowledge/concepts/circuit-breaker.md)
- [recordSuccess](../knowledge/concepts/recordsuccess.md)
- [Open State](../knowledge/concepts/open-state.md)
- [Failure Threshold](../knowledge/concepts/failure-threshold.md)
- [canRequest](../knowledge/concepts/canrequest.md)
- [removeCircuitBreaker](../knowledge/concepts/removecircuitbreaker.md)
- [Half-Open State](../knowledge/concepts/half-open-state.md)
- [recordFailure](../knowledge/concepts/recordfailure.md)
- [Closed State](../knowledge/concepts/closed-state.md)
- [getCircuitBreaker](../knowledge/concepts/getcircuitbreaker.md)
- [Date.now Override](../knowledge/concepts/date-now-override.md)
- [Breakers Registry](../knowledge/concepts/breakers-registry.md)
- [Reset Timeout](../knowledge/concepts/reset-timeout.md)

## Backlinks

### parent_of
- [src/__tests__ — Unit Test Suite](../dirs/src--__tests__.md)





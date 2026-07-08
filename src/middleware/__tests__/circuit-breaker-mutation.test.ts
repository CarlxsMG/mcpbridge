/**
 * Stryker mutation-testing backstop for src/middleware/circuit-breaker.ts's
 * MODULE-LEVEL functions — the existing circuit-breaker.test.ts thoroughly
 * covers the CircuitBreaker class's state machine (closed/open/half_open,
 * sliding window, thundering-herd probe gating) but never touches
 * getAllCircuitStates, getAllBreakerStateGauges, removeCircuitBreaker,
 * updateCircuitBreakerConfig's no-op-on-missing-client guard,
 * startCircuitBreakerCleanup's idle-eviction sweep, or the exact metric
 * labels recorded on a half_open->closed transition.
 */
import { describe, test, expect, spyOn } from "bun:test";
import {
  getCircuitBreaker,
  removeCircuitBreaker,
  updateCircuitBreakerConfig,
  getAllCircuitStates,
  getAllBreakerStateGauges,
  startCircuitBreakerCleanup,
} from "../../middleware/circuit-breaker.js";
import { breakerStateTransitions } from "../../observability/metrics.js";
import * as leaderLoopMod from "../../lib/leader-loop.js";
import * as loggerMod from "../../logger.js";

// 75:74-75:85 / 75:97-75:105 StringLiteral [Survived] ("half_open"/"closed"
// emptied). The half_open->closed transition metric must carry the EXACT
// from_state/to_state label values.
test("recordSuccess in half-open records the transition metric with exact from_state/to_state labels", () => {
  const client = "cb-metrics-half-to-closed";
  removeCircuitBreaker(client);
  const cb = getCircuitBreaker(client);
  cb.recordFailure();
  cb.recordFailure();
  cb.recordFailure();
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 31_000;
    cb.canRequest();
  } finally {
    Date.now = realNow;
  }
  cb.recordSuccess();
  const rendered = breakerStateTransitions.render();
  expect(rendered).toContain(`client="${client}",from_state="half_open",to_state="closed"`);
});

// 76:11-76:17 / 76:19-76:66 StringLiteral [Survived] ("info"/the message
// emptied). recordSuccess's half_open->closed log call must carry the exact
// level, message, and meta.
test("recordSuccess in half-open logs the exact level/message/meta", () => {
  const client = "cb-log-success-client";
  removeCircuitBreaker(client);
  const cb = getCircuitBreaker(client);
  cb.recordFailure();
  cb.recordFailure();
  cb.recordFailure();
  const realNow = Date.now;
  const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
  try {
    Date.now = () => realNow() + 31_000;
    cb.canRequest();
    logSpy.mockClear();
    cb.recordSuccess();
    expect(logSpy).toHaveBeenCalledWith("info", "Circuit breaker closed after successful probe", { client });
  } finally {
    Date.now = realNow;
    logSpy.mockRestore();
  }
});

// 92:11-92:17 StringLiteral [Survived] ("warn" emptied) / 92:67-92:94
// ObjectLiteral [Survived] (`{ client: this.clientName }` -> `{}`).
// recordFailure's half_open->open re-open log call must carry the exact
// level and meta.
test("recordFailure in half-open logs the exact level/message/meta on re-open", () => {
  const client = "cb-log-reopen-client";
  removeCircuitBreaker(client);
  const cb = getCircuitBreaker(client);
  cb.recordFailure();
  cb.recordFailure();
  cb.recordFailure();
  const realNow = Date.now;
  const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
  try {
    Date.now = () => realNow() + 31_000;
    cb.canRequest();
    logSpy.mockClear();
    cb.recordFailure();
    expect(logSpy).toHaveBeenCalledWith("warn", "Circuit breaker re-opened after failed probe", { client });
  } finally {
    Date.now = realNow;
    logSpy.mockRestore();
  }
});

// 63:40-63:49 StringLiteral [Survived] ("Probing" emptied). A second
// concurrent canRequest() during an in-flight half_open probe must be
// rejected with the exact reason string, not just allowed=false.
test('canRequest rejects a second concurrent probe with the exact reason "Probing"', () => {
  const client = "cb-probing-reason-client";
  removeCircuitBreaker(client);
  const cb = getCircuitBreaker(client);
  cb.recordFailure();
  cb.recordFailure();
  cb.recordFailure();
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 31_000;
    cb.canRequest(); // consumes the one probe slot
    const second = cb.canRequest();
    expect(second).toEqual({ allowed: false, reason: "Probing" });
  } finally {
    Date.now = realNow;
  }
});

// 91:35-91:105 ObjectLiteral [Survived] (half_open->open transition metric
// object emptied) / 102:35-102:102 ObjectLiteral [Survived] (closed->open
// transition metric object emptied).
test("recordFailure in half-open records the half_open->open transition metric with exact labels", () => {
  const client = "cb-metrics-half-to-open";
  removeCircuitBreaker(client);
  const cb = getCircuitBreaker(client);
  cb.recordFailure();
  cb.recordFailure();
  cb.recordFailure();
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 31_000;
    cb.canRequest();
    cb.recordFailure();
  } finally {
    Date.now = realNow;
  }
  const rendered = breakerStateTransitions.render();
  expect(rendered).toContain(`client="${client}",from_state="half_open",to_state="open"`);
});

test("opening from closed records the closed->open transition metric with exact labels", () => {
  const client = "cb-metrics-closed-to-open";
  removeCircuitBreaker(client);
  const cb = getCircuitBreaker(client);
  cb.recordFailure();
  cb.recordFailure();
  cb.recordFailure();
  const rendered = breakerStateTransitions.render();
  expect(rendered).toContain(`client="${client}",from_state="closed",to_state="open"`);
});

// 132:11-132:45 EqualityOperator [Survived] (`>=` -> `>` on getState's
// elapsed/resetTimeoutMs boundary check). Existing sibling tests use a
// +31_000 offset against the default 30_000 resetTimeoutMs, which never
// exercises the exact boundary tick.
test("getState transitions to half_open once elapsed reaches resetTimeoutMs exactly, not only once it exceeds it", () => {
  const client = "cb-getstate-boundary-client";
  removeCircuitBreaker(client);
  const cb = getCircuitBreaker(client);
  cb.recordFailure();
  cb.recordFailure();
  const realNow = Date.now;
  const failureTime = realNow();
  try {
    Date.now = () => failureTime;
    cb.recordFailure(); // 3rd failure — trips open with lastFailureTime = failureTime
    expect(cb.getState()).toBe("open");

    Date.now = () => failureTime + 30_000; // exact default resetTimeoutMs boundary
    expect(cb.getState()).toBe("half_open");
  } finally {
    Date.now = realNow;
  }
});

// 98:68-98:96 EqualityOperator [Survived] (`<` -> `<=` on the sliding-window
// prune's age check). A failure whose age exactly equals windowMs must be
// pruned (real `<`), not retained (mutant `<=`) — otherwise a 3rd failure at
// that exact instant wrongly counts a 4th, already-aged-out entry too.
test("the sliding-window prune excludes a failure whose age exactly equals windowMs", () => {
  const client = "cb-window-boundary-client";
  removeCircuitBreaker(client);
  const cb = getCircuitBreaker(client);
  const realNow = Date.now;
  const t0 = realNow();
  const windowMs = 60_000; // default circuitBreakerWindowMs
  try {
    Date.now = () => t0;
    cb.recordFailure(); // 1st failure, ts = t0

    Date.now = () => t0 + windowMs;
    cb.recordFailure(); // 2nd failure — the t0 entry ages out exactly here (real `<`)
    cb.recordFailure(); // 3rd failure, same instant

    // Real code: only the 2 same-instant failures remain in-window (2 <
    // threshold 3) — stays closed. The `<=` mutant wrongly retains the
    // aged-out t0 entry too, reaching 3 and opening.
    expect(cb.getState()).toBe("closed");
  } finally {
    Date.now = realNow;
  }
});

// 165:3-165:41 OptionalChaining [Survived] (`breakers.get(clientName)?.
// updateConfig` with the `?.` removed). A client that was never created must
// be a silent no-op, not a throw.
test("updateCircuitBreakerConfig on a never-created client is a no-op, not a throw", () => {
  const client = "cb-never-created-client";
  removeCircuitBreaker(client);
  expect(() => updateCircuitBreakerConfig(client, { failureThreshold: 1 })).not.toThrow();
});

// 120:57-122:4 BlockStatement [Survived] (`updateConfig`'s body — `this.cfg =
// { ...this.cfg, ...overrides }` — emptied). Must actually apply the
// override to an EXISTING, already-created breaker.
test("updateCircuitBreakerConfig actually applies the override to an existing breaker", () => {
  const client = "cb-update-config-client";
  removeCircuitBreaker(client);
  const cb = getCircuitBreaker(client);
  updateCircuitBreakerConfig(client, { failureThreshold: 1 });
  cb.recordFailure(); // with threshold 1, a single failure must open immediately
  expect(cb.getState()).toBe("open");
});

// 168:69-174:2 BlockStatement [Survived] (getAllCircuitStates's body emptied).
test("getAllCircuitStates reflects every live breaker's state by name", () => {
  const client = "cb-states-test-client";
  removeCircuitBreaker(client);
  getCircuitBreaker(client);
  expect(getAllCircuitStates()[client]).toBe("closed");
});

// 189:17-189:79 ObjectLiteral [Survived] (`{ client: name, value: ... }`
// emptied to `{}`).
test("getAllBreakerStateGauges returns the exact {client, value} shape per breaker", () => {
  const client = "cb-gauges-test-client";
  removeCircuitBreaker(client);
  getCircuitBreaker(client);
  const entry = getAllBreakerStateGauges().find((g) => g.client === client);
  expect(entry).toEqual({ client, value: 0 });
});

// 197:64-199:2 BlockStatement [Survived] (removeCircuitBreaker's body
// emptied — `breakers.delete(clientName)` never runs).
test("removeCircuitBreaker actually deletes the breaker", () => {
  const client = "cb-remove-test-client";
  getCircuitBreaker(client);
  expect(getAllCircuitStates()[client]).toBe("closed");
  removeCircuitBreaker(client);
  expect(getAllCircuitStates()[client]).toBeUndefined();
});

// 142:26-142:36 ArithmeticOperator [Survived] (`5 * 60_000` -> `5 / 60_000`).
// BREAKER_IDLE_TTL isn't exported — observed indirectly via the interval
// value startCircuitBreakerCleanup actually hands to startPeriodicSweep.
describe("startCircuitBreakerCleanup", () => {
  test("passes the real 5-minute idle TTL as the sweep interval", () => {
    const startSpy = spyOn(leaderLoopMod, "startPeriodicSweep").mockImplementation(() => () => {});
    try {
      startCircuitBreakerCleanup();
      expect(startSpy).toHaveBeenCalledTimes(1);
      const intervalMs = startSpy.mock.calls[0]?.[1];
      expect(intervalMs).toBe(300_000);
    } finally {
      startSpy.mockRestore();
    }
  });

  // 209:11-209:59 EqualityOperator [Survived] (`>` -> `<=`) and
  // 209:11-209:40 ArithmeticOperator [Survived] (`now - x` -> `now + x`).
  // Captures the real sweep callback (bypassing the real setInterval) and
  // invokes it directly with controlled Date.now values straddling the
  // exact TTL boundary. The `+` mutant is also caught by the same
  // not-evicted-at-boundary assertion: real epoch timestamps are large
  // enough that `now + lastAccess` always vastly exceeds BREAKER_IDLE_TTL
  // regardless of the tiny offsets used here, so it would wrongly evict.
  test("evicts a breaker only once idle time strictly EXCEEDS the TTL, not merely equal to it", () => {
    let capturedFn: (() => void) | undefined;
    const startSpy = spyOn(leaderLoopMod, "startPeriodicSweep").mockImplementation((fn) => {
      capturedFn = fn as () => void;
      return () => {};
    });
    const client = "cb-idle-sweep-client";
    const realNow = Date.now;
    try {
      removeCircuitBreaker(client);
      const cb = getCircuitBreaker(client);
      const lastAccess = cb.getLastAccess();
      startCircuitBreakerCleanup();
      expect(capturedFn).toBeDefined();

      // Exactly at the TTL boundary — must NOT evict.
      Date.now = () => lastAccess + 300_000;
      capturedFn!();
      expect(getAllCircuitStates()[client]).toBe("closed");

      // Past the TTL — must evict.
      Date.now = () => lastAccess + 300_001;
      capturedFn!();
      expect(getAllCircuitStates()[client]).toBeUndefined();
    } finally {
      Date.now = realNow;
      startSpy.mockRestore();
    }
  });
});

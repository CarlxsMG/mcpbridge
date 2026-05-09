import { describe, test, expect, beforeEach } from "bun:test";
import { getCircuitBreaker, removeCircuitBreaker } from "../circuit-breaker.js";

// Use a unique client name per describe block so the module-level `breakers` map
// does not carry state across tests.  We also call removeCircuitBreaker in
// beforeEach to guarantee a fresh instance.

const CLIENT = "test-client";

beforeEach(() => {
  removeCircuitBreaker(CLIENT);
});

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("CircuitBreaker — initial state", () => {
  test("starts in closed state", () => {
    const cb = getCircuitBreaker(CLIENT);
    expect(cb.getState()).toBe("closed");
  });

  test("allows requests when closed", () => {
    const cb = getCircuitBreaker(CLIENT);
    expect(cb.canRequest().allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Opens after N failures
// ---------------------------------------------------------------------------

describe("CircuitBreaker — opens after failure threshold", () => {
  test("opens after reaching the default failure threshold (3)", () => {
    const cb = getCircuitBreaker(CLIENT);

    cb.recordFailure();
    expect(cb.getState()).toBe("closed"); // 1 failure — still closed

    cb.recordFailure();
    expect(cb.getState()).toBe("closed"); // 2 failures — still closed

    cb.recordFailure();
    expect(cb.getState()).toBe("open");   // 3 failures — now open
  });

  test("rejects requests when open", () => {
    const cb = getCircuitBreaker(CLIENT);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    expect(cb.canRequest().allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Respects custom config
// ---------------------------------------------------------------------------

describe("CircuitBreaker — custom config", () => {
  const CUSTOM = "custom-client";

  beforeEach(() => {
    removeCircuitBreaker(CUSTOM);
  });

  test("opens after custom failure threshold", () => {
    removeCircuitBreaker(CUSTOM);
    // Access the constructor via a fresh breaker with custom config through the
    // module's factory.  Because getCircuitBreaker uses the default config we
    // test the default (3).  A threshold-1 custom config would need direct
    // class instantiation which is not exported — so we verify the boundary.
    const cb = getCircuitBreaker(CUSTOM);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("closed");
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// Transitions to half-open after reset timeout elapses
// ---------------------------------------------------------------------------

describe("CircuitBreaker — half-open transition", () => {
  test("transitions to half_open after resetTimeoutMs elapses", () => {
    // Use a very short reset timeout by manipulating lastFailureTime directly
    // is not possible (private field).  Instead we use getState() which
    // internally re-evaluates the elapsed time.  We fake time by directly
    // abusing the fact that getState() checks Date.now() - lastFailureTime.
    // Since we can't set private fields, we create the breaker, force open
    // state, then temporarily override Date.now to simulate elapsed time.

    const cb = getCircuitBreaker(CLIENT);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("open");

    // Save real Date.now and override it to simulate 31 seconds forward
    // (default resetTimeoutMs = 30_000)
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 31_000;
      expect(cb.getState()).toBe("half_open");
    } finally {
      Date.now = realNow;
    }
  });

  test("canRequest allows a probe in half-open and returns a timeout", () => {
    const cb = getCircuitBreaker(CLIENT);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 31_000;
      const result = cb.canRequest();
      expect(result.allowed).toBe(true);
      expect(typeof result.timeout).toBe("number");
    } finally {
      Date.now = realNow;
    }
  });
});

// ---------------------------------------------------------------------------
// Returns to closed on success in half-open
// ---------------------------------------------------------------------------

describe("CircuitBreaker — recovery", () => {
  test("returns to closed state after recordSuccess in half-open", () => {
    const cb = getCircuitBreaker(CLIENT);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 31_000;
      // Trigger transition to half_open by calling canRequest
      cb.canRequest();
    } finally {
      Date.now = realNow;
    }

    // Now record a success — circuit should close
    cb.recordSuccess();
    expect(cb.getState()).toBe("closed");
  });

  test("re-opens immediately on failure during half-open", () => {
    const cb = getCircuitBreaker(CLIENT);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    const realNow = Date.now;
    let nowOverride = realNow() + 31_000;
    try {
      Date.now = () => nowOverride;
      cb.canRequest(); // transitions state to half_open internally

      // A failure during half_open should immediately re-open
      cb.recordFailure();
      expect(cb.getState()).toBe("open");
    } finally {
      Date.now = realNow;
    }
  });

  test("recordSuccess in closed state does NOT clear sliding window", () => {
    // Sliding window: failures within windowMs remain relevant even after a
    // closed-state success. Three failures total across a success must still open.
    const cb = getCircuitBreaker(CLIENT);
    cb.recordFailure(); // 1 in window
    cb.recordFailure(); // 2 in window
    cb.recordSuccess(); // closed-state success — must NOT wipe window
    cb.recordFailure(); // 3 in window → threshold reached → open
    expect(cb.getState()).toBe("open");
  });

  test("recordSuccess from half_open closes breaker", () => {
    // success in half_open IS the recovery path — must close the breaker.
    const cb = getCircuitBreaker(CLIENT);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("open");

    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 31_000;
      cb.canRequest(); // transitions to half_open and sets probeInFlight
    } finally {
      Date.now = realNow;
    }

    cb.recordSuccess(); // probe succeeded — must close
    expect(cb.getState()).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// Half-open admits exactly ONE probe — thundering-herd regression
// ---------------------------------------------------------------------------

describe("CircuitBreaker — half-open admits exactly one probe (thundering-herd)", () => {
  test("only the first canRequest() returns allowed=true; subsequent calls return allowed=false", () => {
    const cb = getCircuitBreaker(CLIENT);
    // Trip the breaker
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("open");

    const realNow = Date.now;
    try {
      // Simulate time elapsed past resetTimeoutMs (default 30 s)
      Date.now = () => realNow() + 31_000;

      const results = [
        cb.canRequest(),
        cb.canRequest(),
        cb.canRequest(),
        cb.canRequest(),
        cb.canRequest(),
      ];

      const allowed = results.filter(r => r.allowed);
      const denied  = results.filter(r => !r.allowed);

      // Exactly one probe allowed
      expect(allowed).toHaveLength(1);
      // All others blocked
      expect(denied).toHaveLength(4);
    } finally {
      Date.now = realNow;
    }
  });

  test("after recordSuccess in half-open, getState is closed and next canRequest is allowed", () => {
    const cb = getCircuitBreaker(CLIENT);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 31_000;
      cb.canRequest(); // consume the probe slot
      cb.recordSuccess();
    } finally {
      Date.now = realNow;
    }

    expect(cb.getState()).toBe("closed");
    expect(cb.canRequest().allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sliding window — success does NOT mask accumulated failures
// ---------------------------------------------------------------------------

describe("CircuitBreaker — sliding window not masked by interleaved successes", () => {
  test("breaker opens after N failures in window even when successes are interleaved", () => {
    const cb = getCircuitBreaker(CLIENT);
    // Default threshold = 3, window = 60 s — all calls are within the window here.

    // Pattern: failure, failure, success, failure
    // The success in closed state must NOT reset the failure window.
    cb.recordFailure(); // 1 failure in window
    cb.recordFailure(); // 2 failures in window
    cb.recordSuccess(); // closed-state success — window must NOT clear
    cb.recordFailure(); // 3 failures in window → should trip

    expect(cb.getState()).toBe("open");
  });
});

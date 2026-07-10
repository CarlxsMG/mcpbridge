import { describe, expect, test, spyOn } from "bun:test";

import { startLeaderGatedInterval, startPeriodicSweep } from "../leader-loop.js";
import * as loggerMod from "../../logger.js";
import * as leaderLeaseMod from "../../db/leader-lease.js";

// ---------------------------------------------------------------------------
// Mutation-testing backstop for `src/lib/leader-loop.ts` — the shared
// "setInterval + swallow/log errors + return a stop()" scaffold behind five
// background loops. No I/O of its own: everything here is exercised by
// spying on the real `setInterval`/`clearInterval` globals to capture the
// callback the module hands them (rather than waiting on a real timer), and
// by spying on `isLeader`/`log` from the modules `leader-loop.ts` imports.
// `startPeriodicSweep` and `startLeaderGatedInterval` both funnel through
// the same internal (unexported) `runSafely` helper, so the
// error-swallowing/logging assertions are duplicated for each public entry
// point rather than assumed to transfer.
// ---------------------------------------------------------------------------

type FakeTimer = ReturnType<typeof setInterval>;

/**
 * The real global `setInterval` is a heavily-overloaded signature (browser
 * `TimerHandler` vs. Node's `NodeJS.Timeout`-returning form); mocking it with
 * a plain `(cb, ms) => FakeTimer` lambda doesn't structurally match any one
 * overload. Centralize the cast here instead of repeating `as unknown as`
 * at every call site.
 */
function asSetIntervalImpl(impl: (cb: () => void, ms?: number) => FakeTimer): typeof setInterval {
  return impl as unknown as typeof setInterval;
}

function fakeTimer(extra: Record<string, unknown> = {}): FakeTimer {
  return { unref: () => {}, ...extra } as unknown as FakeTimer;
}

/** Flushes any pending microtasks — enough for `await fn()` inside `runSafely` to settle. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("startPeriodicSweep", () => {
  test("registers via setInterval with the exact intervalMs given, and does NOT run fn immediately", () => {
    let capturedFn: (() => void) | undefined;
    let capturedMs: number | undefined;
    const timer = fakeTimer();
    const setIntervalSpy = spyOn(global, "setInterval").mockImplementation(
      asSetIntervalImpl((cb, ms) => {
        capturedFn = cb;
        capturedMs = ms;
        return timer;
      }),
    );
    const fnHolder = { fn: () => {} };
    const fn = spyOn(fnHolder, "fn");
    try {
      startPeriodicSweep(fn, 12345);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(capturedMs).toBe(12345);
      expect(fn).not.toHaveBeenCalled();
      expect(capturedFn).toBeDefined();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  test("stop() calls clearInterval with the exact timer setInterval returned", () => {
    const timer = fakeTimer({ id: "sweep-timer" });
    const setIntervalSpy = spyOn(global, "setInterval").mockImplementation(asSetIntervalImpl(() => timer));
    const clearIntervalSpy = spyOn(global, "clearInterval").mockImplementation(() => {});
    try {
      const stop = startPeriodicSweep(() => {}, 1000);
      stop();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(clearIntervalSpy.mock.calls[0]?.[0]).toBe(timer);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  test("invoking the captured tick runs fn, and a successful run logs nothing", async () => {
    let capturedFn: (() => void) | undefined;
    const setIntervalSpy = spyOn(global, "setInterval").mockImplementation(
      asSetIntervalImpl((cb) => {
        capturedFn = cb;
        return fakeTimer();
      }),
    );
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    let calls = 0;
    try {
      startPeriodicSweep(() => {
        calls++;
      }, 1000);
      expect(capturedFn).toBeDefined();
      capturedFn!();
      await flushMicrotasks();
      expect(calls).toBe(1);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test("swallows a synchronously-thrown Error from fn and logs its .message under the periodic-sweep error message", async () => {
    let capturedFn: (() => void) | undefined;
    const setIntervalSpy = spyOn(global, "setInterval").mockImplementation(
      asSetIntervalImpl((cb) => {
        capturedFn = cb;
        return fakeTimer();
      }),
    );
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      startPeriodicSweep(() => {
        throw new Error("sweep boom");
      }, 1000);
      expect(() => capturedFn!()).not.toThrow();
      await flushMicrotasks();
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0]?.[0]).toBe("error");
      expect(logSpy.mock.calls[0]?.[1]).toBe("Periodic sweep encountered an unhandled error");
      expect(logSpy.mock.calls[0]?.[2]).toEqual({ error: "sweep boom" });
    } finally {
      setIntervalSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test("swallows an async rejection with a non-Error reason, stringifying it via String(err)", async () => {
    let capturedFn: (() => void) | undefined;
    const setIntervalSpy = spyOn(global, "setInterval").mockImplementation(
      asSetIntervalImpl((cb) => {
        capturedFn = cb;
        return fakeTimer();
      }),
    );
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      startPeriodicSweep(() => Promise.reject("plain string reason"), 1000);
      capturedFn!();
      await flushMicrotasks();
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0]?.[2]).toEqual({ error: "plain string reason" });
    } finally {
      setIntervalSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe("startLeaderGatedInterval", () => {
  test("runs fn immediately when isLeader() is true at start, passes the exact intervalMs, and unrefs the timer", () => {
    const isLeaderSpy = spyOn(leaderLeaseMod, "isLeader").mockReturnValue(true);
    const unrefHolder = { unref: () => {} };
    const unrefSpy = spyOn(unrefHolder, "unref");
    const timer = { unref: unrefSpy } as unknown as FakeTimer;
    let capturedMs: number | undefined;
    const setIntervalSpy = spyOn(global, "setInterval").mockImplementation(
      asSetIntervalImpl((_cb, ms) => {
        capturedMs = ms;
        return timer;
      }),
    );
    let calls = 0;
    try {
      startLeaderGatedInterval(() => {
        calls++;
      }, 54321);
      expect(calls).toBe(1);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(capturedMs).toBe(54321);
      expect(unrefSpy).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
      isLeaderSpy.mockRestore();
    }
  });

  test("does NOT run fn immediately when isLeader() is false at start", () => {
    const isLeaderSpy = spyOn(leaderLeaseMod, "isLeader").mockReturnValue(false);
    const setIntervalSpy = spyOn(global, "setInterval").mockImplementation(asSetIntervalImpl(() => fakeTimer()));
    let calls = 0;
    try {
      startLeaderGatedInterval(() => {
        calls++;
      }, 1000);
      expect(calls).toBe(0);
    } finally {
      setIntervalSpy.mockRestore();
      isLeaderSpy.mockRestore();
    }
  });

  test("the captured tick re-checks isLeader() fresh on every invocation, not just at start", () => {
    // Starts as a non-leader (so the immediate tick() at start is a no-op),
    // then flips true/false across subsequent invocations of the SAME
    // captured callback — this is what distinguishes a real per-tick guard
    // from one that was only ever evaluated once at start time.
    let leader = false;
    const isLeaderSpy = spyOn(leaderLeaseMod, "isLeader").mockImplementation(() => leader);
    let capturedFn: (() => void) | undefined;
    const setIntervalSpy = spyOn(global, "setInterval").mockImplementation(
      asSetIntervalImpl((cb) => {
        capturedFn = cb;
        return fakeTimer();
      }),
    );
    let calls = 0;
    try {
      startLeaderGatedInterval(() => {
        calls++;
      }, 1000);
      expect(calls).toBe(0); // immediate call was a no-op (not leader yet)
      expect(capturedFn).toBeDefined();

      capturedFn!();
      expect(calls).toBe(0); // still not leader

      leader = true;
      capturedFn!();
      expect(calls).toBe(1); // now leader — fn runs

      leader = false;
      capturedFn!();
      expect(calls).toBe(1); // lost leadership again — no further run
    } finally {
      setIntervalSpy.mockRestore();
      isLeaderSpy.mockRestore();
    }
  });

  test("stop() calls clearInterval with the exact timer setInterval returned", () => {
    const isLeaderSpy = spyOn(leaderLeaseMod, "isLeader").mockReturnValue(false);
    const timer = fakeTimer({ id: "leader-timer" });
    const setIntervalSpy = spyOn(global, "setInterval").mockImplementation(asSetIntervalImpl(() => timer));
    const clearIntervalSpy = spyOn(global, "clearInterval").mockImplementation(() => {});
    try {
      const stop = startLeaderGatedInterval(() => {}, 1000);
      stop();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(clearIntervalSpy.mock.calls[0]?.[0]).toBe(timer);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      isLeaderSpy.mockRestore();
    }
  });

  test("does not throw when the timer setInterval returns lacks an unref method (guards `if (timer.unref)`)", () => {
    const isLeaderSpy = spyOn(leaderLeaseMod, "isLeader").mockReturnValue(false);
    const timer = {} as unknown as FakeTimer;
    const setIntervalSpy = spyOn(global, "setInterval").mockImplementation(asSetIntervalImpl(() => timer));
    try {
      expect(() => startLeaderGatedInterval(() => {}, 1000)).not.toThrow();
    } finally {
      setIntervalSpy.mockRestore();
      isLeaderSpy.mockRestore();
    }
  });

  test("swallows a thrown error from the immediate leader run and logs under the leader-gated error message", async () => {
    const isLeaderSpy = spyOn(leaderLeaseMod, "isLeader").mockReturnValue(true);
    const setIntervalSpy = spyOn(global, "setInterval").mockImplementation(asSetIntervalImpl(() => fakeTimer()));
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      startLeaderGatedInterval(() => {
        throw new Error("leader boom");
      }, 1000);
      await flushMicrotasks();
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0]?.[0]).toBe("error");
      expect(logSpy.mock.calls[0]?.[1]).toBe("Leader-gated loop encountered an unhandled error");
      expect(logSpy.mock.calls[0]?.[2]).toEqual({ error: "leader boom" });
    } finally {
      setIntervalSpy.mockRestore();
      isLeaderSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test("a successful leader run logs nothing", async () => {
    const isLeaderSpy = spyOn(leaderLeaseMod, "isLeader").mockReturnValue(true);
    const setIntervalSpy = spyOn(global, "setInterval").mockImplementation(asSetIntervalImpl(() => fakeTimer()));
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      startLeaderGatedInterval(() => {}, 1000);
      await flushMicrotasks();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
      isLeaderSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

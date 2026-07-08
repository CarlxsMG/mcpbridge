/**
 * Stryker mutation-testing backstop for src/db/leader-lease.ts — had no
 * dedicated test file at all.
 */
import { describe, test, expect, spyOn } from "bun:test";
import { refreshLeaderStatus, startLeaderElection } from "../../db/leader-lease.js";
import * as connectionMod from "../../db/connection.js";
import * as loggerMod from "../../logger.js";
import { config } from "../../config.js";

// 45:9-45:16 / 45:18-45:50 StringLiteral [Survived] ("error"/"Leader
// election renewal failed" emptied).
describe("refreshLeaderStatus", () => {
  test("a lease-acquisition failure logs the exact level and message", () => {
    const getDbSpy = spyOn(connectionMod, "getDb").mockImplementation(() => {
      throw new Error("boom");
    });
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      const result = refreshLeaderStatus();
      expect(result).toBe(false);
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0]?.[0]).toBe("error");
      expect(logSpy.mock.calls[0]?.[1]).toBe("Leader election renewal failed");
    } finally {
      getDbSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

// 61:10-61:36 ArrowFunction [Survived] (`() => clearInterval(timer)` ->
// `() => undefined` — the returned stop function would silently do nothing).
describe("startLeaderElection", () => {
  test("the returned stop function actually clears the underlying interval", () => {
    const clearSpy = spyOn(globalThis, "clearInterval");
    try {
      const stop = startLeaderElection();
      stop();
      expect(clearSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearSpy.mockRestore();
    }
  });

  // 58:22-58:82 MethodExpression [Survived] (`Math.max(1000,
  // Math.floor(config.leaderLeaseDurationMs / 3))` flipped to `Math.min`).
  // Default leaderLeaseDurationMs (15_000) floors to 5_000, which is well
  // above the 1_000 floor — Math.max and Math.min diverge sharply here.
  test("passes the real Math.max-computed interval, not Math.min's floor value", () => {
    const setIntervalSpy = spyOn(globalThis, "setInterval");
    try {
      const stop = startLeaderElection();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      const expected = Math.max(1000, Math.floor(config.leaderLeaseDurationMs / 3));
      expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(expected);
      stop();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});

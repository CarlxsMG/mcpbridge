/**
 * Smoke tests for the `withConfig` helper itself. The interesting guarantee
 * is that `config` is always restored — even on a thrown assertion in the body
 * or on a rejected promise from an async body. These tests would catch any
 * regression in that contract.
 */
import { describe, test, expect } from "bun:test";
import { config } from "../../config.js";
import { withConfig } from "./with-config.js";

describe("withConfig", () => {
  test("applies the patch and runs the body", () => {
    let captured: unknown = null;
    withConfig({ adminApiKeys: ["x"] }, () => {
      captured = config.adminApiKeys;
    });
    expect(captured).toEqual(["x"]);
  });

  test("restores the original value after sync success", () => {
    const original = config.sessionTtlMs;
    withConfig({ sessionTtlMs: 1 }, () => undefined);
    expect(config.sessionTtlMs).toBe(original);
  });

  test("restores the original value after sync throw", () => {
    const original = config.retryMaxAttempts;
    expect(() =>
      withConfig({ retryMaxAttempts: 99 }, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(config.retryMaxAttempts).toBe(original);
  });

  test("supports async body and restores after resolve", async () => {
    const original = config.maxJsonDepth;
    await withConfig({ maxJsonDepth: 7 }, async () => {
      expect(config.maxJsonDepth).toBe(7);
    });
    expect(config.maxJsonDepth).toBe(original);
  });

  test("restores after async body rejects", async () => {
    const original = config.cacheMaxEntries;
    await expect(
      withConfig({ cacheMaxEntries: 99 }, async () => {
        throw new Error("async boom");
      }),
    ).rejects.toThrow("async boom");
    expect(config.cacheMaxEntries).toBe(original);
  });

  test("patches multiple keys at once", () => {
    const origApiKeys = config.adminApiKeys;
    const origAuthDisabled = config.authDisabled;
    withConfig({ adminApiKeys: ["a"], authDisabled: false }, () => {
      expect(config.adminApiKeys).toEqual(["a"]);
      expect(config.authDisabled).toBe(false);
    });
    expect(config.adminApiKeys).toBe(origApiKeys);
    expect(config.authDisabled).toBe(origAuthDisabled);
  });

  test("does not touch keys absent from the patch", () => {
    const origX = config.sessionTtlMs;
    const origY = config.retryMaxAttempts;
    withConfig({ sessionTtlMs: 1234 }, () => {
      // sessionTtlMs patched, retryMaxAttempts untouched
      expect(config.retryMaxAttempts).toBe(origY);
    });
    expect(config.sessionTtlMs).toBe(origX);
  });

  test("returns the body's resolved value", async () => {
    const v = await withConfig({ sessionTtlMs: 1 }, async () => 42);
    expect(v).toBe(42);
  });
});

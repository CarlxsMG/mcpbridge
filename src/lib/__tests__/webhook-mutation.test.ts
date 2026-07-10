/**
 * Stryker mutation-testing backstop for src/lib/webhook.ts.
 *
 * `dispatchWebhook` is the shared "SSRF-validate, then POST with a timeout,
 * never throw" mechanism factored out of four call sites (alerts.ts,
 * monitor.ts, audit.ts, approvals.ts). Every one of those consumer mutation
 * test files (monitor-mutation, audit-mutation, approvals-mutation, the
 * alerts-mutation-ac* series) `spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(...)`
 * to keep their own tests hermetic — none of them exercise dispatchWebhook's
 * own body. This file is the only place that does.
 *
 * Covers, by exercising the real function directly:
 *   - The SSRF-rejected branch: validateBackendUrl's `valid: false` result
 *     short-circuits before fetch is ever called, logs `rejectedLogMessage`
 *     with `{ ...logContext, reason }`, and resolves `false`. (We don't
 *     re-test ip-validator.ts's own reason strings/CIDR logic here — domain 4
 *     already covers that exhaustively. We only prove dispatchWebhook calls
 *     it and respects a `valid: false` result.)
 *   - The dispatched-successfully branch: exact fetch call shape (method,
 *     Content-Type header, JSON body, `redirect: "error"`, an AbortSignal),
 *     resolving `true` — including when the response itself is a non-2xx
 *     status (per the file's own doc comment: "non-2xx is NOT treated as
 *     failure here").
 *   - The swallowed-exception branch: a thrown `Error` uses `.message`; a
 *     thrown non-Error value falls through to `String(err)` — both logged
 *     via `failedLogMessage` with `{ ...logContext, error }`, resolving
 *     `false`, never rejecting.
 *   - `logContext` is optional (omitted entirely) and, when present, is
 *     merged into the log call rather than replacing it.
 *
 * fetch is mocked throughout (direct `globalThis.fetch` reassignment, the
 * established technique for this exact primitive — see
 * src/observability/__tests__/health-mutation-hc2.test.ts) — never a real
 * network call. `config.allowPrivateIps`/`config.allowedHosts` are saved and
 * restored around every test since a fresh worktree defaults
 * `allowPrivateIps=false` (ALLOW_PRIVATE_IPS ambient-env gotcha) and we need
 * both states for the rejected-vs-dispatched cases; loopback IP literals
 * (`127.0.0.1`) are used throughout so no real DNS resolution is needed
 * either way.
 *
 * Run with STRYKER_TEST_SCOPE="src/lib/__tests__" (never bare `bun test` —
 * see CLAUDE.md).
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { config } from "../../config.js";
import * as loggerMod from "../../logger.js";
import { dispatchWebhook } from "../webhook.js";

interface CapturedFetchCall {
  url: string;
  init: RequestInit;
}

let fetchCalls: CapturedFetchCall[] = [];

/** Installs a fetch mock that records every call's (url, init) and resolves with `status`. */
function mockFetchResolve(status = 200): void {
  fetchCalls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
}

/** Installs a fetch mock that always throws `err` (Error or any other value). */
function mockFetchThrow(err: unknown): void {
  fetchCalls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    throw err;
  }) as unknown as typeof fetch;
}

const originalFetch = globalThis.fetch;
const originalAllowPrivateIps = config.allowPrivateIps;
const originalAllowedHosts = config.allowedHosts;

beforeEach(() => {
  globalThis.fetch = originalFetch;
  (config as Record<string, unknown>).allowPrivateIps = originalAllowPrivateIps;
  (config as Record<string, unknown>).allowedHosts = originalAllowedHosts;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  (config as Record<string, unknown>).allowPrivateIps = originalAllowPrivateIps;
  (config as Record<string, unknown>).allowedHosts = originalAllowedHosts;
});

// ---------------------------------------------------------------------------
// SSRF-rejected branch
// ---------------------------------------------------------------------------

describe("dispatchWebhook — SSRF-rejected URL", () => {
  test("a blocked-private-IP URL resolves false, never calls fetch, and logs rejectedLogMessage + reason + logContext", async () => {
    (config as Record<string, unknown>).allowPrivateIps = false;
    mockFetchResolve(); // if reached, fetchCalls would grow — asserted to stay empty below
    const logSpy = spyOn(loggerMod, "log");
    try {
      const result = await dispatchWebhook(
        "http://127.0.0.1:9999/hook",
        { hello: "world" },
        {
          timeoutMs: 1000,
          rejectedLogMessage: "Webhook URL rejected",
          failedLogMessage: "Webhook delivery failed",
          logContext: { rule: "my-rule" },
        },
      );

      expect(result).toBe(false);
      expect(fetchCalls.length).toBe(0); // the early-return branch must never reach fetch()

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith("warn", "Webhook URL rejected", {
        rule: "my-rule",
        reason: "IP is in a blocked private range: 127.0.0.1",
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  test("logContext is optional — omitted entirely, the rejected log call carries only `reason`", async () => {
    (config as Record<string, unknown>).allowPrivateIps = false;
    mockFetchResolve();
    const logSpy = spyOn(loggerMod, "log");
    try {
      const result = await dispatchWebhook(
        "http://127.0.0.1:9999/hook",
        { a: 1 },
        {
          timeoutMs: 1000,
          rejectedLogMessage: "Rejected no-context",
          failedLogMessage: "Failed no-context",
        },
      );

      expect(result).toBe(false);
      expect(logSpy).toHaveBeenCalledWith("warn", "Rejected no-context", {
        reason: "IP is in a blocked private range: 127.0.0.1",
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  test("an invalid URL (fails URL parsing, a distinct rejection reason from the private-IP case) still resolves false via the same branch", async () => {
    mockFetchResolve();
    const logSpy = spyOn(loggerMod, "log");
    try {
      const result = await dispatchWebhook(
        "not-a-valid-url",
        { a: 1 },
        {
          timeoutMs: 1000,
          rejectedLogMessage: "Rejected invalid",
          failedLogMessage: "Failed invalid",
        },
      );

      expect(result).toBe(false);
      expect(fetchCalls.length).toBe(0);
      expect(logSpy).toHaveBeenCalledWith("warn", "Rejected invalid", { reason: "Invalid URL" });
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Dispatched-successfully branch
// ---------------------------------------------------------------------------

describe("dispatchWebhook — validated URL, fetch dispatched", () => {
  test("POSTs the exact url/method/headers/body/redirect/signal and resolves true on a 200", async () => {
    (config as Record<string, unknown>).allowPrivateIps = true;
    mockFetchResolve(200);

    const payload = { event: "distinct-marker", n: 42 };
    const result = await dispatchWebhook("http://127.0.0.1:9999/hook", payload, {
      timeoutMs: 5000,
      rejectedLogMessage: "should not fire",
      failedLogMessage: "should not fire",
    });

    expect(result).toBe(true);
    expect(fetchCalls.length).toBe(1);

    const call = fetchCalls[0];
    expect(call.url).toBe("http://127.0.0.1:9999/hook");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(call.init.body).toBe(JSON.stringify(payload));
    expect(call.init.redirect).toBe("error");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  test("a distinct payload produces a distinctly different JSON body (proves the real payload is serialized, not a stubbed one)", async () => {
    (config as Record<string, unknown>).allowPrivateIps = true;
    mockFetchResolve(200);

    await dispatchWebhook(
      "http://127.0.0.1:9999/hook-a",
      { marker: "AAA" },
      { timeoutMs: 5000, rejectedLogMessage: "x", failedLogMessage: "y" },
    );
    const bodyA = fetchCalls[0].init.body;

    await dispatchWebhook(
      "http://127.0.0.1:9999/hook-b",
      { marker: "BBB" },
      { timeoutMs: 5000, rejectedLogMessage: "x", failedLogMessage: "y" },
    );
    const bodyB = fetchCalls[1].init.body;

    expect(bodyA).toBe(JSON.stringify({ marker: "AAA" }));
    expect(bodyB).toBe(JSON.stringify({ marker: "BBB" }));
    expect(bodyA).not.toBe(bodyB);
  });

  test("a non-2xx response still resolves true — non-2xx is not treated as a failure here", async () => {
    (config as Record<string, unknown>).allowPrivateIps = true;
    mockFetchResolve(500);

    const logSpy = spyOn(loggerMod, "log");
    try {
      const result = await dispatchWebhook(
        "http://127.0.0.1:9999/hook",
        { a: 1 },
        {
          timeoutMs: 5000,
          rejectedLogMessage: "should not fire",
          failedLogMessage: "should not fire",
        },
      );

      expect(result).toBe(true);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Swallowed-exception branch
// ---------------------------------------------------------------------------

describe("dispatchWebhook — fetch throws, swallowed and logged, never rejects", () => {
  test("a thrown real Error uses .message and resolves false", async () => {
    (config as Record<string, unknown>).allowPrivateIps = true;
    mockFetchThrow(new Error("boom-network-error"));

    const logSpy = spyOn(loggerMod, "log");
    try {
      const result = await dispatchWebhook(
        "http://127.0.0.1:9999/hook",
        { a: 1 },
        {
          timeoutMs: 5000,
          rejectedLogMessage: "should not fire",
          failedLogMessage: "Webhook delivery failed",
          logContext: { rule: "err-rule" },
        },
      );

      expect(result).toBe(false);
      expect(logSpy).toHaveBeenCalledWith("warn", "Webhook delivery failed", {
        rule: "err-rule",
        error: "boom-network-error",
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  test("a thrown non-Error value falls through to String(err) and resolves false", async () => {
    (config as Record<string, unknown>).allowPrivateIps = true;
    mockFetchThrow(42); // a number: String(42) === "42" (string), distinct from the raw number

    const logSpy = spyOn(loggerMod, "log");
    try {
      const result = await dispatchWebhook(
        "http://127.0.0.1:9999/hook",
        { a: 1 },
        {
          timeoutMs: 5000,
          rejectedLogMessage: "should not fire",
          failedLogMessage: "Non-error failure",
        },
      );

      expect(result).toBe(false);
      const call = logSpy.mock.calls.find((c) => c[1] === "Non-error failure");
      expect(call).toBeDefined();
      const meta = call?.[2] as Record<string, unknown>;
      expect(meta.error).toBe("42");
      expect(typeof meta.error).toBe("string");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("never rejects — the promise always settles even when fetch throws", async () => {
    (config as Record<string, unknown>).allowPrivateIps = true;
    mockFetchThrow(new Error("should be swallowed"));

    await expect(
      dispatchWebhook(
        "http://127.0.0.1:9999/hook",
        { a: 1 },
        {
          timeoutMs: 5000,
          rejectedLogMessage: "x",
          failedLogMessage: "y",
        },
      ),
    ).resolves.toBe(false);
  });
});

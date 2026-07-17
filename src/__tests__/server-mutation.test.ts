/**
 * Stryker mutation-testing backstop for `src/server.ts` (`createApp()`).
 *
 * `src/__tests__/create-app.test.ts` already exercises the happy paths
 * (`/livez`, `/health`, a 404, and one real 400 error envelope via malformed
 * JSON) and is left completely untouched. This file gap-fills the wiring
 * details that file doesn't reach:
 *   - `app.set("trust proxy", config.trustProxy)` + the TRUST_PROXY warn log
 *     (both the truthy/falsy branch and the exact pass-through value).
 *   - Every individual baseline security-header value, the full CSP string,
 *     and the full Permissions-Policy string (create-app.test.ts only spot
 *     checks a few with `.toContain`).
 *   - The HSTS conditional (`req.secure || x-forwarded-proto === "https"`).
 *   - The full branch matrix of the global JSON error envelope: status
 *     resolution (`err.status` vs `err.statusCode` vs default), the
 *     400-599 clamp, the 5xx/non-5xx message+code selection, the message
 *     length cutoff, and the `request_id ?? null` fallback.
 *   - The `res.headersSent` short-circuit, which no real route in this app
 *     can trigger over HTTP (nothing here writes a partial response body
 *     before throwing). It's reached by pulling the actual registered
 *     error-handling middleware directly off the Express router stack and
 *     invoking it with a synthetic req/res/next — the standard technique
 *     for unit-testing an inline (non-exported) Express error handler.
 *   - The `createApp()` return shape itself (`app` + callable
 *     `cleanupTransports`).
 */
import { describe, test, expect, afterEach, spyOn } from "bun:test";
import type { AddressInfo } from "net";
import type { Server } from "http";
import type { Express } from "express";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { __resetLeaderFlagForTesting } from "../db/leader-lease.js";
import { createApp } from "../server.js";
import * as loggerMod from "../logger.js";
import { _internalsForTesting as rateLimiterInternals } from "../middleware/rate-limiter.js";

let activeServer: Server | null = null;
let baseUrl = "";
const originalTrustProxy = config.trustProxy;

/** Builds a fresh, fully-wired app without binding a port (for tests that don't need real HTTP). */
function buildApp(): Express {
  __resetDbForTesting();
  __resetLeaderFlagForTesting();
  return createApp().app;
}

/** Builds a fresh app AND binds it to a real loopback port, for header/HTTP-level assertions. */
async function startApp(): Promise<Express> {
  const app = buildApp();
  (config as Record<string, unknown>).adminApiKeys = ["test-admin-key"];
  (config as Record<string, unknown>).authDisabled = false;
  await new Promise<void>((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      activeServer = srv;
      resolve();
    });
    srv.on("error", reject);
  });
  return app;
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (activeServer) {
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

afterEach(async () => {
  await stopServer();
  (config as Record<string, unknown>).trustProxy = originalTrustProxy;
});

describe("createApp() return shape", () => {
  test("returns both `app` and a callable `cleanupTransports`", () => {
    __resetDbForTesting();
    __resetLeaderFlagForTesting();
    const { app, cleanupTransports } = createApp();
    expect(typeof app.listen).toBe("function");
    expect(typeof cleanupTransports).toBe("function");
    // Sanity: calling it must not throw for a session-less app.
    expect(() => cleanupTransports()).not.toThrow();
  });
});

describe("trust proxy wiring", () => {
  test("truthy boolean: app.set receives it, and the TRUST_PROXY warn log fires exactly once", async () => {
    (config as Record<string, unknown>).trustProxy = true;
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      const app = await startApp();
      expect(app.get("trust proxy")).toBe(true);
      const warnCalls = logSpy.mock.calls.filter(
        (c) => c[0] === "warn" && typeof c[1] === "string" && c[1].includes("TRUST_PROXY"),
      );
      expect(warnCalls.length).toBe(1);
      expect(warnCalls[0]?.[1]).toContain("TRUST_PROXY is enabled");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("numeric hop-count values pass through unchanged and still warn", async () => {
    (config as Record<string, unknown>).trustProxy = 2;
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      const app = await startApp();
      expect(app.get("trust proxy")).toBe(2);
      const warnCalls = logSpy.mock.calls.filter(
        (c) => c[0] === "warn" && typeof c[1] === "string" && c[1].includes("TRUST_PROXY"),
      );
      expect(warnCalls.length).toBe(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("false disables proxy trust and suppresses the warn log", async () => {
    (config as Record<string, unknown>).trustProxy = false;
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      const app = await startApp();
      expect(app.get("trust proxy")).toBe(false);
      const warnCalls = logSpy.mock.calls.filter(
        (c) => c[0] === "warn" && typeof c[1] === "string" && c[1].includes("TRUST_PROXY"),
      );
      expect(warnCalls.length).toBe(0);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('body-parser wiring: express.json({ limit: "64kb", strict: true })', () => {
  // Both assertions target an intentionally-unregistered path: nothing in
  // createApp() defines a route for it, so if the body ever reaches the
  // router unmolested, the request falls through to Express's default
  // "no route matched" handling (404) — a clean, route-independent signal
  // that lets us tell "body-parser rejected this" apart from "body-parser
  // accepted this and it just didn't match anything".
  const unknownPath = "/__no_such_route_for_mutation_test__";

  test("the configured 64kb limit is enforced, not body-parser's 100kb default", async () => {
    await startApp();
    // 64kb = 65536 bytes; 100kb = 102400 bytes. ~70000 bytes sits strictly
    // between the two, so only the *configured* (smaller) limit rejects it.
    const bigValue = "x".repeat(70_000);
    const res = await fetch(`${baseUrl}${unknownPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: bigValue }),
    });
    expect(res.status).toBe(413);
  });

  test("strict mode rejects a bare top-level JSON primitive (400), it isn't silently parsed through", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}${unknownPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '"just-a-bare-string"',
    });
    expect(res.status).toBe(400);
  });
});

describe("baseline security headers — exact values", () => {
  test("X-Powered-By is disabled", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/livez`);
    expect(res.headers.get("X-Powered-By")).toBeNull();
  });

  test("every static header on a plain response matches the exact configured value", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/livez`);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "base-uri 'none'",
        "object-src 'none'",
      ].join("; "),
    );
    expect(res.headers.get("Permissions-Policy")).toBe(
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    );
  });

  test("HSTS is absent on a plain (non-forwarded-https) request", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/livez`);
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });

  test("HSTS appears with the exact value when X-Forwarded-Proto is https", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/livez`, { headers: { "X-Forwarded-Proto": "https" } });
    expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
  });

  test("HSTS stays absent when X-Forwarded-Proto is present but not exactly 'https'", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/livez`, { headers: { "X-Forwarded-Proto": "http" } });
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });
});

// ─── Error-envelope request_id (finding #52) ─────────────────────────────────
//
// requestIdMiddleware is now the FIRST middleware, so the two error responses
// that write their own body and never reach the global handler — JSON-depth's
// 400 and the global rate-limit's 429 — are wrapped so they still carry the
// request_id (via withRequestIdError). The body-parser's own errors reach the
// global handler with res.locals.requestId already set, so those carry it too.

describe("error-envelope request_id", () => {
  // Any path works — these middlewares run before routing, so the request never
  // needs to match a real route.
  const probePath = "/__envelope_probe__";

  test("400 JSON_TOO_DEEP body carries the request_id", async () => {
    await startApp();
    let payload: unknown = { leaf: true };
    for (let i = 0; i < config.maxJsonDepth + 5; i++) payload = { nested: payload };
    const res = await fetch(`${baseUrl}${probePath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": "depth-req-id" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; request_id: string } };
    expect(body.error.code).toBe("JSON_TOO_DEEP");
    expect(body.error.request_id).toBe("depth-req-id");
  });

  test("429 RATE_LIMITED body carries the request_id and keeps its retry_after", async () => {
    const originalGlobal = config.rateLimitGlobal;
    (config as Record<string, unknown>).rateLimitGlobal = 1;
    rateLimiterInternals.globalBuckets.clear();
    try {
      await startApp(); // captures the limit of 1 in the rateLimitGlobal closure
      const first = await fetch(`${baseUrl}/livez`);
      expect(first.status).toBe(200); // consumes the single token
      const res = await fetch(`${baseUrl}/livez`, { headers: { "X-Request-ID": "rl-req-id" } });
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: { code: string; request_id: string; retry_after?: number } };
      expect(body.error.code).toBe("RATE_LIMITED");
      expect(body.error.request_id).toBe("rl-req-id");
      expect(typeof body.error.retry_after).toBe("number");
    } finally {
      (config as Record<string, unknown>).rateLimitGlobal = originalGlobal;
      rateLimiterInternals.globalBuckets.clear();
    }
  });

  test("a malformed-JSON 400 (via the global error handler) now carries the request_id after the reorder", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}${probePath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": "malformed-req-id" },
      body: '{"a":}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { request_id: string | null } };
    expect(body.error.request_id).toBe("malformed-req-id");
  });

  test("a normal 200 JSON response is left untouched by the backfill wrapper (res.json restored, no error field injected)", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/livez`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect("error" in body).toBe(false);
    expect(body.status).toBe("alive");
  });
});

// ─── Global error handler — direct middleware invocation ─────────────────────
//
// The handler is an inline `app.use((err, req, res, next) => ...)` at the end
// of createApp(); it's never exported. We recover it by walking the app's
// internal Express router stack for the one 4-arg (error-handling) layer,
// then call it directly with a synthetic req/res/next. This is the only way
// to reach the `res.headersSent` branch: every real route in this app sends
// its full response head+body atomically, so nothing can throw after
// `headersSent` is already true.

interface FakeRouterLayer {
  handle: {
    (...args: unknown[]): void;
    length: number;
  };
}

function getErrorHandler(app: Express): (err: unknown, req: unknown, res: unknown, next: unknown) => void {
  const routerLike = (app as unknown as { router: { stack: FakeRouterLayer[] } }).router;
  const matches = routerLike.stack.filter((layer) => layer.handle.length === 4);
  if (matches.length === 0) {
    throw new Error("createApp() wiring regression: no 4-arg error-handling middleware found on the app stack");
  }
  // Take the last one — the global handler is mounted after every router, so
  // it's the last 4-arg layer in registration order.
  return matches[matches.length - 1]!.handle;
}

interface FakeResState {
  statusCode: number | null;
  jsonBody: unknown;
  headers: Record<string, string>;
}

interface ErrorEnvelope {
  error: { code: string; message: string; request_id: string | null };
}

function makeFakeRes(headersSent: boolean, requestId: string | undefined): { res: unknown; state: FakeResState } {
  const state: FakeResState = { statusCode: null, jsonBody: null, headers: {} };
  const res: Record<string, unknown> = {
    headersSent,
    locals: { requestId },
    setHeader(key: string, value: string) {
      state.headers[key] = value;
    },
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(body: unknown) {
      state.jsonBody = body;
      return res;
    },
  };
  return { res, state };
}

describe("global error handler — headersSent short-circuit", () => {
  test("forwards to next(err) and never touches res.status/json when headers were already sent", () => {
    const handler = getErrorHandler(buildApp());
    const err = new Error("late failure after partial write");
    const { res, state } = makeFakeRes(true, "req-1");
    let nextArg: unknown = "SENTINEL_NOT_CALLED";
    handler(err, {}, res, (e: unknown) => {
      nextArg = e;
    });
    expect(nextArg).toBe(err);
    expect(state.statusCode).toBeNull();
    expect(state.jsonBody).toBeNull();
  });
});

describe("global error handler — status/code/message resolution", () => {
  test("a plain Error with no status/statusCode/code defaults to 500 INTERNAL_ERROR with a generic message", () => {
    const handler = getErrorHandler(buildApp());
    const err = new Error("some internal detail that must not leak to the client");
    const { res, state } = makeFakeRes(false, "req-2");
    handler(err, {}, res, () => {});
    expect(state.statusCode).toBe(500);
    expect(state.jsonBody).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error", request_id: "req-2" },
    });
    expect(state.headers["Content-Type"]).toBe("application/json");
  });

  test("err.status wins over err.statusCode when both are present", () => {
    const handler = getErrorHandler(buildApp());
    const err = { status: 400, statusCode: 403, code: "BAD_INPUT", message: "short message" };
    const { res, state } = makeFakeRes(false, "req-3");
    handler(err, {}, res, () => {});
    expect(state.statusCode).toBe(400);
    expect((state.jsonBody as ErrorEnvelope).error.code).toBe("BAD_INPUT");
    expect((state.jsonBody as ErrorEnvelope).error.message).toBe("short message");
  });

  test("err.statusCode is used when err.status is absent, and missing code/message fall back to BAD_REQUEST/'Bad request'", () => {
    const handler = getErrorHandler(buildApp());
    const err = { statusCode: 403 };
    const { res, state } = makeFakeRes(false, "req-4");
    handler(err, {}, res, () => {});
    expect(state.statusCode).toBe(403);
    expect((state.jsonBody as ErrorEnvelope).error.code).toBe("BAD_REQUEST");
    expect((state.jsonBody as ErrorEnvelope).error.message).toBe("Bad request");
  });

  test("err.statusCode must genuinely be a `number` — a numeric-looking string is ignored and status defaults to 500", () => {
    const handler = getErrorHandler(buildApp());
    // No `status` field, and `statusCode` is a STRING that looks numeric.
    // `typeof errObj.statusCode === "number"` must be false here, so this
    // must fall all the way through to the 500 default, not be coerced.
    const err = { statusCode: "450" };
    const { res, state } = makeFakeRes(false, "req-4b");
    handler(err, {}, res, () => {});
    expect(state.statusCode).toBe(500);
  });

  test("status is clamped to 500 whenever it falls outside 400-599", () => {
    const handler = getErrorHandler(buildApp());
    for (const bad of [399, 600, -1, 0, 3.5]) {
      const { res, state } = makeFakeRes(false, "req-clamp");
      handler({ status: bad }, {}, res, () => {});
      expect(state.statusCode).toBe(500);
    }
  });

  test("400 and 599 are the exact valid boundary values and are kept unclamped", () => {
    const handler = getErrorHandler(buildApp());
    {
      const { res, state } = makeFakeRes(false, "req-b1");
      handler({ status: 400 }, {}, res, () => {});
      expect(state.statusCode).toBe(400);
    }
    {
      const { res, state } = makeFakeRes(false, "req-b2");
      handler({ status: 599 }, {}, res, () => {});
      expect(state.statusCode).toBe(599);
    }
  });

  test("is5xx forces the generic message at exactly the 500 boundary, regardless of any supplied message", () => {
    const handler = getErrorHandler(buildApp());
    const { res, state } = makeFakeRes(false, "req-5");
    handler({ status: 500, message: "should be hidden from the client" }, {}, res, () => {});
    expect((state.jsonBody as ErrorEnvelope).error.message).toBe("Internal server error");
  });

  test("a valid string err.code always wins over the tier default, even at 5xx", () => {
    const handler = getErrorHandler(buildApp());
    const { res, state } = makeFakeRes(false, "req-5b");
    handler({ status: 500, code: "CUSTOM_5XX_CODE" }, {}, res, () => {});
    expect((state.jsonBody as ErrorEnvelope).error.code).toBe("CUSTOM_5XX_CODE");
  });

  test("499 is just below the 5xx boundary: caller-supplied code/message pass through untouched", () => {
    const handler = getErrorHandler(buildApp());
    const { res, state } = makeFakeRes(false, "req-6");
    handler({ status: 499, code: "MY_CODE", message: "my message" }, {}, res, () => {});
    expect((state.jsonBody as ErrorEnvelope).error.code).toBe("MY_CODE");
    expect((state.jsonBody as ErrorEnvelope).error.message).toBe("my message");
  });

  test("a non-string err.code (truthy but wrong type) falls back to the tier default", () => {
    const handler = getErrorHandler(buildApp());
    const { res, state } = makeFakeRes(false, "req-7");
    handler({ status: 400, code: 12345 }, {}, res, () => {});
    expect((state.jsonBody as ErrorEnvelope).error.code).toBe("BAD_REQUEST");
  });

  test("a non-string err.message (non-5xx, truthy but wrong type) falls back to 'Bad request'", () => {
    const handler = getErrorHandler(buildApp());
    const { res, state } = makeFakeRes(false, "req-8");
    handler({ status: 400, message: 12345 }, {}, res, () => {});
    expect((state.jsonBody as ErrorEnvelope).error.message).toBe("Bad request");
  });

  test("message length boundary: 499 chars pass through, exactly 500 chars fall back to 'Bad request'", () => {
    const handler = getErrorHandler(buildApp());
    {
      const { res, state } = makeFakeRes(false, "req-9a");
      handler({ status: 400, message: "a".repeat(499) }, {}, res, () => {});
      expect((state.jsonBody as ErrorEnvelope).error.message).toBe("a".repeat(499));
    }
    {
      const { res, state } = makeFakeRes(false, "req-9b");
      handler({ status: 400, message: "a".repeat(500) }, {}, res, () => {});
      expect((state.jsonBody as ErrorEnvelope).error.message).toBe("Bad request");
    }
  });

  test("a real Error instance's own .message is used (non-5xx), respecting the same length boundary", () => {
    const handler = getErrorHandler(buildApp());
    const err = Object.assign(new Error("boom-message"), { status: 400 });
    const { res, state } = makeFakeRes(false, "req-10");
    handler(err, {}, res, () => {});
    expect((state.jsonBody as ErrorEnvelope).error.message).toBe("boom-message");
  });

  test("request_id: `??` keeps an empty string, only null/undefined fall back to null", () => {
    const handler = getErrorHandler(buildApp());
    {
      const { res, state } = makeFakeRes(false, "");
      handler(new Error("x"), {}, res, () => {});
      expect((state.jsonBody as ErrorEnvelope).error.request_id).toBe("");
    }
    {
      const { res, state } = makeFakeRes(false, undefined);
      handler(new Error("x"), {}, res, () => {});
      expect((state.jsonBody as ErrorEnvelope).error.request_id).toBeNull();
    }
  });
});

describe("global error handler — logging", () => {
  test("logs an Error's message/stack/name under `err`, keyed with the request id", () => {
    const handler = getErrorHandler(buildApp());
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      const err = new Error("logged-message");
      const { res } = makeFakeRes(false, "req-log-1");
      handler(err, {}, res, () => {});
      const call = logSpy.mock.calls.find((c) => c[1] === "Unhandled request error");
      expect(call).toBeDefined();
      expect(call?.[0]).toBe("error");
      const meta = call?.[2] as { request_id?: string; err?: { message: string; name: string } };
      expect(meta.request_id).toBe("req-log-1");
      expect(meta.err?.message).toBe("logged-message");
      expect(meta.err?.name).toBe("Error");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("logs a non-Error err value as-is (no message/stack/name unwrapping)", () => {
    const handler = getErrorHandler(buildApp());
    const logSpy = spyOn(loggerMod, "log").mockImplementation(() => {});
    try {
      const rawErr = { weird: "shape", status: 400 };
      const { res } = makeFakeRes(false, "req-log-2");
      handler(rawErr, {}, res, () => {});
      const call = logSpy.mock.calls.find((c) => c[1] === "Unhandled request error");
      expect(call).toBeDefined();
      expect(call?.[0]).toBe("error");
      const meta = call?.[2] as { err?: unknown };
      expect(meta.err).toEqual(rawErr);
    } finally {
      logSpy.mockRestore();
    }
  });
});

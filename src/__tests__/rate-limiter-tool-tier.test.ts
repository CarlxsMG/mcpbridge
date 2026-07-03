import { describe, test, expect } from "bun:test";
import type { Response } from "express";
import { checkRateLimit, checkToolRateLimit, _internalsForTesting } from "../middleware/rate-limiter.js";

const { checkLimit, toolBuckets } = _internalsForTesting;

function freshMap(): Map<string, { tokens: number[] }> {
  return new Map();
}

// ---------------------------------------------------------------------------
// checkRateLimit — pure function (no Response dependency)
// ---------------------------------------------------------------------------

describe("checkRateLimit — pure sliding-window check", () => {
  test("allows requests under the limit", () => {
    const map = freshMap();
    const r1 = checkRateLimit(map, 100, "k", 3, "test");
    const r2 = checkRateLimit(map, 100, "k", 3, "test");
    const r3 = checkRateLimit(map, 100, "k", 3, "test");
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
  });

  test("rejects the request that exceeds the limit and reports retryAfterSeconds", () => {
    const map = freshMap();
    checkRateLimit(map, 100, "k", 2, "test");
    checkRateLimit(map, 100, "k", 2, "test");
    const blocked = checkRateLimit(map, 100, "k", 2, "test");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  test("different keys have independent windows", () => {
    const map = freshMap();
    checkRateLimit(map, 100, "a", 1, "test");
    const bBucketFirstHit = checkRateLimit(map, 100, "b", 1, "test");
    expect(bBucketFirstHit.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkToolRateLimit — new "tool" tier, keyed by composite tool name
// ---------------------------------------------------------------------------

describe("checkToolRateLimit — per-tool guard tier", () => {
  test("uses the shared toolBuckets map, scoped by the composite tool key", () => {
    toolBuckets.clear();
    const key = "svc__do-thing";
    expect(checkToolRateLimit(key, 2).allowed).toBe(true);
    expect(checkToolRateLimit(key, 2).allowed).toBe(true);
    expect(checkToolRateLimit(key, 2).allowed).toBe(false);
    expect(toolBuckets.has(key)).toBe(true);
  });

  test("two different tools do not share a bucket", () => {
    toolBuckets.clear();
    checkToolRateLimit("svc__tool-a", 1);
    const other = checkToolRateLimit("svc__tool-b", 1);
    expect(other.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression — the Express-facing checkLimit() wrapper must produce byte-
// identical HTTP behaviour after being refactored to delegate to checkRateLimit.
// ---------------------------------------------------------------------------

function makeFakeRes(): { res: Response; headers: Record<string, string>; statusCode?: number; body?: unknown } {
  const state: { headers: Record<string, string>; statusCode?: number; body?: unknown } = { headers: {} };
  const res = {
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return res;
    },
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      return res;
    },
  } as unknown as Response;
  return {
    res,
    headers: state.headers,
    get statusCode() {
      return state.statusCode;
    },
    get body() {
      return state.body;
    },
  };
}

describe("checkLimit — Express wrapper regression (post-refactor)", () => {
  test("allowed request writes no response and returns true", () => {
    const map = freshMap();
    const fake = makeFakeRes();
    const allowed = checkLimit(map, 100, "k", 5, "test", fake.res);
    expect(allowed).toBe(true);
    expect(fake.statusCode).toBeUndefined();
  });

  test("blocked request sets Retry-After header, 429 status, and the RATE_LIMITED error envelope", () => {
    const map = freshMap();
    checkLimit(map, 100, "k", 1, "test", makeFakeRes().res);

    const fake = makeFakeRes();
    const allowed = checkLimit(map, 100, "k", 1, "test", fake.res);

    expect(allowed).toBe(false);
    expect(fake.statusCode).toBe(429);
    expect(fake.headers["Retry-After"]).toBeDefined();
    expect(Number(fake.headers["Retry-After"])).toBeGreaterThan(0);
    expect(fake.body).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests",
        retry_after: Number(fake.headers["Retry-After"]),
      },
    });
  });
});

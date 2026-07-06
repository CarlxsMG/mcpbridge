/**
 * TEST 6 — normalizeIp helper in rate-limiter.ts (indirect integration test)
 *
 * normalizeIp is not exported, so we test it indirectly:
 * two requests with the mapped and unmapped forms of the same IP must
 * share a rate-limit bucket (both count toward the same limit).
 *
 * Cases:
 *   - ::ffff:1.2.3.4 and 1.2.3.4 → same bucket
 *   - 2001:DB8::1%eth0 and 2001:db8::1 → same bucket (lowercase + zone strip)
 *   - undefined / empty → "unknown" bucket
 */
import { describe, test, expect } from "bun:test";
import type { Request, Response, NextFunction } from "express";
import { _internalsForTesting } from "../../middleware/rate-limiter.js";

const { registerBuckets } = _internalsForTesting;

// ---------------------------------------------------------------------------
// Helpers — build lightweight Express-like mocks
// ---------------------------------------------------------------------------

function makeReq(ip: string | undefined): Request {
  return {
    ip,
    socket: { remoteAddress: ip },
    headers: {},
  } as unknown as Request;
}

interface MockRes {
  _status?: number;
  _body?: unknown;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
  setHeader(name: string, value: string): MockRes;
}

function makeRes(): MockRes {
  const r: MockRes = {
    status(code) {
      this._status = code;
      return this;
    },
    json(body) {
      this._body = body;
      return this;
    },
    setHeader() {
      return this;
    },
  };
  return r;
}

function nextFn(): { called: boolean; fn: NextFunction } {
  const state = { called: false, fn: null as unknown as NextFunction };
  state.fn = () => {
    state.called = true;
  };
  return state;
}

// Import the register rate-limiter factory (uses normalizeIp internally)
import { rateLimitRegister } from "../../middleware/rate-limiter.js";

/**
 * Fire `count` requests from `ip` through the register rate-limiter
 * using a very high per-minute limit so we never hit the rate cap.
 * Returns true if all next() were called (no rate-limit block).
 */
function fireRequests(ip: string | undefined, count: number, limitPerMin = 10_000): boolean {
  const mw = rateLimitRegister(limitPerMin);
  for (let i = 0; i < count; i++) {
    const next = nextFn();
    mw(makeReq(ip), makeRes() as unknown as Response, next.fn);
    if (!next.called) return false; // rate-limited unexpectedly
  }
  return true;
}

// ---------------------------------------------------------------------------
// TEST 6a: ::ffff:1.2.3.4 and 1.2.3.4 share the same bucket
// ---------------------------------------------------------------------------

describe("normalizeIp (indirect) — ::ffff:IPv4 and bare IPv4 share a bucket", () => {
  test("tokens from ::ffff:1.2.3.4 and 1.2.3.4 count toward the same rate-limit bucket", async () => {
    // Set rate limit to exactly 3 requests per minute
    const LIMIT = 3;
    const mw = rateLimitRegister(LIMIT);

    // Clear any existing state by using a unique IP not used elsewhere
    const mapped = "::ffff:9.9.9.9";
    const bare = "9.9.9.9";

    let passedCount = 0;
    const results: boolean[] = [];

    // Send LIMIT requests via the mapped form
    for (let i = 0; i < LIMIT; i++) {
      const next = nextFn();
      mw(makeReq(mapped), makeRes() as unknown as Response, next.fn);
      if (next.called) passedCount++;
      results.push(next.called);
    }

    // Now send one more via the bare form — should be rate-limited if they share a bucket
    const extra = nextFn();
    mw(makeReq(bare), makeRes() as unknown as Response, extra.fn);

    // The first LIMIT requests via mapped form must have passed
    expect(passedCount).toBe(LIMIT);
    // The extra request via bare form must be blocked (shared bucket)
    expect(extra.called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TEST 6b: 2001:DB8::1%eth0 and 2001:db8::1 share the same bucket
// ---------------------------------------------------------------------------

describe("normalizeIp (indirect) — zone-ID stripped + lowercased IPv6 shares a bucket", () => {
  test("tokens from 2001:DB8::1%eth0 and 2001:db8::1 count toward the same bucket", async () => {
    const LIMIT = 2;
    const mw = rateLimitRegister(LIMIT);

    const withZone = "2001:DB8::cafe%eth0";
    const normalised = "2001:db8::cafe";

    let passedCount = 0;

    // Fill the bucket via the zone-id / uppercase form
    for (let i = 0; i < LIMIT; i++) {
      const next = nextFn();
      mw(makeReq(withZone), makeRes() as unknown as Response, next.fn);
      if (next.called) passedCount++;
    }

    // Try the normalised form — should be blocked
    const extra = nextFn();
    mw(makeReq(normalised), makeRes() as unknown as Response, extra.fn);

    expect(passedCount).toBe(LIMIT);
    expect(extra.called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TEST 6c: undefined and empty string → 'unknown' bucket
// ---------------------------------------------------------------------------

describe("normalizeIp (indirect) — undefined IP maps to 'unknown' bucket", () => {
  test("requests with undefined IP are bucketed as 'unknown' and share a bucket", async () => {
    const LIMIT = 2;
    const mw = rateLimitRegister(LIMIT);

    let passedUndefined = 0;

    // Send LIMIT requests with undefined IP
    for (let i = 0; i < LIMIT; i++) {
      const next = nextFn();
      mw(makeReq(undefined), makeRes() as unknown as Response, next.fn);
      if (next.called) passedUndefined++;
    }

    // One more — should be blocked (same 'unknown' bucket)
    const extra = nextFn();
    mw(makeReq(undefined), makeRes() as unknown as Response, extra.fn);

    expect(passedUndefined).toBe(LIMIT);
    expect(extra.called).toBe(false);
  });
});

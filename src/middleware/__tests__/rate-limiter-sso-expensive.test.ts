/**
 * Rate-limiter — the `sso` and `expensive` tiers.
 *
 * Both were added because CodeQL's "Missing rate limiting" alerts on
 * auth-oidc.ts, auth.ts and admin/audit-log.ts survived triage as real gaps
 * rather than false positives: those routes were bounded only by the coarse
 * global limit (one bucket shared by every route, 1000/min), which is orders of
 * magnitude too loose for an unauthenticated endpoint that makes outbound IdP
 * requests, an argon2id verify+hash, or a full audit-chain rehash.
 *
 * These are middleware-level tests — they exercise the limiter directly with a
 * fake req/res rather than booting an app, so they pin the two properties that
 * actually matter and can't be read off the route wiring: the per-IP keying,
 * and (for `expensive`) that each routeTag gets an INDEPENDENT budget.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import type { Request, Response } from "express";
import { rateLimitSso, rateLimitExpensive, _internalsForTesting } from "../rate-limiter.js";

interface FakeRes {
  statusCode: number | null;
  headers: Record<string, string>;
  body: unknown;
  setHeader(name: string, value: string): void;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(name, value) {
      res.headers[name] = value;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

/** Runs `mw` once for `ip` and reports whether next() was reached. */
function call(mw: ReturnType<typeof rateLimitSso>, ip: string): { allowed: boolean; res: FakeRes } {
  const res = fakeRes();
  let allowed = false;
  const req = { ip, socket: {}, headers: {} } as unknown as Request;
  mw(req, res as unknown as Response, () => {
    allowed = true;
  });
  return { allowed, res };
}

beforeEach(() => {
  _internalsForTesting.ssoBuckets.clear();
  _internalsForTesting.expensiveBuckets.clear();
});

describe("rateLimitSso — public OIDC endpoints", () => {
  test("allows up to the limit, then 429s with Retry-After", () => {
    const mw = rateLimitSso(3);
    expect(call(mw, "10.0.0.1").allowed).toBe(true);
    expect(call(mw, "10.0.0.1").allowed).toBe(true);
    expect(call(mw, "10.0.0.1").allowed).toBe(true);

    const fourth = call(mw, "10.0.0.1");
    expect(fourth.allowed).toBe(false);
    expect(fourth.res.statusCode).toBe(429);
    expect(fourth.res.headers["Retry-After"]).toBeDefined();
    expect(fourth.res.body).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });

  test("buckets are per-IP — one caller exhausting its budget does not block another", () => {
    const mw = rateLimitSso(1);
    expect(call(mw, "10.0.0.1").allowed).toBe(true);
    expect(call(mw, "10.0.0.1").allowed).toBe(false);
    // A different source IP still has its full allowance.
    expect(call(mw, "10.0.0.2").allowed).toBe(true);
  });
});

describe("rateLimitExpensive — per-route budgets", () => {
  test("allows up to the limit for a given routeTag, then 429s", () => {
    const mw = rateLimitExpensive("audit_verify", 2);
    expect(call(mw, "10.0.0.1").allowed).toBe(true);
    expect(call(mw, "10.0.0.1").allowed).toBe(true);

    const third = call(mw, "10.0.0.1");
    expect(third.allowed).toBe(false);
    expect(third.res.statusCode).toBe(429);
  });

  // The reason this tier takes a routeTag at all. If the key were IP-only, the
  // three routes sharing this tier would share one budget and a caller
  // exporting the audit log could lock itself out of changing its password.
  test("each routeTag has an independent budget for the same IP", () => {
    const verify = rateLimitExpensive("audit_verify", 1);
    const exportLog = rateLimitExpensive("audit_export", 1);
    const password = rateLimitExpensive("password_change", 1);

    expect(call(verify, "10.0.0.1").allowed).toBe(true);
    expect(call(verify, "10.0.0.1").allowed).toBe(false); // that tag is spent

    // ...but the other two tags are untouched.
    expect(call(exportLog, "10.0.0.1").allowed).toBe(true);
    expect(call(password, "10.0.0.1").allowed).toBe(true);
  });

  test("the same routeTag from a different IP is a different bucket", () => {
    const mw = rateLimitExpensive("password_change", 1);
    expect(call(mw, "10.0.0.1").allowed).toBe(true);
    expect(call(mw, "10.0.0.1").allowed).toBe(false);
    expect(call(mw, "10.0.0.2").allowed).toBe(true);
  });
});

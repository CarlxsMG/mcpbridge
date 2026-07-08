/**
 * Stryker mutation-testing backstop for src/middleware/origin-validator.ts's
 * `isOriginAllowed` — 14:10-14:118 MethodExpression [Survived]
 * (`config.allowedOrigins.some(...)` flipped to `.every(...)`). Every
 * existing test uses a single-entry allowlist, which can't distinguish
 * `some` from `every` (both agree when there's only one entry to check).
 */
import { test, expect } from "bun:test";
import type { Request, Response, NextFunction } from "express";
import { isOriginAllowed, originValidator } from "../../middleware/origin-validator.js";
import { config } from "../../config.js";

test("an origin matching only ONE of several allowlist entries is still allowed (some, not every)", () => {
  const orig = config.allowedOrigins;
  (config as Record<string, unknown>).allowedOrigins = [
    "http://only-this-one-matches.example.com",
    "http://a-completely-different-origin.example.net",
  ];
  try {
    expect(isOriginAllowed("http://only-this-one-matches.example.com", undefined)).toBe(true);
  } finally {
    (config as Record<string, unknown>).allowedOrigins = orig;
  }
});

// 30:40-30:60 StringLiteral [Survived] ("Origin not allowed" emptied). A
// PRESENT-but-disallowed Origin must get this exact message, distinct from
// the missing-Origin-header message at line 27.
test("a present but disallowed Origin gets the exact 'Origin not allowed' message", () => {
  const orig = config.allowedOrigins;
  (config as Record<string, unknown>).allowedOrigins = ["http://allowed.example.com"];
  try {
    const req = { headers: { origin: "http://evil.example.com" } } as unknown as Request;
    const res = {
      _status: undefined as number | undefined,
      _body: undefined as unknown,
      status(code: number) {
        this._status = code;
        return this;
      },
      json(body: unknown) {
        this._body = body;
        return this;
      },
    };
    const next: NextFunction = () => {
      throw new Error("next() should not be called");
    };
    originValidator(req, res as unknown as Response, next);
    expect(res._status).toBe(403);
    const body = res._body as { error?: { message?: string } };
    expect(body.error?.message).toBe("Origin not allowed");
  } finally {
    (config as Record<string, unknown>).allowedOrigins = orig;
  }
});

// 26:7-26:14 ConditionalExpression [Survived] (`if (!origin)` forced
// always-false). A browser request with NO Origin header at all (but
// Sec-Fetch-Site present, so still disallowed) must get the "header
// required" message, distinct from the present-but-disallowed message
// above. origin-validator-envelope.test.ts's TEST 8b covers this scenario
// but only asserts `typeof message === "string"`, not the exact text.
test("a browser request with no Origin header at all gets the exact 'Origin header required' message", () => {
  const req = { headers: { "sec-fetch-site": "cross-site" } } as unknown as Request;
  const res = {
    _status: undefined as number | undefined,
    _body: undefined as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._body = body;
      return this;
    },
  };
  const next: NextFunction = () => {
    throw new Error("next() should not be called");
  };
  originValidator(req, res as unknown as Response, next);
  expect(res._status).toBe(403);
  const body = res._body as { error?: { message?: string } };
  expect(body.error?.message).toBe("Origin header required for browser requests");
});

// 14:86-14:116 ObjectLiteral [Survived] (`{ supportsPortWildcard: true }`
// emptied to `{}`). Unlike cors.ts, origin-validator.ts's allowlist DOES
// support the ":*" port-wildcard suffix — but every EXISTING test for that
// syntax exercises a locally-duplicated reimplementation of the matching
// logic (origin-validator.test.ts's own `matchOrigin`), never the real
// `isOriginAllowed`/`matchesOriginEntry` call path, so this option being
// silently dropped was never actually caught.
test("a ':*'-suffixed allowedOrigins entry actually matches via the real isOriginAllowed call path", () => {
  const orig = config.allowedOrigins;
  (config as Record<string, unknown>).allowedOrigins = ["http://localhost:*"];
  try {
    expect(isOriginAllowed("http://localhost:3000", undefined)).toBe(true);
  } finally {
    (config as Record<string, unknown>).allowedOrigins = orig;
  }
});

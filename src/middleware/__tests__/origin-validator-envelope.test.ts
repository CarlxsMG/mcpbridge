/**
 * TEST 8 — Origin validator canonical error envelope
 *
 * Verifies that when a request with a disallowed Origin is rejected, the
 * response body is the canonical envelope:
 *   { error: { code: "ORIGIN_NOT_ALLOWED", message: <string> } }
 * — not a raw string, not missing the code field.
 *
 * Both 403 paths are covered:
 *   1. Origin header present but not in allowedOrigins.
 *   2. No Origin header but Sec-Fetch-Site is present (browser same-site).
 */
import { describe, test, expect } from "bun:test";
import type { Request, Response, NextFunction } from "express";
import { originValidator } from "../../middleware/origin-validator.js";
import { config } from "../../config.js";

// ---------------------------------------------------------------------------
// Minimal mock helpers
// ---------------------------------------------------------------------------

function makeRes() {
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
  return res;
}

function makeNext(): { called: boolean; fn: NextFunction } {
  const state = { called: false, fn: null as unknown as NextFunction };
  state.fn = () => {
    state.called = true;
  };
  return state;
}

// ---------------------------------------------------------------------------
// TEST 8a: Disallowed Origin → 403 with canonical envelope
// ---------------------------------------------------------------------------

describe("originValidator — canonical envelope: disallowed Origin header", () => {
  test("response body is { error: { code: 'ORIGIN_NOT_ALLOWED', message: string } }", () => {
    // Ensure the allowedOrigins does NOT include our test origin
    const origAllowedOrigins = config.allowedOrigins;
    (config as Record<string, unknown>).allowedOrigins = ["http://allowed.example.com"];

    try {
      const req = {
        headers: {
          origin: "http://evil.example.com",
        },
      } as unknown as Request;

      const res = makeRes();
      const next = makeNext();

      originValidator(req, res as unknown as Response, next.fn);

      // Must not call next
      expect(next.called).toBe(false);
      // Must respond with 403
      expect(res._status).toBe(403);
      // Body must be an object (not a string)
      expect(typeof res._body).toBe("object");
      expect(res._body).not.toBeNull();
      // Must have error.code
      const body = res._body as { error?: { code?: string; message?: unknown } };
      expect(body.error).toBeDefined();
      expect(body.error?.code).toBe("ORIGIN_NOT_ALLOWED");
      // message must be a string
      expect(typeof body.error?.message).toBe("string");
    } finally {
      (config as Record<string, unknown>).allowedOrigins = origAllowedOrigins;
    }
  });
});

// ---------------------------------------------------------------------------
// TEST 8b: Sec-Fetch-Site present without Origin → 403 with canonical envelope
// ---------------------------------------------------------------------------

describe("originValidator — canonical envelope: Sec-Fetch-Site without Origin", () => {
  test("browser request with Sec-Fetch-Site but no Origin returns canonical 403 envelope", () => {
    const req = {
      headers: {
        // No origin header
        "sec-fetch-site": "cross-site",
      },
    } as unknown as Request;

    const res = makeRes();
    const next = makeNext();

    originValidator(req, res as unknown as Response, next.fn);

    expect(next.called).toBe(false);
    expect(res._status).toBe(403);
    expect(typeof res._body).toBe("object");
    expect(res._body).not.toBeNull();
    const body = res._body as { error?: { code?: string; message?: unknown } };
    expect(body.error).toBeDefined();
    expect(body.error?.code).toBe("ORIGIN_NOT_ALLOWED");
    expect(typeof body.error?.message).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// TEST 8c: Allowed Origin → next() called, no 403
// ---------------------------------------------------------------------------

describe("originValidator — allowed Origin: next() is called", () => {
  test("allowed origin passes through and next() is called", () => {
    const origAllowedOrigins = config.allowedOrigins;
    (config as Record<string, unknown>).allowedOrigins = ["http://allowed.example.com"];

    try {
      const req = {
        headers: {
          origin: "http://allowed.example.com",
        },
      } as unknown as Request;

      const res = makeRes();
      const next = makeNext();

      originValidator(req, res as unknown as Response, next.fn);

      expect(next.called).toBe(true);
      expect(res._status).toBeUndefined();
    } finally {
      (config as Record<string, unknown>).allowedOrigins = origAllowedOrigins;
    }
  });
});

// ---------------------------------------------------------------------------
// TEST 8d: No Origin, no Sec-Fetch-Site → server-to-server, next() called
// ---------------------------------------------------------------------------

describe("originValidator — server-to-server: no headers, next() called", () => {
  test("request without Origin or Sec-Fetch-Site passes through (server-to-server)", () => {
    const req = {
      headers: {},
    } as unknown as Request;

    const res = makeRes();
    const next = makeNext();

    originValidator(req, res as unknown as Response, next.fn);

    expect(next.called).toBe(true);
    expect(res._status).toBeUndefined();
  });
});

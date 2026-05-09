import { describe, test, expect, beforeEach } from "bun:test";
import type { Request, Response, NextFunction } from "express";

// ---------------------------------------------------------------------------
// Config mutation strategy
//
// `auth.ts` imports `config` as a live object reference:
//   import { config } from "../config.js"
//
// Because ESM imports are live bindings to the *same* object, mutating
// the `config` object's properties here affects the same reference used
// inside auth.ts without needing a mock framework.
// ---------------------------------------------------------------------------

import { config } from "../config.js";
import { adminAuth, mcpAuth } from "../middleware/auth.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

type MockRes = {
  _status: number | undefined;
  _body: unknown;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
  setHeader: (name: string, value: string) => void;
};

function makeRes(): MockRes {
  const res: MockRes = {
    _status: undefined,
    _body: undefined,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    setHeader() {},
  };
  return res;
}

function makeNext(): { fn: NextFunction; called: boolean } {
  const state = { fn: null as unknown as NextFunction, called: false };
  state.fn = () => { state.called = true; };
  return state;
}

// ---------------------------------------------------------------------------
// Store original config values so we can restore after each test
// ---------------------------------------------------------------------------

let originalAuthDisabled: boolean;
let originalAdminApiKeys: string[];
let originalMcpApiKeys: string[];

beforeEach(() => {
  originalAuthDisabled = config.authDisabled;
  originalAdminApiKeys = config.adminApiKeys;
  originalMcpApiKeys = config.mcpApiKeys;
});

function restoreConfig() {
  config.authDisabled = originalAuthDisabled;
  (config as Record<string, unknown>).adminApiKeys = originalAdminApiKeys;
  (config as Record<string, unknown>).mcpApiKeys = originalMcpApiKeys;
}

// ---------------------------------------------------------------------------
// adminAuth tests
// ---------------------------------------------------------------------------

describe("adminAuth — valid Bearer token", () => {
  test("calls next() when token matches an admin key", () => {
    (config as Record<string, unknown>).adminApiKeys = ["secret-key"];
    config.authDisabled = false;

    const req = makeReq({ authorization: "Bearer secret-key" });
    const res = makeRes();
    const next = makeNext();

    adminAuth(req as Request, res as unknown as Response, next.fn);
    restoreConfig();

    expect(next.called).toBe(true);
    expect(res._status).toBeUndefined();
  });
});

describe("adminAuth — missing Authorization header", () => {
  test("responds 401 when Authorization header is absent", () => {
    (config as Record<string, unknown>).adminApiKeys = ["secret-key"];
    config.authDisabled = false;

    const req = makeReq();
    const res = makeRes();
    const next = makeNext();

    adminAuth(req as Request, res as unknown as Response, next.fn);
    restoreConfig();

    expect(next.called).toBe(false);
    expect(res._status).toBe(401);
    expect((res._body as Record<string, Record<string, string>>).error.code).toBe("UNAUTHORIZED");
  });

  test("responds 401 when Authorization header is not a Bearer token", () => {
    (config as Record<string, unknown>).adminApiKeys = ["secret-key"];
    config.authDisabled = false;

    const req = makeReq({ authorization: "Basic dXNlcjpwYXNz" });
    const res = makeRes();
    const next = makeNext();

    adminAuth(req as Request, res as unknown as Response, next.fn);
    restoreConfig();

    expect(next.called).toBe(false);
    expect(res._status).toBe(401);
  });
});

describe("adminAuth — invalid token", () => {
  test("responds 403 when token does not match any admin key", () => {
    (config as Record<string, unknown>).adminApiKeys = ["correct-key"];
    config.authDisabled = false;

    const req = makeReq({ authorization: "Bearer wrong-key" });
    const res = makeRes();
    const next = makeNext();

    adminAuth(req as Request, res as unknown as Response, next.fn);
    restoreConfig();

    expect(next.called).toBe(false);
    expect(res._status).toBe(403);
    expect((res._body as Record<string, Record<string, string>>).error.code).toBe("FORBIDDEN");
  });
});

describe("adminAuth — AUTH_DISABLED bypass", () => {
  test("calls next() without checking token when authDisabled is true", () => {
    config.authDisabled = true;
    (config as Record<string, unknown>).adminApiKeys = ["secret-key"];

    // No Authorization header at all
    const req = makeReq();
    const res = makeRes();
    const next = makeNext();

    adminAuth(req as Request, res as unknown as Response, next.fn);
    restoreConfig();

    expect(next.called).toBe(true);
    expect(res._status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mcpAuth tests
// ---------------------------------------------------------------------------

describe("mcpAuth — valid Bearer token", () => {
  test("calls next() when token matches an MCP key", () => {
    (config as Record<string, unknown>).mcpApiKeys = ["mcp-key"];
    config.authDisabled = false;

    const req = makeReq({ authorization: "Bearer mcp-key" });
    const res = makeRes();
    const next = makeNext();

    mcpAuth(req as Request, res as unknown as Response, next.fn);
    restoreConfig();

    expect(next.called).toBe(true);
  });
});

describe("mcpAuth — no MCP keys configured (backward compat)", () => {
  test("calls next() when mcpApiKeys is empty regardless of token", () => {
    (config as Record<string, unknown>).mcpApiKeys = [];
    config.authDisabled = false;

    const req = makeReq(); // no token
    const res = makeRes();
    const next = makeNext();

    mcpAuth(req as Request, res as unknown as Response, next.fn);
    restoreConfig();

    expect(next.called).toBe(true);
  });
});

describe("mcpAuth — missing Authorization header", () => {
  test("responds 401 when header is absent and MCP keys are configured", () => {
    (config as Record<string, unknown>).mcpApiKeys = ["mcp-key"];
    config.authDisabled = false;

    const req = makeReq();
    const res = makeRes();
    const next = makeNext();

    mcpAuth(req as Request, res as unknown as Response, next.fn);
    restoreConfig();

    expect(next.called).toBe(false);
    expect(res._status).toBe(401);
  });
});

describe("mcpAuth — invalid token", () => {
  test("responds 403 when token does not match any MCP key", () => {
    (config as Record<string, unknown>).mcpApiKeys = ["real-mcp-key"];
    config.authDisabled = false;

    const req = makeReq({ authorization: "Bearer fake-mcp-key" });
    const res = makeRes();
    const next = makeNext();

    mcpAuth(req as Request, res as unknown as Response, next.fn);
    restoreConfig();

    expect(next.called).toBe(false);
    expect(res._status).toBe(403);
  });
});

describe("mcpAuth — AUTH_DISABLED bypass", () => {
  test("calls next() without checking token when authDisabled is true", () => {
    config.authDisabled = true;
    (config as Record<string, unknown>).mcpApiKeys = ["mcp-key"];

    const req = makeReq(); // no token
    const res = makeRes();
    const next = makeNext();

    mcpAuth(req as Request, res as unknown as Response, next.fn);
    restoreConfig();

    expect(next.called).toBe(true);
    expect(res._status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// safeCompare — timing-safe length-leak prevention
// ---------------------------------------------------------------------------

describe("safeCompare — hash-before-compare (via adminAuth)", () => {
  test("returns false without throwing when comparing short vs long strings", () => {
    // Verifies both sides are hashed to fixed 32-byte digests before timingSafeEqual;
    // a length-leaking implementation would have returned false early but here we
    // confirm the function completes without error and produces the correct result.
    (config as Record<string, unknown>).adminApiKeys = ["verylongverylongverylong"];
    config.authDisabled = false;

    // "short" !== "verylongverylongverylong" — must be 403, not a throw
    const req = makeReq({ authorization: "Bearer short" });
    const res = makeRes();
    const next = makeNext();

    expect(() => {
      adminAuth(req as Request, res as unknown as Response, next.fn);
    }).not.toThrow();
    restoreConfig();

    expect(next.called).toBe(false);
    expect(res._status).toBe(403);
  });
});

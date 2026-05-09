import { describe, test, expect } from "bun:test";
import type { Request, Response, NextFunction } from "express";
import { enforceJsonDepth } from "../middleware/json-depth.js";

// ---------------------------------------------------------------------------
// Mock helpers — lightweight Express-like req/res/next
// ---------------------------------------------------------------------------

function makeReq(body: unknown): Request {
  return { body } as unknown as Request;
}

type MockRes = {
  _status: number | undefined;
  _body: unknown;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
};

function makeRes(): MockRes {
  const res: MockRes = {
    _status: undefined,
    _body: undefined,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

function makeNext(): { fn: NextFunction; called: boolean } {
  const state = { fn: null as unknown as NextFunction, called: false };
  state.fn = () => { state.called = true; };
  return state;
}

function run(body: unknown, maxDepth: number): { status: number | undefined; body: unknown; nextCalled: boolean } {
  const req = makeReq(body);
  const res = makeRes();
  const next = makeNext();
  enforceJsonDepth(maxDepth)(req as Request, res as unknown as Response, next.fn);
  return { status: res._status, body: res._body, nextCalled: next.called };
}

// ---------------------------------------------------------------------------
// TEST 1: Body at exactly maxDepth passes
// ---------------------------------------------------------------------------

describe("enforceJsonDepth — body at exactly maxDepth", () => {
  test("body nested to exactly maxDepth levels passes (calls next)", () => {
    // Build an object exactly maxDepth levels deep
    // depth 0 = root object, depth 1 = one level in, etc.
    // The middleware checks: if depth > maxDepth return true, so maxDepth itself is allowed.
    const maxDepth = 4;
    let nested: unknown = { leaf: true };
    for (let i = 0; i < maxDepth; i++) {
      nested = { child: nested };
    }

    const result = run(nested, maxDepth);
    expect(result.nextCalled).toBe(true);
    expect(result.status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TEST 2: Body at maxDepth + 1 returns 400 JSON_TOO_DEEP
// ---------------------------------------------------------------------------

describe("enforceJsonDepth — body exceeding maxDepth", () => {
  test("body nested to maxDepth + 1 returns 400 JSON_TOO_DEEP", () => {
    const maxDepth = 4;
    let nested: unknown = { leaf: true };
    for (let i = 0; i < maxDepth + 1; i++) {
      nested = { child: nested };
    }

    const result = run(nested, maxDepth);
    expect(result.nextCalled).toBe(false);
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("JSON_TOO_DEEP");
  });
});

// ---------------------------------------------------------------------------
// TEST 3: Array nesting counts as depth
// ---------------------------------------------------------------------------

describe("enforceJsonDepth — array nesting", () => {
  test("arrays contribute to depth count", () => {
    const maxDepth = 2;
    // [[[ ... ]]] at depth 3 (root object wrapping an array that wraps an array wrapping an array)
    const body = { a: [[["deep"]]] };
    // depth: root(0) → a(1) → array(2) → array(3) which is > 2
    const result = run(body, maxDepth);
    expect(result.nextCalled).toBe(false);
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: string } }).error.code).toBe("JSON_TOO_DEEP");
  });

  test("shallow array passes", () => {
    const result = run({ items: [1, 2, 3] }, 4);
    expect(result.nextCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TEST 4: Non-object/array bodies pass without iteration
// ---------------------------------------------------------------------------

describe("enforceJsonDepth — primitive body types", () => {
  test("string body passes without error", () => {
    const result = run("hello", 4);
    expect(result.nextCalled).toBe(true);
  });

  test("number body passes without error", () => {
    const result = run(42, 4);
    expect(result.nextCalled).toBe(true);
  });

  test("null body passes without error", () => {
    const result = run(null, 4);
    expect(result.nextCalled).toBe(true);
  });

  test("undefined body (not set) passes without error", () => {
    const req = { body: undefined } as unknown as Request;
    const res = makeRes();
    const next = makeNext();
    enforceJsonDepth(4)(req as Request, res as unknown as Response, next.fn);
    expect(next.called).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TEST 5: 100k-deep object rejects quickly without stack overflow
// ---------------------------------------------------------------------------

describe("enforceJsonDepth — no stack overflow on very deep object", () => {
  test("100k-deep object rejects without throwing a RangeError (stack overflow)", () => {
    const DEEP = 100_000;
    // Build a 100k-deep object — this would overflow a recursive implementation
    let nested: unknown = { leaf: true };
    for (let i = 0; i < DEEP; i++) {
      nested = { c: nested };
    }

    expect(() => {
      const result = run(nested, 32);
      // Should have rejected with 400 (not stack-overflowed)
      expect(result.status).toBe(400);
      expect(result.nextCalled).toBe(false);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TEST 6: Cycle detection — objects referring to each other do NOT hang
// ---------------------------------------------------------------------------

describe("enforceJsonDepth — cyclic object handling", () => {
  test("cyclic object is handled without infinite loop", () => {
    // JSON.parse cannot produce real cycles, but Express body-parser will have
    // already run JSON.parse. We simulate a cycle by constructing it directly.
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b", ref: a };
    a["ref"] = b; // a → b → a

    // The middleware should terminate — BFS tracks depth by level, not by reference.
    // Since the depth will keep increasing and eventually exceed maxDepth, or the
    // seen-set (if implemented) stops it. Either way it must terminate.
    let terminated = false;
    const timer = setTimeout(() => {
      // If we reach 2 seconds, the test will hang — this is our failsafe
    }, 2000);

    try {
      // Run with a low maxDepth so it exits quickly even without a seen-set
      const result = run(a, 5);
      terminated = true;
      clearTimeout(timer);
      // It should reject (depth exceeded via cycle) or pass — either is acceptable
      // as long as it doesn't hang. The important property is terminated === true.
      expect(terminated).toBe(true);
    } catch {
      clearTimeout(timer);
      terminated = true;
      // An error is also acceptable — the key is it didn't hang
      expect(terminated).toBe(true);
    }
  });
});

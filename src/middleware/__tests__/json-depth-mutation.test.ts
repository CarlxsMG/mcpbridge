/**
 * Stryker mutation-testing backstop for src/middleware/json-depth.ts — had
 * no dedicated test file at all.
 *
 * Documented equivalent (not chased further): 10:24-10:48 ConditionalExpression
 * (`typeof root !== "object"` forced `false`, leaving only the `root ===
 * null` early-return check active). Verified empirically (`bun -e`) across
 * every JS primitive type (number, string, boolean, NaN, Infinity, symbol,
 * function, bigint) — `Object.values()` on any of them returns either `[]`
 * or an array of further PRIMITIVE values, which the loop's own child-type
 * check (`typeof child === "object"`) already filters out, so the final
 * boolean result is identical either way. The ONE input that DOES diverge —
 * `undefined` as the root, where `Object.values(undefined)` throws — is
 * unreachable through the public API: `enforceJsonDepth` itself guards
 * `req.body !== undefined` before ever calling this function, and
 * `undefined` can never appear as a recursive `node` value either, since
 * the same child-type check that filters primitives also filters
 * `undefined` (it isn't `typeof "object"`).
 */
import { describe, test, expect } from "bun:test";
import type { Request, Response, NextFunction } from "express";
import { enforceJsonDepth } from "../../middleware/json-depth.js";

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

// 21:11-21:54 LogicalOperator [Survived] (`child !== null && typeof child
// === "object"` flipped to `||`) / 21:56-23:8 BlockStatement [Survived]
// (the queue.push(...) body emptied). A non-object primitive at the root
// must never be queued as a nested node (kills the `&&`->`||` flip), and a
// genuinely nested object must actually be queued and detected (kills the
// emptied push).
describe("enforceJsonDepth — exceedsDepth via the middleware", () => {
  function run(body: unknown, maxDepth: number): { status?: number; nextCalled: boolean } {
    const mw = enforceJsonDepth(maxDepth);
    const req = { body } as unknown as Request;
    const res = makeRes();
    const next = makeNext();
    mw(req, res as unknown as Response, next.fn);
    return { status: res._status, nextCalled: next.called };
  }

  test("an array of plain primitives at maxDepth=0 is NOT flagged (primitives are never queued as nodes)", () => {
    const result = run([1, 2, 3], 0);
    expect(result.nextCalled).toBe(true);
    expect(result.status).toBeUndefined();
  });

  test("a genuinely nested object exceeding maxDepth is actually detected via BFS", () => {
    const result = run({ a: { b: { c: 1 } } }, 1);
    expect(result.nextCalled).toBe(false);
    expect(result.status).toBe(400);
  });

  // 38:9-38:67 ConditionalExpression [Survived] (`if (req.body !== undefined
  // && exceedsDepth(...))` forced always-false — an over-deep body would
  // never be rejected).
  test("a body exceeding maxDepth is rejected with 400, not silently passed through", () => {
    const result = run({ a: { b: { c: { d: 1 } } } }, 2);
    expect(result.nextCalled).toBe(false);
    expect(result.status).toBe(400);
  });

  // 41:17-41:32 StringLiteral [Survived] ("JSON_TOO_DEEP" emptied).
  test("the rejection body carries the exact JSON_TOO_DEEP code and message", () => {
    const mw = enforceJsonDepth(1);
    const req = { body: { a: { b: { c: 1 } } } } as unknown as Request;
    const res = makeRes();
    const next = makeNext();
    mw(req, res as unknown as Response, next.fn);
    const body = res._body as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("JSON_TOO_DEEP");
    // 42:20-42:64 StringLiteral [Survived] (the exact message emptied).
    expect(body.error?.message).toBe("Request body exceeds maximum nesting depth");
  });

  // 10:7-10:48 LogicalOperator [Survived] (`root === null || typeof root
  // !== "object"` flipped to `&&`). A `null` body must short-circuit
  // BEFORE ever reaching `Object.values(root)` — `typeof null === "object"`
  // in JS, so under the `&&` mutant this guard never fires for null and
  // `Object.values(null)` throws.
  test("a null body is not flagged and does not throw (Object.values(null) would throw under the flipped operator)", () => {
    expect(() => run(null, 0)).not.toThrow();
    const result = run(null, 0);
    expect(result.nextCalled).toBe(true);
  });

  // 10:57-10:62 BooleanLiteral [Survived] (`return false` flipped to
  // `return true`). A plain non-object, non-null primitive body must NOT
  // be flagged as exceeding depth.
  test("a plain primitive body (not null, not an object) is not flagged", () => {
    const result = run(5, 0);
    expect(result.nextCalled).toBe(true);
    expect(result.status).toBeUndefined();
  });

  test("a body within maxDepth calls next() and never touches the response", () => {
    const result = run({ a: 1 }, 5);
    expect(result.nextCalled).toBe(true);
    expect(result.status).toBeUndefined();
  });

  test("req.body === undefined (no body parsed) always calls next()", () => {
    const result = run(undefined, 0);
    expect(result.nextCalled).toBe(true);
  });
});

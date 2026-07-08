/**
 * Stryker mutation-testing backstop for src/middleware/authz.ts — had no
 * dedicated test file at all (72/74 mutants already killed via indirect
 * route-level coverage; these 2 close the remaining gaps directly).
 */
import { describe, test, expect } from "bun:test";
import type { Request, Response, NextFunction } from "express";
import { callerTeamId, ensureClientAccess, requireOperator } from "../../middleware/authz.js";
import * as teamsMod from "../../admin/entities/teams.js";
import { spyOn } from "bun:test";

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

// 7:10-7:33 OptionalChaining [Survived] (`req.authContext?.method` with the
// `?.` removed — throws when req.authContext is undefined, the normal
// shape for a bearer caller).
describe("callerTeamId", () => {
  test("a bearer caller (no authContext at all) returns undefined instead of throwing", () => {
    const req = {} as unknown as Request;
    expect(() => callerTeamId(req)).not.toThrow();
    expect(callerTeamId(req)).toBeUndefined();
  });

  // 7:38-7:47 StringLiteral [Survived] ("session" emptied to ""). A real
  // session caller must actually resolve to its own teamId, not fall
  // through to undefined (which the OptionalChaining test above already
  // covers for a DIFFERENT input shape — this needs a genuine session
  // caller to distinguish "session" from "").
  test("a real session caller resolves to its own teamId, not undefined", () => {
    const req = { authContext: { method: "session", teamId: 42 } } as unknown as Request;
    expect(callerTeamId(req)).toBe(42);
  });
});

describe("ensureClientAccess", () => {
  // 20:37-20:55 StringLiteral [Survived] ("Client not found" emptied).
  test("a scoped caller denied access gets the exact 'Client not found' message", () => {
    const getTeamSpy = spyOn(teamsMod, "getClientTeam").mockReturnValue(2);
    const canAccessSpy = spyOn(teamsMod, "canAccessClient").mockReturnValue(false);
    try {
      const req = { authContext: { method: "session", teamId: 1 } } as unknown as Request;
      const res = makeRes();
      const result = ensureClientAccess(req, res as unknown as Response, "some-client");
      expect(result).toBe(false);
      expect(res._status).toBe(404);
      const body = res._body as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe("CLIENT_NOT_FOUND");
      expect(body.error?.message).toBe("Client not found");
    } finally {
      getTeamSpy.mockRestore();
      canAccessSpy.mockRestore();
    }
  });

  // 18:40-18:44 BooleanLiteral [Survived] (`if (clientTeam === undefined)
  // return true;` flipped to `return false;`). An UNKNOWN client must be
  // waved through (true, no response written) so the route's own 404
  // handles it normally — not treated as an access denial.
  test("an unknown client returns true and writes no response at all", () => {
    const getTeamSpy = spyOn(teamsMod, "getClientTeam").mockReturnValue(undefined);
    try {
      const req = { authContext: { method: "session", teamId: 1 } } as unknown as Request;
      const res = makeRes();
      const result = ensureClientAccess(req, res as unknown as Response, "no-such-client");
      expect(result).toBe(true);
      expect(res._status).toBeUndefined();
    } finally {
      getTeamSpy.mockRestore();
    }
  });

  // 19:7-19:53 ConditionalExpression [Survived] (`if
  // (canAccessClient(...)) return true;` forced always-false). A caller who
  // genuinely HAS access must actually be granted it, not denied.
  test("a caller with genuine access is granted it — no response written", () => {
    const getTeamSpy = spyOn(teamsMod, "getClientTeam").mockReturnValue(1);
    const canAccessSpy = spyOn(teamsMod, "canAccessClient").mockReturnValue(true);
    try {
      const req = { authContext: { method: "session", teamId: 1 } } as unknown as Request;
      const res = makeRes();
      const result = ensureClientAccess(req, res as unknown as Response, "some-client");
      expect(result).toBe(true);
      expect(res._status).toBeUndefined();
    } finally {
      getTeamSpy.mockRestore();
      canAccessSpy.mockRestore();
    }
  });
});

// 53:33-53:42 StringLiteral [Survived] ("session" emptied to ""). If this
// comparison is broken, a session-authenticated caller's role check is
// skipped entirely (`method === ""` is always false for a real session),
// so a viewer/auditor session would wrongly bypass the operator-role gate.
describe("requireOperator", () => {
  test("a session caller with the viewer role (lacking operator/admin) is rejected, not waved through", () => {
    const req = { authContext: { method: "session", role: "viewer" } } as unknown as Request;
    const res = makeRes();
    const next = makeNext();
    requireOperator(req, res as unknown as Response, next.fn);
    expect(next.called).toBe(false);
    expect(res._status).toBe(403);
    // 57:33-57:82 StringLiteral [Survived] (the exact rejection message
    // emptied).
    const body = res._body as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe("FORBIDDEN");
    expect(body.error?.message).toBe("This action requires the admin or operator role");
  });

  test("a session caller with the operator role passes through", () => {
    const req = { authContext: { method: "session", role: "operator" } } as unknown as Request;
    const res = makeRes();
    const next = makeNext();
    requireOperator(req, res as unknown as Response, next.fn);
    expect(next.called).toBe(true);
  });

  // 54:5-54:37 ConditionalExpression [Survived] (`req.authContext.role
  // !== "admin"` forced always-true). An admin session caller (higher
  // privilege than operator) must also pass through, not be rejected.
  test("a session caller with the admin role also passes through", () => {
    const req = { authContext: { method: "session", role: "admin" } } as unknown as Request;
    const res = makeRes();
    const next = makeNext();
    requireOperator(req, res as unknown as Response, next.fn);
    expect(next.called).toBe(true);
  });

  // 53:5-53:28 OptionalChaining [Survived] (`req.authContext?.method` with
  // the `?.` removed — throws when req.authContext is undefined, the
  // normal shape for a bearer caller, which must always pass unconditionally).
  test("a bearer caller (no authContext at all) passes through without throwing", () => {
    const req = {} as unknown as Request;
    const res = makeRes();
    const next = makeNext();
    expect(() => requireOperator(req, res as unknown as Response, next.fn)).not.toThrow();
    expect(next.called).toBe(true);
  });
});

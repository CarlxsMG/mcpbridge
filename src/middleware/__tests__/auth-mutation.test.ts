/**
 * Stryker mutation-testing backstop for src/middleware/auth.ts (admin auth,
 * MCP data-plane auth, and the /mcp control-plane's fail-closed root auth).
 * 152 mutants, 94.08% baseline (143/152) — surprisingly high given there is
 * NO dedicated test file for auth.ts at all; the existing coverage is
 * entirely INDIRECT, via routes tests exercising adminAuth through real
 * HTTP calls. That indirect coverage has a real gap: rootMcpAuth's actual
 * exercise lives in src/mcp/__tests__ (transports.test.ts,
 * transports-sharded.test.ts, mcp-server-mutation-s2.test.ts), which is
 * OUTSIDE this domain's STRYKER_TEST_SCOPE ("src/db/__tests__
 * src/middleware/__tests__") — so mutating auth.ts in isolation from that
 * scope makes rootMcpAuth (and a few evaluateMcpAuth branches only reached
 * via /mcp's real request flow) look untested even though real coverage
 * exists elsewhere. Rather than widen the scope (slower, and creates a
 * permanent cross-domain coupling for every future domain-4 file), this
 * file makes auth.ts's own mutation coverage self-sufficient: every branch
 * is driven directly with lightweight mock Express req/res objects (same
 * idiom as origin-validator-envelope.test.ts) plus `spyOn` on the security-
 * module dependencies (system-role.js, jwt.js, mcp-key-store.js) to force
 * each branch deterministically, no real DB/JWT setup needed.
 */
import { describe, test, expect, spyOn } from "bun:test";
import type { Request, Response, NextFunction } from "express";
import { rootMcpAuth, evaluateMcpAuth, mcpAuth, adminAuth } from "../../middleware/auth.js";
import { config } from "../../config.js";
import * as systemRoleMod from "../../security/system-role.js";
import * as jwtMod from "../../security/jwt.js";
import * as mcpKeyStoreMod from "../../security/mcp-key-store.js";
import * as sessionStoreMod from "../../security/session-store.js";
import * as userStoreMod from "../../security/user-store.js";
import { SESSION_COOKIE_NAME } from "../../security/cookies.js";

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

function makeReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

// ===========================================================================
// rootMcpAuth — 191:84-207:2 BlockStatement [Survived] (the whole function
// body emptied). Real indirect coverage exists in src/mcp/__tests__, but
// outside this domain's Stryker scope — direct tests here make this file
// self-sufficient.
// ===========================================================================

describe("rootMcpAuth", () => {
  test("no Authorization header at all -> 401 UNAUTHORIZED, next() never called", () => {
    const resolveSpy = spyOn(systemRoleMod, "resolveSystemRole").mockReturnValue(null);
    try {
      const req = makeReq();
      const res = makeRes();
      const next = makeNext();
      rootMcpAuth(req, res as unknown as Response, next.fn);
      expect(next.called).toBe(false);
      expect(res._status).toBe(401);
      const body = res._body as { error?: { code?: string } };
      expect(body.error?.code).toBe("UNAUTHORIZED");
    } finally {
      resolveSpy.mockRestore();
    }
  });

  // 202:35-202:79 StringLiteral [Survived] (the "This credential has no
  // system role on /mcp" message emptied). A PRESENT-but-rejected Bearer
  // token (distinct from an absent one) must get 403 FORBIDDEN with the
  // exact message text, not the 401 "missing" message.
  test("a present but rejected Bearer token -> 403 FORBIDDEN with the exact message", () => {
    const resolveSpy = spyOn(systemRoleMod, "resolveSystemRole").mockReturnValue(null);
    try {
      const req = makeReq({ authorization: "Bearer wrong-token" });
      const res = makeRes();
      const next = makeNext();
      rootMcpAuth(req, res as unknown as Response, next.fn);
      expect(next.called).toBe(false);
      expect(res._status).toBe(403);
      const body = res._body as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe("FORBIDDEN");
      expect(body.error?.message).toBe("This credential has no system role on /mcp");
    } finally {
      resolveSpy.mockRestore();
    }
  });

  test("a resolved system role calls next(), not an error response", () => {
    const resolveSpy = spyOn(systemRoleMod, "resolveSystemRole").mockReturnValue({
      role: "admin",
      elevated: true,
      keyId: 1,
      isEnvBearer: true,
    });
    try {
      const req = makeReq({ authorization: "Bearer real-admin-key" });
      const res = makeRes();
      const next = makeNext();
      rootMcpAuth(req, res as unknown as Response, next.fn);
      expect(next.called).toBe(true);
      expect(res._status).toBeUndefined();
    } finally {
      resolveSpy.mockRestore();
    }
  });
});

// ===========================================================================
// evaluateMcpAuth — the JWT branch and the "no auth material" fallback
// (L130-160).
// ===========================================================================

describe("evaluateMcpAuth — JWT branch", () => {
  const origMcpApiKeys = config.mcpApiKeys;

  function withNoEnvKeysNoManagedKeys<T>(fn: () => T): T {
    (config as Record<string, unknown>).mcpApiKeys = [];
    const hasKeysSpy = spyOn(mcpKeyStoreMod, "hasAnyMcpKeys").mockReturnValue(false);
    const resolveKeySpy = spyOn(mcpKeyStoreMod, "resolveMcpKeyByToken").mockReturnValue(null);
    try {
      return fn();
    } finally {
      (config as Record<string, unknown>).mcpApiKeys = origMcpApiKeys;
      hasKeysSpy.mockRestore();
      resolveKeySpy.mockRestore();
    }
  }

  // 145:9-145:26 ConditionalExpression [Survived] "true" (`if
  // (isJwtConfigured())` forced always-true). When JWT is NOT configured,
  // verifyJwt must never even be called for an unrecognized token. Uses
  // hasAnyMcpKeys=true (a managed key exists, even though it doesn't match
  // this token) specifically so the "no auth material configured => allow
  // all" fallback does NOT short-circuit first — that fallback only cares
  // whether auth material exists at all, not whether the SPECIFIC token
  // offered is valid, so with genuinely zero auth material configured
  // ANY token (even garbage) would be waved through before ever reaching
  // this mutant's branch.
  test("when JWT is not configured, an unrecognized token never invokes verifyJwt", async () => {
    const origMcpApiKeys = config.mcpApiKeys;
    (config as Record<string, unknown>).mcpApiKeys = [];
    const hasKeysSpy = spyOn(mcpKeyStoreMod, "hasAnyMcpKeys").mockReturnValue(true);
    const resolveKeySpy = spyOn(mcpKeyStoreMod, "resolveMcpKeyByToken").mockReturnValue(null);
    const isConfiguredSpy = spyOn(jwtMod, "isJwtConfigured").mockReturnValue(false);
    const verifySpy = spyOn(jwtMod, "verifyJwt");
    try {
      // 159:42-159:53 StringLiteral [Survived] ("FORBIDDEN" emptied) — the
      // final fallback's exact code, asserted here too since this is
      // exactly the "present but unrecognized token" scenario that reaches it.
      const verdict = await evaluateMcpAuth({ authorization: "Bearer some-token" });
      expect(verifySpy).not.toHaveBeenCalled();
      expect(verdict).toEqual({ ok: false, status: 403, code: "FORBIDDEN", message: "Invalid API key" });
    } finally {
      (config as Record<string, unknown>).mcpApiKeys = origMcpApiKeys;
      hasKeysSpy.mockRestore();
      resolveKeySpy.mockRestore();
      isConfiguredSpy.mockRestore();
      verifySpy.mockRestore();
    }
  });

  // 147:11-147:24 ConditionalExpression [Survived] "false" (`if
  // (verdict.valid)` forced always-false). A GENUINELY valid JWT must
  // actually grant access with the subject echoed back.
  test("a genuinely valid JWT grants access with jwtSubject set", async () => {
    await withNoEnvKeysNoManagedKeys(async () => {
      const isConfiguredSpy = spyOn(jwtMod, "isJwtConfigured").mockReturnValue(true);
      const verifySpy = spyOn(jwtMod, "verifyJwt").mockResolvedValue({
        valid: true,
        claims: { sub: "user-42" },
      } as Awaited<ReturnType<typeof jwtMod.verifyJwt>>);
      try {
        const verdict = await evaluateMcpAuth({ authorization: "Bearer a-real-jwt" });
        expect(verdict.ok).toBe(true);
        expect(verdict.jwtSubject).toBe("user-42");
      } finally {
        isConfiguredSpy.mockRestore();
        verifySpy.mockRestore();
      }
    });
  });

  test("an invalid JWT (signature/claims fail) does not grant access", async () => {
    await withNoEnvKeysNoManagedKeys(async () => {
      const isConfiguredSpy = spyOn(jwtMod, "isJwtConfigured").mockReturnValue(true);
      const verifySpy = spyOn(jwtMod, "verifyJwt").mockResolvedValue({
        valid: false,
      } as Awaited<ReturnType<typeof jwtMod.verifyJwt>>);
      try {
        const verdict = await evaluateMcpAuth({ authorization: "Bearer a-bad-jwt" });
        expect(verdict.ok).toBe(false);
      } finally {
        isConfiguredSpy.mockRestore();
        verifySpy.mockRestore();
      }
    });
  });
});

describe("evaluateMcpAuth — the 'if (token)' guard and env-key match", () => {
  const origMcpApiKeys = config.mcpApiKeys;

  // 136:7-136:12 ConditionalExpression [Survived] "true" (`if (token)`
  // forced always-true). With no Authorization header at all (token is
  // genuinely null), the whole token-checking block — including
  // resolveMcpKeyByToken — must never even run.
  test("with no Authorization header, resolveMcpKeyByToken is never called at all", async () => {
    (config as Record<string, unknown>).mcpApiKeys = [];
    const hasKeysSpy = spyOn(mcpKeyStoreMod, "hasAnyMcpKeys").mockReturnValue(true);
    const resolveKeySpy = spyOn(mcpKeyStoreMod, "resolveMcpKeyByToken");
    const isConfiguredSpy = spyOn(jwtMod, "isJwtConfigured").mockReturnValue(false);
    try {
      const verdict = await evaluateMcpAuth({});
      expect(resolveKeySpy).not.toHaveBeenCalled();
      expect(verdict).toEqual({
        ok: false,
        status: 401,
        code: "UNAUTHORIZED",
        message: "Missing Authorization header",
      });
    } finally {
      (config as Record<string, unknown>).mcpApiKeys = origMcpApiKeys;
      hasKeysSpy.mockRestore();
      resolveKeySpy.mockRestore();
      isConfiguredSpy.mockRestore();
    }
  });

  // 137:91-137:103 ObjectLiteral [Survived] ("{ ok: true }" emptied to
  // "{}"). A token that matches a real configured env key must return
  // EXACTLY { ok: true }, not an object missing the "ok" field.
  test("a token matching a configured env key returns exactly { ok: true }", async () => {
    (config as Record<string, unknown>).mcpApiKeys = ["real-env-key"];
    try {
      const verdict = await evaluateMcpAuth({ authorization: "Bearer real-env-key" });
      expect(verdict).toEqual({ ok: true });
    } finally {
      (config as Record<string, unknown>).mcpApiKeys = origMcpApiKeys;
    }
  });

  // 137:9-137:82 LogicalOperator [Survived] (`envConfigured && config.mcpApiKeys.some(...)`
  // flipped to `||`). Merely having SOME env keys configured must not itself
  // grant access — the offered token has to actually match one of them.
  test("having env keys configured does not itself grant access to a non-matching token", async () => {
    (config as Record<string, unknown>).mcpApiKeys = ["real-env-key"];
    const hasKeysSpy = spyOn(mcpKeyStoreMod, "hasAnyMcpKeys").mockReturnValue(true);
    const resolveKeySpy = spyOn(mcpKeyStoreMod, "resolveMcpKeyByToken").mockReturnValue(null);
    const isConfiguredSpy = spyOn(jwtMod, "isJwtConfigured").mockReturnValue(false);
    try {
      const verdict = await evaluateMcpAuth({ authorization: "Bearer totally-different-token" });
      expect(verdict).toEqual({ ok: false, status: 403, code: "FORBIDDEN", message: "Invalid API key" });
    } finally {
      (config as Record<string, unknown>).mcpApiKeys = origMcpApiKeys;
      hasKeysSpy.mockRestore();
      resolveKeySpy.mockRestore();
      isConfiguredSpy.mockRestore();
    }
  });
});

// 131:7-131:26 ConditionalExpression [Survived] (`if (config.authDisabled)`
// forced always-false). Configured so that, absent the authDisabled
// short-circuit, the real fallthrough would land on a 401 — isolating this
// one line rather than incidentally passing via the "no auth material"
// fallback.
describe("evaluateMcpAuth — config.authDisabled short-circuit", () => {
  test("authDisabled grants access immediately, before the env-key / token checks even run", async () => {
    const origAuthDisabled = config.authDisabled;
    const origMcpApiKeys = config.mcpApiKeys;
    (config as Record<string, unknown>).authDisabled = true;
    (config as Record<string, unknown>).mcpApiKeys = ["some-key"];
    try {
      const verdict = await evaluateMcpAuth({});
      expect(verdict).toEqual({ ok: true });
    } finally {
      (config as Record<string, unknown>).authDisabled = origAuthDisabled;
      (config as Record<string, unknown>).mcpApiKeys = origMcpApiKeys;
    }
  });
});

describe("evaluateMcpAuth — 'no auth material configured => allow all' fallback", () => {
  const origMcpApiKeys = config.mcpApiKeys;

  // 156:7-156:63 / 156:25-156:41 / 156:72-156:84 [all Survived] — the
  // fallback's full condition and its returned object.
  test("with genuinely NO auth material at all (no env keys, no managed keys, no JWT), an unauthenticated request is allowed", async () => {
    (config as Record<string, unknown>).mcpApiKeys = [];
    const hasKeysSpy = spyOn(mcpKeyStoreMod, "hasAnyMcpKeys").mockReturnValue(false);
    const isConfiguredSpy = spyOn(jwtMod, "isJwtConfigured").mockReturnValue(false);
    try {
      const verdict = await evaluateMcpAuth({});
      expect(verdict).toEqual({ ok: true });
    } finally {
      (config as Record<string, unknown>).mcpApiKeys = origMcpApiKeys;
      hasKeysSpy.mockRestore();
      isConfiguredSpy.mockRestore();
    }
  });

  test("merely having a managed MCP key minted (even if unused by this request) locks down the surface — unauthenticated request is rejected", async () => {
    (config as Record<string, unknown>).mcpApiKeys = [];
    const hasKeysSpy = spyOn(mcpKeyStoreMod, "hasAnyMcpKeys").mockReturnValue(true);
    const isConfiguredSpy = spyOn(jwtMod, "isJwtConfigured").mockReturnValue(false);
    try {
      const verdict = await evaluateMcpAuth({});
      expect(verdict.ok).toBe(false);
      expect(verdict.status).toBe(401);
    } finally {
      (config as Record<string, unknown>).mcpApiKeys = origMcpApiKeys;
      hasKeysSpy.mockRestore();
      isConfiguredSpy.mockRestore();
    }
  });
});

// ===========================================================================
// mcpAuth — the Express adapter over evaluateMcpAuth (L170-179).
// 176:7-176:37 ConditionalExpression [Survived] "false" (`if
// (verdict.mcpKeyId !== undefined) req.mcpKeyId = ...` never fires).
// ===========================================================================

describe("mcpAuth", () => {
  test("a successful managed-key auth sets req.mcpKeyId to the real matched key id", async () => {
    const origMcpApiKeys = config.mcpApiKeys;
    (config as Record<string, unknown>).mcpApiKeys = [];
    const hasKeysSpy = spyOn(mcpKeyStoreMod, "hasAnyMcpKeys").mockReturnValue(true);
    const resolveKeySpy = spyOn(mcpKeyStoreMod, "resolveMcpKeyByToken").mockReturnValue({
      id: 77,
      scopes: null,
    } as unknown as ReturnType<typeof mcpKeyStoreMod.resolveMcpKeyByToken>);
    const touchSpy = spyOn(mcpKeyStoreMod, "touchMcpKeyLastUsed").mockImplementation(() => {});
    try {
      const req = makeReq({ authorization: "Bearer a-managed-key" }) as Request & {
        mcpKeyId?: number;
        jwtSubject?: string;
      };
      const res = makeRes();
      const next = makeNext();
      await mcpAuth(req, res as unknown as Response, next.fn);
      expect(next.called).toBe(true);
      expect(req.mcpKeyId).toBe(77);
      // 177:7-177:39 ConditionalExpression [Survived] (`if (verdict.jwtSubject
      // !== undefined)` forced always-true). This verdict has no jwtSubject at
      // all — the assignment must never run, not even to assign `undefined`.
      expect(Object.prototype.hasOwnProperty.call(req, "jwtSubject")).toBe(false);
    } finally {
      (config as Record<string, unknown>).mcpApiKeys = origMcpApiKeys;
      hasKeysSpy.mockRestore();
      resolveKeySpy.mockRestore();
      touchSpy.mockRestore();
    }
  });

  // 177:7-177:39 ConditionalExpression [Survived] "false" (`if
  // (verdict.jwtSubject !== undefined) req.jwtSubject = ...` never fires).
  // A successful JWT-based auth must set req.jwtSubject to the real
  // verified subject.
  test("a successful JWT auth sets req.jwtSubject to the real verified subject", async () => {
    const origMcpApiKeys = config.mcpApiKeys;
    (config as Record<string, unknown>).mcpApiKeys = [];
    const hasKeysSpy = spyOn(mcpKeyStoreMod, "hasAnyMcpKeys").mockReturnValue(true);
    const resolveKeySpy = spyOn(mcpKeyStoreMod, "resolveMcpKeyByToken").mockReturnValue(null);
    const isConfiguredSpy = spyOn(jwtMod, "isJwtConfigured").mockReturnValue(true);
    const verifySpy = spyOn(jwtMod, "verifyJwt").mockResolvedValue({
      valid: true,
      claims: { sub: "user-99" },
    } as Awaited<ReturnType<typeof jwtMod.verifyJwt>>);
    try {
      const req = makeReq({ authorization: "Bearer a-real-jwt" }) as Request & { jwtSubject?: string };
      const res = makeRes();
      const next = makeNext();
      await mcpAuth(req, res as unknown as Response, next.fn);
      expect(next.called).toBe(true);
      expect(req.jwtSubject).toBe("user-99");
    } finally {
      (config as Record<string, unknown>).mcpApiKeys = origMcpApiKeys;
      hasKeysSpy.mockRestore();
      resolveKeySpy.mockRestore();
      isConfiguredSpy.mockRestore();
      verifySpy.mockRestore();
    }
  });

  // 172:20-175:4 BlockStatement [Survived] (the `if (!verdict.ok) { sendError
  // ...; return; }` body emptied). A rejected verdict must actually short-
  // circuit the response — not fall through and call next() anyway.
  test("a rejected verdict sends the error response and never calls next()", async () => {
    const origMcpApiKeys = config.mcpApiKeys;
    (config as Record<string, unknown>).mcpApiKeys = ["real-env-key"];
    const hasKeysSpy = spyOn(mcpKeyStoreMod, "hasAnyMcpKeys").mockReturnValue(true);
    try {
      const req = makeReq();
      const res = makeRes();
      const next = makeNext();
      await mcpAuth(req, res as unknown as Response, next.fn);
      expect(next.called).toBe(false);
      expect(res._status).toBe(401);
      const body = res._body as { error?: { code?: string } };
      expect(body.error?.code).toBe("UNAUTHORIZED");
    } finally {
      (config as Record<string, unknown>).mcpApiKeys = origMcpApiKeys;
      hasKeysSpy.mockRestore();
    }
  });
});

// ===========================================================================
// adminAuth — 57:82-106:2 BlockStatement [Timeout] (the whole function body
// emptied). Real indirect coverage exists via routes/admin tests, but
// outside this domain's Stryker scope — direct tests here make this file
// self-sufficient and resolve the ambiguous timeout status to a clean kill.
// ===========================================================================

describe("adminAuth", () => {
  const origAuthDisabled = config.authDisabled;
  const origAdminApiKeys = config.adminApiKeys;

  function restore(): void {
    (config as Record<string, unknown>).authDisabled = origAuthDisabled;
    (config as Record<string, unknown>).adminApiKeys = origAdminApiKeys;
  }

  test("config.authDisabled bypasses all checks and calls next() immediately", async () => {
    (config as Record<string, unknown>).authDisabled = true;
    try {
      const req = makeReq();
      const res = makeRes();
      const next = makeNext();
      adminAuth(req, res as unknown as Response, next.fn);
      expect(next.called).toBe(true);
      expect(res._status).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("a valid Bearer API key authenticates via the bearer method, bypassing session/CSRF entirely", async () => {
    (config as Record<string, unknown>).authDisabled = false;
    (config as Record<string, unknown>).adminApiKeys = ["the-real-admin-key"];
    try {
      const req = makeReq({ authorization: "Bearer the-real-admin-key" }) as Request & {
        authContext?: { method: string };
      };
      const res = makeRes();
      const next = makeNext();
      adminAuth(req, res as unknown as Response, next.fn);
      expect(next.called).toBe(true);
      expect(req.authContext).toEqual({ method: "bearer" });
    } finally {
      restore();
    }
  });

  test("an invalid Bearer token is rejected with 403 FORBIDDEN, not silently accepted", async () => {
    (config as Record<string, unknown>).authDisabled = false;
    (config as Record<string, unknown>).adminApiKeys = ["the-real-admin-key"];
    try {
      const req = makeReq({ authorization: "Bearer totally-wrong" });
      const res = makeRes();
      const next = makeNext();
      adminAuth(req, res as unknown as Response, next.fn);
      expect(next.called).toBe(false);
      expect(res._status).toBe(403);
    } finally {
      restore();
    }
  });

  test("no Authorization header and no session cookie -> 401 UNAUTHORIZED", async () => {
    (config as Record<string, unknown>).authDisabled = false;
    (config as Record<string, unknown>).adminApiKeys = ["the-real-admin-key"];
    try {
      const req = makeReq();
      const res = makeRes();
      const next = makeNext();
      adminAuth(req, res as unknown as Response, next.fn);
      expect(next.called).toBe(false);
      expect(res._status).toBe(401);
    } finally {
      restore();
    }
  });

  // 97:18-97:54 OptionalChaining [Survived] (`findUserById(session.userId)?.teamId`
  // with the `?.` removed). A valid session whose user has since been deleted
  // (or a stale FK) must resolve teamId to null via the optional chain, not
  // throw. GET is used so the CSRF branch is skipped entirely, isolating this
  // line.
  test("a valid session whose user no longer exists resolves teamId to null instead of throwing", () => {
    (config as Record<string, unknown>).authDisabled = false;
    const validateSpy = spyOn(sessionStoreMod, "validateSession").mockReturnValue({
      userId: 123,
      username: "ghost",
      role: "admin",
      csrfToken: "csrf-abc",
    });
    const findUserSpy = spyOn(userStoreMod, "findUserById").mockReturnValue(null);
    try {
      const req = makeReq({ cookie: `${SESSION_COOKIE_NAME}=some-session-token` }) as Request & {
        method?: string;
        authContext?: { teamId?: number | null };
      };
      req.method = "GET";
      const res = makeRes();
      const next = makeNext();
      expect(() => adminAuth(req, res as unknown as Response, next.fn)).not.toThrow();
      expect(next.called).toBe(true);
      expect(req.authContext?.teamId).toBeNull();
    } finally {
      restore();
      validateSpy.mockRestore();
      findUserSpy.mockRestore();
    }
  });
});

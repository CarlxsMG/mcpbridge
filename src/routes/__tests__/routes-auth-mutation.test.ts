/**
 * Stryker mutation-testing backstop for src/routes/auth.ts — domain 8.
 * Baseline: 188 mutants, 43 killed / 144 survived / 1 timed out. The existing
 * hand-written routes-auth.test.ts (left untouched here) only covers the
 * login happy/sad paths, GET /me's session branch, and logout's CSRF gate —
 * it never touches PATCH /me/password, GET /sessions, or DELETE
 * /sessions/:id at all (entirely 0% baseline coverage on those three
 * routes), never asserts exact error codes/messages, never exercises the
 * bearer branch of GET /me, and never checks setSessionCookies /
 * clearSessionCookies' cookie attributes (Max-Age/Path/SameSite) beyond
 * httpOnly. All line:col citations below were read directly from
 * reports/mutation/result.json.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { createUser, updateUser, updatePassword } from "../../security/user-store.js";
import * as userStoreMod from "../../security/user-store.js";
import { listActiveSessionsForUser } from "../../security/session-store.js";
import { _internalsForTesting } from "../../middleware/rate-limiter.js";
import * as loggerMod from "../../logger.js";
import { withConfig } from "../../__tests__/_utils/with-config.js";

const ADMIN_KEY = "test-admin-key-auth-mut";

async function startApp(): Promise<{ baseUrl: string; server: Server }> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { authRoutes } = await import("../../routes/auth.js");
  const app = express();
  app.use(express.json());
  authRoutes(app);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      resolve({ baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, server: srv });
    });
    srv.on("error", reject);
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
}

async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const { baseUrl, server } = await startApp();
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function seedUser(
  username: string,
  password: string,
  role: "admin" | "operator" | "auditor" | "viewer" = "admin",
) {
  const hash = await Bun.password.hash(password);
  return createUser(username, hash, role, null);
}

/** Extracts `name=value` pairs from Set-Cookie headers, dropping attributes, for re-sending on the next request. */
function cookieHeaderFrom(res: Response): string {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

function findSetCookie(res: Response, name: string): string | undefined {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return setCookies.find((c) => c.startsWith(`${name}=`));
}

/** Logs in and returns everything needed to drive a follow-up session-authenticated request. */
async function loginAs(
  baseUrl: string,
  username: string,
  password: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ res: Response; cookieHeader: string; csrfToken: string; body: { csrf_token: string } }> {
  const res = await fetch(`${baseUrl}/admin-api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({ username, password }),
  });
  const cookieHeader = cookieHeaderFrom(res);
  const body = (await res.json()) as { csrf_token: string };
  return { res, cookieHeader, csrfToken: body.csrf_token, body };
}

function sessionHeaders(cookieHeader: string, csrfToken: string): Record<string, string> {
  return { Cookie: cookieHeader, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };
}

beforeEach(() => {
  // The login rate limiter is a module-level singleton keyed by IP, never
  // reset by __resetDbForTesting — this file logs in many times from the
  // same loopback address, so it must be cleared per test (precedent:
  // routes-auth-oidc.test.ts / routes-register.test.ts).
  _internalsForTesting.loginBuckets.clear();
});

afterEach(() => {
  _internalsForTesting.loginBuckets.clear();
});

describe("POST /admin-api/auth/login — additional coverage", () => {
  // Kills 21/22 (the `.trim().toLowerCase()` MethodExpression mutants).
  test("a padded, mixed-case username is trimmed and lowercased before lookup", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-case", "correct-horse-battery-staple");
      const res = await fetch(`${baseUrl}/admin-api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "  Auth-Mut-Case  ", password: "correct-horse-battery-staple" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: { username: string } };
      expect(body.user.username).toBe("auth-mut-case");
    });
  });

  // Kills 19 (OptionalChaining `body?.username` -> `body.username`) and 27
  // (OptionalChaining `body?.password` -> `body.password`): with no body at
  // all, req.body is genuinely undefined, so removing either `?.` throws
  // and the request never gets the clean 400 real code produces.
  test("no request body at all (no Content-Type) fails validation gracefully, not a crash", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/auth/login`, { method: "POST" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // Kills 23 (the username fallback "" replaced by a truthy placeholder,
  // which would wrongly pass validation and reach a real lookup).
  test("a non-string, truthy username fails validation (not coerced to a lookup key)", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: 12345, password: "correct-horse-battery-staple" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // Kills 24 (ConditionalExpression forcing the password ternary's
  // condition true, so a non-string truthy password would be passed
  // through raw instead of coerced to "") and 29 (the "" fallback replaced
  // by a truthy placeholder). A truthy NUMBER is required — a missing
  // field stays falsy either way and can't distinguish the mutant.
  test("a non-string, truthy password fails validation for an existing user (not treated as valid input)", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-badpass", "correct-horse-battery-staple");
      const res = await fetch(`${baseUrl}/admin-api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "auth-mut-badpass", password: 123456789012 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // Kills 32 (LogicalOperator `!username || !password` -> `&&`) and 36 (the
  // validation message emptied). A missing username with a password
  // PRESENT distinguishes OR from AND — routes-auth.test.ts's existing
  // test sends both missing, which can't tell OR from AND apart.
  test("a missing username (password present) fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "correct-horse-battery-staple" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("username and password are required");
    });
  });

  // Kills the `!user.isActive` clause's contribution to the OR (part of the
  // 44/45/46/47 BooleanLiteral/LogicalOperator cluster around line 53) with
  // a fixture routes-auth.test.ts never exercises: an existing, CORRECTLY
  // authenticated but deactivated user must still be rejected.
  test("a deactivated user with the correct password still gets 401 INVALID_CREDENTIALS", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-inactive", "correct-horse-battery-staple");
      updateUser("auth-mut-inactive", { isActive: false });
      const res = await fetch(`${baseUrl}/admin-api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "auth-mut-inactive", password: "correct-horse-battery-staple" }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_CREDENTIALS");
      expect(body.error.message).toBe("Invalid username or password");
    });
  });

  // Kills 40 (the `.catch(() => false)` arrow's `false` replaced by
  // `true`): Bun.password.verify only ever THROWS (reaching the catch) for
  // a malformed hash, which never happens via the normal seed path — a
  // corrupt stored hash is written directly to force that branch. If the
  // mutant's catch returned `true`, a corrupt-hash user with ANY password
  // would wrongly log in.
  test("a corrupt stored password hash fails closed (verify() throwing is treated as invalid, not valid)", async () => {
    await withApp(async (baseUrl) => {
      const user = createUser("auth-mut-corrupthash", "not-a-real-argon2-hash", "admin", null);
      expect(user.username).toBe("auth-mut-corrupthash");
      const res = await fetch(`${baseUrl}/admin-api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "auth-mut-corrupthash", password: "whatever-password-1" }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_CREDENTIALS");
    });
  });

  // Kills 2 (Math.max -> Math.min, which would force maxAge to 0), 3
  // (ArithmeticOperator `-` -> `+`, which would blow maxAge up to roughly
  // 2x Date.now()), 4 (the whole `shared` attrs object emptied, dropping
  // secure/sameSite/path/maxAge from BOTH cookies), 5 (the "/" path
  // literal emptied), and 8 (the CSRF cookie's OWN `{ ...shared, httpOnly:
  // false }` object emptied — httpOnly is absent either way for that
  // cookie, so only checking Path/SameSite/Max-Age on the CSRF cookie
  // specifically can distinguish this from real code).
  test("a successful login sets both cookies with sane Max-Age/Path/SameSite attributes", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-cookieattrs", "correct-horse-battery-staple");
      const res = await fetch(`${baseUrl}/admin-api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "auth-mut-cookieattrs", password: "correct-horse-battery-staple" }),
      });
      expect(res.status).toBe(200);
      for (const name of ["mcp_admin_session", "__Host-mcp_admin_session", "mcp_admin_csrf", "__Host-mcp_admin_csrf"]) {
        const cookie = findSetCookie(res, name);
        if (!cookie) continue;
        const lower = cookie.toLowerCase();
        expect(lower).toContain("path=/;");
        expect(lower).toContain("samesite=lax");
        const maxAgeMatch = lower.match(/max-age=(\d+)/);
        expect(maxAgeMatch).not.toBeNull();
        const maxAge = Number(maxAgeMatch![1]);
        // sessionAbsoluteTtlMs defaults to 12h (43200s); bound loosely so
        // this doesn't get flaky, but tight enough to catch both a
        // forced-zero (Math.min) and a blown-up (arithmetic flip) mutant.
        expect(maxAge).toBeGreaterThan(1000);
        expect(maxAge).toBeLessThan(90_000);
      }
    });
  });

  // Kills 56 (the "user-agent" header-key StringLiteral emptied, which
  // would make createSession store a null user_agent instead of the real
  // header) via a round-trip through GET /sessions, and 57/58/59 (the
  // log("info", "Admin login succeeded", {...}) call's literals/object
  // emptied) via a logger spy with an exact toHaveBeenCalledWith.
  test("a successful login records the real User-Agent and logs the exact success message", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-ua", "correct-horse-battery-staple");
      const logSpy = spyOn(loggerMod, "log");
      try {
        const loginRes = await fetch(`${baseUrl}/admin-api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": "auth-mut-test-agent/1.0" },
          body: JSON.stringify({ username: "auth-mut-ua", password: "correct-horse-battery-staple" }),
        });
        expect(loginRes.status).toBe(200);
        expect(logSpy).toHaveBeenCalledWith(
          "info",
          "Admin login succeeded",
          expect.objectContaining({ username: "auth-mut-ua" }),
        );

        const cookieHeader = cookieHeaderFrom(loginRes);
        const sessionsRes = await fetch(`${baseUrl}/admin-api/auth/sessions`, { headers: { Cookie: cookieHeader } });
        const sessionsBody = (await sessionsRes.json()) as { sessions: { userAgent: string | null }[] };
        expect(sessionsBody.sessions.some((s) => s.userAgent === "auth-mut-test-agent/1.0")).toBe(true);
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  // Kills 50/51/52 (the log("warn", "Admin login failed", {...}) call's
  // literals/object emptied) and 54 (the 401 message emptied) — the
  // existing wrong-password test in routes-auth.test.ts only checks the
  // error code, and never spies on the log call at all.
  test("a wrong password logs the exact failure warning and the exact 401 message", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-wronglog", "correct-horse-battery-staple");
      const logSpy = spyOn(loggerMod, "log");
      try {
        const res = await fetch(`${baseUrl}/admin-api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "auth-mut-wronglog", password: "totally-wrong" }),
        });
        expect(res.status).toBe(401);
        const body = (await res.json()) as { error: { message: string } };
        expect(body.error.message).toBe("Invalid username or password");
        expect(logSpy).toHaveBeenCalledWith(
          "warn",
          "Admin login failed",
          expect.objectContaining({ username: "auth-mut-wronglog" }),
        );
      } finally {
        logSpy.mockRestore();
      }
    });
  });
});

describe("POST /admin-api/auth/logout — additional coverage", () => {
  // Kills 64 (ConditionalExpression forcing `if (token)` true, which would
  // call revokeSession(undefined) and crash) via a Bearer-authenticated
  // logout that carries no session cookie at all — real code must skip the
  // revoke call gracefully.
  test("a Bearer-authenticated logout with no session cookie succeeds without crashing", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/auth/logout`, { method: "POST", headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("logged_out");
    });
  });

  // Kills 66 (the response ObjectLiteral emptied) and 67 (the "logged_out"
  // literal emptied) with an exact body assertion — the existing tests in
  // routes-auth.test.ts only check the status code.
  test("a successful logout returns the exact response shape", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-logoutbody", "correct-horse-battery-staple");
      const { cookieHeader, csrfToken } = await loginAs(baseUrl, "auth-mut-logoutbody", "correct-horse-battery-staple");
      const res = await fetch(`${baseUrl}/admin-api/auth/logout`, {
        method: "POST",
        headers: sessionHeaders(cookieHeader, csrfToken),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body).toEqual({ status: "logged_out" });
    });
  });

  // Kills 10 (clearSessionCookies' whole body emptied, which would leave NO
  // Set-Cookie headers on logout at all), 11 (its `shared` attrs object
  // emptied, dropping Path/SameSite from the clearing cookies), and 12 (the
  // "/" path literal emptied).
  test("a successful logout clears both cookies with the same Path/SameSite attributes", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-logoutclear", "correct-horse-battery-staple");
      const { cookieHeader, csrfToken } = await loginAs(
        baseUrl,
        "auth-mut-logoutclear",
        "correct-horse-battery-staple",
      );
      const res = await fetch(`${baseUrl}/admin-api/auth/logout`, {
        method: "POST",
        headers: sessionHeaders(cookieHeader, csrfToken),
      });
      expect(res.status).toBe(200);
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      expect(setCookies.length).toBeGreaterThanOrEqual(2);
      for (const cookie of setCookies) {
        const lower = cookie.toLowerCase();
        expect(lower).toContain("path=/;");
        expect(lower).toContain("samesite=lax");
      }
    });
  });
});

describe("GET /admin-api/auth/me — additional coverage", () => {
  // Kills the entire 71/72/74/76/77/78/79/80 cluster on the
  // `!ctx || ctx.method === "bearer"` guard and its response body: a
  // Bearer-authenticated call must report auth_method "bearer" with no
  // user field, and every LogicalOperator/ConditionalExpression/
  // StringLiteral/BooleanLiteral mutation on that branch flips this exact
  // shape (usually into the session branch, which crashes on
  // ctx.username/ctx.role being undefined, or into a wrong auth_method).
  test("Bearer auth reports the exact bearer identity shape", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/auth/me`, { headers: bearer() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown;
      expect(body).toEqual({ authenticated: true, auth_method: "bearer" });
    });
  });
});

describe("PATCH /admin-api/auth/me/password", () => {
  // Kills 87 (forced true — always forbidden, contradicted by the success
  // test below), 91/92 (the `!ctx && ctx.method !== "session"` AND-swap and
  // the `!ctx` negation removed — both would crash accessing ctx.method on
  // a genuinely undefined ctx instead of cleanly returning 403), and 89/90
  // (the outer AND-swap / forced-false — same crash-vs-clean-403 argument).
  test("no auth context at all (authDisabled, no headers) returns the exact 403 FORBIDDEN", async () => {
    await withApp(async (baseUrl) => {
      await withConfig({ authDisabled: true }, async () => {
        const res = await fetch(`${baseUrl}/admin-api/auth/me/password`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ current_password: "x", new_password: "irrelevant12" }),
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("FORBIDDEN");
        expect(body.error.message).toBe("Password change requires a session-authenticated user");
      });
    });
  });

  // Kills the `ctx.method !== "session"` clause's contribution for a
  // REAL (non-undefined) ctx: Bearer auth.
  test("Bearer auth (not session-authenticated) returns the exact 403 FORBIDDEN", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/auth/me/password`, {
        method: "PATCH",
        headers: bearer(),
        body: JSON.stringify({ current_password: "x", new_password: "irrelevant12" }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toBe("Password change requires a session-authenticated user");
    });
  });

  // Kills 103 (OptionalChaining `body?.current_password` -> `.`) and 109
  // (same for `body?.new_password`) — a genuinely bodyless PATCH must
  // still fail validation cleanly, not crash.
  test("no request body at all fails validation gracefully with a valid session", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-pwnobody", "correct-horse-battery-staple");
      const { cookieHeader, csrfToken } = await loginAs(baseUrl, "auth-mut-pwnobody", "correct-horse-battery-staple");
      const res = await fetch(`${baseUrl}/admin-api/auth/me/password`, {
        method: "PATCH",
        headers: { Cookie: cookieHeader, "X-CSRF-Token": csrfToken },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // Kills 102/104 (the current_password fallback's EqualityOperator/
  // StringLiteral) and 105 (the truthy placeholder fallback) via a
  // non-string, TRUTHY current_password.
  test("a non-string, truthy current_password fails validation", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-pwbadcur", "correct-horse-battery-staple");
      const { cookieHeader, csrfToken } = await loginAs(baseUrl, "auth-mut-pwbadcur", "correct-horse-battery-staple");
      const res = await fetch(`${baseUrl}/admin-api/auth/me/password`, {
        method: "PATCH",
        headers: sessionHeaders(cookieHeader, csrfToken),
        body: JSON.stringify({ current_password: 123456789012, new_password: "new-password-12" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // Kills 108/110 (the new_password fallback's EqualityOperator/
  // StringLiteral) and 111 (the truthy placeholder fallback) via a
  // non-string, TRUTHY new_password.
  test("a non-string, truthy new_password fails validation", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-pwbadnew", "correct-horse-battery-staple");
      const { cookieHeader, csrfToken } = await loginAs(baseUrl, "auth-mut-pwbadnew", "correct-horse-battery-staple");
      const res = await fetch(`${baseUrl}/admin-api/auth/me/password`, {
        method: "PATCH",
        headers: sessionHeaders(cookieHeader, csrfToken),
        body: JSON.stringify({ current_password: "correct-horse-battery-staple", new_password: 123456789012 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // Kills 120/121 (the `newPassword.length < 12` EqualityOperator flips)
  // at the boundary — 11 chars must fail.
  test("an 11-character new_password fails validation with the exact message", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-pwshort", "correct-horse-battery-staple");
      const { cookieHeader, csrfToken } = await loginAs(baseUrl, "auth-mut-pwshort", "correct-horse-battery-staple");
      const res = await fetch(`${baseUrl}/admin-api/auth/me/password`, {
        method: "PATCH",
        headers: sessionHeaders(cookieHeader, csrfToken),
        body: JSON.stringify({ current_password: "correct-horse-battery-staple", new_password: "12345678901" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("current_password and new_password (min 12 chars) are required");
    });
  });

  // Kills the `<` -> `<=` boundary direction: exactly 12 chars must pass.
  test("an exactly-12-character new_password passes validation (with correct current_password)", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-pwboundary", "correct-horse-battery-staple");
      const { cookieHeader, csrfToken } = await loginAs(baseUrl, "auth-mut-pwboundary", "correct-horse-battery-staple");
      const res = await fetch(`${baseUrl}/admin-api/auth/me/password`, {
        method: "PATCH",
        headers: sessionHeaders(cookieHeader, csrfToken),
        body: JSON.stringify({ current_password: "correct-horse-battery-staple", new_password: "123456789012" }),
      });
      expect(res.status).toBe(200);
    });
  });

  // Kills 129 (LogicalOperator `!user || !valid` -> `&&`), 131 (`!valid`
  // negation removed), 132 (the 401 block emptied), 133/134 (the exact
  // code/message emptied) — a real user with the WRONG current password.
  test("the wrong current_password returns the exact 401 INVALID_CREDENTIALS", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-pwwrong", "correct-horse-battery-staple");
      const { cookieHeader, csrfToken } = await loginAs(baseUrl, "auth-mut-pwwrong", "correct-horse-battery-staple");
      const res = await fetch(`${baseUrl}/admin-api/auth/me/password`, {
        method: "PATCH",
        headers: sessionHeaders(cookieHeader, csrfToken),
        body: JSON.stringify({ current_password: "totally-wrong-password", new_password: "new-password-12" }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_CREDENTIALS");
      expect(body.error.message).toBe("Current password is incorrect");
    });
  });

  // Kills 125 (the `.catch(() => false)` arrow's `false` replaced by
  // `true`, at the hash-comparison call site): Bun.password.verify only
  // throws (reaching the catch) for a malformed hash, which never happens
  // via the normal seed path — a corrupt stored hash is written directly
  // to force that branch, mirroring the same technique used for login.
  // NOTE: the hash must be corrupted AFTER a real login (which itself
  // verifies against the SAME stored hash) — corrupting it up front would
  // make even the initial login fail, leaving no valid session to drive
  // this request with.
  test("a corrupt stored password hash fails closed on password change (not treated as valid)", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-pwcorrupthash", "correct-horse-battery-staple");
      const { cookieHeader, csrfToken } = await loginAs(
        baseUrl,
        "auth-mut-pwcorrupthash",
        "correct-horse-battery-staple",
      );
      updatePassword("auth-mut-pwcorrupthash", "not-a-real-argon2-hash");
      const res = await fetch(`${baseUrl}/admin-api/auth/me/password`, {
        method: "PATCH",
        headers: sessionHeaders(cookieHeader, csrfToken),
        body: JSON.stringify({ current_password: "whatever-current-pw", new_password: "new-password-1234" }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_CREDENTIALS");
    });
  });

  // Defense-in-depth for the `!user` clause of `if (!user || !valid)`, using
  // the same findUserByUsername-spy technique as the corrupt-hash test
  // above to reach a `user === null` state without disturbing adminAuth's
  // own session validation (which uses a different function,
  // findUserById). NOTE: this does NOT kill mutant 126 (the ternary's
  // outer `: false` -> `: true` on the `valid` fallback when user is
  // null) — confirmed equivalent by hand-mutation: `!user` alone already
  // short-circuits the `||` to true whenever user is null, so `valid`'s
  // value in that branch can never affect the outcome. Kept anyway as a
  // regression guard on the `!user` clause itself.
  test("the handler's own user lookup returning null is treated as invalid, not valid", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-pwghost", "correct-horse-battery-staple");
      const { cookieHeader, csrfToken } = await loginAs(baseUrl, "auth-mut-pwghost", "correct-horse-battery-staple");
      const spy = spyOn(userStoreMod, "findUserByUsername");
      spy.mockReturnValue(null);
      try {
        const res = await fetch(`${baseUrl}/admin-api/auth/me/password`, {
          method: "PATCH",
          headers: sessionHeaders(cookieHeader, csrfToken),
          body: JSON.stringify({ current_password: "correct-horse-battery-staple", new_password: "new-password-1234" }),
        });
        expect(res.status).toBe(401);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe("INVALID_CREDENTIALS");
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Full success path. Kills 130 (`!user` negation removed — a truthy user
  // object would wrongly satisfy the OR), 94/95/96 (the ctx guard's
  // clause-B/clause-C mutants, which for a genuine valid session flip the
  // guard to incorrectly forbid), 122/123 (the update block emptied /
  // audit-adjacent message emptied — N/A here, this file has no audit
  // calls, but the block-emptied direction would skip updatePassword
  // entirely), 124/125/126 (Bun.password.hash arrow/booleans — indirectly,
  // a wrong hash would break the "new password works" follow-up login),
  // 135/136 (req.socket?.remoteAddress / the "user-agent" key on the NEW
  // session), 137/138/139 (the log("info", "Admin password changed", ...)
  // call), and 140/141 (the response object/csrf_token key emptied).
  test("a valid password change updates the hash, revokes old sessions, issues a new one, and logs it", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-pwok", "correct-horse-battery-staple");
      const { cookieHeader: oldCookie, csrfToken: oldCsrf } = await loginAs(
        baseUrl,
        "auth-mut-pwok",
        "correct-horse-battery-staple",
      );
      const logSpy = spyOn(loggerMod, "log");
      try {
        const res = await fetch(`${baseUrl}/admin-api/auth/me/password`, {
          method: "PATCH",
          headers: { ...sessionHeaders(oldCookie, oldCsrf), "User-Agent": "auth-mut-pw-agent/1.0" },
          body: JSON.stringify({
            current_password: "correct-horse-battery-staple",
            new_password: "brand-new-password-123",
          }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; csrf_token: string };
        expect(body.status).toBe("password_changed");
        expect(typeof body.csrf_token).toBe("string");
        expect(body.csrf_token).not.toBe(oldCsrf);

        expect(logSpy).toHaveBeenCalledWith(
          "info",
          "Admin password changed",
          expect.objectContaining({ username: "auth-mut-pwok" }),
        );

        // The old session must be revoked (revokeAllSessionsForUser).
        const meWithOld = await fetch(`${baseUrl}/admin-api/auth/me`, { headers: { Cookie: oldCookie } });
        expect(meWithOld.status).toBe(401);

        // A fresh session was issued and its cookies were set on THIS response.
        const newCookieHeader = cookieHeaderFrom(res);
        expect(newCookieHeader).not.toBe("");
        const meWithNew = await fetch(`${baseUrl}/admin-api/auth/me`, { headers: { Cookie: newCookieHeader } });
        expect(meWithNew.status).toBe(200);

        // The new session recorded the real User-Agent (kills 136).
        const sessionsRes = await fetch(`${baseUrl}/admin-api/auth/sessions`, { headers: { Cookie: newCookieHeader } });
        const sessionsBody = (await sessionsRes.json()) as { sessions: { userAgent: string | null }[] };
        expect(sessionsBody.sessions.some((s) => s.userAgent === "auth-mut-pw-agent/1.0")).toBe(true);

        // The password was actually changed (login with the NEW password works).
        const reloginRes = await fetch(`${baseUrl}/admin-api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "auth-mut-pwok", password: "brand-new-password-123" }),
        });
        expect(reloginRes.status).toBe(200);
      } finally {
        logSpy.mockRestore();
      }
    });
  });
});

describe("GET /admin-api/auth/sessions", () => {
  // Kills the `!ctx || ctx.method !== "session" || ctx.userId === undefined`
  // guard's crash-vs-clean-403 mutants (undefined ctx branch), same
  // reasoning as the password route's own copy of this guard.
  test("no auth context at all (authDisabled, no headers) returns the exact 403 FORBIDDEN", async () => {
    await withApp(async (baseUrl) => {
      await withConfig({ authDisabled: true }, async () => {
        const res = await fetch(`${baseUrl}/admin-api/auth/sessions`);
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("FORBIDDEN");
        expect(body.error.message).toBe("Requires a session-authenticated user");
      });
    });
  });

  test("Bearer auth (not session-authenticated) returns the exact 403 FORBIDDEN", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/auth/sessions`, { headers: bearer() });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toBe("Requires a session-authenticated user");
    });
  });

  // Full success path with >= 2 DISTINCT sessions (two separate logins) so
  // the response can't be mistaken for an unfiltered/hardcoded single
  // result. Kills the ctx guard's clause-B/clause-C mutants for a genuine
  // valid session (94/95/96-equivalent at this call site) and 158 (the
  // `{ sessions: ... }` ObjectLiteral emptied).
  test("returns exactly the caller's own active sessions", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-sessions", "correct-horse-battery-staple");
      const first = await loginAs(baseUrl, "auth-mut-sessions", "correct-horse-battery-staple");
      const second = await loginAs(baseUrl, "auth-mut-sessions", "correct-horse-battery-staple");
      expect(first.cookieHeader).not.toBe(second.cookieHeader);

      const res = await fetch(`${baseUrl}/admin-api/auth/sessions`, { headers: { Cookie: second.cookieHeader } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: { id: number }[] };
      expect(Array.isArray(body.sessions)).toBe(true);
      expect(body.sessions.length).toBe(2);
    });
  });
});

describe("DELETE /admin-api/auth/sessions/:id", () => {
  test("no auth context at all (authDisabled, no headers) returns the exact 403 FORBIDDEN", async () => {
    await withApp(async (baseUrl) => {
      await withConfig({ authDisabled: true }, async () => {
        const res = await fetch(`${baseUrl}/admin-api/auth/sessions/1`, { method: "DELETE" });
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("FORBIDDEN");
        expect(body.error.message).toBe("Requires a session-authenticated user");
      });
    });
  });

  test("Bearer auth (not session-authenticated) returns the exact 403 FORBIDDEN", async () => {
    await withApp(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin-api/auth/sessions/1`, { method: "DELETE", headers: bearer() });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toBe("Requires a session-authenticated user");
    });
  });

  // Kills 175/176/177 (Number.isInteger BooleanLiteral/ConditionalExpression
  // forced) — a non-numeric id.
  test("a non-numeric session id returns the exact 400 VALIDATION_ERROR", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-delbadid", "correct-horse-battery-staple");
      const { cookieHeader, csrfToken } = await loginAs(baseUrl, "auth-mut-delbadid", "correct-horse-battery-staple");
      const res = await fetch(`${baseUrl}/admin-api/auth/sessions/not-a-number`, {
        method: "DELETE",
        headers: sessionHeaders(cookieHeader, csrfToken),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toBe("Invalid session id");
    });
  });

  // Boundary: a non-integer NUMBER (not just a non-numeric string) must
  // also fail — this is the direction that actually distinguishes
  // Number.isInteger's forced-true mutant (a forced-true would let 1.5
  // through to revokeSessionById, which finds no matching row and would
  // return 404 instead of the real code's 400).
  test("a decimal session id returns the exact 400 VALIDATION_ERROR", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-deldecimal", "correct-horse-battery-staple");
      const { cookieHeader, csrfToken } = await loginAs(baseUrl, "auth-mut-deldecimal", "correct-horse-battery-staple");
      const res = await fetch(`${baseUrl}/admin-api/auth/sessions/1.5`, {
        method: "DELETE",
        headers: sessionHeaders(cookieHeader, csrfToken),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // Kills 180/181/182 (the `!revoked` BooleanLiteral/ConditionalExpression)
  // and 184/185 (the exact 404 code/message) — a well-formed id that isn't
  // an active session of the caller's.
  test("an unknown session id returns the exact 404 SESSION_NOT_FOUND", async () => {
    await withApp(async (baseUrl) => {
      await seedUser("auth-mut-delunknown", "correct-horse-battery-staple");
      const { cookieHeader, csrfToken } = await loginAs(baseUrl, "auth-mut-delunknown", "correct-horse-battery-staple");
      const res = await fetch(`${baseUrl}/admin-api/auth/sessions/999999`, {
        method: "DELETE",
        headers: sessionHeaders(cookieHeader, csrfToken),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("SESSION_NOT_FOUND");
      expect(body.error.message).toBe("Session not found");
    });
  });

  // Full success path. Kills 186 (the response ObjectLiteral emptied) and
  // 187 ("revoked" literal emptied), and proves the revocation is REAL
  // (not just a 200) by checking the session disappears from the list and
  // a second delete of the same id now 404s.
  //
  // GOTCHA: GET /sessions authenticates via validateSession, which touches
  // the AUTHENTICATING cookie's own last_seen_at (sliding window) as a side
  // effect — listing sessions with the "keep" cookie makes it sort FIRST
  // (most recent), so naively picking sessions[0] actually targets the
  // wrong (authenticating) session. A distinct User-Agent per login plus a
  // direct call to the real listActiveSessionsForUser entity function
  // (bypassing HTTP/side effects entirely) identifies the target
  // deterministically instead.
  test("revoking one's own session returns the exact response shape and actually revokes it", async () => {
    await withApp(async (baseUrl) => {
      const user = await seedUser("auth-mut-delok", "correct-horse-battery-staple");
      const target = await loginAs(baseUrl, "auth-mut-delok", "correct-horse-battery-staple", {
        "User-Agent": "auth-mut-target-agent",
      });
      const actor = await loginAs(baseUrl, "auth-mut-delok", "correct-horse-battery-staple", {
        "User-Agent": "auth-mut-actor-agent",
      });

      const before = listActiveSessionsForUser(user.id);
      expect(before.length).toBe(2);
      const targetSession = before.find((s) => s.userAgent === "auth-mut-target-agent");
      expect(targetSession).toBeDefined();
      const targetId = targetSession!.id;

      const res = await fetch(`${baseUrl}/admin-api/auth/sessions/${targetId}`, {
        method: "DELETE",
        headers: sessionHeaders(actor.cookieHeader, actor.csrfToken),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body).toEqual({ status: "revoked" });

      const after = listActiveSessionsForUser(user.id);
      expect(after.some((s) => s.id === targetId)).toBe(false);
      expect(after.length).toBe(1);

      const secondDelete = await fetch(`${baseUrl}/admin-api/auth/sessions/${targetId}`, {
        method: "DELETE",
        headers: sessionHeaders(actor.cookieHeader, actor.csrfToken),
      });
      expect(secondDelete.status).toBe(404);
      void target;
    });
  });
});

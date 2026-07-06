/**
 * HTTP-level tests for src/routes/auth.ts — real express() instance + native
 * fetch(), matching the transports.test.ts convention. Native fetch has no
 * cookie jar, so cookies from Set-Cookie are captured manually and threaded
 * into subsequent requests.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { createUser } from "../../security/user-store.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../security/cookies.js";

import { withConfig } from "../../__tests__/_utils/with-config.js";
let baseUrl = "";
let activeServer: Server | null = null;

async function startApp(): Promise<() => void> {
  __resetDbForTesting();
  const { authRoutes } = await import("../../routes/auth.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use(requestIdMiddleware);
  authRoutes(app);

  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      activeServer = srv;
      resolve(() => {});
    });
    srv.on("error", reject);
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (activeServer) {
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

/** Extracts `name=value` pairs from Set-Cookie headers, dropping attributes, for re-sending on the next request. */
function cookieHeaderFrom(res: Response): string {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

const originalRateLimitLogin = config.rateLimitLogin;

beforeEach(() => {
  (config as Record<string, unknown>).rateLimitLogin = originalRateLimitLogin;
});

afterEach(async () => {
  (config as Record<string, unknown>).rateLimitLogin = originalRateLimitLogin;
  await stopServer();
});

async function seedUser(username: string, password: string) {
  const hash = await Bun.password.hash(password);
  return createUser(username, hash, "admin", null);
}

describe("POST /admin-api/auth/login", () => {
  test("valid credentials return 200, set both cookies, and echo the CSRF token in the body", async () => {
    await startApp();
    await seedUser("alice", "correct-horse-battery-staple");

    const res = await fetch(`${baseUrl}/admin-api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "correct-horse-battery-staple" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { username: string; role: string }; csrf_token: string };
    expect(body.user).toEqual({ username: "alice", role: "admin" });
    expect(typeof body.csrf_token).toBe("string");

    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(true);
    expect(setCookies.some((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`))).toBe(true);
    // Session cookie must be httpOnly; CSRF cookie must NOT be (JS needs to read it).
    const sessionCookie = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))!;
    const csrfCookie = setCookies.find((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`))!;
    expect(sessionCookie.toLowerCase()).toContain("httponly");
    expect(csrfCookie.toLowerCase()).not.toContain("httponly");
  });

  test("wrong password returns 401 INVALID_CREDENTIALS", async () => {
    await startApp();
    await seedUser("alice", "correct-horse-battery-staple");

    const res = await fetch(`${baseUrl}/admin-api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "wrong-password" }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_CREDENTIALS");
  });

  test("unknown username returns the SAME 401 INVALID_CREDENTIALS (no user-enumeration signal)", async () => {
    await startApp();

    const res = await fetch(`${baseUrl}/admin-api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "nobody", password: "whatever-12345" }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_CREDENTIALS");
  });

  test("missing username/password returns 400 VALIDATION_ERROR", async () => {
    await startApp();

    const res = await fetch(`${baseUrl}/admin-api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  test("is rate-limited per IP after the configured cap", async () => {
    await withConfig({ rateLimitLogin: 2 }, async () => {
      await startApp();
      await seedUser("alice", "correct-horse-battery-staple");

      const attempt = () =>
        fetch(`${baseUrl}/admin-api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "alice", password: "wrong" }),
        });

      await attempt();
      await attempt();
      const third = await attempt();
      expect(third.status).toBe(429);
    });
  });
});

describe("GET /admin-api/auth/me", () => {
  test("returns 401 with no cookie at all", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/auth/me`);
    expect(res.status).toBe(401);
  });

  test("returns session identity when called with a valid session cookie", async () => {
    await startApp();
    await seedUser("alice", "correct-horse-battery-staple");

    const loginRes = await fetch(`${baseUrl}/admin-api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "correct-horse-battery-staple" }),
    });
    const cookieHeader = cookieHeaderFrom(loginRes);

    const meRes = await fetch(`${baseUrl}/admin-api/auth/me`, { headers: { Cookie: cookieHeader } });
    expect(meRes.status).toBe(200);
    const body = (await meRes.json()) as { authenticated: boolean; auth_method: string; user: { username: string } };
    expect(body.authenticated).toBe(true);
    expect(body.auth_method).toBe("session");
    expect(body.user.username).toBe("alice");
  });
});

describe("POST /admin-api/auth/logout", () => {
  test("requires CSRF header (it's a mutating, session-authenticated request)", async () => {
    await startApp();
    await seedUser("alice", "correct-horse-battery-staple");

    const loginRes = await fetch(`${baseUrl}/admin-api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "correct-horse-battery-staple" }),
    });
    const cookieHeader = cookieHeaderFrom(loginRes);

    const noCSRF = await fetch(`${baseUrl}/admin-api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookieHeader },
    });
    expect(noCSRF.status).toBe(403);
  });

  test("with a valid CSRF header, revokes the session so it can no longer be used", async () => {
    await startApp();
    await seedUser("alice", "correct-horse-battery-staple");

    const loginRes = await fetch(`${baseUrl}/admin-api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "correct-horse-battery-staple" }),
    });
    const cookieHeader = cookieHeaderFrom(loginRes);
    const { csrf_token } = (await loginRes.json()) as { csrf_token: string };

    const logoutRes = await fetch(`${baseUrl}/admin-api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookieHeader, "X-CSRF-Token": csrf_token },
    });
    expect(logoutRes.status).toBe(200);

    const meRes = await fetch(`${baseUrl}/admin-api/auth/me`, { headers: { Cookie: cookieHeader } });
    expect(meRes.status).toBe(401);
  });
});

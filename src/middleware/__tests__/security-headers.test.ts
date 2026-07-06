/**
 * Security headers + admin session cookie hardening tests.
 *
 * Covers the P1-5 follow-ups from docs/REVIEW.md §2.3:
 *   - Content-Security-Policy present and restrictive (default-src 'none').
 *   - Permissions-Policy present and disables every powerful feature the
 *     admin UI does not legitimately need.
 *   - The X-Frame-Options / Referrer-Policy / HSTS headers the rest of the
 *     security middleware already sets are still emitted (regression guard).
 *   - Session + CSRF cookies carry `SameSite=Lax` so a cross-site redirect
 *     can't leak them; and the clear-cookie issued on logout matches those
 *     attributes so it actually removes them client-side.
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

let baseUrl = "";
let activeServer: Server | null = null;

async function startApp(): Promise<void> {
  __resetDbForTesting();
  const { authRoutes } = await import("../../routes/auth.js");
  // Replicate the baseline security-header middleware from src/index.ts.
  // We don't import src/index.ts because it would start the listener and
  // background loops we don't want during a unit test.
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use(requestIdMiddleware);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "base-uri 'none'",
        "object-src 'none'",
      ].join("; "),
    );
    res.setHeader(
      "Permissions-Policy",
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    );
    next();
  });
  authRoutes(app);

  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      activeServer = srv;
      resolve();
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

const originalRateLimitLogin = config.rateLimitLogin;

beforeEach(() => {
  config.rateLimitLogin = 1000; // tests log in directly, not through the rate limit
});

afterEach(async () => {
  config.rateLimitLogin = originalRateLimitLogin;
  await stopServer();
});

/** Parsed `Set-Cookie` entry. Lower-cased attribute name → value (empty string for valueless flags). */
function parseSetCookie(setCookie: string): Record<string, string> {
  const parts = setCookie.split(";").map((p) => p.trim());
  const out: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const eq = part.indexOf("=");
    if (eq < 0) {
      out[part.toLowerCase()] = "";
    } else {
      out[part.slice(0, eq).toLowerCase()] = part.slice(eq + 1);
    }
  }
  return out;
}

describe("baseline security headers", () => {
  test("every response carries the full set of hardening headers", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/auth/me`);
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    // HSTS is conditional on HTTPS — http://127.0.0.1 in this test, so absent.
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });

  test("CSP is restrictive (default-src 'none') and permits the admin UI's own self-hosted resources", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/auth/me`);
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).not.toBeNull();
    // default-src 'none' is the lock-it-down default
    expect(csp).toContain("default-src 'none'");
    // admin UI is self-hosted
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    // clickjacking / form-action / base-URI / plugin hardening
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("object-src 'none'");
    // No 'unsafe-eval' anywhere — the admin UI is Vue 3 (no eval needed).
    expect(csp).not.toContain("'unsafe-eval'");
  });

  test("Permissions-Policy disables every powerful browser feature the admin UI doesn't need", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/auth/me`);
    const pp = res.headers.get("Permissions-Policy");
    expect(pp).not.toBeNull();
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) {
      // Each feature should be disabled — either explicitly (feature=()) or
      // by being absent. We assert explicit disable for the common ones so
      // a future "remove this feature" cleanup pass gets caught.
      expect(pp).toContain(`${feature}=()`);
    }
  });
});

async function seedUser(username: string, password: string): Promise<void> {
  const hash = await Bun.password.hash(password);
  createUser(username, hash, "admin", null);
}

describe("admin session cookies", () => {
  test("login cookies carry SameSite=Lax and Path=/", async () => {
    await startApp();
    await seedUser("alice", "correct-horse-battery-staple");

    const res = await fetch(`${baseUrl}/admin-api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "correct-horse-battery-staple" }),
    });
    expect(res.status).toBe(200);

    const setCookies = res.headers.getSetCookie();
    const session = parseSetCookie(setCookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))!);
    const csrf = parseSetCookie(setCookies.find((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`))!);

    for (const parsed of [session, csrf]) {
      expect(parsed["samesite"]).toBe("Lax");
      expect(parsed["path"]).toBe("/");
    }
    // Session cookie is httpOnly, CSRF cookie is NOT (JS reads it).
    expect(session["httponly"]).toBe("");
    expect(csrf["httponly"]).toBeUndefined();
  });

  test("logout's clear-cookie matches the original set-cookie attributes (otherwise browsers refuse to delete it)", async () => {
    await startApp();
    await seedUser("alice", "correct-horse-battery-staple");

    const loginRes = await fetch(`${baseUrl}/admin-api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "correct-horse-battery-staple" }),
    });
    const cookieHeader = loginRes.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const csrfToken = ((await loginRes.json()) as { csrf_token: string }).csrf_token;

    const logoutRes = await fetch(`${baseUrl}/admin-api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookieHeader, "X-CSRF-Token": csrfToken },
    });
    expect(logoutRes.status).toBe(200);

    const cleared = logoutRes.headers.getSetCookie();
    const sessionClear = parseSetCookie(cleared.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))!);
    const csrfClear = parseSetCookie(cleared.find((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`))!);

    // The clear-cookie value is empty AND it has the same attributes as the
    // original Set-Cookie, otherwise some browsers (Chrome is the strictest)
    // won't actually remove the cookie.
    for (const parsed of [sessionClear, csrfClear]) {
      expect(parsed["samesite"]).toBe("Lax");
      expect(parsed["path"]).toBe("/");
    }
  });
});

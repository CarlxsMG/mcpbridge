/**
 * HTTP-level tests for src/routes/upstream-auth.ts — mirrors the routes-admin
 * harness (real express() + native fetch, Bearer admin auth, in-memory DB).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { clearRegistry } from "../../__tests__/_utils/registry.js";
import { listen } from "../../__tests__/_utils/app.js";
import { jsonBearerHeaders, setAdminApiKeys } from "../../__tests__/_utils/admin-auth.js";
import express from "express";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import { createUser } from "../../security/user-store.js";
import { createSession } from "../../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../security/cookies.js";
import type { RestToolDefinition } from "../../mcp/types.js";

let baseUrl = "";
let activeServer: Server | null = null;
const ADMIN_KEY = "test-admin-key";
const originalKey = config.secretEncryptionKey;

function makeTool(): RestToolDefinition {
  return {
    name: "get-users",
    method: "GET",
    endpoint: "/users",
    description: "list",
    inputSchema: { type: "object", properties: {} },
  };
}

async function startApp(withSecretBox = true): Promise<void> {
  __resetDbForTesting();
  setAdminApiKeys([ADMIN_KEY]);
  (config as Record<string, unknown>).authDisabled = false;
  (config as Record<string, unknown>).secretEncryptionKey = withSecretBox
    ? Buffer.alloc(32, 3).toString("base64")
    : undefined;

  const { adminRoutes } = await import("../../routes/admin.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use(requestIdMiddleware);
  adminRoutes(app);

  ({ baseUrl, server: activeServer } = await listen(app));
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (activeServer)
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    else resolve();
  });
}

const bearer = (): Record<string, string> => jsonBearerHeaders(ADMIN_KEY);

async function reg(name: string): Promise<void> {
  await registry.register(name, [makeTool()], "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

afterEach(async () => {
  await clearRegistry();
  await stopServer();
  (config as Record<string, unknown>).secretEncryptionKey = originalKey;
});

describe("PUT/GET/DELETE /admin-api/clients/:name/upstream-auth", () => {
  test("set bearer, read info, then clear", async () => {
    await startApp();
    await reg("svc");

    const put = await fetch(`${baseUrl}/admin-api/clients/svc/upstream-auth`, {
      method: "PUT",
      headers: bearer(),
      body: JSON.stringify({ type: "bearer", token: "sekret" }),
    });
    expect(put.status).toBe(200);

    const get = await fetch(`${baseUrl}/admin-api/clients/svc/upstream-auth`, { headers: bearer() });
    const info = (await get.json()) as { configured: boolean; type: string };
    expect(info.configured).toBe(true);
    expect(info.type).toBe("bearer");
    // The secret is never returned.
    expect(JSON.stringify(info)).not.toContain("sekret");

    const del = await fetch(`${baseUrl}/admin-api/clients/svc/upstream-auth`, { method: "DELETE", headers: bearer() });
    expect(del.status).toBe(200);
    const del2 = await fetch(`${baseUrl}/admin-api/clients/svc/upstream-auth`, { method: "DELETE", headers: bearer() });
    expect(del2.status).toBe(404);
  });

  test("501 when the secret box is not configured", async () => {
    await startApp(false);
    await reg("svc");
    const put = await fetch(`${baseUrl}/admin-api/clients/svc/upstream-auth`, {
      method: "PUT",
      headers: bearer(),
      body: JSON.stringify({ type: "bearer", token: "x" }),
    });
    expect(put.status).toBe(501);
  });

  test("400 for an invalid type", async () => {
    await startApp();
    await reg("svc");
    const put = await fetch(`${baseUrl}/admin-api/clients/svc/upstream-auth`, {
      method: "PUT",
      headers: bearer(),
      body: JSON.stringify({ type: "oauth5" }),
    });
    expect(put.status).toBe(400);
  });

  test("400 for a forbidden custom header name", async () => {
    await startApp();
    await reg("svc");
    const put = await fetch(`${baseUrl}/admin-api/clients/svc/upstream-auth`, {
      method: "PUT",
      headers: bearer(),
      body: JSON.stringify({ type: "header", headerName: "Host", value: "evil" }),
    });
    expect(put.status).toBe(400);
  });

  test("404 for an unknown client", async () => {
    await startApp();
    const get = await fetch(`${baseUrl}/admin-api/clients/ghost/upstream-auth`, { headers: bearer() });
    expect(get.status).toBe(404);
  });

  test("requires auth", async () => {
    await startApp();
    await reg("svc");
    const get = await fetch(`${baseUrl}/admin-api/clients/svc/upstream-auth`);
    expect(get.status).toBe(401);
  });

  test("a viewer session cannot set upstream auth (403)", async () => {
    await startApp();
    await reg("svc");
    const viewer = createUser("viewer-user", "irrelevant-hash", "viewer", null);
    const session = createSession(viewer.id, "127.0.0.1", "agent");
    const put = await fetch(`${baseUrl}/admin-api/clients/svc/upstream-auth`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE_NAME}=${session.token}; ${CSRF_COOKIE_NAME}=${session.csrfToken}`,
        "X-CSRF-Token": session.csrfToken,
      },
      body: JSON.stringify({ type: "bearer", token: "x" }),
    });
    expect(put.status).toBe(403);
  });
});

/**
 * The upstream-auth writes store a backend's credentials, so they carry a
 * per-route cap rather than sitting at the global ceiling — every other
 * credential surface in this repo already does (login 10/min, backup 5,
 * register 10, sso 20), and this one sat at 1000.
 *
 * Driving the real Express stack is the only thing that distinguishes "the
 * middleware is imported" from "the middleware is actually mounted". The exact
 * cutoff is deliberately not asserted: `rateLimitExpensive(...,
 * config.rateLimitExpensive)` binds its max when the router module is first
 * imported, so it reflects whatever config held then — which depends on file
 * order across the shared test process. "The first call passes, some later call
 * 429s, and it stays 429" is the property that tells a mounted limiter from an
 * absent one.
 *
 * CodeQL alert #107 (js/missing-rate-limiting) named this handler. It was
 * wrong on its own terms — `rateLimitGlobal` already covered it, the query
 * just cannot see this repo's hand-rolled middleware — but the tighter cap it
 * prompted is a real improvement, and this test is what keeps it.
 */
describe("PUT/DELETE upstream-auth — per-route credential cap", () => {
  test("repeated writes start 429ing, and stay 429 for the rest of the window", async () => {
    await startApp();
    await reg("rl-svc");

    const write = (): Promise<globalThis.Response> =>
      fetch(`${baseUrl}/admin-api/clients/rl-svc/upstream-auth`, {
        method: "PUT",
        headers: jsonBearerHeaders(ADMIN_KEY),
        body: JSON.stringify({ type: "bearer", token: "t" }),
      });

    expect((await write()).status, "the very first call was already limited").toBe(200);

    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await write()).status);

    const firstLimited = statuses.indexOf(429);
    expect(firstLimited, `no call was ever rate limited: ${JSON.stringify(statuses)}`).toBeGreaterThanOrEqual(0);
    // Every status is one of the two expected outcomes — a 500 hiding in here
    // would otherwise satisfy "not 200" without proving anything.
    expect(new Set(statuses.slice(0, firstLimited))).toEqual(firstLimited === 0 ? new Set() : new Set([200]));
    expect(new Set(statuses.slice(firstLimited))).toEqual(new Set([429]));
  });

  test("DELETE shares the PUT's bucket — alternating the two must not double the budget", async () => {
    await startApp();
    await reg("rl-shared");

    const put = (): Promise<globalThis.Response> =>
      fetch(`${baseUrl}/admin-api/clients/rl-shared/upstream-auth`, {
        method: "PUT",
        headers: jsonBearerHeaders(ADMIN_KEY),
        body: JSON.stringify({ type: "bearer", token: "t" }),
      });
    const del = (): Promise<globalThis.Response> =>
      fetch(`${baseUrl}/admin-api/clients/rl-shared/upstream-auth`, {
        method: "DELETE",
        headers: jsonBearerHeaders(ADMIN_KEY),
      });

    // Spend the budget on PUTs alone...
    for (let i = 0; i < 40; i++) await put();
    // ...then a DELETE must already be refused, which it only can be if it
    // reads the same bucket rather than opening a second one.
    expect((await del()).status).toBe(429);
  });
});

/**
 * HTTP-level tests for src/routes/upstream-auth.ts — mirrors the routes-admin
 * harness (real express() + native fetch, Bearer admin auth, in-memory DB).
 */
import { describe, test, expect, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import { createUser } from "../security/user-store.js";
import { createSession } from "../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../security/cookies.js";
import type { RestToolDefinition } from "../mcp/types.js";

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
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  (config as Record<string, unknown>).secretEncryptionKey = withSecretBox
    ? Buffer.alloc(32, 3).toString("base64")
    : undefined;

  const { upstreamAuthRoutes } = await import("../routes/upstream-auth.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use(requestIdMiddleware);
  upstreamAuthRoutes(app);

  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      activeServer = srv;
      resolve();
    });
    srv.on("error", reject);
  });
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

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
}

async function reg(name: string): Promise<void> {
  await registry.register(name, [makeTool()], "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
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

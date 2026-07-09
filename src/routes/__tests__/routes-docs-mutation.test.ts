/**
 * Stryker mutation-testing backstop for src/routes/docs.ts — domain 8.
 *
 * Baseline: 7 mutants, 0 killed / 7 survived — docs.ts had ZERO test coverage
 * of any kind before this file. All line:col citations below were read
 * directly from reports/mutation/result.json.
 */
import { describe, test, expect, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";

let activeServer: Server | null = null;
const originalNodeEnv = process.env.NODE_ENV;
const ADMIN_KEY = "test-admin-key-docs";
const originalAdminApiKeys = config.adminApiKeys;
const originalAuthDisabled = config.authDisabled;

async function startApp(nodeEnv: string): Promise<string> {
  process.env.NODE_ENV = nodeEnv;
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;

  const { docsRoutes } = await import("../../routes/docs.js");
  const app = express();
  docsRoutes(app);

  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      activeServer = srv;
      resolve(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
    });
    srv.on("error", reject);
  });
}

afterEach(async () => {
  process.env.NODE_ENV = originalNodeEnv;
  (config as Record<string, unknown>).adminApiKeys = originalAdminApiKeys;
  (config as Record<string, unknown>).authDisabled = originalAuthDisabled;
  await new Promise<void>((resolve) => {
    if (activeServer)
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    else resolve();
  });
});

describe("docsRoutes — the NODE_ENV=development guard bypass", () => {
  // Kills 14:5-14:43 (ConditionalExpression true/false, EqualityOperator
  // '!==') and 14:30-14:43 (StringLiteral, "development" emptied) — in
  // development mode, /docs must be reachable with NO Authorization header.
  test("in development mode, /docs is reachable without any Authorization header", async () => {
    const baseUrl = await startApp("development");
    const res = await fetch(`${baseUrl}/docs/`);
    expect(res.status).not.toBe(401);
  });

  // Kills the SAME mutants from the opposite direction — outside development
  // mode, /docs must require admin auth (401 without a valid Bearer key).
  test("outside development mode, /docs requires admin auth", async () => {
    const baseUrl = await startApp("test");
    const res = await fetch(`${baseUrl}/docs/`);
    expect(res.status).toBe(401);
  });

  test("outside development mode, a valid Bearer key reaches /docs", async () => {
    const baseUrl = await startApp("test");
    const res = await fetch(`${baseUrl}/docs/`, { headers: { Authorization: `Bearer ${ADMIN_KEY}` } });
    expect(res.status).not.toBe(401);
  });
});

describe("docsRoutes — the dev-mode passthrough actually calls next()", () => {
  // Kills 14:46-14:107 ArrowFunction (the `(_req, _res, next) => next()`
  // passthrough replaced with a no-op that never calls next -- the request
  // would hang/never resolve past the guard). A real HTTP round-trip that
  // resolves at all (not a timeout) proves next() was actually invoked.
  test("a development-mode request resolves rather than hanging on an un-invoked next()", async () => {
    const baseUrl = await startApp("development");
    const res = await fetch(`${baseUrl}/docs/`);
    expect(res.status).toBeLessThan(500);
  });
});

describe("docsRoutes — mounted at the exact /docs path", () => {
  // Kills 12:48-17:2 BlockStatement (the whole function body emptied -- no
  // route would be wired at all) and 16:11-16:18 StringLiteral (the "/docs"
  // mount path emptied, which would mount the middleware at "/" instead,
  // making it also match unrelated paths).
  test("an unrelated path is NOT served by the docs middleware", async () => {
    const baseUrl = await startApp("development");
    const res = await fetch(`${baseUrl}/totally-unrelated-path`);
    expect(res.status).toBe(404);
  });

  test("/docs itself IS served (the route is genuinely wired)", async () => {
    const baseUrl = await startApp("development");
    const res = await fetch(`${baseUrl}/docs/`);
    expect(res.status).not.toBe(404);
  });
});

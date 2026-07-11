/**
 * Stryker mutation-testing backstop for src/routes/docs.ts — domain 8.
 *
 * /docs (Swagger UI + the full OpenAPI spec) is admin-authenticated by default;
 * EXPOSE_DOCS_UNAUTHENTICATED=true is the explicit opt-in that serves it
 * publicly. (Previously the bypass was tied to NODE_ENV=development, which risked
 * exposing the whole API surface on a staging deploy that inherited that env —
 * the explicit opt-in is fail-secure.)
 */
import { describe, test, expect, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";

let activeServer: Server | null = null;
const originalExposeDocs = process.env.EXPOSE_DOCS_UNAUTHENTICATED;
const ADMIN_KEY = "test-admin-key-docs";
const originalAdminApiKeys = config.adminApiKeys;
const originalAuthDisabled = config.authDisabled;

async function startApp(exposeDocs: boolean): Promise<string> {
  if (exposeDocs) process.env.EXPOSE_DOCS_UNAUTHENTICATED = "true";
  else delete process.env.EXPOSE_DOCS_UNAUTHENTICATED;
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
  if (originalExposeDocs === undefined) delete process.env.EXPOSE_DOCS_UNAUTHENTICATED;
  else process.env.EXPOSE_DOCS_UNAUTHENTICATED = originalExposeDocs;
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

describe("docsRoutes — the EXPOSE_DOCS_UNAUTHENTICATED opt-in", () => {
  // Kills the ConditionalExpression (true/false), the EqualityOperator, and the
  // "true" / env-name StringLiterals — with the opt-in set, /docs must be
  // reachable with NO Authorization header.
  test("with EXPOSE_DOCS_UNAUTHENTICATED=true, /docs is reachable without any Authorization header", async () => {
    const baseUrl = await startApp(true);
    const res = await fetch(`${baseUrl}/docs/`);
    expect(res.status).not.toBe(401);
  });

  // The SAME mutants from the opposite direction — without the opt-in, /docs
  // must require admin auth (401 without a valid Bearer key).
  test("without the opt-in, /docs requires admin auth", async () => {
    const baseUrl = await startApp(false);
    const res = await fetch(`${baseUrl}/docs/`);
    expect(res.status).toBe(401);
  });

  test("without the opt-in, a valid Bearer key reaches /docs", async () => {
    const baseUrl = await startApp(false);
    const res = await fetch(`${baseUrl}/docs/`, { headers: { Authorization: `Bearer ${ADMIN_KEY}` } });
    expect(res.status).not.toBe(401);
  });
});

describe("docsRoutes — the opt-in passthrough actually calls next()", () => {
  // Kills the ArrowFunction passthrough (`(_req, _res, next) => next()` replaced
  // with a no-op that never calls next — the request would hang past the guard).
  // A real HTTP round-trip that resolves at all (not a timeout) proves next().
  test("an opt-in request resolves rather than hanging on an un-invoked next()", async () => {
    const baseUrl = await startApp(true);
    const res = await fetch(`${baseUrl}/docs/`);
    expect(res.status).toBeLessThan(500);
  });
});

describe("docsRoutes — mounted at the exact /docs path", () => {
  // Kills the whole-body BlockStatement (no route wired) and the "/docs" mount
  // StringLiteral (emptied → mounted at "/", matching unrelated paths too).
  test("an unrelated path is NOT served by the docs middleware", async () => {
    const baseUrl = await startApp(true);
    const res = await fetch(`${baseUrl}/totally-unrelated-path`);
    expect(res.status).toBe(404);
  });

  test("/docs itself IS served (the route is genuinely wired)", async () => {
    const baseUrl = await startApp(true);
    const res = await fetch(`${baseUrl}/docs/`);
    expect(res.status).not.toBe(404);
  });
});

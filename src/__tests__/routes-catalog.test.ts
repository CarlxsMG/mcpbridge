/**
 * HTTP-level tests for src/routes/catalog.ts: list/CRUD of custom entries,
 * builtin immutability, and install (reusing the real performRestRegistration
 * path against a local mock upstream, same pattern as routes-register.test.ts).
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import { _internalsForTesting } from "../middleware/rate-limiter.js";
import { registry } from "../mcp/registry.js";
import { createCustomEntry } from "../catalog/index.js";

const ADMIN_KEY = "test-admin-key";
const originalAllowPrivate = config.allowPrivateIps;

let adminBase = "";
let adminServer: Server | null = null;
let upstream: Server | null = null;
let upstreamPort = 0;

beforeAll(async () => {
  const up = express();
  up.get("/openapi.json", (_req, res) =>
    res.json({
      openapi: "3.0.0",
      info: { title: "demo", version: "1.0.0" },
      servers: [{ url: `http://127.0.0.1:${upstreamPort}` }],
      paths: {
        "/pets": {
          get: { operationId: "list_pets", summary: "List pets", responses: { "200": { description: "ok" } } },
        },
      },
    }),
  );
  up.get("/health", (_req, res) => res.json({ ok: true }));
  await new Promise<void>((resolve) => {
    const srv = up.listen(0, "127.0.0.1", () => {
      upstreamPort = (srv.address() as AddressInfo).port;
      upstream = srv;
      resolve();
    });
  });
});

afterAll(() => {
  upstream?.close();
});

async function startApp(): Promise<void> {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
  _internalsForTesting.registerBuckets.clear();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  (config as Record<string, unknown>).allowPrivateIps = true;

  const { catalogRoutes } = await import("../routes/catalog.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use(requestIdMiddleware);
  catalogRoutes(app);

  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      adminBase = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      adminServer = srv;
      resolve();
    });
    srv.on("error", reject);
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (adminServer)
      adminServer.close(() => {
        adminServer = null;
        resolve();
      });
    else resolve();
  });
  (config as Record<string, unknown>).allowPrivateIps = originalAllowPrivate;
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

describe("GET /admin-api/catalog", () => {
  test("lists builtin entries and requires auth", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog`, { headers: bearer() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; source: string }[] };
    expect(body.items.some((i) => i.source === "builtin")).toBe(true);

    const unauth = await fetch(`${adminBase}/admin-api/catalog`);
    expect(unauth.status).toBe(401);
  });
});

describe("custom catalog entry CRUD routes", () => {
  test("create / update / delete", async () => {
    await startApp();
    const create = await fetch(`${adminBase}/admin-api/catalog`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        slug: "internal-svc",
        name: "Internal Svc",
        kind: "rest",
        healthUrl: "https://internal/health",
        openapiUrl: "https://internal/openapi.json",
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string };
    expect(created.id).toStartWith("custom:");

    const update = await fetch(`${adminBase}/admin-api/catalog/${created.id}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ featured: true }),
    });
    expect(update.status).toBe(200);

    const del = await fetch(`${adminBase}/admin-api/catalog/${created.id}`, { method: "DELETE", headers: bearer() });
    expect(del.status).toBe(200);
  });

  test("400 for an invalid slug", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ slug: "Not Valid!", name: "x", kind: "rest" }),
    });
    expect(res.status).toBe(400);
  });

  test("builtin entries reject PATCH/DELETE with 403 IMMUTABLE_ENTRY", async () => {
    await startApp();
    const list = (await (await fetch(`${adminBase}/admin-api/catalog`, { headers: bearer() })).json()) as {
      items: { id: string; source: string }[];
    };
    const builtinId = list.items.find((i) => i.source === "builtin")!.id;

    const patch = await fetch(`${adminBase}/admin-api/catalog/${builtinId}`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ name: "x" }),
    });
    expect(patch.status).toBe(403);
    const patchBody = (await patch.json()) as { error: { code: string } };
    expect(patchBody.error.code).toBe("IMMUTABLE_ENTRY");

    const del = await fetch(`${adminBase}/admin-api/catalog/${builtinId}`, { method: "DELETE", headers: bearer() });
    expect(del.status).toBe(403);
  });
});

describe("POST /admin-api/catalog/:id/install", () => {
  test("installs a custom REST entry through the real registration path", async () => {
    await startApp();
    createCustomEntry(
      {
        slug: "petstore-clone",
        name: "Petstore Clone",
        kind: "rest",
        healthUrl: `http://127.0.0.1:${upstreamPort}/health`,
        openapiUrl: `http://127.0.0.1:${upstreamPort}/openapi.json`,
      },
      "admin",
    );
    const list = (await (await fetch(`${adminBase}/admin-api/catalog`, { headers: bearer() })).json()) as {
      items: { id: string; slug: string }[];
    };
    const entryId = list.items.find((i) => i.slug === "petstore-clone")!.id;

    const install = await fetch(`${adminBase}/admin-api/catalog/${entryId}/install`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({}),
    });
    expect(install.status).toBe(200);
    const body = (await install.json()) as { status: string; name: string; tools_count: number };
    expect(body.status).toBe("registered");
    expect(body.name).toBe("petstore-clone");
    expect(body.tools_count).toBe(1);
    expect(registry.getClient("petstore-clone")).toBeDefined();
  });

  test("install accepts a custom name to avoid collisions", async () => {
    await startApp();
    createCustomEntry(
      {
        slug: "petstore-clone2",
        name: "Petstore Clone 2",
        kind: "rest",
        healthUrl: `http://127.0.0.1:${upstreamPort}/health`,
        openapiUrl: `http://127.0.0.1:${upstreamPort}/openapi.json`,
      },
      "admin",
    );
    const list = (await (await fetch(`${adminBase}/admin-api/catalog`, { headers: bearer() })).json()) as {
      items: { id: string; slug: string }[];
    };
    const entryId = list.items.find((i) => i.slug === "petstore-clone2")!.id;

    const install = await fetch(`${adminBase}/admin-api/catalog/${entryId}/install`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "petstore-staging" }),
    });
    expect(install.status).toBe(200);
    expect(registry.getClient("petstore-staging")).toBeDefined();
    expect(registry.getClient("petstore-clone2")).toBeUndefined();
  });

  test("404 for an unknown catalog entry id", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog/custom:999999/install`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  test("a dead openapi_url surfaces the same DISCOVERY_ERROR as /register", async () => {
    await startApp();
    createCustomEntry(
      {
        slug: "dead-svc",
        name: "Dead Svc",
        kind: "rest",
        healthUrl: `http://127.0.0.1:${upstreamPort}/health`,
        openapiUrl: `http://127.0.0.1:${upstreamPort}/does-not-exist.json`,
      },
      "admin",
    );
    const list = (await (await fetch(`${adminBase}/admin-api/catalog`, { headers: bearer() })).json()) as {
      items: { id: string; slug: string }[];
    };
    const entryId = list.items.find((i) => i.slug === "dead-svc")!.id;

    const install = await fetch(`${adminBase}/admin-api/catalog/${entryId}/install`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({}),
    });
    expect(install.status).toBe(400);
    const body = (await install.json()) as { error: { code: string } };
    expect(body.error.code).toBe("DISCOVERY_ERROR");
  });

  test("requires admin role (not just adminAuth)", async () => {
    // Custom-entry mutation and install both require requireAdminRole; a bare
    // bearer key without operator/admin role context still passes adminAuth's
    // env-key branch (which has no role concept), so this documents that the
    // env-key path is always treated as admin — covered at the requireAdminRole
    // unit level elsewhere. Here we just confirm unauthenticated requests 401.
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/catalog/builtin:slack/install`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});

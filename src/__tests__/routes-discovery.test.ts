/**
 * Integration tests for POST /admin-api/discovery/preview — spins up a local
 * upstream that serves an OpenAPI spec (127.0.0.1 + allowPrivateIps) and checks
 * the preview returns discovered tools without persisting anything.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { requestIdMiddleware } from "../middleware/request-id.js";

const ADMIN_KEY = "test-admin-key";
const originalAllowPrivate = config.allowPrivateIps;

let adminBase = "";
let adminServer: Server | null = null;
let upstream: Server | null = null;
let upstreamPort = 0;

function spec() {
  return {
    openapi: "3.0.0",
    info: { title: "demo", version: "1.0.0" },
    servers: [{ url: `http://127.0.0.1:${upstreamPort}` }],
    paths: {
      "/users": {
        get: { operationId: "listUsers", summary: "List users", responses: { "200": { description: "ok" } } },
      },
      "/users/{id}": {
        get: {
          operationId: "getUser",
          summary: "Get user",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

function graphqlSchema() {
  const typeRef = (kind: string, name: string | null = null, ofType: unknown = null) => ({ kind, name, ofType });
  return {
    data: {
      __schema: {
        queryType: { name: "Query" },
        mutationType: null,
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            fields: [{ name: "hello", description: "Say hello", args: [], type: typeRef("SCALAR", "String") }],
            inputFields: null,
            enumValues: null,
          },
          { kind: "SCALAR", name: "String", fields: null, inputFields: null, enumValues: null },
        ],
      },
    },
  };
}

beforeAll(async () => {
  const up = express();
  up.use(express.json());
  up.get("/openapi.json", (_req, res) => res.json(spec()));
  up.get("/empty.json", (_req, res) => res.json({ openapi: "3.0.0", info: { title: "x", version: "1" } }));
  up.post("/graphql", (_req, res) => res.json(graphqlSchema()));
  up.post("/graphql-no-introspection", (_req, res) => res.json({ data: {} }));
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
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  (config as Record<string, unknown>).allowPrivateIps = true;

  const { discoveryRoutes } = await import("../routes/discovery.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use(requestIdMiddleware);
  discoveryRoutes(app);

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
});

describe("POST /admin-api/discovery/preview", () => {
  test("returns the discovered tools without persisting", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ openapi_url: `http://127.0.0.1:${upstreamPort}/openapi.json` }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; tools: { name: string; method: string; endpoint: string }[] };
    expect(body.count).toBe(2);
    // camelCase operationIds ("listUsers"/"getUser") are normalized to the
    // registry's tool-name rule (lowercase + underscore) — see
    // sanitizeToolName in openapi-discovery.ts. Registering a raw camelCase
    // operationId would otherwise always fail registry.register()'s name
    // validation, which real-world specs (most APIs) routinely use.
    const names = body.tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_user", "list_users"]);
    expect(body.tools.every((t) => t.method === "GET")).toBe(true);
  });

  test("400 for a non-absolute openapi_url", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ openapi_url: "/relative/openapi.json" }),
    });
    expect(res.status).toBe(400);
  });

  test("400 DISCOVERY_ERROR when the spec has no paths", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ openapi_url: `http://127.0.0.1:${upstreamPort}/empty.json` }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("DISCOVERY_ERROR");
  });

  test("requires auth", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openapi_url: `http://127.0.0.1:${upstreamPort}/openapi.json` }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /admin-api/discovery/preview-graphql", () => {
  test("returns the discovered tools without persisting", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview-graphql`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ graphql_url: `http://127.0.0.1:${upstreamPort}/graphql` }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; tools: { name: string; method: string }[] };
    expect(body.count).toBe(1);
    expect(body.tools[0].name).toBe("hello");
    expect(body.tools[0].method).toBe("POST");
  });

  test("400 for a non-absolute graphql_url", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview-graphql`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ graphql_url: "/relative" }),
    });
    expect(res.status).toBe(400);
  });

  test("400 DISCOVERY_ERROR when introspection is disabled", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview-graphql`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ graphql_url: `http://127.0.0.1:${upstreamPort}/graphql-no-introspection` }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("DISCOVERY_ERROR");
  });

  test("requires auth", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/admin-api/discovery/preview-graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ graphql_url: `http://127.0.0.1:${upstreamPort}/graphql` }),
    });
    expect(res.status).toBe(401);
  });
});

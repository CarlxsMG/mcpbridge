/**
 * HTTP-level tests for POST /register — added as the regression gate for the
 * performRestRegistration/performMcpRegistration extraction (register.ts),
 * since no route-level tests existed for /register before that refactor.
 * Mirrors the local-upstream pattern in routes-discovery.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import { _internalsForTesting } from "../middleware/rate-limiter.js";
import { registry } from "../registry.js";
import { upsertWsProxyTarget, __resetWsProxyForTesting } from "../ws-proxy.js";

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
        get: { operationId: "list_users", summary: "List users", responses: { "200": { description: "ok" } } },
      },
    },
  };
}

function graphqlSchema() {
  const typeRef = (kind: string, name: string | null = null, ofType: unknown = null) => ({ kind, name, ofType });
  const NON_NULL = (of: unknown) => typeRef("NON_NULL", null, of);
  const SCALAR = (name: string) => typeRef("SCALAR", name);
  return {
    data: {
      __schema: {
        queryType: { name: "Query" },
        mutationType: null,
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            fields: [
              {
                name: "hello",
                description: "Say hello",
                args: [{ name: "name", description: null, type: NON_NULL(SCALAR("String")), defaultValue: null }],
                type: SCALAR("String"),
              },
            ],
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
  up.get("/health", (_req, res) => res.json({ ok: true }));
  up.post("/graphql", (_req, res) => res.json(graphqlSchema()));
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
  __resetWsProxyForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
  _internalsForTesting.registerBuckets.clear();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  (config as Record<string, unknown>).allowPrivateIps = true;

  const { registerRoutes } = await import("../routes/register.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use(requestIdMiddleware);
  registerRoutes(app);

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

describe("POST /register — REST/OpenAPI branch", () => {
  test("registers a client discovered from an OpenAPI spec", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        name: "demo-svc",
        health_url: `http://127.0.0.1:${upstreamPort}/health`,
        openapi_url: `http://127.0.0.1:${upstreamPort}/openapi.json`,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; name: string; tools_count: number; source: string };
    expect(body.status).toBe("registered");
    expect(body.name).toBe("demo-svc");
    expect(body.tools_count).toBe(1);
    expect(body.source).toBe("openapi");
    expect(registry.getClient("demo-svc")).toBeDefined();
  });

  test("registers a client from manual tools[]", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        name: "manual-svc",
        health_url: `http://127.0.0.1:${upstreamPort}/health`,
        tools: [
          {
            name: "ping",
            method: "GET",
            endpoint: "/health",
            description: "ping",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; tools_count: number };
    expect(body.source).toBe("manual");
    expect(body.tools_count).toBe(1);
  });

  test("registers a client from a raw cURL paste (curl_input)", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        name: "curl-svc",
        health_url: `http://127.0.0.1:${upstreamPort}/health`,
        curl_input: `curl -X POST https://api.example.com/widgets -H "Content-Type: application/json" -d '{"sku":"abc"}'`,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; tools_count: number };
    expect(body.source).toBe("manual");
    expect(body.tools_count).toBe(1);
    const detail = registry.getClientDetail("curl-svc");
    expect(detail?.tools[0]?.method).toBe("POST");
    expect(detail?.tools[0]?.endpoint).toBe("/widgets");
  });

  test("registers a client from a Postman Collection v2.1 export (postman_collection)", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        name: "postman-svc",
        health_url: `http://127.0.0.1:${upstreamPort}/health`,
        postman_collection: {
          item: [{ name: "List Widgets", request: { method: "GET", url: "https://api.example.com/widgets" } }],
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; tools_count: number };
    expect(body.source).toBe("manual");
    expect(body.tools_count).toBe(1);
  });

  test("400 VALIDATION_ERROR when both tools and curl_input are provided", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        name: "both-svc",
        health_url: `http://127.0.0.1:${upstreamPort}/health`,
        tools: [{ name: "ping", method: "GET", endpoint: "/health", description: "ping", inputSchema: {} }],
        curl_input: "curl https://api.example.com/ping",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  test("400 VALIDATION_ERROR for an unparseable curl_input", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        name: "bad-curl-svc",
        health_url: `http://127.0.0.1:${upstreamPort}/health`,
        curl_input: "# just a comment, no actual command",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  test("400 VALIDATION_ERROR when neither tools nor openapi_url is provided", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "x", health_url: `http://127.0.0.1:${upstreamPort}/health` }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  test("400 DISCOVERY_ERROR when the OpenAPI spec has no paths", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        name: "empty-svc",
        health_url: `http://127.0.0.1:${upstreamPort}/health`,
        openapi_url: `http://127.0.0.1:${upstreamPort}/empty.json`,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("DISCOVERY_ERROR");
  });

  test("400 for a non-object body (Change A guard)", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify(["not", "an", "object"]),
    });
    expect(res.status).toBe(400);
  });

  test("400 when tools[] exceeds the configured maximum (Change B guard)", async () => {
    await startApp();
    const original = config.maxToolsPerClient;
    (config as Record<string, unknown>).maxToolsPerClient = 1;
    try {
      const res = await fetch(`${adminBase}/register`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "too-many",
          health_url: `http://127.0.0.1:${upstreamPort}/health`,
          tools: [
            {
              name: "a",
              method: "GET",
              endpoint: "/a",
              description: "a",
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "b",
              method: "GET",
              endpoint: "/b",
              description: "b",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      (config as Record<string, unknown>).maxToolsPerClient = original;
    }
  });

  test("requires auth", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", health_url: `http://127.0.0.1:${upstreamPort}/health`, tools: [] }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /register — MCP branch validation", () => {
  test("400 when mcp_url is missing an http(s) scheme", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ kind: "mcp", name: "mcp-svc", mcp_url: "not-a-url" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  test("400 for an invalid mcp_transport", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        kind: "mcp",
        name: "mcp-svc",
        mcp_url: `http://127.0.0.1:${upstreamPort}`,
        mcp_transport: "carrier-pigeon",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("dispatches to the MCP branch when mcp_url is present without an explicit kind", async () => {
    await startApp();
    // No MCP server actually listening at this address inside the discovery
    // timeout, so this exercises dispatch + eventual DISCOVERY_ERROR rather
    // than a full successful registration (covered at the unit level in
    // mcp-discovery.test.ts / mcp-upstream.test.ts).
    const res = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "mcp-svc", mcp_url: `http://127.0.0.1:${upstreamPort}/openapi.json` }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("DISCOVERY_ERROR");
  });
});

describe("POST /register — GraphQL branch", () => {
  test("registers a client discovered from GraphQL introspection", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        name: "graphql-svc",
        graphql_url: `http://127.0.0.1:${upstreamPort}/graphql`,
        health_url: `http://127.0.0.1:${upstreamPort}/health`,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; name: string; tools_count: number; source: string };
    expect(body.status).toBe("registered");
    expect(body.tools_count).toBe(1);
    expect(body.source).toBe("graphql");
    const detail = registry.getClientDetail("graphql-svc");
    expect(detail?.tools[0].graphql?.enabled).toBe(true);
    expect(detail?.tools[0].graphql?.query).toContain("query hello");
  });

  test("dispatches to the GraphQL branch via an explicit kind without graphql_url shape checks failing", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        kind: "graphql",
        name: "graphql-svc2",
        graphql_url: `http://127.0.0.1:${upstreamPort}/graphql`,
      }),
    });
    expect(res.status).toBe(200);
  });

  test("warns when health_url is omitted and defaults to graphql_url", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "graphql-svc3", graphql_url: `http://127.0.0.1:${upstreamPort}/graphql` }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings?: string[] };
    expect(body.warnings?.length).toBeGreaterThan(0);
  });

  test("400 when an explicit health_url fails SSRF validation (not just graphql_url)", async () => {
    await startApp();
    // Restrict to the mock upstream's own host so graphql_url still passes,
    // but a health_url pointing anywhere else — private/link-local or not —
    // is rejected on its own, proving health_url gets its own independent
    // validateBackendUrl call rather than riding on graphql_url's pass.
    const originalAllowedHosts = config.allowedHosts;
    (config as Record<string, unknown>).allowedHosts = ["127.0.0.1"];
    try {
      const res = await fetch(`${adminBase}/register`, {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          name: "graphql-svc-bad-health",
          graphql_url: `http://127.0.0.1:${upstreamPort}/graphql`,
          health_url: "http://169.254.169.254/latest/meta-data/",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      (config as Record<string, unknown>).allowedHosts = originalAllowedHosts;
    }
  });

  test("400 when graphql_url is missing an http(s) scheme", async () => {
    await startApp();
    const res = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "graphql-svc4", graphql_url: "not-a-url" }),
    });
    expect(res.status).toBe(400);
  });

  test("re-registration drops stale tool_graphql rows for tools no longer present", async () => {
    await startApp();
    await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        name: "graphql-svc5",
        graphql_url: `http://127.0.0.1:${upstreamPort}/graphql`,
        health_url: `http://127.0.0.1:${upstreamPort}/health`,
      }),
    });
    expect(registry.getClientDetail("graphql-svc5")?.tools).toHaveLength(1);

    // Re-register the same client as a plain manual REST client with no
    // overlapping tool names — the old GraphQL-discovered "hello" tool row
    // (and its tool_graphql FK row) must be gone, not just shadowed.
    const second = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        name: "graphql-svc5",
        health_url: `http://127.0.0.1:${upstreamPort}/health`,
        tools: [
          {
            name: "ping",
            method: "GET",
            endpoint: "/health",
            description: "ping",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    });
    expect(second.status).toBe(200);
    const detail = registry.getClientDetail("graphql-svc5");
    expect(detail?.tools.map((t) => t.name)).toEqual(["ping"]);
    expect(detail?.tools[0].graphql).toBeUndefined();
  });
});

describe("POST /register — rejects a name already used by a WS proxy target", () => {
  test("REST branch", async () => {
    await startApp();
    await upsertWsProxyTarget("shared-name", { backendWsUrl: "ws://127.0.0.1:9" });
    const res = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "shared-name", health_url: `http://127.0.0.1:${upstreamPort}/health`, tools: [] }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NAME_COLLISION");
    expect(registry.getClient("shared-name")).toBeUndefined();
  });

  test("MCP branch", async () => {
    await startApp();
    await upsertWsProxyTarget("shared-name-mcp", { backendWsUrl: "ws://127.0.0.1:9" });
    const res = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ kind: "mcp", name: "shared-name-mcp", mcp_url: `http://127.0.0.1:${upstreamPort}` }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NAME_COLLISION");
  });

  test("GraphQL branch", async () => {
    await startApp();
    await upsertWsProxyTarget("shared-name-gql", { backendWsUrl: "ws://127.0.0.1:9" });
    const res = await fetch(`${adminBase}/register`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ name: "shared-name-gql", graphql_url: `http://127.0.0.1:${upstreamPort}/graphql` }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NAME_COLLISION");
  });
});

/**
 * Composite (macro) tools — argument templating, CRUD, the chaining runner
 * (each step through the full proxyToolCall guard stack), and MCP integration.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server as HttpServer } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { removeCircuitBreaker } from "../middleware/circuit-breaker.js";
import { createMcpServer } from "../mcp/mcp-server.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import {
  initComposites,
  createComposite,
  updateComposite,
  deleteComposite,
  getCompositeDetail,
  listComposites,
  runComposite,
  resolveRef,
  resolveTemplate,
  hasComposite,
} from "../admin/tool-composition/composites.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RestToolDefinition } from "../mcp/types.js";

function tool(name: string, properties: Record<string, unknown> = {}): RestToolDefinition {
  return {
    name,
    method: "POST",
    endpoint: `/${name}`,
    description: `tool ${name}`,
    inputSchema: { type: "object", properties },
  };
}
async function regSvc(): Promise<void> {
  // `second` declares itemId/msg so the proxy's Ajv (removeAdditional) doesn't
  // strip them — proving the composite feeds real args through the guard stack.
  await registry.register(
    "svc",
    [tool("first"), tool("second", { itemId: { type: "number" }, msg: { type: "string" } })],
    "http://1.2.3.4/health",
    "1.2.3.4",
    "http://1.2.3.4",
    "1.2.3.4",
  );
}

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  initComposites();
  removeCircuitBreaker("svc");
  globalThis.fetch = originalFetch;
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  initComposites();
  globalThis.fetch = originalFetch;
});

const OBJ_SCHEMA = { type: "object", properties: {} };

describe("composites — templating", () => {
  const ctx = {
    input: { a: 1, nested: { b: "x" } },
    steps: [{ text: '{"id":42}', json: { id: 42, arr: [{ v: 7 }] } }],
  };
  test("resolveRef reads input / steps.text / steps.json paths", () => {
    expect(resolveRef("input.a", ctx)).toBe(1);
    expect(resolveRef("input.nested.b", ctx)).toBe("x");
    expect(resolveRef("steps.0.text", ctx)).toBe('{"id":42}');
    expect(resolveRef("steps.0.json.id", ctx)).toBe(42);
    expect(resolveRef("steps.0.json.arr.0.v", ctx)).toBe(7);
    expect(resolveRef("steps.9.json.id", ctx)).toBeUndefined();
  });
  test("resolveTemplate honours $ref objects and ${} interpolation", () => {
    const out = resolveTemplate({ id: { $ref: "steps.0.json.id" }, msg: "item ${steps.0.json.id}", keep: "lit" }, ctx);
    expect(out).toEqual({ id: 42, msg: "item 42", keep: "lit" });
  });
});

describe("composites — CRUD", () => {
  test("create + detail + list", async () => {
    await regSvc();
    const r = await createComposite(
      "flow",
      "chains two",
      OBJ_SCHEMA,
      [
        { targetClient: "svc", targetTool: "first", argsTemplate: {} },
        { targetClient: "svc", targetTool: "second", argsTemplate: { id: { $ref: "steps.0.json.id" } } },
      ],
      "tester",
    );
    expect(r.ok).toBe(true);
    expect(getCompositeDetail("flow")?.steps.length).toBe(2);
    expect(listComposites()[0].name).toBe("flow");
    expect(hasComposite("flow")).toBe(true);
  });

  test("rejects a name containing the __ separator", async () => {
    await regSvc();
    const r = await createComposite(
      "bad__name",
      undefined,
      OBJ_SCHEMA,
      [{ targetClient: "svc", targetTool: "first", argsTemplate: {} }],
      "t",
    );
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_NAME" } });
  });

  test("rejects a step referencing an unknown tool", async () => {
    await regSvc();
    const r = await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [{ targetClient: "svc", targetTool: "ghost", argsTemplate: {} }],
      "t",
    );
    expect(r).toMatchObject({ ok: false, error: { code: "UNKNOWN_TOOL" } });
  });

  test("rejects zero steps", async () => {
    await regSvc();
    const r = await createComposite("flow", undefined, OBJ_SCHEMA, [], "t");
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_STEPS" } });
  });

  test("update toggles enabled; delete removes", async () => {
    await regSvc();
    await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [{ targetClient: "svc", targetTool: "first", argsTemplate: {} }],
      "t",
    );
    expect((await updateComposite("flow", { enabled: false })).ok).toBe(true);
    expect(getCompositeDetail("flow")?.enabled).toBe(false);
    expect(await deleteComposite("flow")).toBe(true);
    expect(getCompositeDetail("flow")).toBeUndefined();
  });
});

describe("composites — runComposite", () => {
  // Mock fetch: /first returns {id:42}; /second echoes the request body back.
  function chainFetch(): typeof fetch {
    return (async (url: string, opts: RequestInit) => {
      if (String(url).includes("/first")) {
        return new Response(JSON.stringify({ id: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(String(opts?.body ?? "{}"), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  }

  test("threads step0 output into step1 args", async () => {
    await regSvc();
    globalThis.fetch = chainFetch();
    await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [
        { targetClient: "svc", targetTool: "first", argsTemplate: {} },
        { targetClient: "svc", targetTool: "second", argsTemplate: { itemId: { $ref: "steps.0.json.id" } } },
      ],
      "t",
    );
    const result = await runComposite("flow", {});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ itemId: 42 });
  });

  test("short-circuits and reports the failing step", async () => {
    await regSvc();
    globalThis.fetch = (async (url: string) =>
      String(url).includes("/first")
        ? new Response("boom", { status: 500 })
        : new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [
        { targetClient: "svc", targetTool: "first", argsTemplate: {} },
        { targetClient: "svc", targetTool: "second", argsTemplate: {} },
      ],
      "t",
    );
    const result = await runComposite("flow", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/step 1/);
  });

  test("a disabled composite is not runnable", async () => {
    await regSvc();
    await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [{ targetClient: "svc", targetTool: "first", argsTemplate: {} }],
      "t",
    );
    await updateComposite("flow", { enabled: false });
    const result = await runComposite("flow", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/disabled/);
  });

  test("underlying tool guards still apply per step (disabled tool -> step error)", async () => {
    await regSvc();
    globalThis.fetch = chainFetch();
    await registry.setToolEnabled("svc", "first", false);
    await createComposite(
      "flow",
      undefined,
      OBJ_SCHEMA,
      [{ targetClient: "svc", targetTool: "first", argsTemplate: {} }],
      "t",
    );
    const result = await runComposite("flow", {});
    expect(result.isError).toBe(true);
  });
});

describe("composites — MCP integration (aggregated only)", () => {
  async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  test("advertised in aggregated tools/list, callable through it", async () => {
    await regSvc();
    globalThis.fetch = (async (url: string) =>
      String(url).includes("/first")
        ? new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await createComposite(
      "flow",
      "desc",
      OBJ_SCHEMA,
      [{ targetClient: "svc", targetTool: "first", argsTemplate: {} }],
      "t",
    );

    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("flow");
      const result = await client.callTool({ name: "flow", arguments: {} });
      expect(result.isError).toBeFalsy();
    } finally {
      await close();
    }
  });

  test("not advertised on a sharded (single-client) scope", async () => {
    await regSvc();
    await createComposite(
      "flow",
      "desc",
      OBJ_SCHEMA,
      [{ targetClient: "svc", targetTool: "first", argsTemplate: {} }],
      "t",
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ kind: "client", name: "svc" });
    const client = new Client({ name: "t", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).not.toContain("flow");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("composites — admin route", () => {
  const ADMIN_KEY = "test-admin-key";
  let baseUrl = "";
  let server: HttpServer | null = null;
  async function startApp(): Promise<void> {
    (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
    (config as Record<string, unknown>).authDisabled = false;
    const { compositeRoutes } = await import("../routes/composites.js");
    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    compositeRoutes(app);
    await new Promise<void>((resolve) => {
      const srv = app.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
        server = srv;
        resolve();
      });
    });
  }
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server)
        server.close(() => {
          server = null;
          resolve();
        });
      else resolve();
    });
  });
  function bearer(): Record<string, string> {
    return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
  }

  test("POST creates, GET returns detail, DELETE removes", async () => {
    await regSvc();
    await startApp();
    const create = await fetch(`${baseUrl}/admin-api/composites`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        name: "flow",
        description: "d",
        inputSchema: OBJ_SCHEMA,
        steps: [{ targetClient: "svc", targetTool: "first", argsTemplate: {} }],
      }),
    });
    expect(create.status).toBe(201);
    const get = await fetch(`${baseUrl}/admin-api/composites/flow`, { headers: bearer() });
    expect(get.status).toBe(200);
    const del = await fetch(`${baseUrl}/admin-api/composites/flow`, { method: "DELETE", headers: bearer() });
    expect(del.status).toBe(200);
  });

  test("POST with an unknown step tool returns 400", async () => {
    await regSvc();
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/composites`, {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({
        name: "flow",
        inputSchema: OBJ_SCHEMA,
        steps: [{ targetClient: "svc", targetTool: "ghost", argsTemplate: {} }],
      }),
    });
    expect(res.status).toBe(400);
  });
});

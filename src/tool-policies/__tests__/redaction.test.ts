/**
 * Response redaction: path redaction unit tests + proxy application + admin route.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import {
  applyRedaction,
  setRedactionPaths,
  getRedactionPaths,
  stripInjectedCredentials,
} from "../../content-filtering/redaction.js";
import { requestIdMiddleware } from "../../middleware/request-id.js";
import type { RestToolDefinition } from "../../mcp/types.js";

function makeTool(): RestToolDefinition {
  return {
    name: "get-users",
    method: "GET",
    endpoint: "/users",
    description: "d",
    inputSchema: { type: "object", properties: {} },
  };
}
async function reg(name: string): Promise<void> {
  await registry.register(name, [makeTool()], "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

describe("applyRedaction", () => {
  test("redacts top-level and nested paths, leaving others", () => {
    const out = applyRedaction(
      ["password", "user.ssn"],
      JSON.stringify({ password: "p", user: { ssn: "1", name: "x" } }),
    );
    const data = JSON.parse(out!);
    expect(data.password).toBe("[REDACTED]");
    expect(data.user.ssn).toBe("[REDACTED]");
    expect(data.user.name).toBe("x");
  });

  test("wildcard over array elements", () => {
    const out = applyRedaction(
      ["items.*.secret"],
      JSON.stringify({
        items: [
          { secret: "a", id: 1 },
          { secret: "b", id: 2 },
        ],
      }),
    );
    const data = JSON.parse(out!);
    expect(data.items[0].secret).toBe("[REDACTED]");
    expect(data.items[1].secret).toBe("[REDACTED]");
    expect(data.items[0].id).toBe(1);
  });

  test("wildcard leaf redacts each array element", () => {
    const out = applyRedaction(["tokens.*"], JSON.stringify({ tokens: ["a", "b"] }));
    expect(JSON.parse(out!).tokens).toEqual(["[REDACTED]", "[REDACTED]"]);
  });

  test("missing paths are a no-op", () => {
    const out = applyRedaction(["nope.deep"], JSON.stringify({ a: 1 }));
    expect(JSON.parse(out!)).toEqual({ a: 1 });
  });

  test("returns null for non-JSON", () => {
    expect(applyRedaction(["x"], "not json")).toBeNull();
  });

  test("a prototype-chain path is ignored — no Object.prototype pollution", () => {
    for (const p of ["__proto__.polluted", "constructor.prototype.polluted", "__proto__.hasOwnProperty"]) {
      expect(JSON.parse(applyRedaction([p], JSON.stringify({ a: 1 }))!)).toEqual({ a: 1 });
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(typeof Object.prototype.hasOwnProperty).toBe("function");
  });
});

describe("stripInjectedCredentials", () => {
  test("redacts the full injected header value when reflected", () => {
    const out = stripInjectedCredentials(`{"seen":"Bearer sk-abc123def456"}`, {
      Authorization: "Bearer sk-abc123def456",
    });
    expect(out).not.toContain("sk-abc123def456");
    expect(out).toContain("<redacted>");
  });

  test("redacts the BARE token when a backend echoes it without the scheme prefix", () => {
    // The exploit this closes: backend reflects only "sk-abc123def456", not the
    // whole "Bearer sk-abc123def456", which a full-value match would miss.
    const out = stripInjectedCredentials(`{"token":"sk-abc123def456"}`, {
      Authorization: "Bearer sk-abc123def456",
    });
    expect(out).not.toContain("sk-abc123def456");
    expect(out).toContain("<redacted>");
  });

  test("scheme match is case-insensitive (bearer/Bearer)", () => {
    const out = stripInjectedCredentials(`{"t":"tok-longenough-1234"}`, {
      Authorization: "bearer tok-longenough-1234",
    });
    expect(out).not.toContain("tok-longenough-1234");
  });

  test("strips the base64 blob of a Basic credential reflected on its own", () => {
    const blob = Buffer.from("user:password").toString("base64");
    const out = stripInjectedCredentials(`{"decoded":"${blob}"}`, { Authorization: `Basic ${blob}` });
    expect(out).not.toContain(blob);
  });

  test("does not redact a short (<8 char) token, avoiding mangling legitimate content", () => {
    const out = stripInjectedCredentials(`{"msg":"abc appears here"}`, { Authorization: "Bearer abc" });
    expect(out).toContain("abc appears here");
  });
});

describe("store", () => {
  test("set/get, empty clears, unknown tool false", async () => {
    await reg("svc");
    expect(setRedactionPaths("svc", "get-users", ["password", "password"])).toBe(true);
    expect(getRedactionPaths("svc", "get-users")).toEqual(["password"]);
    setRedactionPaths("svc", "get-users", []);
    expect(getRedactionPaths("svc", "get-users")).toEqual([]);
    expect(setRedactionPaths("svc", "nope", ["x"])).toBe(false);
  });
});

describe("proxy redaction", () => {
  test("redacts configured fields in a JSON response", async () => {
    await reg("svc");
    setRedactionPaths("svc", "get-users", ["password"]);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ user: "a", password: "secret" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const res = await proxyToolCall("svc__get-users", {});
    const body = JSON.parse(res.content[0].text);
    expect(body.password).toBe("[REDACTED]");
    expect(body.user).toBe("a");
  });
});

describe("admin route", () => {
  const ADMIN_KEY = "test-admin-key";
  let baseUrl = "";
  let server: Server | null = null;

  async function startApp(): Promise<void> {
    (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
    (config as Record<string, unknown>).authDisabled = false;
    const { adminRoutes } = await import("../../routes/admin.js");
    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    adminRoutes(app);
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

  test("PATCH sets redaction paths, exposed on detail", async () => {
    await reg("svc");
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/clients/svc/tools/get-users`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ redactPaths: ["a.b", "c"] }),
    });
    expect(res.status).toBe(200);
    expect(registry.getClientDetail("svc")!.tools[0].redactPaths).toEqual(["a.b", "c"]);
  });
});

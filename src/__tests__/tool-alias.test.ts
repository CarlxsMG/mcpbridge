/**
 * Tool display-name alias (override.displayName) — advertises a tool as
 * clientName__displayName while keeping the canonical name callable, and
 * resolves the alias back to canonical at call time.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry, ToolOverrideError } from "../registry.js";
import { removeCircuitBreaker } from "../circuit-breaker.js";
import { proxyToolCall } from "../proxy.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import type { RestToolDefinition } from "../types.js";

function tool(name: string, endpoint = "/x"): RestToolDefinition {
  return {
    name,
    method: "GET",
    endpoint,
    description: `desc ${name}`,
    inputSchema: { type: "object", properties: {} },
  };
}
async function reg(clientName: string, tools: RestToolDefinition[]): Promise<void> {
  await registry.register(clientName, tools, "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
  globalThis.fetch = originalFetch;
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  globalThis.fetch = originalFetch;
});

describe("display-name alias — registry", () => {
  test("advertised name uses the alias; canonical name is unchanged in storage", async () => {
    await reg("github", [tool("list_issues_for_repo_v2")]);
    await registry.setToolOverride("github", "list_issues_for_repo_v2", { displayName: "issues" });

    const advertised = registry.getAllMcpTools().map((t) => t.name);
    expect(advertised).toContain("github__issues");
    expect(advertised).not.toContain("github__list_issues_for_repo_v2");

    // The stored tool name is untouched.
    expect(registry.resolveTool("github__list_issues_for_repo_v2")?.tool.name).toBe("list_issues_for_repo_v2");
  });

  test("resolveAdvertisedName maps alias -> canonical and passes through non-aliases", async () => {
    await reg("github", [tool("list_issues_for_repo_v2")]);
    await registry.setToolOverride("github", "list_issues_for_repo_v2", { displayName: "issues" });

    expect(registry.resolveAdvertisedName("github__issues")).toBe("github__list_issues_for_repo_v2");
    expect(registry.resolveAdvertisedName("github__list_issues_for_repo_v2")).toBe("github__list_issues_for_repo_v2");
    expect(registry.resolveAdvertisedName("github__nope")).toBe("github__nope");
  });

  test("resolveTool works via both the alias key and the canonical key", async () => {
    await reg("github", [tool("list_issues_for_repo_v2")]);
    await registry.setToolOverride("github", "list_issues_for_repo_v2", { displayName: "issues" });

    expect(registry.resolveTool("github__issues")?.tool.name).toBe("list_issues_for_repo_v2");
    expect(registry.resolveTool("github__list_issues_for_repo_v2")?.tool.name).toBe("list_issues_for_repo_v2");
  });

  test("clearing the alias reverts the advertised name and stops resolving it", async () => {
    await reg("github", [tool("list_issues_for_repo_v2")]);
    await registry.setToolOverride("github", "list_issues_for_repo_v2", { displayName: "issues" });
    await registry.setToolOverride("github", "list_issues_for_repo_v2", null);

    expect(registry.getAllMcpTools().map((t) => t.name)).toContain("github__list_issues_for_repo_v2");
    expect(registry.resolveAdvertisedName("github__issues")).toBe("github__issues"); // no longer an alias
    expect(registry.resolveTool("github__issues")).toBeUndefined();
  });

  test("alias survives re-registration (backend reboot)", async () => {
    await reg("github", [tool("list_issues_for_repo_v2")]);
    await registry.setToolOverride("github", "list_issues_for_repo_v2", { displayName: "issues" });
    await reg("github", [tool("list_issues_for_repo_v2")]);

    expect(registry.getAllMcpTools().map((t) => t.name)).toContain("github__issues");
    expect(registry.resolveTool("github__issues")?.tool.name).toBe("list_issues_for_repo_v2");
  });

  test("displayName can coexist with description + params overrides", async () => {
    await reg("svc", [
      {
        name: "t",
        method: "GET",
        endpoint: "/t",
        description: "orig",
        inputSchema: { type: "object", properties: { limit: { type: "number", description: "orig" } } },
      },
    ]);
    await registry.setToolOverride("svc", "t", {
      displayName: "clean",
      description: "better",
      params: { limit: { description: "max rows" } },
    });
    const adv = registry.getAllMcpTools().find((t) => t.name === "svc__clean");
    expect(adv?.description).toBe("better");
    expect((adv?.inputSchema.properties as Record<string, { description: string }>).limit.description).toBe("max rows");
  });
});

describe("display-name alias — collision + validation", () => {
  test("rejects an alias that collides with another tool's real name", async () => {
    await reg("svc", [tool("alpha"), tool("beta")]);
    await expect(registry.setToolOverride("svc", "alpha", { displayName: "beta" })).rejects.toBeInstanceOf(
      ToolOverrideError,
    );
  });

  test("rejects an alias that collides with another tool's displayName", async () => {
    await reg("svc", [tool("alpha"), tool("beta")]);
    await registry.setToolOverride("svc", "beta", { displayName: "shared" });
    await expect(registry.setToolOverride("svc", "alpha", { displayName: "shared" })).rejects.toMatchObject({
      code: "TOOL_ALIAS_CONFLICT",
    });
  });

  test("rejects a malformed alias", async () => {
    await reg("svc", [tool("alpha")]);
    await expect(registry.setToolOverride("svc", "alpha", { displayName: "Bad Name!" })).rejects.toMatchObject({
      code: "TOOL_ALIAS_INVALID",
    });
  });

  test("the same alias on two different clients is fine (prefix keeps them distinct)", async () => {
    await reg("a", [tool("x")]);
    await reg("b", [tool("y")]);
    await registry.setToolOverride("a", "x", { displayName: "shared" });
    await registry.setToolOverride("b", "y", { displayName: "shared" });
    expect(registry.resolveTool("a__shared")?.tool.name).toBe("x");
    expect(registry.resolveTool("b__shared")?.tool.name).toBe("y");
  });
});

describe("display-name alias — proxyToolCall", () => {
  test("calling the alias reaches the underlying tool", async () => {
    await reg("github", [tool("list_issues_for_repo_v2")]);
    await registry.setToolOverride("github", "list_issues_for_repo_v2", { displayName: "issues" });
    removeCircuitBreaker("github");

    let hits = 0;
    globalThis.fetch = (async () => {
      hits++;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await proxyToolCall("github__issues", {});
    expect(result.isError).toBeUndefined();
    expect(hits).toBe(1);
  });
});

describe("display-name alias — admin route", () => {
  const ADMIN_KEY = "test-admin-key";
  let baseUrl = "";
  let server: Server | null = null;

  async function startApp(): Promise<void> {
    (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
    (config as Record<string, unknown>).authDisabled = false;
    const { adminRoutes } = await import("../routes/admin.js");
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
  function bearer(): Record<string, string> {
    return { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" };
  }

  test("PATCH displayName updates the advertised name", async () => {
    await reg("github", [tool("list_issues_for_repo_v2")]);
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/clients/github/tools/list_issues_for_repo_v2`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ overrides: { displayName: "issues" } }),
    });
    expect(res.status).toBe(200);
    expect(registry.getAllMcpTools().map((t) => t.name)).toContain("github__issues");
  });

  test("409 on a colliding displayName", async () => {
    await reg("svc", [tool("alpha"), tool("beta")]);
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/clients/svc/tools/alpha`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ overrides: { displayName: "beta" } }),
    });
    expect(res.status).toBe(409);
  });

  test("400 on a malformed displayName", async () => {
    await reg("svc", [tool("alpha")]);
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/clients/svc/tools/alpha`, {
      method: "PATCH",
      headers: bearer(),
      body: JSON.stringify({ overrides: { displayName: "Bad Name!" } }),
    });
    expect(res.status).toBe(400);
  });
});

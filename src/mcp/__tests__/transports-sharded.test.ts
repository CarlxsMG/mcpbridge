/**
 * Tests for the sharded /mcp/:clientName endpoint (src/transports.ts).
 *
 * Does a real MCP JSON-RPC handshake (initialize → notifications/initialized
 * → tools/list) over Streamable HTTP, matching the actual wire protocol —
 * the response is SSE-framed ("event: message\ndata: {...}"), so a small
 * helper extracts the JSON payload.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { registry } from "../../mcp/registry.js";
import type { RestToolDefinition } from "../../mcp/types.js";
import { createMcpKey, deleteMcpKey } from "../../security/mcp-key-store.js";

import { withConfig } from "../../__tests__/_utils/with-config.js";
let baseUrl = "";
let activeServer: Server | null = null;
let cleanupFn: (() => void) | null = null;

async function startApp(): Promise<void> {
  const { setupTransports } = await import("../../mcp/transports.js");
  const app = express();
  app.use(express.json({ limit: "64kb", strict: true }));
  cleanupFn = setupTransports(app);

  await new Promise<void>((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      activeServer = srv;
      resolve();
    });
    srv.on("error", reject);
  });
}

function stopApp(): Promise<void> {
  if (cleanupFn) cleanupFn();
  return new Promise((resolve) => {
    if (activeServer) {
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "get-thing",
    method: "GET",
    endpoint: "/thing",
    description: "probe tool",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

async function reg(name: string, tools: RestToolDefinition[] = [makeTool()]) {
  await registry.register(name, tools, "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

function parseSseJson(text: string): { result?: unknown; error?: unknown; id?: unknown } {
  const match = text.match(/data: (.+)/);
  if (!match) throw new Error(`Could not parse SSE body: ${text}`);
  return JSON.parse(match[1]);
}

/** Performs the real MCP initialize handshake against `path`. Returns the session id, or null if init failed. */
async function initSession(path: string, extraHeaders: Record<string, string> = {}): Promise<string | null> {
  const initRes = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...extraHeaders },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    }),
  });
  const sessionId = initRes.headers.get("mcp-session-id");
  if (initRes.status !== 200 || !sessionId) return null;

  await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return sessionId;
}

async function toolsList(
  path: string,
  sessionId: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body?: { tools: { name: string }[] } }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }),
  });
  if (res.status !== 200) return { status: res.status };
  const parsed = parseSseJson(await res.text());
  return { status: res.status, body: parsed.result as { tools: { name: string }[] } };
}

beforeEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
});

afterEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  await stopApp();
});

describe("POST /mcp/:clientName — new session", () => {
  test("404s for an unknown client", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/mcp/nobody`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CLIENT_NOT_FOUND");
  });

  test("establishes a session for a known client and scopes tools/list to just that client", async () => {
    await startApp();
    await reg("client-a", [makeTool({ name: "tool-a" })]);
    await reg("client-b", [makeTool({ name: "tool-b" })]);

    const sessionId = await initSession("/mcp/client-a");
    expect(sessionId).not.toBeNull();

    const list = await toolsList("/mcp/client-a", sessionId!);
    expect(list.status).toBe(200);
    expect(list.body?.tools.map((t) => t.name).filter((n) => n !== "search_tools")).toEqual(["client-a__tool-a"]);
  });

  test("a disabled tool is excluded from the sharded tools/list, same as the aggregated one", async () => {
    await startApp();
    await reg("client-a", [makeTool({ name: "tool-a" }), makeTool({ name: "tool-b" })]);
    await registry.setToolEnabled("client-a", "tool-a", false);

    const sessionId = await initSession("/mcp/client-a");
    const list = await toolsList("/mcp/client-a", sessionId!);
    expect(list.body?.tools.map((t) => t.name).filter((n) => n !== "search_tools")).toEqual(["client-a__tool-b"]);
  });
});

describe("Confused-deputy defense — a session bound to one client is rejected on another client's URL", () => {
  test("GET /mcp/:otherClient with a session bound to a different client returns 404", async () => {
    await startApp();
    await reg("client-a");
    await reg("client-b");

    const sessionId = await initSession("/mcp/client-a");
    expect(sessionId).not.toBeNull();

    const res = await fetch(`${baseUrl}/mcp/client-b`, {
      method: "GET",
      headers: { "mcp-session-id": sessionId!, accept: "text/event-stream" },
    });
    expect(res.status).toBe(404);
  });

  test("DELETE /mcp/:otherClient with a session bound to a different client returns 404 and does not terminate it", async () => {
    await startApp();
    await reg("client-a");
    await reg("client-b");

    const sessionId = await initSession("/mcp/client-a");

    const res = await fetch(`${baseUrl}/mcp/client-b`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId! },
    });
    expect(res.status).toBe(404);

    // The session must still work against its OWN client afterwards.
    const list = await toolsList("/mcp/client-a", sessionId!);
    expect(list.status).toBe(200);
  });

  test("POST /mcp/:otherClient (continuing an existing session) with a session bound to a different client returns 404", async () => {
    await startApp();
    await reg("client-a");
    await reg("client-b");

    const sessionId = await initSession("/mcp/client-a");

    const res = await fetch(`${baseUrl}/mcp/client-b`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 3 }),
    });
    expect(res.status).toBe(404);
  });
});

describe("/mcp — system control plane, not a data aggregator", () => {
  const originalAdminApiKeys = config.adminApiKeys;

  afterEach(() => {
    (config as Record<string, unknown>).adminApiKeys = originalAdminApiKeys;
  });

  test("POST /mcp without a system-role credential is rejected outright (no 'unconfigured means open' fallback)", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect([401, 403]).toContain(res.status);
  });

  test("POST /mcp with the env admin Bearer serves system tools, never backend tools, while /mcp/:clientName keeps serving that client's tools", async () => {
    await withConfig({ adminApiKeys: ["test-root-admin-key"] }, async () => {
      const authHeader = { Authorization: "Bearer test-root-admin-key" };
      await startApp();
      await reg("client-a", [makeTool({ name: "tool-a" })]);

      const systemSession = await initSession("/mcp", authHeader);
      expect(systemSession).not.toBeNull();
      const systemList = await toolsList("/mcp", systemSession!, authHeader);
      const systemNames = systemList.body?.tools.map((t) => t.name) ?? [];
      expect(systemNames).toContain("sys_list_clients");
      expect(systemNames.some((n) => n.startsWith("client-a__"))).toBe(false);

      const shardedSession = await initSession("/mcp/client-a");
      const shardedList = await toolsList("/mcp/client-a", shardedSession!);
      expect(shardedList.body?.tools.map((t) => t.name).filter((n) => n !== "search_tools")).toEqual([
        "client-a__tool-a",
      ]);
    });
  });
});

// A managed key is deleted after each test — minting one flips the data plane
// from open to key-required (hasAnyMcpKeys), so leaving it behind would lock
// down other test files that share this process's DB and expect open mode.
describe("POST /mcp/:clientName — tools/list is filtered by the caller's key scope", () => {
  test("a managed key scoped to one tool sees only that tool, not the client's others", async () => {
    await startApp();
    await reg("scopefilter", [makeTool({ name: "tool-a" }), makeTool({ name: "tool-b", endpoint: "/thing-b" })]);
    const { record, rawKey } = createMcpKey("scoped-to-a", { tools: ["scopefilter__tool-a"] }, null, "test");
    const auth = { Authorization: `Bearer ${rawKey}` };
    try {
      const session = await initSession("/mcp/scopefilter", auth);
      expect(session).not.toBeNull();
      const names = (await toolsList("/mcp/scopefilter", session!, auth)).body?.tools.map((t) => t.name) ?? [];
      expect(names).toContain("scopefilter__tool-a");
      expect(names).not.toContain("scopefilter__tool-b");
    } finally {
      deleteMcpKey(record.id);
    }
  });

  test("an unrestricted managed key still sees all of the client's tools", async () => {
    await startApp();
    await reg("scopefilter2", [makeTool({ name: "tool-a" }), makeTool({ name: "tool-b", endpoint: "/thing-b" })]);
    const { record, rawKey } = createMcpKey("unrestricted", null, null, "test");
    const auth = { Authorization: `Bearer ${rawKey}` };
    try {
      const session = await initSession("/mcp/scopefilter2", auth);
      const names = (await toolsList("/mcp/scopefilter2", session!, auth)).body?.tools.map((t) => t.name) ?? [];
      expect(names).toContain("scopefilter2__tool-a");
      expect(names).toContain("scopefilter2__tool-b");
    } finally {
      deleteMcpKey(record.id);
    }
  });
});

/**
 * Tests for the bundle /mcp-custom/:bundleName endpoint (src/transports.ts).
 *
 * Mirrors transports-sharded.test.ts's structure (same real MCP JSON-RPC
 * handshake over Streamable HTTP), plus bundle-specific cases: cross-client
 * tool selection, tools/call membership rejection, and confused-deputy
 * defense across bundle/bundle AND bundle/client-shard scope boundaries
 * (the client:/bundle: namespacing in transports.ts's sessionScope map).
 *
 * Unlike its sharded sibling, bundle existence is 100% SQL-durable by
 * construction (no unregister()-equivalent that skips the DB) — so this
 * file calls __resetDbForTesting() + initBundles() in beforeEach to avoid
 * cross-file leakage through the shared module-level DB singleton.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { registry } from "../registry.js";
import { __resetDbForTesting } from "../db/connection.js";
import { initBundles, createBundle, updateBundle } from "../bundles.js";
import type { RestToolDefinition } from "../types.js";

let baseUrl = "";
let activeServer: Server | null = null;
let cleanupFn: (() => void) | null = null;

async function startApp(): Promise<void> {
  const { setupTransports } = await import("../transports.js");
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
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId, ...extraHeaders },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return sessionId;
}

async function toolsList(path: string, sessionId: string): Promise<{ status: number; body?: { tools: { name: string }[] } }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }),
  });
  if (res.status !== 200) return { status: res.status };
  const parsed = parseSseJson(await res.text());
  return { status: res.status, body: parsed.result as { tools: { name: string }[] } };
}

async function toolsCall(
  path: string,
  sessionId: string,
  toolName: string
): Promise<{ status: number; body?: { isError?: boolean; content?: { type: string; text: string }[] } }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 3, params: { name: toolName, arguments: {} } }),
  });
  if (res.status !== 200) return { status: res.status };
  const parsed = parseSseJson(await res.text());
  return { status: res.status, body: parsed.result as { isError?: boolean; content?: { type: string; text: string }[] } };
}

beforeEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  __resetDbForTesting();
  initBundles();
});

afterEach(async () => {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  await stopApp();
});

describe("POST /mcp-custom/:bundleName — new session", () => {
  test("404s for an unknown bundle", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/mcp-custom/nobody`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BUNDLE_NOT_FOUND");
  });

  test("establishes a session scoped to a cross-client tool selection", async () => {
    await startApp();
    await reg("client-a", [makeTool({ name: "tool-a" }), makeTool({ name: "other-a" })]);
    await reg("client-b", [makeTool({ name: "tool-b" })]);
    await createBundle(
      "mix",
      undefined,
      [
        { client: "client-a", tool: "tool-a" },
        { client: "client-b", tool: "tool-b" },
      ],
      "test"
    );

    const sessionId = await initSession("/mcp-custom/mix");
    expect(sessionId).not.toBeNull();

    const list = await toolsList("/mcp-custom/mix", sessionId!);
    expect(list.status).toBe(200);
    // Only the two bundled tools — "other-a" (same client, not in the bundle) is excluded.
    expect(list.body?.tools.map((t) => t.name).sort()).toEqual(["client-a__tool-a", "client-b__tool-b"]);
  });

  test("a disabled member tool is excluded from the bundle's tools/list", async () => {
    await startApp();
    await reg("client-a", [makeTool({ name: "tool-a" }), makeTool({ name: "tool-b" })]);
    await createBundle(
      "b",
      undefined,
      [
        { client: "client-a", tool: "tool-a" },
        { client: "client-a", tool: "tool-b" },
      ],
      "test"
    );
    await registry.setToolEnabled("client-a", "tool-a", false);

    const sessionId = await initSession("/mcp-custom/b");
    const list = await toolsList("/mcp-custom/b", sessionId!);
    expect(list.body?.tools.map((t) => t.name)).toEqual(["client-a__tool-b"]);
  });

  test("a disabled bundle serves an empty tools/list", async () => {
    await startApp();
    await reg("client-a", [makeTool({ name: "tool-a" })]);
    await createBundle("b", undefined, [{ client: "client-a", tool: "tool-a" }], "test");
    await updateBundle("b", { enabled: false });

    const sessionId = await initSession("/mcp-custom/b");
    expect(sessionId).not.toBeNull(); // session creation itself is not blocked, same as a disabled client
    const list = await toolsList("/mcp-custom/b", sessionId!);
    expect(list.body?.tools).toEqual([]);
  });
});

describe("tools/call membership enforcement", () => {
  test("rejects a real, existing tool that simply isn't a member of this bundle", async () => {
    await startApp();
    await reg("client-a", [makeTool({ name: "tool-a" })]);
    await reg("client-b", [makeTool({ name: "tool-b" })]);
    await createBundle("b", undefined, [{ client: "client-a", tool: "tool-a" }], "test");

    const sessionId = await initSession("/mcp-custom/b");
    const result = await toolsCall("/mcp-custom/b", sessionId!, "client-b__tool-b");

    expect(result.status).toBe(200);
    expect(result.body?.isError).toBe(true);
    expect(result.body?.content?.[0]?.text).toBe("Unknown tool: client-b__tool-b");
  });

  test("rejects a disabled bundle's member tool without attempting the call", async () => {
    await startApp();
    await reg("client-a", [makeTool({ name: "tool-a" })]);
    await createBundle("b", undefined, [{ client: "client-a", tool: "tool-a" }], "test");
    await updateBundle("b", { enabled: false });

    const sessionId = await initSession("/mcp-custom/b");
    const result = await toolsCall("/mcp-custom/b", sessionId!, "client-a__tool-a");

    expect(result.body?.isError).toBe(true);
    expect(result.body?.content?.[0]?.text).toBe("Unknown tool: client-a__tool-a");
  });
});

describe("Confused-deputy defense", () => {
  test("a session bound to one bundle is rejected (GET) on a different bundle's URL", async () => {
    await startApp();
    await reg("client-a", [makeTool({ name: "tool-a" })]);
    await createBundle("bundle-a", undefined, [{ client: "client-a", tool: "tool-a" }], "test");
    await createBundle("bundle-b", undefined, [], "test");

    const sessionId = await initSession("/mcp-custom/bundle-a");
    expect(sessionId).not.toBeNull();

    const res = await fetch(`${baseUrl}/mcp-custom/bundle-b`, {
      method: "GET",
      headers: { "mcp-session-id": sessionId!, accept: "text/event-stream" },
    });
    expect(res.status).toBe(404);
  });

  test("a session bound to one bundle is rejected (DELETE) on a different bundle's URL and is not terminated", async () => {
    await startApp();
    await createBundle("bundle-a", undefined, [], "test");
    await createBundle("bundle-b", undefined, [], "test");

    const sessionId = await initSession("/mcp-custom/bundle-a");

    const res = await fetch(`${baseUrl}/mcp-custom/bundle-b`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId! },
    });
    expect(res.status).toBe(404);

    const list = await toolsList("/mcp-custom/bundle-a", sessionId!);
    expect(list.status).toBe(200);
  });

  test("a session bound to a bundle is rejected on a client-shard URL of the SAME literal name (client:/bundle: namespacing)", async () => {
    await startApp();
    await reg("shared-name"); // a client...
    await createBundle("shared-name", undefined, [], "test"); // ...and a bundle, same literal name

    const bundleSession = await initSession("/mcp-custom/shared-name");
    expect(bundleSession).not.toBeNull();

    const res = await fetch(`${baseUrl}/mcp/shared-name`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": bundleSession! },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 3 }),
    });
    expect(res.status).toBe(404);

    // And the reverse direction: a client-shard session rejected on the bundle URL of the same name.
    const clientSession = await initSession("/mcp/shared-name");
    expect(clientSession).not.toBeNull();

    const res2 = await fetch(`${baseUrl}/mcp-custom/shared-name`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": clientSession! },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 3 }),
    });
    expect(res2.status).toBe(404);
  });
});

describe("side-by-side with /mcp/:clientName and aggregated /mcp", () => {
  test("a bundle session, a sharded session, and the aggregated session all see correctly-scoped tool lists", async () => {
    await startApp();
    await reg("client-a", [makeTool({ name: "tool-a" })]);
    await reg("client-b", [makeTool({ name: "tool-b" })]);
    await createBundle("mix", undefined, [{ client: "client-b", tool: "tool-b" }], "test");

    const bundleSession = await initSession("/mcp-custom/mix");
    const bundleList = await toolsList("/mcp-custom/mix", bundleSession!);
    expect(bundleList.body?.tools.map((t) => t.name)).toEqual(["client-b__tool-b"]);

    const shardedSession = await initSession("/mcp/client-a");
    const shardedList = await toolsList("/mcp/client-a", shardedSession!);
    expect(shardedList.body?.tools.map((t) => t.name)).toEqual(["client-a__tool-a"]);

    const aggregatedSession = await initSession("/mcp");
    const aggregatedList = await toolsList("/mcp", aggregatedSession!);
    expect(aggregatedList.body?.tools.map((t) => t.name).sort()).toEqual(["client-a__tool-a", "client-b__tool-b"]);
  });
});

/**
 * Authorization surface for the /mcp system control plane
 * (src/mcp/system-tools.ts + src/security/system-role.ts): role-tier
 * visibility/dispatch, the sensitive/__confirm step-up gate, the
 * envBearerOnly restriction on sys_mint_key, and session-reuse with a
 * different credential. Also a regression test for the client-scope
 * confused-deputy fix in mcp-server.ts (exact tool->client membership,
 * not a name-prefix test).
 *
 * Does the real MCP JSON-RPC handshake over Streamable HTTP against a real
 * setupTransports() app, mirroring transports-sharded.test.ts's harness.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { createMcpKey } from "../../security/mcp-key-store.js";
import type { RestToolDefinition } from "../../mcp/types.js";

let baseUrl = "";
let activeServer: Server | null = null;
let cleanupFn: (() => void) | null = null;

const ROOT_KEY = "test-root-admin-key";
const originalAdminApiKeys = config.adminApiKeys;

async function startApp(): Promise<void> {
  __resetDbForTesting();
  (config as Record<string, unknown>).adminApiKeys = [ROOT_KEY];
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
  (config as Record<string, unknown>).adminApiKeys = originalAdminApiKeys;
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

async function toolsCall(
  path: string,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body?: { isError?: boolean; content?: { type: string; text: string }[] } }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 3, params: { name: toolName, arguments: args } }),
  });
  if (res.status !== 200) return { status: res.status };
  const parsed = parseSseJson(await res.text());
  return {
    status: res.status,
    body: parsed.result as { isError?: boolean; content?: { type: string; text: string }[] },
  };
}

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  await stopApp();
});

describe("system-tools — role-tier visibility and dispatch", () => {
  test("a viewer-role key sees only read-tier tools and cannot call an operate-tier tool", async () => {
    await startApp();
    const { rawKey: viewerKey } = createMcpKey("viewer-bot", null, null, "tester", null, false, "viewer");

    const sessionId = await initSession("/mcp", authHeader(viewerKey));
    expect(sessionId).not.toBeNull();

    const list = await toolsList("/mcp", sessionId!, authHeader(viewerKey));
    const names = list.body?.tools.map((t) => t.name) ?? [];
    expect(names).toContain("sys_list_clients");
    expect(names).not.toContain("sys_set_client_enabled");
    expect(names).not.toContain("sys_mint_key");

    const call = await toolsCall(
      "/mcp",
      sessionId!,
      "sys_set_client_enabled",
      { name: "x", enabled: false },
      authHeader(viewerKey),
    );
    expect(call.body?.isError).toBe(true);
    expect(call.body?.content?.[0]?.text).toContain("requires the 'operate' tier or higher");
  });

  test("an operator-role key can call an operate-tier tool but not an admin-tier one", async () => {
    await startApp();
    await reg("svc");
    const { rawKey: opKey } = createMcpKey("op-bot", null, null, "tester", null, false, "operator");

    const sessionId = await initSession("/mcp", authHeader(opKey));
    const enable = await toolsCall(
      "/mcp",
      sessionId!,
      "sys_set_client_enabled",
      { name: "svc", enabled: false },
      authHeader(opKey),
    );
    expect(enable.body?.isError).toBeUndefined();

    const mint = await toolsCall("/mcp", sessionId!, "sys_mint_key", { label: "nope" }, authHeader(opKey));
    expect(mint.body?.isError).toBe(true);
    expect(mint.body?.content?.[0]?.text).toContain("requires the 'admin' tier or higher");
  });
});

describe("system-tools — sensitive/__confirm step-up gate", () => {
  test("a sensitive operate-tier tool is rejected without __confirm or an elevated key", async () => {
    await startApp();
    const { rawKey: opKey } = createMcpKey("op-bot", null, null, "tester", null, false, "operator");
    const sessionId = await initSession("/mcp", authHeader(opKey));

    const result = await toolsCall("/mcp", sessionId!, "sys_delete_client", { name: "nobody" }, authHeader(opKey));
    expect(result.body?.isError).toBe(true);
    expect(result.body?.content?.[0]?.text).toContain("is sensitive");
  });

  test("__confirm: true lets a sensitive tool proceed past the step-up gate", async () => {
    await startApp();
    await reg("svc");
    const { rawKey: opKey } = createMcpKey("op-bot", null, null, "tester", null, false, "operator");
    const sessionId = await initSession("/mcp", authHeader(opKey));

    const result = await toolsCall(
      "/mcp",
      sessionId!,
      "sys_delete_client",
      { name: "svc", __confirm: true },
      authHeader(opKey),
    );
    // Proceeds to the real handler (and succeeds, since "svc" exists) rather
    // than being blocked by the sensitive gate.
    expect(result.body?.content?.[0]?.text).not.toContain("is sensitive");
    expect(result.body?.isError).toBeUndefined();
  });

  test("an elevated key skips the __confirm requirement entirely", async () => {
    await startApp();
    await reg("svc");
    const { rawKey: elevatedOpKey } = createMcpKey("elevated-op-bot", null, null, "tester", null, true, "operator");
    const sessionId = await initSession("/mcp", authHeader(elevatedOpKey));

    const result = await toolsCall("/mcp", sessionId!, "sys_delete_client", { name: "svc" }, authHeader(elevatedOpKey));
    expect(result.body?.content?.[0]?.text).not.toContain("is sensitive");
    expect(result.body?.isError).toBeUndefined();
  });
});

describe("system-tools — envBearerOnly (no self-escalation via a minted key)", () => {
  test("a managed key with adminRole:'admin' cannot call sys_mint_key — only the env Bearer can", async () => {
    await startApp();
    const { rawKey: adminKey } = createMcpKey("admin-bot", null, null, "tester", null, true, "admin");
    const sessionId = await initSession("/mcp", authHeader(adminKey));

    const result = await toolsCall(
      "/mcp",
      sessionId!,
      "sys_mint_key",
      { label: "escalate", __confirm: true },
      authHeader(adminKey),
    );
    expect(result.body?.isError).toBe(true);
    expect(result.body?.content?.[0]?.text).toContain("requires the environment admin Bearer credential");
  });

  test("the env Bearer can call sys_mint_key", async () => {
    await startApp();
    const sessionId = await initSession("/mcp", authHeader(ROOT_KEY));

    const result = await toolsCall(
      "/mcp",
      sessionId!,
      "sys_mint_key",
      { label: "ok", __confirm: true },
      authHeader(ROOT_KEY),
    );
    expect(result.body?.isError).toBeUndefined();
    expect(result.body?.content?.[0]?.text).toContain("mcp_");
  });
});

describe("system-tools — session reuse with a different credential", () => {
  test("reusing a session opened by an admin key with a viewer key's token reflects the viewer's tier, not the session-creator's", async () => {
    await startApp();
    const { rawKey: adminKey } = createMcpKey("admin-bot", null, null, "tester", null, false, "admin");
    const { rawKey: viewerKey } = createMcpKey("viewer-bot", null, null, "tester", null, false, "viewer");

    const sessionId = await initSession("/mcp", authHeader(adminKey));
    expect(sessionId).not.toBeNull();

    const listAsAdmin = await toolsList("/mcp", sessionId!, authHeader(adminKey));
    expect(listAsAdmin.body?.tools.map((t) => t.name)).toContain("sys_mint_key");

    const listAsViewer = await toolsList("/mcp", sessionId!, authHeader(viewerKey));
    expect(listAsViewer.body?.tools.map((t) => t.name)).not.toContain("sys_mint_key");

    const callAsViewer = await toolsCall("/mcp", sessionId!, "sys_mint_key", { label: "x" }, authHeader(viewerKey));
    expect(callAsViewer.body?.isError).toBe(true);
  });
});

describe("regression — client-scope tools/call uses exact tool->client membership, not a name-prefix test", () => {
  test("a session scoped to /mcp/acme cannot reach a tool belonging to an unrelated client named 'acme__evil'", async () => {
    await startApp();
    await reg("acme", [makeTool({ name: "safe-op" })]);
    await reg("acme__evil", [makeTool({ name: "steal" })]);

    const sessionId = await initSession("/mcp/acme");
    expect(sessionId).not.toBeNull();

    // tools/list correctly scopes to "acme" only.
    const list = await toolsList("/mcp/acme", sessionId!);
    expect(list.body?.tools.map((t) => t.name).filter((n) => n !== "search_tools")).toEqual(["acme__safe-op"]);

    // tools/call must reject the sibling client's tool even though its name
    // extends "acme" across the "__" separator.
    const result = await toolsCall("/mcp/acme", sessionId!, "acme__evil__steal");
    expect(result.body?.isError).toBe(true);
    expect(result.body?.content?.[0]?.text).toBe("Unknown tool: acme__evil__steal");
  });
});

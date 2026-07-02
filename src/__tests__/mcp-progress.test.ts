/**
 * MCP-to-MCP progress notifications and cancellation forwarding.
 *
 * Two layers: McpUpstreamPool.call's direct SDK plumbing (onprogress/signal),
 * and the full proxyToolCall -> dispatchMcpToolCall integration for the
 * breaker-non-penalization guarantee on a caller-initiated cancel.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../registry.js";
import { removeCircuitBreaker, getAllCircuitStates } from "../circuit-breaker.js";
import { proxyToolCall } from "../proxy.js";
import { McpUpstreamPool, mcpUpstream, buildTransport, type McpConnParams } from "../mcp-upstream.js";
import type { DiscoveredMcpTool } from "../mcp-discovery.js";
import type { Progress } from "@modelcontextprotocol/sdk/types.js";

let lastSeenProgressToken: string | number | undefined;

function makeFactory(): (p: McpConnParams) => Transport {
  return (_p: McpConnParams): Transport => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "test-upstream", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: "with-progress", description: "reports progress", inputSchema: { type: "object" } },
        { name: "hangs", description: "never resolves quickly", inputSchema: { type: "object" } },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      lastSeenProgressToken = req.params._meta?.progressToken;
      if (req.params.name === "with-progress") {
        const token = req.params._meta?.progressToken;
        if (token !== undefined) {
          await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: 1, total: 3 } });
          await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: 2, total: 3 } });
        }
        return { content: [{ type: "text", text: "done" }] };
      }
      if (req.params.name === "hangs") {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return { content: [{ type: "text", text: "should not get here" }] };
      }
      return { content: [{ type: "text", text: "unknown" }], isError: true };
    });
    void server.connect(serverT);
    return clientT;
  };
}

const PARAMS: McpConnParams = { name: "up1", url: "http://example.test/mcp", transport: "streamable-http" };

describe("McpUpstreamPool.call — progress forwarding", () => {
  test("forwards upstream progress notifications to onprogress when the caller requested them", async () => {
    const pool = new McpUpstreamPool({ transportFactory: makeFactory() });
    const received: Progress[] = [];
    const r = await pool.call(PARAMS, "with-progress", {}, { timeoutMs: 2000, maxBytes: 1_000_000, onprogress: (p) => received.push(p) });
    expect(r.isError).toBeUndefined();
    expect(lastSeenProgressToken).toBeDefined(); // SDK auto-populated _meta.progressToken because onprogress was set
    expect(received.map((p) => p.progress)).toEqual([1, 2]);
    await pool.disconnect("up1");
  });

  test("never requests progress from the upstream when onprogress is not provided", async () => {
    lastSeenProgressToken = "unset";
    const pool = new McpUpstreamPool({ transportFactory: makeFactory() });
    const r = await pool.call(PARAMS, "with-progress", {}, { timeoutMs: 2000, maxBytes: 1_000_000 });
    expect(r.isError).toBeUndefined();
    expect(lastSeenProgressToken).toBeUndefined();
    await pool.disconnect("up1");
  });
});

describe("McpUpstreamPool.call — cancellation", () => {
  test("an aborted signal yields a cancelled result and leaves the connection live (no disconnect)", async () => {
    const pool = new McpUpstreamPool({ transportFactory: makeFactory() });
    const controller = new AbortController();
    const callPromise = pool.call(PARAMS, "hangs", {}, { timeoutMs: 10_000, maxBytes: 1_000_000, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();

    const r = await callPromise;
    expect(r.isError).toBe(true);
    expect(r.cancelled).toBe(true);
    // Connection preserved — a caller cancel is not a connection failure.
    expect(pool.isConnected("up1")).toBe(true);
    await pool.disconnect("up1");
  });
});

describe("proxyToolCall — MCP-kind dispatch integration", () => {
  const CLIENT = "mcp-progress-test-client";
  const TOOLS: DiscoveredMcpTool[] = [
    { name: "hangs", upstreamName: "hangs", description: "Slow", inputSchema: { type: "object" } },
  ];

  beforeEach(async () => {
    __resetDbForTesting();
    removeCircuitBreaker(CLIENT);
    mcpUpstream.__setTransportFactoryForTesting(makeFactory());
    await registry.registerMcp(CLIENT, TOOLS, "http://mcp.test/mcp", "streamable-http", "127.0.0.1", "127.0.0.1");
  });

  afterEach(async () => {
    await registry.unregister(CLIENT);
    await mcpUpstream.disconnect(CLIENT);
    removeCircuitBreaker(CLIENT);
    mcpUpstream.__setTransportFactoryForTesting(buildTransport);
  });

  test("a downstream cancellation does not penalize the circuit breaker", async () => {
    const controller = new AbortController();
    const callPromise = proxyToolCall(`${CLIENT}__hangs`, {}, undefined, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();

    const r = await callPromise;
    expect(r.isError).toBe(true);
    expect(r.content[0].text.toLowerCase()).toContain("cancel");
    expect(getAllCircuitStates()[CLIENT]).toBe("closed");
  });
});

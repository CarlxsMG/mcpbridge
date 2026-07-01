import { describe, test, expect } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpUpstreamPool, mcpResultToProxyResult, type McpConnParams } from "../mcp-upstream.js";
import { normalizeToolName, discoverMapTools, discoverToolsFromMcpServer } from "../mcp-discovery.js";

// A fake upstream MCP server, served over an in-process InMemoryTransport pair.
// Tool names deliberately exercise the normalizer + collision handling.
const LIST_TOOLS = [
  {
    name: "echo",
    description: "Echoes input",
    inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
  },
  { name: "Weird.Name", description: "", inputSchema: { type: "object" } },
  { name: "weird_name", description: "collides after normalize", inputSchema: { type: "object" } },
];

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function handleCall(name: string, args: Record<string, unknown>): ToolResult | Promise<ToolResult> {
  switch (name) {
    case "echo":
      return { content: [{ type: "text", text: `echo:${String(args.msg)}` }] };
    case "boom":
      return { content: [{ type: "text", text: "boom details" }], isError: true };
    case "slow":
      return new Promise<ToolResult>((res) =>
        setTimeout(() => res({ content: [{ type: "text", text: "late" }] }), 300)
      );
    case "big":
      return { content: [{ type: "text", text: "x".repeat(5000) }] };
    default:
      return { content: [{ type: "text", text: `unknown:${name}` }], isError: true };
  }
}

/** Transport factory that spins a fresh in-process server per connection. */
function makeFactory() {
  let connects = 0;
  const factory = (_p: McpConnParams): Transport => {
    connects++;
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "test-upstream", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: LIST_TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (req) =>
      handleCall(req.params.name, req.params.arguments ?? {})
    );
    void server.connect(serverT);
    return clientT;
  };
  return { factory, connects: () => connects };
}

const PARAMS: McpConnParams = { name: "up1", url: "http://example.test/mcp", transport: "streamable-http" };

describe("McpUpstreamPool.call", () => {
  test("forwards a tools/call and passes the result through", async () => {
    const { factory } = makeFactory();
    const pool = new McpUpstreamPool({ transportFactory: factory });
    const r = await pool.call(PARAMS, "echo", { msg: "hi" }, { timeoutMs: 2000, maxBytes: 1_000_000 });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]).toEqual({ type: "text", text: "echo:hi" });
    await pool.disconnect("up1");
  });

  test("preserves an upstream isError result", async () => {
    const { factory } = makeFactory();
    const pool = new McpUpstreamPool({ transportFactory: factory });
    const r = await pool.call(PARAMS, "boom", {}, { timeoutMs: 2000, maxBytes: 1_000_000 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("boom details");
    await pool.disconnect("up1");
  });

  test("maps a per-call timeout to an error result (no double-execute)", async () => {
    const { factory } = makeFactory();
    const pool = new McpUpstreamPool({ transportFactory: factory });
    const r = await pool.call(PARAMS, "slow", {}, { timeoutMs: 50, maxBytes: 1_000_000 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("MCP tool call failed");
    await pool.disconnect("up1");
  });

  test("enforces the response byte cap", async () => {
    const { factory } = makeFactory();
    const pool = new McpUpstreamPool({ transportFactory: factory });
    const r = await pool.call(PARAMS, "big", {}, { timeoutMs: 2000, maxBytes: 1000 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("exceeded");
    await pool.disconnect("up1");
  });

  test("reuses one connection, then reconnects after disconnect", async () => {
    const { factory, connects } = makeFactory();
    const pool = new McpUpstreamPool({ transportFactory: factory });

    await pool.call(PARAMS, "echo", { msg: "a" }, { timeoutMs: 2000, maxBytes: 1_000_000 });
    await pool.call(PARAMS, "echo", { msg: "b" }, { timeoutMs: 2000, maxBytes: 1_000_000 });
    expect(connects()).toBe(1); // second call reused the pooled connection
    expect(pool.isConnected("up1")).toBe(true);

    await pool.disconnect("up1");
    expect(pool.isConnected("up1")).toBe(false);

    await pool.call(PARAMS, "echo", { msg: "c" }, { timeoutMs: 2000, maxBytes: 1_000_000 });
    expect(connects()).toBe(2); // reconnected
    await pool.disconnect("up1");
  });

  test("ping returns true against a live upstream", async () => {
    const { factory } = makeFactory();
    const pool = new McpUpstreamPool({ transportFactory: factory });
    expect(await pool.ping(PARAMS, 2000)).toBe(true);
    await pool.disconnect("up1");
  });
});

describe("discovery", () => {
  test("normalizeToolName conforms to the registry regex", () => {
    expect(normalizeToolName("echo")).toBe("echo");
    expect(normalizeToolName("Weird.Name")).toBe("weird_name");
    expect(normalizeToolName("-leading")).toBe("t-leading");
    expect(normalizeToolName("GitHub/Create-Issue")).toBe("github_create-issue");
    expect(normalizeToolName("")).toBe("tool");
    expect(normalizeToolName("A".repeat(80)).length).toBeLessThanOrEqual(63);
  });

  test("discoverMapTools normalizes, de-dupes, keeps upstreamName, and backfills description", () => {
    const mapped = discoverMapTools(LIST_TOOLS);
    expect(mapped.map((t) => t.name)).toEqual(["echo", "weird_name", "weird_name_2"]);
    expect(mapped.map((t) => t.upstreamName)).toEqual(["echo", "Weird.Name", "weird_name"]);
    // empty upstream description → synthesized fallback that references the raw name
    expect(mapped[1].description).toContain("Weird.Name");
    expect(mapped[0].description).toBe("Echoes input");
  });

  test("discoverToolsFromMcpServer lists tools over a real Client connection", async () => {
    const { factory } = makeFactory();
    const tools = await discoverToolsFromMcpServer(PARAMS, { transportFactory: factory, timeoutMs: 2000 });
    expect(tools).toHaveLength(3);
    expect(tools[0]).toMatchObject({ name: "echo", upstreamName: "echo" });
  });
});

describe("mcpResultToProxyResult", () => {
  test("JSON-encodes non-text content instead of dropping it", () => {
    const r = mcpResultToProxyResult(
      { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
      1_000_000
    );
    expect(r.isError).toBeUndefined();
    expect(r.content[0].type).toBe("text");
    expect(r.content[0].text).toContain("image/png");
  });
});

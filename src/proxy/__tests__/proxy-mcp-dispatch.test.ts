import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import { mcpUpstream, buildTransport, type McpConnParams } from "../../mcp/mcp-upstream.js";
import type { DiscoveredMcpTool } from "../../mcp/mcp-discovery.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function handleCall(name: string, args: Record<string, unknown>): ToolResult {
  if (name === "echo") return { content: [{ type: "text", text: `echo:${String(args.msg)}` }] };
  if (name === "boom") return { content: [{ type: "text", text: "boom" }], isError: true };
  return { content: [{ type: "text", text: `unknown:${name}` }], isError: true };
}

// Injected into the shared pool so the proxy's MCP branch reaches an in-process
// server instead of a real network endpoint.
function factory(_p: McpConnParams): Transport {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "up", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "e",
        inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    handleCall(req.params.name, req.params.arguments ?? {}),
  );
  void server.connect(serverT);
  return clientT;
}

const TOOLS: DiscoveredMcpTool[] = [
  {
    name: "echo",
    upstreamName: "echo",
    description: "Echoes",
    inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
  },
  { name: "boom", upstreamName: "boom", description: "Fails", inputSchema: { type: "object" } },
];

describe("proxyToolCall — MCP-kind dispatch", () => {
  beforeEach(async () => {
    __resetDbForTesting();
    mcpUpstream.__setTransportFactoryForTesting(factory);
    await registry.registerMcp("up", TOOLS, "http://mcp.test/mcp", "streamable-http", "127.0.0.1", "127.0.0.1");
  });

  afterEach(async () => {
    await registry.unregister("up");
    await mcpUpstream.disconnect("up");
    // Restore the real transport factory so other test files are unaffected.
    mcpUpstream.__setTransportFactoryForTesting(buildTransport);
  });

  test("forwards to the MCP upstream and returns its content", async () => {
    const r = await proxyToolCall("up__echo", { msg: "hi" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe("echo:hi");
  });

  test("propagates an upstream isError result", async () => {
    const r = await proxyToolCall("up__boom", {});
    expect(r.isError).toBe(true);
  });

  test("validates args against the tool inputSchema before dispatch", async () => {
    const r = await proxyToolCall("up__echo", {}); // missing required msg
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Argument validation failed");
  });

  test("a disabled MCP tool is rejected by the proxy backstop", async () => {
    await registry.setToolEnabled("up", "echo", false);
    const r = await proxyToolCall("up__echo", { msg: "hi" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("disabled");
  });

  test("advertises MCP tools via getAllMcpTools", () => {
    const names = registry
      .getAllMcpTools()
      .map((t) => t.name)
      .filter((n) => n.startsWith("up__"));
    expect(names.sort()).toEqual(["up__boom", "up__echo"]);
  });
});

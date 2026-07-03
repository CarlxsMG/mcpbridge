/**
 * Upstream MCP resources/prompts passthrough — the pool's list/read/get methods
 * against an in-process MCP server, plus graceful [] when the upstream lacks the
 * capability.
 */
import { describe, test, expect } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpUpstreamPool, type McpConnParams } from "../mcp-upstream.js";

const PARAMS: McpConnParams = { name: "up1", url: "http://example.test/mcp", transport: "streamable-http" };

/** Full upstream: tools + resources + prompts. */
function richFactory(): (p: McpConnParams) => Transport {
  return () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "up", version: "1.0.0" }, { capabilities: { resources: {}, prompts: {} } });
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: "mem://a", name: "A" }] }));
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
      contents: [{ uri: req.params.uri, text: `content:${req.params.uri}` }],
    }));
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [{ name: "greet", description: "greet" }],
    }));
    server.setRequestHandler(GetPromptRequestSchema, async (req) => ({
      messages: [{ role: "user", content: { type: "text", text: `hi ${req.params.arguments?.who ?? ""}` } }],
    }));
    void server.connect(serverT);
    return clientT;
  };
}

/** Tools-only upstream: no resources/prompts handlers. */
function toolsOnlyFactory(): (p: McpConnParams) => Transport {
  return () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "up", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    void server.connect(serverT);
    return clientT;
  };
}

describe("resources/prompts passthrough", () => {
  test("list/read resources and list/get prompts pass through", async () => {
    const pool = new McpUpstreamPool({ transportFactory: richFactory() });
    expect(await pool.listResources(PARAMS, 2000)).toEqual([{ uri: "mem://a", name: "A" }]);

    const r = (await pool.readResource(PARAMS, "mem://a", 2000)) as { contents: Array<{ text: string }> };
    expect(r.contents[0].text).toBe("content:mem://a");

    expect(await pool.listPrompts(PARAMS, 2000)).toEqual([{ name: "greet", description: "greet" }]);

    const g = (await pool.getPrompt(PARAMS, "greet", { who: "bob" }, 2000)) as {
      messages: Array<{ content: { text: string } }>;
    };
    expect(g.messages[0].content.text).toBe("hi bob");

    await pool.disconnect("up1");
  });

  test("list degrades to [] when the upstream lacks the capability", async () => {
    const pool = new McpUpstreamPool({ transportFactory: toolsOnlyFactory() });
    expect(await pool.listResources(PARAMS, 2000)).toEqual([]);
    expect(await pool.listPrompts(PARAMS, 2000)).toEqual([]);
    await pool.disconnect("up1");
  });
});

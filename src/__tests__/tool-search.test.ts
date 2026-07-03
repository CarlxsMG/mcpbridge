/**
 * search_tools meta-tool — pure ranking, the runSearchTool result shape, and
 * end-to-end advertisement + dispatch through the MCP server handlers.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../registry.js";
import { createMcpServer } from "../mcp-server.js";
import { rankTools, runSearchTool, searchToolDefinition, SEARCH_TOOL_NAME } from "../tool-search.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RestToolDefinition } from "../types.js";
import type { AdvertisedTool } from "../tool-search.js";

/** Connects a real SDK Client to a bridge MCP server over an in-process transport pair. */
async function connectClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function tool(name: string, description: string): RestToolDefinition {
  return { name, method: "GET", endpoint: `/${name}`, description, inputSchema: { type: "object", properties: {} } };
}
async function reg(clientName: string, tools: RestToolDefinition[]): Promise<void> {
  await registry.register(clientName, tools, "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
  (config as Record<string, unknown>).enableSearchTool = true;
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
});

const SAMPLE: AdvertisedTool[] = [
  { name: "github__create_issue", description: "Create an issue in a repository", inputSchema: {} },
  { name: "github__list_issues", description: "List issues for a repository", inputSchema: {} },
  { name: "slack__post_message", description: "Post a message to a Slack channel", inputSchema: {} },
];

describe("rankTools", () => {
  test("ranks name matches above description-only matches", () => {
    const ranked = rankTools("issue", SAMPLE, 10);
    expect(ranked[0].name.includes("issue")).toBe(true);
    // slack tool has no 'issue' token in name or description -> excluded
    expect(ranked.find((r) => r.name === "slack__post_message")).toBeUndefined();
  });

  test("whole-query substring of the name boosts that tool", () => {
    const ranked = rankTools("create_issue", SAMPLE, 10);
    expect(ranked[0].name).toBe("github__create_issue");
  });

  test("empty query returns nothing", () => {
    expect(rankTools("   ", SAMPLE, 10)).toEqual([]);
  });

  test("limit truncates results", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      name: `svc__tool_${i}`,
      description: "search me",
      inputSchema: {},
    }));
    expect(rankTools("search", many, 5).length).toBe(5);
  });
});

describe("runSearchTool", () => {
  test("returns a JSON payload of matches", () => {
    const res = runSearchTool({ query: "message" }, SAMPLE);
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0].text) as { count: number; matches: { name: string }[] };
    expect(parsed.matches[0].name).toBe("slack__post_message");
    expect(parsed.count).toBe(1);
  });

  test("errors on a missing query", () => {
    const res = runSearchTool({}, SAMPLE);
    expect(res.isError).toBe(true);
  });
});

describe("search_tools — MCP server integration", () => {
  test("advertised in tools/list when tools exist", async () => {
    await reg("github", [tool("create_issue", "Create an issue"), tool("list_issues", "List issues")]);
    const { client, close } = await connectClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain(SEARCH_TOOL_NAME);
      expect(names).toContain("github__create_issue");
    } finally {
      await close();
    }
  });

  test("not advertised when the scope has no tools", async () => {
    const { client, close } = await connectClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBe(0);
    } finally {
      await close();
    }
  });

  test("calling search_tools returns ranked matches without hitting proxyToolCall", async () => {
    await reg("github", [tool("create_issue", "Create an issue in a repo"), tool("list_issues", "List issues")]);
    const { client, close } = await connectClient();
    try {
      const result = await client.callTool({ name: SEARCH_TOOL_NAME, arguments: { query: "create issue" } });
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text) as { matches: { name: string }[] };
      expect(parsed.matches[0].name).toBe("github__create_issue");
    } finally {
      await close();
    }
  });

  test("disabling the flag removes it from tools/list", async () => {
    await reg("github", [tool("create_issue", "Create an issue")]);
    (config as Record<string, unknown>).enableSearchTool = false;
    const { client, close } = await connectClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).not.toContain(SEARCH_TOOL_NAME);
    } finally {
      await close();
    }
  });

  test("search tool definition has a required query param", () => {
    const def = searchToolDefinition();
    expect(def.name).toBe(SEARCH_TOOL_NAME);
    expect(def.inputSchema.required as string[]).toContain("query");
  });
});

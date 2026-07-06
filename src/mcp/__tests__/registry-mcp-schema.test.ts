import { describe, test, expect, beforeEach } from "bun:test";
import { __resetDbForTesting, getDb } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import type { DiscoveredMcpTool } from "../../mcp/mcp-discovery.js";

// Registry tests must reset the shared module-level DB in beforeEach — unregister()
// deliberately does not purge SQLite, so state would otherwise leak across files.
describe("migration #16 — mcp upstream columns", () => {
  beforeEach(() => {
    __resetDbForTesting();
  });

  test("adds kind/mcp_url/mcp_transport to clients and upstream_name to tools", () => {
    const db = getDb();
    const clientCols = (db.query(`PRAGMA table_info(clients)`).all() as { name: string }[]).map((c) => c.name);
    expect(clientCols).toContain("kind");
    expect(clientCols).toContain("mcp_url");
    expect(clientCols).toContain("mcp_transport");

    const toolCols = (db.query(`PRAGMA table_info(tools)`).all() as { name: string }[]).map((c) => c.name);
    expect(toolCols).toContain("upstream_name");
  });

  test("an existing REST registration defaults to kind='rest'", async () => {
    await registry.register(
      "svc",
      [{ name: "get-x", method: "GET", endpoint: "/x", description: "desc", inputSchema: { type: "object" } }],
      "http://10.0.0.1/health",
      "10.0.0.1",
      "http://10.0.0.1",
      "10.0.0.1",
      false,
    );

    const row = getDb().query(`SELECT kind FROM clients WHERE name = ?`).get("svc") as { kind: string };
    expect(row.kind).toBe("rest");
    expect(registry.getClient("svc")?.kind).toBe("rest");

    await registry.unregister("svc");
  });

  test("an MCP registration surfaces kind/mcpUrl/upstreamName in the read models", async () => {
    const tools: DiscoveredMcpTool[] = [
      { name: "echo", upstreamName: "echo", description: "Echoes", inputSchema: { type: "object" } },
    ];
    await registry.registerMcp("mcpsvc", tools, "http://mcp.test/mcp", "streamable-http", "127.0.0.1", "127.0.0.1");

    const detail = registry.getClientDetail("mcpsvc");
    expect(detail?.kind).toBe("mcp");
    expect(detail?.mcpUrl).toBe("http://mcp.test/mcp");
    expect(detail?.mcpTransport).toBe("streamable-http");
    expect(detail?.tools[0]?.upstreamName).toBe("echo");

    const summary = registry.listClientsSummary({ q: "mcpsvc" });
    expect(summary.items[0]?.kind).toBe("mcp");

    await registry.unregister("mcpsvc");
  });
});

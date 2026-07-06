import { describe, test, expect } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpConnParams } from "../../mcp/mcp-upstream.js";
import {
  normalizeToolName,
  discoverMapTools,
  discoverToolsFromMcpServer,
  type DiscoveredMcpTool,
} from "../../mcp/mcp-discovery.js";

// ---------------------------------------------------------------------------
// Direct coverage for mcp-discovery.ts (previously only exercised indirectly
// via mcp-upstream.test.ts and registry-mcp-schema.test.ts).
//
// Note on SSRF/validation: discoverToolsFromMcpServer performs NO SSRF/IP
// validation itself — it only opens a Client against whatever transport the
// factory hands it. The SSRF check (src/net/ip-validator.ts's
// validateBackendUrl) is performed by the CALLER, src/routes/register.ts's
// performMcpRegistration(), *before* discoverToolsFromMcpServer is ever
// invoked (see register.ts around the `validateBackendUrl(mcpUrl, ...)`
// call). Since mcp-discovery.ts does not import ip-validator.ts at all,
// there is no SSRF behavior in this module to test directly — that
// responsibility lives in routes-register.test.ts. This is intentionally
// skipped here rather than testing something the module doesn't do.
// ---------------------------------------------------------------------------

const PARAMS: McpConnParams = { name: "up1", url: "http://example.test/mcp", transport: "streamable-http" };

// ---------------------------------------------------------------------------
// normalizeToolName
// ---------------------------------------------------------------------------

describe("normalizeToolName", () => {
  test("passes through an already-conforming lowercase name", () => {
    expect(normalizeToolName("get_item")).toBe("get_item");
  });

  test("lowercases uppercase names", () => {
    expect(normalizeToolName("GetItem")).toBe("getitem");
  });

  test("replaces dots and slashes with underscores", () => {
    expect(normalizeToolName("github.repos/list")).toBe("github_repos_list");
  });

  test("replaces spaces and other punctuation", () => {
    expect(normalizeToolName("do the thing!")).toBe("do_the_thing_");
  });

  test("prefixes with 't' when the name starts with a non-alphanumeric char", () => {
    expect(normalizeToolName("-leading-dash")).toBe("t-leading-dash");
    expect(normalizeToolName("_leading_underscore")).toBe("t_leading_underscore");
  });

  test("leaves a leading digit untouched (digits are alphanumeric)", () => {
    expect(normalizeToolName("123tool")).toBe("123tool");
  });

  test("empty string maps to the literal fallback 'tool'", () => {
    expect(normalizeToolName("")).toBe("tool");
  });

  test("a name that becomes empty after stripping (all unsafe chars) still yields a usable name", () => {
    // "!!!" -> "___" (non-empty after replace, but doesn't start alnum) -> "t___"
    expect(normalizeToolName("!!!")).toBe("t___");
  });

  test("truncates to a maximum of 63 characters", () => {
    const long = normalizeToolName("a".repeat(200));
    expect(long.length).toBe(63);
    expect(long).toBe("a".repeat(63));
  });

  test("truncation is applied after the 't' prefix is added", () => {
    const long = normalizeToolName("-" + "a".repeat(200));
    expect(long.length).toBe(63);
    expect(long.startsWith("t")).toBe(true);
  });
});

describe("normalizeToolName — unicode", () => {
  test("non-ASCII letters are treated as unsafe and replaced with underscores", () => {
    expect(normalizeToolName("café")).toBe("caf_");
    expect(normalizeToolName("café_tool")).toBe("caf__tool");
  });
});

// ---------------------------------------------------------------------------
// discoverMapTools
// ---------------------------------------------------------------------------

describe("discoverMapTools", () => {
  test("maps name/description/inputSchema/upstreamName straight through when already safe", () => {
    const out = discoverMapTools([{ name: "echo", description: "Echoes input", inputSchema: { type: "object" } }]);
    expect(out).toEqual([
      { name: "echo", upstreamName: "echo", description: "Echoes input", inputSchema: { type: "object" } },
    ]);
  });

  test("synthesizes a fallback description when missing", () => {
    const out = discoverMapTools([{ name: "noop", inputSchema: { type: "object" } }]);
    expect(out[0].description).toBe('Tool "noop" from upstream MCP server');
  });

  test("synthesizes a fallback description when description is whitespace-only", () => {
    const out = discoverMapTools([{ name: "noop", description: "   ", inputSchema: { type: "object" } }]);
    expect(out[0].description).toBe('Tool "noop" from upstream MCP server');
  });

  test("de-dupes three-way collisions with numeric suffixes", () => {
    const out = discoverMapTools([
      { name: "Get.Item", inputSchema: {} },
      { name: "get_item", inputSchema: {} },
      { name: "get item", inputSchema: {} },
    ]);
    expect(out.map((t) => t.name)).toEqual(["get_item", "get_item_2", "get_item_3"]);
    // Original upstream names are preserved verbatim for dispatch.
    expect(out.map((t) => t.upstreamName)).toEqual(["Get.Item", "get_item", "get item"]);
  });

  test("empty input list maps to an empty output list", () => {
    expect(discoverMapTools([])).toEqual([]);
  });

  test("collision suffix search skips already-used suffixed names", () => {
    // Three tools that all normalize to "x": first keeps "x", second and third
    // both need a suffix; the loop must skip any suffix already taken.
    const out = discoverMapTools([
      { name: "x", inputSchema: {} },
      { name: "X", inputSchema: {} },
      { name: "x ", inputSchema: {} },
    ]);
    const names = out.map((t) => t.name);
    expect(new Set(names).size).toBe(3); // all unique
    expect(names[0]).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// discoverToolsFromMcpServer — success, pagination, error/timeout handling
// ---------------------------------------------------------------------------

/** Builds a transport factory around a fresh in-process MCP server per connection. */
function makeFactory(
  handler: (cursor: string | undefined) => Promise<{
    tools: DiscoveredMcpTool[] | Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
    nextCursor?: string;
  }>,
) {
  const factory = (_p: McpConnParams): Transport => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "test-upstream", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async (req) => {
      const cursor = req.params?.cursor;
      return handler(cursor);
    });
    void server.connect(serverT);
    return clientT;
  };
  return factory;
}

describe("discoverToolsFromMcpServer — success path", () => {
  test("lists tools from a single (non-paginated) page and maps them", async () => {
    const factory = makeFactory(async () => ({
      tools: [
        { name: "echo", description: "Echoes input", inputSchema: { type: "object" } },
        { name: "Weird.Name", inputSchema: { type: "object" } },
      ],
    }));

    const tools = await discoverToolsFromMcpServer(PARAMS, { transportFactory: factory, timeoutMs: 2000 });

    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({
      name: "echo",
      upstreamName: "echo",
      description: "Echoes input",
      inputSchema: { type: "object" },
    });
    expect(tools[1].name).toBe("weird_name");
    expect(tools[1].upstreamName).toBe("Weird.Name");
  });

  test("returns an empty array when the upstream has no tools", async () => {
    const factory = makeFactory(async () => ({ tools: [] }));
    const tools = await discoverToolsFromMcpServer(PARAMS, { transportFactory: factory, timeoutMs: 2000 });
    expect(tools).toEqual([]);
  });
});

describe("discoverToolsFromMcpServer — pagination", () => {
  test("follows nextCursor across multiple pages and merges results in order", async () => {
    const seenCursors: Array<string | undefined> = [];
    const factory = makeFactory(async (cursor) => {
      seenCursors.push(cursor);
      if (!cursor) {
        return { tools: [{ name: "page1-a", inputSchema: { type: "object" } }], nextCursor: "page2" };
      }
      if (cursor === "page2") {
        return { tools: [{ name: "page2-a", inputSchema: { type: "object" } }], nextCursor: "page3" };
      }
      // page3 — final page, no nextCursor
      return { tools: [{ name: "page3-a", inputSchema: { type: "object" } }] };
    });

    const tools = await discoverToolsFromMcpServer(PARAMS, { transportFactory: factory, timeoutMs: 2000 });

    expect(seenCursors).toEqual([undefined, "page2", "page3"]);
    expect(tools.map((t) => t.upstreamName)).toEqual(["page1-a", "page2-a", "page3-a"]);
  });

  test("a single page with no nextCursor makes exactly one tools/list call", async () => {
    let calls = 0;
    const factory = makeFactory(async () => {
      calls++;
      return { tools: [{ name: "only", inputSchema: { type: "object" } }] };
    });

    await discoverToolsFromMcpServer(PARAMS, { transportFactory: factory, timeoutMs: 2000 });
    expect(calls).toBe(1);
  });
});

describe("discoverToolsFromMcpServer — error handling", () => {
  test("propagates a synchronous transport-factory failure (e.g. connection setup error)", async () => {
    const factory = (_p: McpConnParams): Transport => {
      throw new Error("dial failed");
    };
    await expect(discoverToolsFromMcpServer(PARAMS, { transportFactory: factory, timeoutMs: 2000 })).rejects.toThrow(
      "dial failed",
    );
  });

  test("propagates rejection when the server never responds and the connect times out", async () => {
    // A transport whose client side never receives anything back — the SDK's
    // own request-timeout machinery (via the `timeout` option) must reject.
    const factory = (_p: McpConnParams): Transport => {
      const [clientT] = InMemoryTransport.createLinkedPair();
      // Deliberately do not connect a server to the other end — client.connect()
      // will hang until the timeout fires.
      return clientT;
    };

    await expect(discoverToolsFromMcpServer(PARAMS, { transportFactory: factory, timeoutMs: 50 })).rejects.toThrow();
  });

  test("propagates rejection when tools/list itself times out mid-pagination", async () => {
    const factory = makeFactory(async () => {
      // Never resolves within the timeout window.
      await new Promise((res) => setTimeout(res, 5000));
      return { tools: [] };
    });

    await expect(discoverToolsFromMcpServer(PARAMS, { transportFactory: factory, timeoutMs: 50 })).rejects.toThrow();
  });

  test("uses the default 10s timeout when none is supplied (does not throw immediately)", async () => {
    // Not asserting the full 10s wait — just that omitting timeoutMs doesn't
    // itself throw synchronously and the default path still succeeds fast
    // against a responsive server.
    const factory = makeFactory(async () => ({ tools: [{ name: "fast", inputSchema: { type: "object" } }] }));
    const tools = await discoverToolsFromMcpServer(PARAMS, { transportFactory: factory });
    expect(tools.map((t) => t.upstreamName)).toEqual(["fast"]);
  });
});

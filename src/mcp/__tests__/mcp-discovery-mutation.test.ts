/**
 * Stryker mutation-testing backstop for src/mcp/mcp-discovery.ts (MCP
 * upstream tool discovery: name normalization, collision de-dup,
 * description fallback, and the paginated tools/list connect flow). 53
 * mutants, 77.36% baseline (41/53) — the existing coverage
 * (mcp-upstream.test.ts's "discovery" describe block) only ever exercises a
 * TWO-way name collision and a single-page tools/list, leaving the
 * multi-collision loop, the description-fallback's whitespace-only case,
 * and the connect/listTools per-call timeouts untested.
 *
 * Written directly (no agent round — small survivor count), one file,
 * following the registry-persistence-mutation.test.ts / mcp-upstream-
 * mutation.test.ts convention. Each test cites the exact line:column +
 * mutator + replacement it targets.
 *
 * Reuses two techniques already established in mcp-upstream-mutation.test.ts:
 *   - `getClientVersion()` (a Server, connected via InMemoryTransport,
 *     observing what CLIENT_NAME/CLIENT_VERSION this file's Client reports).
 *   - `delayMethod()` (monkey-patching a real transport's send() to delay
 *     one JSON-RPC method), to prove a custom timeoutMs is actually honored
 *     rather than silently falling back to the SDK's own much larger
 *     default.
 *
 * FIXED (2026-07-16): discoverMapTools's collision-suffix loop used to be
 * hand-rolled here and could infinite-loop (freezing the whole gateway, no
 * `await` in the loop body) whenever the normalized base name was already 63
 * characters — every `${name}_${i}`.slice(0, 63)` candidate collapsed back to
 * the identical string, so `used.has(...)` never went false. It now delegates
 * to the shared `uniqueToolName` helper (src/discovery/tool-naming.ts,
 * already used by openapi-discovery.ts/graphql-discovery.ts), which
 * truncates the BASE name first and is proven to terminate within
 * `used.size + 1` iterations. The mutants below that targeted the old inline
 * loop no longer apply to this file; `uniqueToolName` has its own dedicated
 * mutation-test backstop (tool-naming-mutation.test.ts). The "three tools"
 * test below is kept as an integration-level check that discoverMapTools
 * still produces the right suffixes end-to-end.
 *
 * NOT CHASED (documented per task instructions rather than dropped silently
 * — verified after a verify1 Stryker run against this file's first pass):
 *
 *   - 95:77-95:97 ObjectLiteral (`{ capabilities: {} }` -> `{}` on the
 *     `Client` constructor's second argument) is the SAME equivalence
 *     already documented twice elsewhere in this series
 *     (mcp-upstream-mutation.test.ts, mcp-server-mutation-s2.test.ts): the
 *     SDK's own `Client` constructor does
 *     `this._capabilities = options?.capabilities ?? {}`, so an emptied
 *     options object and the real `{ capabilities: {} }` both leave
 *     `_capabilities` as `{}` either way — the SDK's own default subsumes
 *     ours.
 *   - [RESOLVED — see FIXED note below] this bullet used to document a
 *     genuine infinite loop for near-63-char collisions in this file's own
 *     hand-rolled collision-suffix loop; that loop has since been replaced
 *     by the shared `uniqueToolName` helper, which owns (and has its own
 *     dedicated mutation-test backstop for) this logic now.
 *   - 102:52-102:62 ObjectLiteral, tagged `[Timeout]` rather than
 *     `[Survived]` — Stryker's own genuine-hang detection (the same
 *     "detected via timeout" pattern documented for transports.ts/
 *     mcp-server.ts's route-handler-body mutants), not a live gap.
 */
import { describe, test, expect } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { discoverMapTools, discoverToolsFromMcpServer } from "../../mcp/mcp-discovery.js";
import type { McpConnParams } from "../../mcp/mcp-upstream.js";

const PARAMS: McpConnParams = { name: "disc-test", url: "http://example.test/mcp", transport: "streamable-http" };

/** Monkey-patches a REAL transport's send() to delay only messages of one JSON-RPC method. */
function delayMethod(transport: Transport, delayedMethod: string, delayMs: number): Transport {
  const originalSend = transport.send.bind(transport);
  transport.send = async (message, options) => {
    const msg = message as { method?: string };
    if (msg.method === delayedMethod) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return originalSend(message, options);
  };
  return transport;
}

// ===========================================================================
// discoverMapTools — collision de-dup loop (L58-71).
// ===========================================================================

describe("discoverMapTools — multi-way name collisions", () => {
  // Integration-level check that discoverMapTools + uniqueToolName produce
  // the right suffixes end-to-end across more than one collision (the
  // existing sibling coverage in mcp-upstream.test.ts only exercises a
  // TWO-way collision, one retry). uniqueToolName's own mutants are covered
  // directly by tool-naming-mutation.test.ts.
  test("three tools that all normalize to the same name get _2 and _3 suffixes, in order", () => {
    const mapped = discoverMapTools([
      { name: "Get.Item", inputSchema: {} },
      { name: "get_item", inputSchema: {} },
      { name: "GET ITEM", inputSchema: {} },
    ]);
    expect(mapped.map((t) => t.name)).toEqual(["get_item", "get_item_2", "get_item_3"]);
    expect(mapped.map((t) => t.upstreamName)).toEqual(["Get.Item", "get_item", "GET ITEM"]);
  });
});

// ===========================================================================
// discoverMapTools — description fallback (L67-68).
// ===========================================================================

describe("discoverMapTools — description fallback", () => {
  // 68:7-68:55 LogicalOperator ("&&" -> "||"), 68:24-68:55
  // ConditionalExpression ("true"), 68:24-68:44 MethodExpression (the
  // ".trim()" call removed) [all Survived]. The existing sibling coverage
  // only tests a genuinely-empty description ("") and a real one — neither
  // distinguishes ".trim().length > 0" from a bare truthiness check, since
  // "" is already falsy without needing .trim() at all. A WHITESPACE-ONLY
  // description ("   ") is truthy as a raw string (so a "||" or
  // truthiness-only mutant would wrongly treat it as real content) but
  // trims down to empty (so the real code must still fall back).
  test("a whitespace-only description is treated as blank, not real content", () => {
    const mapped = discoverMapTools([{ name: "spacey", description: "   ", inputSchema: {} }]);
    expect(mapped[0]!.description).toBe('Tool "spacey" from upstream MCP server');
  });

  test("a description with real content surrounded by whitespace is kept, not discarded", () => {
    const mapped = discoverMapTools([{ name: "padded", description: "  real text  ", inputSchema: {} }]);
    // The ORIGINAL (untrimmed) description is used verbatim once the
    // .trim().length > 0 check passes — only the CHECK trims, not the
    // stored value.
    expect(mapped[0]!.description).toBe("  real text  ");
  });
});

// ===========================================================================
// discoverToolsFromMcpServer — Client self-identification (L31, L95).
// ===========================================================================

describe("discoverToolsFromMcpServer identifies itself with the real constants", () => {
  // 31:21-31:38 StringLiteral [Survived] (CLIENT_VERSION "1.0.0" -> "").
  test("the connected Server sees clientInfo {name: 'mcp-rest-bridge', version: '1.0.0'}", async () => {
    let capturedServer: Server | undefined;
    const factory = (_p: McpConnParams): Transport => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "disc-fake-upstream", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
      capturedServer = server;
      void server.connect(serverT);
      return clientT;
    };
    await discoverToolsFromMcpServer(PARAMS, { transportFactory: factory, timeoutMs: 2000 });
    expect(capturedServer!.getClientVersion()).toEqual({ name: "mcp-rest-bridge", version: "1.0.0" });
  });
});

// ===========================================================================
// discoverToolsFromMcpServer — timeout propagation (L92-93, L96, L102).
// ===========================================================================

describe("discoverToolsFromMcpServer timeoutMs option", () => {
  // 93:19-93:43 LogicalOperator ("??" -> "&&"), 96:41-96:52 ObjectLiteral
  // (connect's "{ timeout }" -> "{}"), 102:52-102:62 ObjectLiteral
  // (listTools's "{ timeout }" -> "{}") [all Survived]. A small custom
  // timeoutMs plus a delayed "initialize" response proves the connect-phase
  // timeout is honored; a delayed "tools/list" response (on an
  // ALREADY-connected client, via a longer initial delay budget) proves the
  // per-page timeout is honored too. Both share the SAME `timeout` local
  // variable (L93), so a single test exercising the connect phase already
  // kills 93 and 96 together; a second test isolates 102.
  test("a small custom timeoutMs is honored during connect, not silently replaced by the SDK's default", async () => {
    const factory = (_p: McpConnParams): Transport => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "disc-slow-upstream", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
      void server.connect(serverT);
      return delayMethod(clientT, "initialize", 500);
    };
    const started = Date.now();
    await expect(discoverToolsFromMcpServer(PARAMS, { transportFactory: factory, timeoutMs: 20 })).rejects.toThrow();
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeLessThan(500);
  });

  test("a small custom timeoutMs is honored on each tools/list page, not silently replaced by the SDK's default", async () => {
    const factory = (_p: McpConnParams): Transport => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "disc-slow-list-upstream", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
      void server.connect(serverT);
      // Only "tools/list" is delayed — "initialize" proceeds at normal
      // speed, so the connect phase succeeds and this test isolates the
      // listTools-specific timeout.
      return delayMethod(clientT, "tools/list", 500);
    };
    const started = Date.now();
    await expect(discoverToolsFromMcpServer(PARAMS, { transportFactory: factory, timeoutMs: 20 })).rejects.toThrow();
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeLessThan(500);
  });
});

// ===========================================================================
// discoverToolsFromMcpServer — pagination loop (L100-111).
// ===========================================================================

describe("discoverToolsFromMcpServer pagination", () => {
  // 111:14-111:20 ConditionalExpression [Survived] "false" — "} while
  // (cursor);" forced to never loop again, even when the server returned a
  // real nextCursor. The existing sibling coverage only exercises a
  // single-page response (no nextCursor at all), which can't distinguish
  // "stop because cursor is falsy" (real, correct) from "always stop after
  // one page regardless" (the mutant). A two-page fake upstream forces a
  // second listTools call to actually happen.
  test("a multi-page tools/list response is fully paginated, not truncated after the first page", async () => {
    const factory = (_p: McpConnParams): Transport => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "disc-paginated-upstream", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async (req) => {
        if (!req.params?.cursor) {
          return {
            tools: [{ name: "page-one-tool", inputSchema: { type: "object", properties: {} } }],
            nextCursor: "page-2",
          };
        }
        expect(req.params.cursor).toBe("page-2");
        return { tools: [{ name: "page-two-tool", inputSchema: { type: "object", properties: {} } }] };
      });
      void server.connect(serverT);
      return clientT;
    };
    const tools = await discoverToolsFromMcpServer(PARAMS, { transportFactory: factory, timeoutMs: 2000 });
    expect(tools.map((t) => t.upstreamName)).toEqual(["page-one-tool", "page-two-tool"]);
  });
});

/**
 * Stryker mutation-testing backstop for src/mcp/mcp-server.ts — CLUSTER S2
 * ONLY: the `Server` constructor's capabilities object, the `tools/list`
 * handler, and `tools/call`'s opening sequence up through the system-scope
 * authorization gate (name-resolution translation, the `search_tools`
 * meta-tool branch, and `resolveSystemRole`'s `!auth` rejection) — source
 * lines ~122-158 as of this writing. Other clusters of this same file
 * (client-scope confused-deputy + bundle membership/composite dispatch,
 * resources/prompts passthrough, notifyToolsChanged, header-dependent
 * endUserId/progress plumbing) are covered by sibling
 * `mcp-server-mutation-s*.test.ts` files written by other agents in this
 * series — this file adds exactly ONE new test file so those parallel
 * passes never conflict on the same path. `160:9-160:32` (the client-scope
 * `if (scope.kind === "client")` check) is explicitly S3's territory and is
 * deliberately not targeted here, even though one test below incidentally
 * passes through it on the way to an "Unknown tool" result.
 *
 * mcp-server.ts itself is NOT modified (file under test).
 *
 * TWO HARNESSES, matching this cluster's own split:
 *
 *   - LIGHTWEIGHT (InMemoryTransport, Client <-> Server directly, no HTTP)
 *     for every mutant that doesn't depend on a real caller header value
 *     reaching `extra.requestInfo.headers` — the server capabilities object,
 *     `tools/list`'s handler body, and the `search_tools` meta-tool branch's
 *     structural logic (`config.enableSearchTool && name === SEARCH_TOOL_NAME`)
 *     are all in this category: none of them read `callerToken` in a way
 *     whose *value* matters (the lightweight harness's `callerToken` is
 *     always `undefined`, which is exactly what's needed to reach
 *     `scopedToolList`'s "system, no token" path where relevant, and is
 *     simply irrelevant to the other branches tested here).
 *
 *   - A CUSTOM MINIMAL REAL-HTTP HARNESS (not the shared `setupTransports`)
 *     for the system-scope `!auth` rejection (154/155). This is NOT the same
 *     as reusing `setupTransports(app)` wholesale, and that distinction is
 *     load-bearing: `setupTransports` mounts `rootMcpAuth` as blanket
 *     Express middleware on the entire `/mcp` path (`app.use("/mcp",
 *     rootMcpAuth)`, see transports.ts), which runs `resolveSystemRole` on
 *     every single request — including a `tools/call` continuing an already-
 *     open session — via the *exact same* Bearer-extraction logic
 *     (`extractBearerToken` in middleware/auth.ts vs. this file's own
 *     `extractBearerFromHeader`; both do `header.startsWith("Bearer ")` /
 *     `.slice(7).trim()` against the same `req.headers.authorization`).
 *     Concretely: any request that would make `resolveSystemRole(callerToken)`
 *     return `null` *inside* the `CallToolRequestSchema` handler (154) would
 *     already have been rejected by `rootMcpAuth` — with a DIFFERENT message
 *     ("Missing Authorization header" / "This credential has no system role
 *     on /mcp", both distinct from this file's own "This credential has no
 *     system role") and a DIFFERENT HTTP status (401/403 from Express, never
 *     reaching the JSON-RPC layer at all — see transports-sharded.test.ts's
 *     existing "/mcp without a system-role credential is rejected outright"
 *     test, which asserts exactly that outer-layer behavior) — BEFORE the
 *     handler's own redundant check at 152-158 could ever run. So reusing
 *     `setupTransports` cannot exercise 154/155's exact code at all; it can
 *     only ever prove the outer gate works, which is already covered
 *     elsewhere. What CAN exercise it: a minimal harness that wires
 *     `createMcpServer({kind:"system"})` to a real
 *     `StreamableHTTPServerTransport` over real HTTP (so a real Authorization
 *     header still reaches `extra.requestInfo.headers`, satisfying this
 *     series' hard InMemoryTransport constraint) WITHOUT the production
 *     `rootMcpAuth` middleware in front of it — proving mcp-server.ts's OWN
 *     internal gate independently rejects an unauthenticated/mismatched
 *     caller, exactly as it must for defense-in-depth if the outer Express
 *     gate were ever missing, misconfigured, or (as tested here) simply not
 *     the thing under test.
 *
 * NOT USED: a `notifications/tools/list_changed` round-trip to prove
 * `listChanged: true` (125). Verified by reading the SDK before writing
 * anything: `Server.assertNotificationCapability` (see
 * node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js) only
 * checks `!this._capabilities.tools` (object PRESENCE), never the nested
 * `listChanged` boolean, so the notification sends under either value of the
 * literal this mutant targets. And on the receiving side,
 * `Client.setNotificationHandler` (the low-level API — see sibling
 * mcp-server-mutation-s5.test.ts's `notifyToolsChanged` tests, which use
 * exactly this API to receive the same notification) isn't capability-gated
 * either; only the SDK's separate, higher-level convenience `listChanged`
 * constructor option (which this codebase's own `Client` usages never pass)
 * consults `_serverCapabilities?.tools?.listChanged` before installing an
 * auto-refresh handler. A round-trip test would therefore pass identically
 * whether this literal were `true` or `false` — it would not have killed the
 * mutant it was nominally testing. Used instead: `Client.getServerCapabilities()`
 * (populated verbatim from the server's initialize response — see
 * client/index.js's `connect()`: `this._serverCapabilities = result.capabilities`),
 * the single most direct possible observation of this exact object literal.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import { randomUUID } from "crypto";
import type { AddressInfo } from "net";
import type { Server as HttpServer } from "http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpServer, type McpServerScope } from "../../mcp/mcp-server.js";
import { registry } from "../../mcp/registry.js";
import { config } from "../../config.js";
import { withConfig } from "../../__tests__/_utils/with-config.js";
import type { RestToolDefinition } from "../../mcp/types.js";

/** Task's own lightweight-harness idiom: a real JSON-RPC round trip, no HTTP, no real caller headers. */
async function connectClient(scope: McpServerScope): Promise<Client> {
  const server = createMcpServer(scope);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "s2-test-client", version: "1.0" }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "get-thing",
    method: "GET",
    endpoint: "/thing",
    description: "probe tool for cluster S2",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

async function reg(name: string, tools: RestToolDefinition[] = [makeTool()]): Promise<void> {
  await registry.register(name, tools, "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

// ===========================================================================
// Server capabilities — 125:45-125:49 BooleanLiteral ("listChanged: true" ->
// "listChanged: false"). See file header for why this is asserted directly
// off the negotiated capabilities rather than via a notification round trip.
// ===========================================================================

describe("server capabilities", () => {
  test("the negotiated server capabilities advertise tools.listChanged: true", async () => {
    // Capabilities are a fixed literal in the Server constructor, independent
    // of `scope` — "system" is used purely because it needs no registry setup.
    const client = await connectClient({ kind: "system" });
    try {
      expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: true });
    } finally {
      await client.close();
    }
  });

  // 124:13-124:30 StringLiteral [Survived] ("mcp-rest-bridge" -> ""). The
  // Server's own self-identification (its `serverInfo` in the initialize
  // handshake) — mirrors mcp-upstream-mutation.test.ts's use of the SDK's
  // getClientVersion() on the OTHER side of a connection, here using the
  // Client-side getServerVersion() to observe what THIS repo's own Server
  // reports about itself.
  test("the Server reports its own name as 'mcp-rest-bridge' during the handshake", async () => {
    const client = await connectClient({ kind: "system" });
    try {
      expect(client.getServerVersion()?.name).toBe("mcp-rest-bridge");
    } finally {
      await client.close();
    }
  });
});

// ===========================================================================
// tools/list handler + tools/call's search_tools branch (client scope,
// lightweight harness). Registry setup mirrors transports-sharded.test.ts /
// tool-search.test.ts's reg() idiom.
// ===========================================================================

describe("tools/list + tools/call's search_tools meta-tool branch", () => {
  const CLIENT = "mcp-server-s2-client";

  beforeEach(async () => {
    await reg(CLIENT);
  });

  afterEach(async () => {
    await registry.unregister(CLIENT);
  });

  // 128:79-135:4 BlockStatement [Timeout] (the whole ListTools handler body
  // emptied) — no dedicated test required per the task's own instructions
  // ("killed as a side effect of any real tools/list call in this cluster or
  // elsewhere"). This IS that real round trip, kept in this cluster's own
  // file rather than relying entirely on another cluster's file to supply it.
  test("tools/list advertises the client's own tool plus the search_tools meta-tool", async () => {
    const client = await connectClient({ kind: "client", name: CLIENT });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([`${CLIENT}__get-thing`, "search_tools"].sort());
    } finally {
      await client.close();
    }
  });

  // 148:8-150:5-ish ConditionalExpression ("config.enableSearchTool && name
  // === SEARCH_TOOL_NAME" forced true/false) — the "true" (real) direction.
  // Proven WITHOUT a live backend: runSearchTool is fully synchronous and
  // never calls proxyToolCall, so a well-formed {query,count,matches} JSON
  // envelope here — despite this client's base_url ("http://example.com")
  // never actually being dialed anywhere in this test — is itself proof the
  // meta-tool branch was taken directly, not a proxied dispatch attempt.
  test("calling the literal name 'search_tools' is handled directly, ranking only the caller's own scoped tools", async () => {
    const client = await connectClient({ kind: "client", name: CLIENT });
    try {
      const result = await client.callTool({ name: "search_tools", arguments: { query: "thing" } });
      expect(result.isError).toBeUndefined();
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      const parsed = JSON.parse(text) as { query: string; count: number; matches: { name: string }[] };
      expect(parsed.query).toBe("thing");
      expect(parsed.matches.map((m) => m.name)).toContain(`${CLIENT}__get-thing`);
    } finally {
      await client.close();
    }
  });

  // EqualityOperator on `name === SEARCH_TOOL_NAME` (=== -> !==). A garbage
  // tool name is never literally "search_tools", so under the real code the
  // whole `&&` is false and control falls through to ordinary resolution:
  // the (S3-owned) client-scope membership check fails and returns "Unknown
  // tool: ..." WITHOUT ever reaching proxyToolCall — so, same as above, this
  // needs no live backend. Under the !== mutant the condition would instead
  // be forced TRUE for this exact non-matching name, wrongly routing it into
  // runSearchTool's ranking logic (a materially different response shape)
  // instead of the real "Unknown tool" rejection.
  test("a garbage/unknown tool name (never literally 'search_tools') is not captured by the meta-tool's equality check", async () => {
    const client = await connectClient({ kind: "client", name: CLIENT });
    try {
      const badName = `${CLIENT}__does-not-exist`;
      const result = await client.callTool({ name: badName, arguments: {} });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toBe(`Unknown tool: ${badName}`);
    } finally {
      await client.close();
    }
  });

  // The `config.enableSearchTool &&` conjunct's own boolean, evaluated at the
  // tools/call site (148) — distinct from the identically-named conjunct at
  // the tools/list site (133), which tool-search.test.ts's "disabling the
  // flag removes it from tools/list" test already covers. With the flag off,
  // the literal name "search_tools" is no longer special-cased at all: no
  // client is ever registered under that literal name, so it falls through
  // to the exact same "Unknown tool" failure the garbage-name case above
  // hits — never reaching runSearchTool.
  test("with config.enableSearchTool disabled, the literal name 'search_tools' is ordinary (failing) resolution, not the meta-tool", async () => {
    await withConfig({ enableSearchTool: false }, async () => {
      const client = await connectClient({ kind: "client", name: CLIENT });
      try {
        const result = await client.callTool({ name: "search_tools", arguments: { query: "thing" } });
        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
        expect(text).toBe("Unknown tool: search_tools");
      } finally {
        await client.close();
      }
    });
  });
});

// ===========================================================================
// tools/call — system-scope authorization gate, no credential reaching
// resolveSystemRole (154/155). Real-HTTP-only (needs a real Authorization
// header value reaching extra.requestInfo.headers) via the custom minimal
// harness described in the file header — deliberately NOT setupTransports,
// which cannot reach this exact code (see header for the full reachability
// argument).
//
// 154:11-154:16 ConditionalExpression [Survived] ("if (!auth)" forced to
// "false") and 154:18-156:8 BlockStatement [Survived] (that block emptied):
// both killed by simply reaching this branch at all and observing a non-
// error/non-empty response would mean neither mutant.
//
// 155:16-155:106 ObjectLiteral / 155:27-155:31 BooleanLiteral /
// 155:42-155:104 ArrayDeclaration / 155:51-155:57 StringLiteral /
// 155:65-155:101 StringLiteral [all Survived]: the exact error object's
// every field asserted via one full toEqual (isError literally true, content
// an array of exactly one entry, that entry's type exactly "text", its text
// exactly "This credential has no system role") — not partial/toContain
// assertions, so any one of these sub-mutants independently fails the
// assertion.
// ===========================================================================

describe("tools/call — system-scope authorization gate (no credential reaching resolveSystemRole)", () => {
  let baseUrl = "";
  let activeServer: HttpServer | null = null;
  const transports = new Map<string, StreamableHTTPServerTransport>();

  async function startApp(): Promise<void> {
    const app = express();
    app.use(express.json({ limit: "64kb", strict: true }));

    // Deliberately NO rootMcpAuth/mcpAuth/originValidator here — see file
    // header. This exercises mcp-server.ts's OWN system-scope gate in
    // isolation from the (separately-tested, separately-worded) production
    // Express-level gate.
    app.post("/mcp", async (req, res) => {
      const sid = req.headers["mcp-session-id"];
      const sessionId = typeof sid === "string" ? sid : undefined;
      const existing = sessionId ? transports.get(sessionId) : undefined;
      if (existing) {
        await existing.handleRequest(req, res, req.body);
        return;
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const server: Server = createMcpServer({ kind: "system" });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      if (transport.sessionId) transports.set(transport.sessionId, transport);
    });

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
    return new Promise((resolve) => {
      transports.clear();
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

  function parseSseJson(text: string): { result?: unknown; error?: unknown; id?: unknown } {
    const match = text.match(/data: (.+)/);
    if (!match) throw new Error(`Could not parse SSE body: ${text}`);
    return JSON.parse(match[1]) as { result?: unknown; error?: unknown; id?: unknown };
  }

  /** Mirrors transports-sharded.test.ts's initSession() idiom, against this file's own minimal (rootMcpAuth-free) app. */
  async function initSession(extraHeaders: Record<string, string> = {}): Promise<string | null> {
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...extraHeaders },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "s2-test", version: "1.0" } },
      }),
    });
    const sessionId = initRes.headers.get("mcp-session-id");
    if (initRes.status !== 200 || !sessionId) return null;

    await fetch(`${baseUrl}/mcp`, {
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

  async function toolsCall(
    sessionId: string,
    toolName: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body?: { isError?: boolean; content?: { type: string; text: string }[] } }> {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
        ...extraHeaders,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 2, params: { name: toolName, arguments: {} } }),
    });
    if (res.status !== 200) return { status: res.status };
    const parsed = parseSseJson(await res.text());
    return {
      status: res.status,
      body: parsed.result as { isError?: boolean; content?: { type: string; text: string }[] },
    };
  }

  async function toolsList(
    sessionId: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body?: { tools: { name: string }[] } }> {
    const res = await fetch(`${baseUrl}/mcp`, {
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

  afterEach(async () => {
    await stopApp();
  });

  test("tools/call with no Authorization header at all returns the exact 'no system role' error object", async () => {
    await startApp();
    const sessionId = await initSession();
    expect(sessionId).not.toBeNull();

    const result = await toolsCall(sessionId!, "sys_list_clients");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      isError: true,
      content: [{ type: "text", text: "This credential has no system role" }],
    });
  });

  // Security property: auth is resolved BEFORE `name` is even looked at, so a
  // caller with no system role gets the byte-identical error whether they
  // named a real sys_* tool or complete garbage — closing off an enumeration
  // oracle that would otherwise let an unauthenticated/under-privileged
  // caller learn which sys_* tool names exist by comparing error messages.
  // See the code comment at the `scope.kind === "system"` gate for the full
  // reasoning (this was previously an unimplemented aspiration documented on
  // a since-removed `isSystemTool` helper's stale JSDoc).
  test("tools/call for a NONEXISTENT tool name with no Authorization header returns the identical 'no system role' error, not an 'unknown tool' error", async () => {
    await startApp();
    const sessionId = await initSession();
    expect(sessionId).not.toBeNull();

    const result = await toolsCall(sessionId!, "sys_this_tool_does_not_exist");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      isError: true,
      content: [{ type: "text", text: "This credential has no system role" }],
    });
  });

  // 90:46-90:48 ArrayDeclaration [Survived] ("[]" -> "[\"Stryker was here\"]")
  // on scopedToolList's system-scope branch: "return auth ?
  // listSystemTools(auth.role) : [];". A no-credential tools/list for the
  // system scope must return a genuinely EMPTY tools array, not a poisoned
  // placeholder entry. This mutant is only reachable bypassing rootMcpAuth
  // (same reasoning as this whole describe block's file-header note) —
  // rootMcpAuth would otherwise reject the request before ever reaching
  // mcp-server.ts's own (redundant) scopedToolList call.
  test("tools/list with no Authorization header at all returns a genuinely empty tools array", async () => {
    await startApp();
    const sessionId = await initSession();
    expect(sessionId).not.toBeNull();

    const result = await toolsList(sessionId!);
    expect(result.status).toBe(200);
    expect(result.body?.tools).toEqual([]);
  });

  test("tools/call with a present but non-matching Bearer token returns the identical exact error object", async () => {
    await withConfig({ adminApiKeys: ["s2-real-admin-key"] }, async () => {
      await startApp();
      const sessionId = await initSession();
      expect(sessionId).not.toBeNull();

      const result = await toolsCall(sessionId!, "sys_list_clients", { Authorization: "Bearer s2-totally-wrong-key" });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        isError: true,
        content: [{ type: "text", text: "This credential has no system role" }],
      });
      // Sanity check that the token really was wrong, not e.g. a typo that
      // happens to match config.authDisabled's env-bearer bypass: the exact
      // same session/token combo must ALSO be what a legitimately-configured
      // admin key would NOT match — config.adminApiKeys only contains the
      // real key, never the wrong one.
      expect(config.adminApiKeys).toEqual(["s2-real-admin-key"]);
    });
  });

  // 48:56-48:65 StringLiteral [Survived] ("Bearer " -> "") on
  // extractBearerFromHeader's "!header.startsWith(\"Bearer \")" guard. Every
  // string startsWith(""), so the guard's second disjunct becomes
  // permanently false under this mutant — ANY string-typed Authorization
  // header value, regardless of prefix, falls through to `.slice(7).trim()`
  // instead of being rejected. Proven with a header that does NOT start
  // with "Bearer " but is crafted so that slicing off its first 7
  // characters anyway happens to land exactly on the real configured admin
  // key — the mutant would wrongly extract and accept it; the real code
  // must reject the header outright (wrong prefix) before ever reaching
  // the slice.
  test("a non-'Bearer '-prefixed Authorization header is rejected outright, even when slicing off 7 chars would accidentally yield the real admin key", async () => {
    await withConfig({ adminApiKeys: ["realkey123"] }, async () => {
      await startApp();
      const sessionId = await initSession();
      expect(sessionId).not.toBeNull();

      // "XXXXXXXrealkey123".slice(7) === "realkey123" — the exact real key —
      // but this header does not start with "Bearer ", so real code must
      // never reach the slice at all.
      const result = await toolsCall(sessionId!, "sys_list_clients", { Authorization: "XXXXXXXrealkey123" });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        isError: true,
        content: [{ type: "text", text: "This credential has no system role" }],
      });
    });
  });

  // 49:10-49:32 MethodExpression [Survived] "header.slice(7)" (real:
  // "header.slice(7).trim()") — a DIFFERENT mutant than the one the
  // "Bearer <token>" tests already kill (that one removes .slice(7) itself,
  // collapsing to "header.trim()"; this one removes the trailing .trim()
  // call instead). "Bearer <exact-key>" with no extra whitespace can't
  // distinguish the two: slice(7) alone already yields the exact key, so
  // .trim() is a no-op either way. A TRAILING space on the whole header
  // value doesn't work either — verified empirically that Node's own HTTP
  // parser strips leading/trailing OWS (optional whitespace) from a header
  // VALUE before Express ever sees it, so "Bearer realkey456 " arrives as
  // "Bearer realkey456" regardless of what mcp-server.ts does. What DOES
  // survive (also verified empirically): whitespace INTERNAL to the value,
  // e.g. a doubled space right after "Bearer" — Node only trims the outer
  // edges, not arbitrary internal runs. "Bearer  realkey456" (two spaces)
  // arrives intact; slice(7) consumes only ONE of the two spaces (exactly
  // 7 chars: "Bearer "), leaving a stray LEADING space on the extracted
  // token that only .trim() removes.
  test("a stray space left over after slicing off the 'Bearer ' prefix is trimmed before comparison", async () => {
    await withConfig({ adminApiKeys: ["realkey456"] }, async () => {
      await startApp();
      const sessionId = await initSession();
      expect(sessionId).not.toBeNull();

      // "Bearer  realkey456".slice(7) === " realkey456" (one leading space
      // still attached, since slice(7) only consumes ONE of the two spaces)
      // — real code's .trim() strips it down to exactly "realkey456",
      // matching config.adminApiKeys. Without .trim(), " realkey456" never
      // safeCompare-equals the real key.
      const result = await toolsCall(sessionId!, "sys_list_clients", { Authorization: "Bearer  realkey456" });
      expect(result.status).toBe(200);
      const body = result.body as { isError?: boolean };
      expect(body.isError).toBeUndefined();
    });
  });
});

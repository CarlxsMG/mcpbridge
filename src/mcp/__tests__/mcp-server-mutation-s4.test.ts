/**
 * Stryker mutation-testing backstop for src/mcp/mcp-server.ts — CLUSTER S4:
 * tools/call's endUserId extraction, progress/cancellation bridging, and the
 * final proxyToolCall dispatch call (current source lines ~195-219):
 *
 *   const endUserId = extractEndUserId(extraHeaders(extra)?.["x-end-user-id"]);
 *   const progressToken = extra._meta?.progressToken;
 *   const onProgress =
 *     progressToken !== undefined
 *       ? (progress, total, message) => {
 *           void extra.sendNotification({
 *             method: "notifications/progress",
 *             params: { progressToken, progress, total, message },
 *           });
 *         }
 *       : undefined;
 *   return proxyToolCall(name, args ?? {}, callerToken, {
 *     signal: extra.signal,
 *     onProgress,
 *     endUserId,
 *     sessionId: extra.sessionId,
 *   });
 *
 * TWO harnesses, per the task's own split:
 *
 *  - HARNESS A (most of this file) — lightweight, no real HTTP: our own
 *    mcp-server.ts Server (scope "client") is connected directly to a real
 *    SDK Client over InMemoryTransport, and — for the tests that need a
 *    genuine downstream MCP dispatch (progress/cancellation/args) — the
 *    registered client is `kind: "mcp"` with McpUpstreamPool's own outbound
 *    connection *also* redirected to a second, independent InMemoryTransport
 *    pair via `mcpUpstream.__setTransportFactoryForTesting`, exactly the
 *    double-hop technique mcp-progress.test.ts already uses one layer lower
 *    (at McpUpstreamPool.call directly). None of this cluster's targets read
 *    `extra.requestInfo.headers`, so InMemoryTransport's header gap (see task
 *    description) never applies here — _meta/progressToken and the request
 *    body's `arguments` both flow through InMemoryTransport untouched (see
 *    node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js
 *    `_onrequest`'s `fullExtra` construction: `_meta: request.params?._meta`
 *    and `sessionId: capturedTransport?.sessionId` — both come from the
 *    JSON-RPC message/transport itself, never from `requestInfo`).
 *
 *  - HARNESS B (last describe block) — real HTTP via setupTransports(app),
 *    copying transports-sharded.test.ts's reg()/initSession() idioms, used
 *    only for the one target that needs an actually-live MCP transport
 *    session id (`extra.sessionId` is `capturedTransport?.sessionId`, and
 *    only a real Streamable-HTTP session actually populates a transport's
 *    `sessionId` — see transports.ts's `transport.sessionId` sequencing) and
 *    a real X-End-User-Id header.
 *
 * Targets covered here (line:col current-file, mutator, replacement):
 *   - 202:27-202:53 OptionalChaining ("extra._meta.progressToken" real:
 *     "extra._meta?.progressToken") — a call with NO _meta field whatsoever.
 *   - 204:7-204:34 ConditionalExpression (both true/false) + EqualityOperator
 *     ("!==" -> "===") on "progressToken !== undefined ? ... : undefined" —
 *     both directions (WITH and WITHOUT a progressToken).
 *   - 205:*-210:* BlockStatement (onProgress's body emptied), 206:*-209:*
 *     ObjectLiteral (the sendNotification call's argument emptied), 208:*
 *     ObjectLiteral (the notification's `params` object emptied) — the exact
 *     progress-notification shape, asserted via a real double-hop dispatch.
 *   - 213 LogicalOperator ("args ?? {}" -> "args && {}") — real caller
 *     arguments must reach the upstream unchanged, not be wiped to {}.
 *   - 213-218 ObjectLiteral (the whole ToolCallOpts object emptied to {}) —
 *     no single dedicated test; killed redundantly by the onProgress test
 *     (needs the `onProgress` key), the cancellation test (needs `signal`),
 *     and the sessionId test in Harness B (needs `sessionId`) — see the note
 *     right before that describe block for why a 4th, endUserId-keyed test
 *     is intentionally left as a lighter smoke check.
 *   - A caller-initiated `extra.signal` abort, proven to reach all the way to
 *     the downstream MCP upstream's OWN request-scoped `extra.signal`.
 *   - `extra.sessionId` reaching proxyToolCall's `sessionId` ToolCallOpts key
 *     (observed via the OTLP `mcp.session_id` span attribute, the same
 *     signal src/observability/__tests__/tracing.test.ts already uses to
 *     test proxyToolCall's OWN handling of that opt — here we're proving
 *     mcp-server.ts's own extraction+threading of `extra.sessionId` into
 *     that opt, one layer up, through a REAL MCP transport session id).
 *
 * No genuine equivalent mutants identified in this cluster; every mutant
 * enumerated in the task description is killed by a test below.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server as HttpServer } from "http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ProgressNotificationSchema,
  type Progress,
} from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, type McpServerScope } from "../../mcp/mcp-server.js";
import { registry } from "../../mcp/registry.js";
import { mcpUpstream, buildTransport, type McpConnParams } from "../../mcp/mcp-upstream.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { __resetDbForTesting } from "../../db/connection.js";
import type { DiscoveredMcpTool } from "../../mcp/mcp-discovery.js";
import { flush, _internalsForTesting } from "../../observability/tracing.js";
import { withConfig } from "../../__tests__/_utils/with-config.js";
import type { RestToolDefinition } from "../../mcp/types.js";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const CLIENT = "s4-mcp-client";

const TOOLS: DiscoveredMcpTool[] = [
  {
    name: "echo-args",
    upstreamName: "echo-args",
    description: "echoes its received arguments back as JSON text",
    inputSchema: { type: "object", properties: { foo: { type: "string" } } },
  },
  {
    name: "with-progress",
    upstreamName: "with-progress",
    description: "reports two progress notifications when asked",
    inputSchema: { type: "object" },
  },
  {
    name: "hangs",
    upstreamName: "hangs",
    description: "never resolves unless its own extra.signal aborts",
    inputSchema: { type: "object" },
  },
];

type FactoryState = { upstreamSawAbort: boolean; lastMetaProgressToken: string | number | undefined | "not-called" };

/**
 * A fake MCP upstream (mirrors mcp-progress.test.ts / mcp-upstream-mutation.test.ts's
 * pattern), wired in as McpUpstreamPool's OWN transport factory so the
 * "kind: mcp" dispatch path in dispatchMcpToolCall runs for real, without any
 * real network. `state.upstreamSawAbort` is how the cancellation test proves
 * `extra.signal` really propagated all the way down (not just that our own
 * client's local promise rejected, which happens regardless — see that
 * test's comment).
 */
function makeFactory(): { factory: (p: McpConnParams) => Transport; state: FactoryState } {
  const state: FactoryState = { upstreamSawAbort: false, lastMetaProgressToken: "not-called" };
  const factory = (_p: McpConnParams): Transport => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "s4-fake-upstream", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: "echo-args", description: "echo", inputSchema: { type: "object" } },
        { name: "with-progress", description: "progress", inputSchema: { type: "object" } },
        { name: "hangs", description: "hangs", inputSchema: { type: "object" } },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<ToolResult> => {
      if (req.params.name === "echo-args") {
        state.lastMetaProgressToken = req.params._meta?.progressToken;
        return { content: [{ type: "text", text: JSON.stringify(req.params.arguments ?? null) }] };
      }
      if (req.params.name === "with-progress") {
        const token = req.params._meta?.progressToken;
        if (token !== undefined) {
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken: token, progress: 1, total: 3 },
          });
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken: token, progress: 2, total: 3 },
          });
        }
        return { content: [{ type: "text", text: "done" }] };
      }
      if (req.params.name === "hangs") {
        return new Promise<ToolResult>((resolve) => {
          extra.signal.addEventListener("abort", () => {
            state.upstreamSawAbort = true;
            resolve({ isError: true, content: [{ type: "text", text: "upstream saw abort" }] });
          });
        });
      }
      return { content: [{ type: "text", text: "unknown tool" }], isError: true };
    });
    void server.connect(serverT);
    return clientT;
  };
  return { factory, state };
}

async function connectClient(scope: McpServerScope = { kind: "client", name: CLIENT }): Promise<Client> {
  const server = createMcpServer(scope);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "s4-test-client", version: "1.0" }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("mcp-server.ts CallToolRequestSchema — cluster S4 (Harness A: double-hop InMemoryTransport)", () => {
  beforeEach(async () => {
    __resetDbForTesting();
    removeCircuitBreaker(CLIENT);
    await registry.registerMcp(CLIENT, TOOLS, "http://s4.test/mcp", "streamable-http", "127.0.0.1", "127.0.0.1");
  });

  afterEach(async () => {
    await registry.unregister(CLIENT);
    await mcpUpstream.disconnect(CLIENT);
    removeCircuitBreaker(CLIENT);
    mcpUpstream.__setTransportFactoryForTesting(buildTransport);
  });

  // 202:27-202:53 OptionalChaining ("extra._meta.progressToken" real:
  // "extra._meta?.progressToken"). A request with NO "arguments" and no
  // onprogress option carries NO "_meta" key in its params at all (confirmed
  // by reading the SDK's Client.request(): `_meta` is only ever added when
  // `options?.onprogress` is truthy — see
  // node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js
  // around "if (options?.onprogress) { ... jsonrpcRequest.params = {...} }"),
  // so on the server side `extra._meta` itself (not just `.progressToken`) is
  // `undefined`. Under the mutant, `extra._meta.progressToken` throws
  // synchronously inside the handler; the SDK catches that and turns it into
  // a JSON-RPC error response, which surfaces here as callTool() REJECTING.
  test("202: a call with no _meta field whatsoever does not throw (resolves cleanly)", async () => {
    const { factory } = makeFactory();
    mcpUpstream.__setTransportFactoryForTesting(factory);
    const client = await connectClient();
    const r = (await client.callTool({ name: `${CLIENT}__echo-args` })) as ToolResult;
    expect(r.isError).toBeFalsy();
    // mcp-server.ts's own "args ?? {}" (line 213) already normalizes the
    // missing "arguments" field to {} before this ever reaches the fake
    // upstream — so the echoed text is "{}", not "null". The point of this
    // assertion is just "resolved successfully with SOME real echoed args
    // object", not the exact fallback value; the real content of this test
    // is that callTool() didn't reject (see comment above).
    expect(r.content[0]!.text).toBe(JSON.stringify({}));
  });

  // 213:32-213:42 LogicalOperator ("args ?? {}" -> "args && {}"). For a
  // truthy `args` object, `??` returns `args` itself while `&&` returns the
  // RIGHT operand — a brand-new, always-EMPTY `{}` — discarding every real
  // argument the caller sent. `proxyToolCall`'s own `args: ... = {}` default
  // parameter only ever normalizes an `undefined` args (JS default
  // parameters trigger on `undefined`, verified empirically: `((a={}) =>
  // a)(undefined)` and `((a={}) => a)({})` both yield `{}`), so that
  // direction of this mutant is inert — but a real, non-empty `arguments`
  // object is NOT `undefined`, so the "wipe to {}" direction is fully
  // observable: the fake upstream echoes back exactly what
  // `req.params.arguments` it received.
  test("213 LogicalOperator: real caller-supplied arguments reach the upstream unchanged, not wiped to {}", async () => {
    const { factory } = makeFactory();
    mcpUpstream.__setTransportFactoryForTesting(factory);
    const client = await connectClient();
    const r = (await client.callTool({
      name: `${CLIENT}__echo-args`,
      arguments: { foo: "bar-value" },
    })) as ToolResult;
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).toBe(JSON.stringify({ foo: "bar-value" }));
  });

  describe("204/205/206/208 — progressToken-gated onProgress wiring and exact notification shape", () => {
    // 204 (both ConditionalExpression true/false AND EqualityOperator
    // "!==" -> "==="), 205 BlockStatement, 206/208 ObjectLiteral. WITH a
    // progressToken: onProgress must be a REAL function that is actually
    // invoked by the downstream MCP-to-MCP progress bridge, forwarding the
    // real progress/total values with the SAME progressToken our own client
    // sent. The SDK's own `_onprogress` (see protocol.js) only ever
    // delivers a notification to OUR registered `onprogress` handler when
    // its `progressToken` matches the exact message id our request used —
    // so a non-empty `received` array is only possible if mcp-server.ts's
    // onProgress closure correctly re-embeds that same token (208) inside a
    // well-formed `{method, params}` notification (206) with a non-empty
    // body (205).
    test("WITH a progressToken: the client receives the real progress values, correctly token-matched", async () => {
      const { factory } = makeFactory();
      mcpUpstream.__setTransportFactoryForTesting(factory);
      const client = await connectClient();
      const received: Progress[] = [];
      const r = (await client.callTool({ name: `${CLIENT}__with-progress`, arguments: {} }, undefined, {
        onprogress: (p) => received.push(p),
      })) as ToolResult;
      expect(r.isError).toBeFalsy();
      expect(received.map((p) => p.progress)).toEqual([1, 2]);
      expect(received.every((p) => p.total === 3)).toBe(true);
    });

    // The other direction: WITHOUT a progressToken, onProgress must stay
    // `undefined` (never wired at all — not a no-op that still fires). We
    // bypass the SDK's own token-matching dispatch (which would silently
    // drop a mismatched/absent-token notification via `_onerror`, masking a
    // "sent but with the wrong token" mutant behavior) by installing a raw
    // ProgressNotificationSchema handler that observes ANY inbound progress
    // notification at all, regardless of its token.
    test("WITHOUT a progressToken: no progress notification is EVER sent", async () => {
      const { factory } = makeFactory();
      mcpUpstream.__setTransportFactoryForTesting(factory);
      const client = await connectClient();
      const received: unknown[] = [];
      client.setNotificationHandler(ProgressNotificationSchema, (n) => {
        received.push(n);
      });
      const r = (await client.callTool({ name: `${CLIENT}__with-progress`, arguments: {} })) as ToolResult;
      expect(r.isError).toBeFalsy();
      // Give any (wrongly sent, under the mutant) notification a moment to
      // land — everything here is in-memory/microtask-scheduled, no real
      // network latency.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(received).toEqual([]);
    });

    // 204:7-204:34 ConditionalExpression [Survived] "true" — the direction
    // the two tests above do NOT actually distinguish. Traced through 3
    // layers: forcing onProgress to always be a real function (even when our
    // OWN caller's progressToken is undefined) makes proxy.ts's own
    // "opts?.onProgress ? (p) => ... : undefined" (src/proxy/proxy.ts L1313)
    // forward a REAL onprogress callback to McpUpstreamPool.call(), which
    // forwards it to the SDK's Client.callTool(). The SDK (see
    // node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js)
    // auto-generates a FRESH progressToken and attaches it to the OUTBOUND
    // request's _meta whenever `options?.onprogress` is truthy — regardless
    // of what our own original progressToken was. This means the "WITHOUT a
    // progressToken: no progress notification is EVER sent" test above does
    // NOT reliably distinguish this mutant: under the mutant, the fake
    // upstream's "with-progress" tool WOULD receive a real (SDK-generated)
    // token and WOULD attempt to send notifications back — but those
    // notifications carry mcp-server.ts's OWN outer-closure `progressToken`
    // (still `undefined`, captured by reference from OUR original,
    // token-less call), producing a `{progressToken: undefined, ...}`
    // params object at the `extra.sendNotification` call site — which fails
    // to round-trip to the client either way (dropped by schema validation
    // on the send or receive side, indistinguishably from "never sent at
    // all"). So the notification-arrival test above passes under BOTH real
    // code and the mutant, for two DIFFERENT reasons — not evidence the
    // mutant is dead.
    //
    // The reliable signal is one layer earlier: whether the UPSTREAM-BOUND
    // request itself carries an auto-generated progressToken in its own
    // `_meta`, independent of what happens to any notification afterward.
    // The fake upstream's "echo-args" handler (see makeFactory above)
    // records exactly this for every call.
    test("204 (reliable signal): a call with no progressToken never causes an onprogress option to reach the SDK's outbound request at all", async () => {
      const { factory, state } = makeFactory();
      mcpUpstream.__setTransportFactoryForTesting(factory);
      const client = await connectClient();
      const r = (await client.callTool({ name: `${CLIENT}__echo-args`, arguments: {} })) as ToolResult;
      expect(r.isError).toBeFalsy();
      // Real code: onProgress stays undefined -> proxy.ts forwards
      // `onprogress: undefined` -> the SDK never auto-generates a token ->
      // the fake upstream's own request never carries one either.
      expect(state.lastMetaProgressToken).toBeUndefined();
    });
  });

  // Cancellation: proves `extra.signal` really reaches proxyToolCall's
  // ToolCallOpts (part of the 213-218 ObjectLiteral target). Merely
  // asserting that OUR OWN client's callTool() promise rejects promptly is
  // NOT sufficient by itself — the SDK rejects that promise LOCALLY the
  // moment our own AbortSignal fires, regardless of whether the signal ever
  // reaches the server at all (see protocol.js's `request()`:
  // `options?.signal?.addEventListener('abort', () => cancel(...))` runs
  // client-side, unconditionally). So instead we prove the signal reached
  // the SERVER (and beyond, all the way to the downstream MCP upstream's
  // OWN request-scoped `extra.signal`) via `state.upstreamSawAbort`: our
  // client's abort -> SDK sends notifications/cancelled to our mcp-server ->
  // aborts ITS extra.signal -> (if wired) proxyToolCall's opts.signal ->
  // dispatchMcpToolCall -> pool.call's own downstream client.callTool(...,
  // {signal}) -> SDK sends notifications/cancelled to the FAKE UPSTREAM ->
  // aborts THAT extra.signal -> our "hangs" handler's abort listener sets
  // the flag. Under the 213-218 "options object emptied to {}" mutant,
  // `signal` is never threaded through, so the fake upstream's "hangs"
  // handler never sees an abort and the flag stays false.
  test("cancellation: a client-side abort propagates extra.signal all the way to the downstream MCP upstream", async () => {
    const { factory, state } = makeFactory();
    mcpUpstream.__setTransportFactoryForTesting(factory);
    const client = await connectClient();
    const controller = new AbortController();
    const callPromise = client.callTool({ name: `${CLIENT}__hangs`, arguments: {} }, undefined, {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await expect(callPromise).rejects.toBeTruthy();
    // The downstream propagation (our-server -> pool -> fake-upstream) is a
    // few extra async hops beyond the client's own local rejection; give it
    // a generous margin — still trivially fast since nothing here waits on
    // a real timer or network round trip.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(state.upstreamSawAbort).toBe(true);
  });
});

/**
 * HARNESS B — real HTTP via setupTransports(app), copying
 * transports-sharded.test.ts's reg()/initSession() idioms verbatim (that
 * file's own HARD-RULE-protected — this is a fresh copy, not an import).
 *
 * Only one target strictly NEEDS this harness: `extra.sessionId` is
 * `capturedTransport?.sessionId` (see protocol.js's `_onrequest`), and only
 * a real, live Streamable-HTTP session actually has a non-undefined
 * `transport.sessionId` (assigned by the SDK once `initialize` completes —
 * see transports.ts's `if (transport.sessionId) { streamableSessions.set(...) }`).
 * InMemoryTransport never sets `.sessionId` at all, so Harness A's
 * `extra.sessionId` would always be `undefined` there regardless of which
 * way this mutant goes — genuinely unreachable through Harness A, matching
 * the task's note about `requestInfo`/headers but for a different transport
 * field.
 *
 * endUserId (line 195, `extractEndUserId(extraHeaders(extra)?.["x-end-user-id"])`)
 * has the same real-header constraint as callerToken (see the task
 * description's note on cluster S1's extractEndUserId coverage). This
 * harness gives it one honest, lightweight smoke test — a real
 * X-End-User-Id header must not crash the dispatch path — but deliberately
 * does NOT attempt to prove deeper per-end-user rate-limit behavior:
 * resolveEndUserId's consumer/quota-gated path (src/proxy/proxy.ts) needs a
 * managed API key + consumer + explicit per-end-user rate-limit opt-in to
 * even engage, which is orthogonal setup this cluster's own line range
 * (195-219) doesn't otherwise need — left to whichever cluster owns
 * extractEndUserId's unit-level coverage.
 */
describe("mcp-server.ts CallToolRequestSchema — cluster S4 (Harness B: real HTTP, real transport session)", () => {
  let baseUrl = "";
  let activeServer: HttpServer | null = null;
  let cleanupFn: (() => void) | null = null;
  const originalFetch = globalThis.fetch;

  async function startApp(): Promise<void> {
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
    await registry.register(name, tools, "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
  }

  function parseSseJson(text: string): { result?: unknown; error?: unknown; id?: unknown } {
    const match = text.match(/data: (.+)/);
    if (!match) throw new Error(`Could not parse SSE body: ${text}`);
    return JSON.parse(match[1]);
  }

  async function initSession(path: string): Promise<string | null> {
    const initRes = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "s4-http-test", version: "1.0" },
        },
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
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    return sessionId;
  }

  async function toolsCall(
    path: string,
    sessionId: string,
    toolName: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body?: { isError?: boolean } }> {
    const res = await fetch(`${baseUrl}${path}`, {
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
    return { status: res.status, body: parsed.result as { isError?: boolean } };
  }

  beforeEach(async () => {
    for (const c of registry.listClients()) await registry.unregister(c.name);
    __resetDbForTesting();
    _internalsForTesting.clear();
    // Base mock: any call to the pinned backend IP resolves instantly
    // (avoids real network flakiness/timeouts); everything else (our own
    // localhost test server, and — inside the sessionId test — the fake
    // OTLP endpoint) passes through to the real fetch.
    globalThis.fetch = (async (url: string, opts?: RequestInit) => {
      if (String(url).includes("1.2.3.4")) {
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      return originalFetch(url as unknown as string, opts);
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    for (const c of registry.listClients()) await registry.unregister(c.name);
    await stopApp();
    _internalsForTesting.clear();
    globalThis.fetch = originalFetch;
  });

  // Part of the 213-218 ObjectLiteral target (the `sessionId` key) — the
  // same observable signal src/observability/__tests__/tracing.test.ts uses
  // to test proxyToolCall's OWN handling of ToolCallOpts.sessionId; here we
  // additionally prove mcp-server.ts's own `sessionId: extra.sessionId`
  // extraction actually threads a REAL transport session id into that opt.
  test("sessionId: a real MCP transport session id reaches the span as mcp.session_id", async () => {
    await withConfig({ otelEndpoint: "http://otel.local/v1/traces" }, async () => {
      let captured: Record<string, unknown> | null = null;
      globalThis.fetch = (async (url: string, opts?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes("otel.local")) {
          captured = JSON.parse(String(opts?.body));
          return new Response("{}", { status: 200 });
        }
        if (urlStr.includes("1.2.3.4")) {
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        }
        return originalFetch(url as unknown as string, opts);
      }) as unknown as typeof fetch;

      await startApp();
      await reg("s4-sess-client");

      const sessionId = await initSession("/mcp/s4-sess-client");
      expect(sessionId).not.toBeNull();

      const result = await toolsCall("/mcp/s4-sess-client", sessionId!, "s4-sess-client__get-thing");
      expect(result.status).toBe(200);

      await flush();
      const span = (
        (
          (captured as unknown as { resourceSpans: Record<string, unknown>[] }).resourceSpans[0].scopeSpans as Record<
            string,
            unknown
          >[]
        )[0].spans as Record<string, unknown>[]
      )[0];
      const attrs = span.attributes as { key: string; value: { stringValue?: string } }[];
      expect(attrs.find((a) => a.key === "mcp.session_id")?.value.stringValue).toBe(sessionId!);
    });
  });

  // Lightweight smoke coverage for line 195 (endUserId extraction/threading)
  // — see the describe-block comment above for why deeper per-end-user
  // rate-limit behavior is intentionally out of scope here.
  test("endUserId: a real X-End-User-Id header reaches dispatch without crashing", async () => {
    await startApp();
    await reg("s4-eu-client");
    const sessionId = await initSession("/mcp/s4-eu-client");
    expect(sessionId).not.toBeNull();

    const result = await toolsCall("/mcp/s4-eu-client", sessionId!, "s4-eu-client__get-thing", {
      "x-end-user-id": "user-123",
    });
    expect(result.status).toBe(200);
    expect(result.body?.isError).toBeFalsy();
  });
});

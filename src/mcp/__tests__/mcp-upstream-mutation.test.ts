/**
 * Stryker mutation-testing backstop for src/mcp/mcp-upstream.ts (the outbound
 * MCP upstream connection pool + dispatcher). 131 mutants, 81.68% baseline
 * (106/131) — the existing mcp-upstream.test.ts only ever exercises the pool
 * through a custom transportFactory, so `buildTransport` itself (the real
 * network-transport builder) was completely untested, plus a scattering of
 * fallback/boundary/error-message gaps elsewhere.
 *
 * Written directly (no agent round — small survivor count), one file,
 * following the registry-persistence-mutation.test.ts convention. Each
 * describe/test cites the exact line:column + mutator + replacement it
 * targets, per house style.
 *
 * Two internal-field techniques used below, since `buildTransport` returns
 * an opaque `Transport` and nothing else exposes what was configured:
 *   - `SSEClientTransport`/`StreamableHTTPClientTransport` both store their
 *     constructor options as `this._requestInit` / `this._fetch` (confirmed
 *     by reading node_modules/@modelcontextprotocol/sdk's
 *     dist/esm/client/{sse,streamableHttp}.js) — accessed here via a cast,
 *     the same "reach past TS privacy to the real runtime shape" pattern
 *     used elsewhere in this series for framework internals.
 *   - The SDK's `Server` class exposes `getClientVersion()` AFTER a real
 *     handshake completes, reflecting exactly what the `Client` declared
 *     about itself — used to verify the CLIENT_NAME/CLIENT_VERSION
 *     constants actually reach the wire, without needing to intercept the
 *     `Client` constructor itself.
 *
 * EQUIVALENT MUTANTS (documented per task instructions rather than dropped
 * — verified across 2 verify Stryker runs against this file; Stryker's own
 * mutant-selection swaps which exact sub-variant survives run-to-run at
 * some of these locations, same [[px2_proxy_verification_noise]]-style
 * churn documented elsewhere in this series, but the underlying
 * reachability argument is identical for every variant seen):
 *   - 58:39-58:62, BOTH the ConditionalExpression (right operand of
 *     `p.resolvedIp && p.resolvedIp.length > 0` forced to `true`) AND the
 *     EqualityOperator (`> 0` -> `>= 0`) variants seen across runs. Whenever
 *     the left operand is truthy, `p.resolvedIp` is by definition a
 *     non-empty string, so `.length > 0` (and `.length >= 0`) are BOTH
 *     unconditionally true anyway — the `&&` never evaluates a right-hand
 *     value either replacement could actually differ from. No string is
 *     simultaneously truthy and zero-length. Left undistinguished by design.
 *   - 80:9-80:20, 81:9-81:21, 86:7-86:18, 87:7-87:19 ConditionalExpression
 *     ("true") — all four structurally-identical `if (x) opts.y = x;`
 *     guards (SSE branch's requestInit/fetch, streamable-http branch's
 *     requestInit/fetch; which specific one(s) survive swaps between verify
 *     runs, all four share one argument). Forcing any of these to
 *     always-true, when the guarded variable is `undefined`, changes `opts`
 *     from `{}` (key absent) to `{requestInit: undefined}` /
 *     `{fetch: undefined}` (key PRESENT with an `undefined` value) — an
 *     objectively different object shape, but one this file has no way to
 *     observe: the only inspection point available is the constructed
 *     transport's own `this._requestInit = opts?.requestInit` /
 *     `this._fetch = opts?.fetch` (see
 *     dist/esm/client/{sse,streamableHttp}.js), which reads the VALUE the
 *     same way regardless of whether the key exists — `{}.requestInit` and
 *     `{requestInit: undefined}.requestInit` are both `undefined`.
 *     Intercepting the raw `opts` object before the SDK's constructor
 *     consumes it (to inspect `Object.keys()` directly) would need
 *     `spyOn` on the `StreamableHTTPClientTransport`/`SSEClientTransport`
 *     class exports — tried and confirmed NOT viable: bun:test's `spyOn`
 *     replaces the export with a mock function that cannot be invoked with
 *     `new` against the real class (`TypeError: Cannot call a class
 *     constructor ... without |new|`), so the real constructor never runs
 *     and no transport is actually built to test against. Left
 *     undistinguished by design.
 *   - 108:43-108:49 StringLiteral (`Buffer.byteLength(text, "utf8")` ->
 *     `Buffer.byteLength(text, "")`) — verified empirically (`bun -e`):
 *     Bun's Buffer.byteLength treats "" identically to "utf8" (the same
 *     equivalence already documented for secret-box.ts L35's
 *     `cipher.update(str, "utf8")` in this series).
 *   - 145:81-145:101 ObjectLiteral (`{ capabilities: {} }` -> `{}` on the
 *     `Client` constructor's second argument). The SDK's own `Client`
 *     constructor already does `this._capabilities = options?.capabilities
 *     ?? {}` (confirmed by reading node_modules/@modelcontextprotocol/sdk's
 *     dist/esm/client/index.js) — passing `{}` (options object emptied) or
 *     `{ capabilities: {} }` (the real code) both leave `_capabilities` as
 *     `{}`, since `undefined ?? {}` and the literal `{}` are the same
 *     value. The SDK's own default subsumes ours.
 *   - 208:29-208:31 and 230:27-230:29, both ArrayDeclaration (`r.resources
 *     ?? []` / `r.prompts ?? []` -> `?? ["Stryker was here"]`) are
 *     unreachable through the real SDK: `client.listResources()` /
 *     `client.listPrompts()` validate the server's response against
 *     `ListResourcesResultSchema` / `ListPromptsResultSchema`, whose
 *     `resources` / `prompts` fields are REQUIRED `z.ZodArray`s (not
 *     `.optional()` — confirmed by reading the SDK's types.d.ts for both
 *     schemas). Any response missing that field fails validation and
 *     throws *before* this code ever runs, landing in the surrounding
 *     `catch { return []; }` instead — so `r.resources`/`r.prompts` can
 *     never actually be `undefined`/`null` by the time these lines
 *     execute; the `?? []` is defensive-only narrowing against our own
 *     `as { resources?: unknown[] }` / `as { prompts?: unknown[] }` casts
 *     lying about a type the schema already guarantees.
 *   - 263:9-263:15 ConditionalExpression, the "force `if (client)` to
 *     `true`" direction specifically (the "force to `false`" direction IS
 *     killed below). When `client` is genuinely `undefined` (disconnecting
 *     a name with no live connection), forcing the guard to fire anyway
 *     makes `await client.close()` throw synchronously (reading `.close`
 *     off `undefined`) — but that throw is caught by the very next line's
 *     `try { ... } catch { }`, which was already there for the "socket may
 *     already be gone" case. The function still resolves to `undefined`
 *     either way, with no other observable state change (`conns.delete`
 *     already ran unconditionally one line earlier), so this direction is
 *     silently absorbed and produces no externally distinguishable outcome.
 */
import { describe, test, expect } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ReadResourceRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildTransport, mcpResultToProxyResult, McpUpstreamPool, type McpConnParams } from "../../mcp/mcp-upstream.js";

/** Monkey-patches a REAL transport's send() to delay only messages of one JSON-RPC method, letting everything else (initialize, etc.) proceed at normal speed. Mutates and returns the same instance so onmessage/onclose wiring stays intact. */
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

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function handleCall(name: string): ToolResult {
  if (name === "slow") {
    // Never resolves within any of this file's timeouts — used purely to
    // give an in-flight call something to be cancelled/timed-out against.
    return { content: [{ type: "text", text: "unused" }] };
  }
  return { content: [{ type: "text", text: `echo:${name}` }] };
}

/** Same fake-upstream shape as mcp-upstream.test.ts's makeFactory, but exposes the live Server instance for getClientVersion()/capability assertions. */
function makeFactory(): { factory: (p: McpConnParams) => Transport; server: () => Server | undefined } {
  let server: Server | undefined;
  const factory = (_p: McpConnParams): Transport => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    server = new Server({ name: "test-upstream", version: "1.0.0" }, { capabilities: { tools: {}, prompts: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      if (req.params.name === "slow") {
        return new Promise<ToolResult>(() => {
          /* never resolves */
        });
      }
      return handleCall(req.params.name);
    });
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({}) as { prompts: never[] });
    void server.connect(serverT);
    return clientT;
  };
  return { factory, server: () => server };
}

const PARAMS: McpConnParams = { name: "mu-test", url: "http://example.test/mcp", transport: "streamable-http" };

// ===========================================================================
// buildTransport — completely untested by the sibling file, which always
// injects a custom transportFactory that bypasses it entirely.
// ===========================================================================

type TransportInternals = { _requestInit?: RequestInit; _fetch?: unknown };
function internals(t: Transport): TransportInternals {
  return t as unknown as TransportInternals;
}

const BT_BASE: McpConnParams = { name: "bt", url: "http://example.test/mcp", transport: "streamable-http" };

describe("buildTransport", () => {
  // 78:7-78:28 EqualityOperator ("===" -> "!=="), 78:23-78:28 StringLiteral ("sse" -> "").
  test("transport: 'streamable-http' returns a StreamableHTTPClientTransport, not SSEClientTransport", () => {
    const t = buildTransport({ ...BT_BASE, transport: "streamable-http" });
    expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
    expect(t).not.toBeInstanceOf(SSEClientTransport);
  });

  test("transport: 'sse' returns an SSEClientTransport, not the streamable-http default", () => {
    const t = buildTransport({ ...BT_BASE, transport: "sse" });
    expect(t).toBeInstanceOf(SSEClientTransport);
    expect(t).not.toBeInstanceOf(StreamableHTTPClientTransport);
  });

  // 80:9-80:21 / 81:9-81:21 (SSE branch) and 86:7-86:18 / 87:7-87:18
  // (streamable-http branch) ConditionalExpression (both true/false
  // directions) on "if (requestInit) ..." / "if (tracingFetch) ...".
  test("with neither authHeaders nor resolvedIp, neither requestInit nor fetch is set, on either transport kind", () => {
    for (const kind of ["streamable-http", "sse"] as const) {
      const t = buildTransport({ ...BT_BASE, transport: kind });
      expect(internals(t)._requestInit).toBeUndefined();
      expect(internals(t)._fetch).toBeUndefined();
    }
  });

  test("authHeaders alone sets requestInit but not fetch, on either transport kind", () => {
    const authHeaders = { Authorization: "Bearer xyz" };
    for (const kind of ["streamable-http", "sse"] as const) {
      const t = buildTransport({ ...BT_BASE, transport: kind, authHeaders });
      expect(internals(t)._requestInit).toEqual({ headers: authHeaders });
      expect(internals(t)._fetch).toBeUndefined();
    }
  });

  test("resolvedIp alone sets fetch (pinned/tracing) but not requestInit, on either transport kind", () => {
    for (const kind of ["streamable-http", "sse"] as const) {
      const t = buildTransport({ ...BT_BASE, transport: kind, resolvedIp: "93.184.216.34" });
      expect(typeof internals(t)._fetch).toBe("function");
      expect(internals(t)._requestInit).toBeUndefined();
    }
  });

  test("both authHeaders and resolvedIp set both requestInit and fetch together", () => {
    const authHeaders = { Authorization: "Bearer xyz" };
    const t = buildTransport({ ...BT_BASE, transport: "streamable-http", authHeaders, resolvedIp: "93.184.216.34" });
    expect(internals(t)._requestInit).toEqual({ headers: authHeaders });
    expect(typeof internals(t)._fetch).toBe("function");
  });

  // 58:23-58:62 LogicalOperator ("p.resolvedIp && p.resolvedIp.length > 0"
  // -> "p.resolvedIp || p.resolvedIp.length > 0"). With resolvedIp omitted
  // entirely (undefined — the common case, matching every real registered
  // client's McpConnParams when SSRF pinning hasn't run yet), the real code
  // short-circuits on the falsy left operand and never evaluates ".length".
  // Under the || mutant, a falsy left operand forces evaluation of the RIGHT
  // operand instead: "undefined.length" throws a TypeError.
  test("resolvedIp omitted entirely does not throw, on either transport kind (58 LogicalOperator && -> ||)", () => {
    expect(() => buildTransport({ ...BT_BASE, transport: "streamable-http" })).not.toThrow();
    expect(() => buildTransport({ ...BT_BASE, transport: "sse" })).not.toThrow();
  });
});

// ===========================================================================
// Client self-identification — 48:24-48:31 StringLiteral (CLIENT_VERSION
// "1.0.0" -> ""), 145:81-145:101 ObjectLiteral ({name, version} -> {}).
// ===========================================================================

describe("McpUpstreamPool identifies itself to the upstream with the real constants", () => {
  test("the connected Server sees clientInfo {name: 'mcp-rest-bridge', version: '1.0.0'}", async () => {
    const { factory, server } = makeFactory();
    const pool = new McpUpstreamPool({ transportFactory: factory });
    await pool.call(PARAMS, "echo", {}, { timeoutMs: 2000, maxBytes: 1_000_000 });
    expect(server()!.getClientVersion()).toEqual({ name: "mcp-rest-bridge", version: "1.0.0" });
    await pool.disconnect("mu-test");
  });
});

// ===========================================================================
// connectTimeoutMs — 133:29-133:60 LogicalOperator ("??" -> "&&"),
// 146:54-146:88 ObjectLiteral ({timeout: this.connectTimeoutMs} -> {}).
// ===========================================================================

/** A raw Transport whose response to "initialize" is artificially delayed, to make the connect-timeout race observable without a real slow network. */
function makeDelayedInitTransport(delayMs: number): Transport {
  const t: Transport = {
    start: async () => {},
    send: async (message: unknown) => {
      const msg = message as { method?: string; id?: unknown };
      if (msg.method === "initialize") {
        setTimeout(() => {
          t.onmessage?.({
            jsonrpc: "2.0",
            id: msg.id as string | number,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "slow-upstream", version: "1.0" },
            },
          });
        }, delayMs);
      }
    },
    close: async () => {},
  };
  return t;
}

describe("McpUpstreamPool connectTimeoutMs option", () => {
  test("a small custom connectTimeoutMs is actually honored, not silently replaced by the 10s default", async () => {
    const pool = new McpUpstreamPool({ transportFactory: () => makeDelayedInitTransport(500), connectTimeoutMs: 20 });
    const started = Date.now();
    const r = await pool.call(PARAMS, "echo", {}, { timeoutMs: 5000, maxBytes: 1_000_000 });
    const elapsedMs = Date.now() - started;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Failed to connect");
    // Under the "?? -> &&" mutant a truthy 20 would be discarded in favor of
    // 10_000; under the "{timeout:...} -> {}" mutant no override would reach
    // the SDK at all, falling back to ITS OWN much larger default. Either
    // way the real 500ms-delayed init would still resolve successfully well
    // before either fallback fires. A generous margin (under the 500ms
    // delay) still cleanly distinguishes "our 20ms fired" from "it didn't".
    expect(elapsedMs).toBeLessThan(500);
  });
});

// ===========================================================================
// call() — connect-failure message precision. 50:42-52:2 BlockStatement
// (messageOf's body emptied -> always returns undefined), 181:93-181:110
// ObjectLiteral ({isError: true} -> {}), 181:104-181:108 BooleanLiteral
// (true -> false).
// ===========================================================================

describe("call() connect-failure message", () => {
  test("the error result is isError:true with the real underlying error text, not a blank/undefined suffix", async () => {
    const failingFactory = (): Transport => {
      throw new Error("mcp-upstream-mutation-boom");
    };
    const pool = new McpUpstreamPool({ transportFactory: failingFactory });
    const r = await pool.call(PARAMS, "echo", {}, { timeoutMs: 2000, maxBytes: 1_000_000 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("Failed to connect to MCP upstream 'mu-test': mcp-upstream-mutation-boom");
  });
});

// ===========================================================================
// call() — caller-initiated cancellation. Confirms the abort path is reached
// with a real in-flight call (not just reasoned about), locking down the
// exact result shape it returns.
// ===========================================================================

describe("call() caller-initiated cancellation", () => {
  test("aborting mid-call returns isError:true, cancelled:true, and the exact cancellation message", async () => {
    const { factory } = makeFactory();
    const pool = new McpUpstreamPool({ transportFactory: factory });
    const controller = new AbortController();
    const callPromise = pool.call(
      PARAMS,
      "slow",
      {},
      {
        timeoutMs: 5000,
        maxBytes: 1_000_000,
        signal: controller.signal,
      },
    );
    setTimeout(() => controller.abort(), 50);
    const r = await callPromise;
    expect(r).toEqual({
      isError: true,
      cancelled: true,
      content: [{ type: "text", text: "Tool call cancelled by caller" }],
    });
    await pool.disconnect("mu-test");
  });
});

// ===========================================================================
// ping() — 253:13-256:6 BlockStatement (catch body emptied), 255:14-255:19
// BooleanLiteral (return false -> true).
// ===========================================================================

describe("ping()", () => {
  test("a failed ping returns false (not true) and drops the now-broken connection", async () => {
    const clientTransports: Transport[] = [];
    const factory = (_p: McpConnParams): Transport => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "test-upstream", version: "1.0.0" }, { capabilities: {} });
      void server.connect(serverT);
      clientTransports.push(clientT);
      return clientT;
    };
    const pool = new McpUpstreamPool({ transportFactory: factory });

    expect(await pool.ping(PARAMS, 2000)).toBe(true);
    expect(pool.isConnected("mu-test")).toBe(true);

    // Sabotage the underlying transport directly (simulating an unexpected
    // connection drop) without going through pool.disconnect(), so the
    // pool's cached client is now broken but still present in `conns`.
    await clientTransports[0]!.close();

    const result = await pool.ping(PARAMS, 2000);
    expect(result).toBe(false);
    expect(pool.isConnected("mu-test")).toBe(false);
  });

  // 251:25-251:47 ObjectLiteral ("{ timeout: timeoutMs }" -> "{}" on
  // client.ping()). A delayed "ping" response plus a small custom timeoutMs
  // must fail quickly; under the mutant no timeout override reaches the
  // SDK, so it would fall back to the SDK's own much larger default and the
  // delayed response would still arrive in time.
  test("ping honors the given timeoutMs, not a silently-emptied options object", async () => {
    const factory = (_p: McpConnParams): Transport => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "test-upstream", version: "1.0.0" }, { capabilities: {} });
      void server.connect(serverT);
      return delayMethod(clientT, "ping", 500);
    };
    const pool = new McpUpstreamPool({ transportFactory: factory });

    const started = Date.now();
    const result = await pool.ping(PARAMS, 20);
    const elapsedMs = Date.now() - started;

    expect(result).toBe(false);
    expect(elapsedMs).toBeLessThan(500);
  });
});

// ===========================================================================
// readResource()/getPrompt() — 218:49-218:71 ObjectLiteral
// ("{ timeout: timeoutMs }" -> "{}" on client.readResource()), 241:19-244:6
// BlockStatement (getPrompt's catch body emptied).
// ===========================================================================

describe("readResource()", () => {
  test("honors the given timeoutMs, not a silently-emptied options object", async () => {
    const factory = (_p: McpConnParams): Transport => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "test-upstream", version: "1.0.0" }, { capabilities: { resources: {} } });
      server.setRequestHandler(ReadResourceRequestSchema, async () => ({ contents: [] }));
      void server.connect(serverT);
      return delayMethod(clientT, "resources/read", 500);
    };
    const pool = new McpUpstreamPool({ transportFactory: factory });

    const started = Date.now();
    await expect(pool.readResource(PARAMS, "test://thing", 20)).rejects.toThrow();
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeLessThan(500);
  });
});

describe("getPrompt()", () => {
  test("disconnects and rethrows the real error on failure, not swallowing it", async () => {
    const factory = (_p: McpConnParams): Transport => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      // No "prompts" capability and no getPrompt handler registered — a
      // getPrompt call against this server must fail.
      const server = new Server({ name: "test-upstream", version: "1.0.0" }, { capabilities: {} });
      void server.connect(serverT);
      return clientT;
    };
    const pool = new McpUpstreamPool({ transportFactory: factory });

    await expect(pool.getPrompt(PARAMS, "nonexistent", {}, 2000)).rejects.toThrow();
    expect(pool.isConnected("mu-test")).toBe(false);
  });

  // 240:64-240:86 ObjectLiteral ("{ timeout: timeoutMs }" -> "{}" on
  // client.getPrompt()). Same "custom timeout must actually reach the SDK"
  // technique as ping()/readResource() above.
  test("honors the given timeoutMs, not a silently-emptied options object", async () => {
    const factory = (_p: McpConnParams): Transport => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "test-upstream", version: "1.0.0" }, { capabilities: { prompts: {} } });
      server.setRequestHandler(GetPromptRequestSchema, async () => ({ messages: [] }));
      void server.connect(serverT);
      return delayMethod(clientT, "prompts/get", 500);
    };
    const pool = new McpUpstreamPool({ transportFactory: factory });

    const started = Date.now();
    await expect(pool.getPrompt(PARAMS, "greet", {}, 20)).rejects.toThrow();
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeLessThan(500);
  });
});

// ===========================================================================
// getClient() in-flight dedup — 142:9-142:17 ConditionalExpression
// ("if (inflight) return inflight;" forced to "false"). Two concurrent
// calls to the same not-yet-connected upstream must share ONE connection
// attempt, not race to open two.
// ===========================================================================

describe("McpUpstreamPool concurrent connection requests", () => {
  test("two concurrent calls to the same upstream share one in-flight connection attempt", async () => {
    let connectCount = 0;
    const factory = (_p: McpConnParams): Transport => {
      connectCount++;
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "test-upstream", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
      server.setRequestHandler(CallToolRequestSchema, async () => handleCall("echo"));
      void server.connect(serverT);
      return clientT;
    };
    const pool = new McpUpstreamPool({ transportFactory: factory });

    const [r1, r2] = await Promise.all([
      pool.call(PARAMS, "echo", {}, { timeoutMs: 2000, maxBytes: 1_000_000 }),
      pool.call(PARAMS, "echo", {}, { timeoutMs: 2000, maxBytes: 1_000_000 }),
    ]);

    expect(r1.isError).toBeUndefined();
    expect(r2.isError).toBeUndefined();
    // If the inflight-reuse guard were skipped, both calls would race to
    // build their own transport, so the factory's connect counter would be
    // 2 instead of 1.
    expect(connectCount).toBe(1);
    await pool.disconnect("mu-test");
  });
});

// ===========================================================================
// disconnect() — 263:9-263:15 ConditionalExpression ("if (client)" forced
// false), 263:17-269:6 / 264:11-266:8 BlockStatement (the guarded block /
// the try{close}catch{} emptied).
// ===========================================================================

describe("disconnect()", () => {
  test("really calls client.close(), tearing down the transport — not just forgetting the cache entry", async () => {
    let closeCalls = 0;
    const factory = (_p: McpConnParams): Transport => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "test-upstream", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
      server.setRequestHandler(CallToolRequestSchema, async () => handleCall("echo"));
      void server.connect(serverT);
      const originalClose = clientT.close.bind(clientT);
      clientT.close = async () => {
        closeCalls++;
        await originalClose();
      };
      return clientT;
    };
    const pool = new McpUpstreamPool({ transportFactory: factory });

    await pool.call(PARAMS, "echo", {}, { timeoutMs: 2000, maxBytes: 1_000_000 });
    expect(pool.isConnected("mu-test")).toBe(true);

    await pool.disconnect("mu-test");
    // The SDK's own Client.close() internals invoke the transport's close()
    // more than once for a single logical disconnect (empirically observed
    // here, the same kind of SDK-internal double-cleanup already documented
    // for transports.ts's DELETE handler) — the mutation-relevant fact is
    // simply that it's invoked AT LEAST once (0 under the "if(client)"
    // forced-false mutant, or the guarded block/try emptied), not the exact
    // count.
    expect(closeCalls).toBeGreaterThanOrEqual(1);
    expect(pool.isConnected("mu-test")).toBe(false);
  });

  test("disconnecting a name with no live connection is a safe no-op", async () => {
    const pool = new McpUpstreamPool({ transportFactory: makeFactory().factory });
    await expect(pool.disconnect("never-connected")).resolves.toBeUndefined();
  });
});

// ===========================================================================
// listPrompts() — 230:27-230:29 ArrayDeclaration ("r.prompts ?? []" ->
// "r.prompts ?? [\"Stryker was here\"]").
// ===========================================================================

describe("listPrompts()", () => {
  test("a response with no 'prompts' field returns a genuinely empty array", async () => {
    const { factory } = makeFactory();
    const pool = new McpUpstreamPool({ transportFactory: factory });
    const prompts = await pool.listPrompts(PARAMS, 2000);
    expect(prompts).toEqual([]);
    await pool.disconnect("mu-test");
  });
});

// ===========================================================================
// mcpResultToProxyResult — 100:56-100:58 ArrayDeclaration (non-array content
// fallback), 107:18-107:71 LogicalOperator / 107:42-107:71
// ConditionalExpression (the text/type narrowing), 109:9-109:30
// EqualityOperator ("> " -> ">=" byte-cap boundary).
// ===========================================================================

describe("mcpResultToProxyResult edge cases", () => {
  test("non-array content falls back to a genuinely empty array, not a poisoned placeholder", () => {
    const r = mcpResultToProxyResult({ content: "not-an-array" }, 1_000_000);
    expect(r.content).toEqual([]);
  });

  test("a 'text'-typed item whose text field is NOT a string is JSON-stringified as a whole, not passed through raw", () => {
    const item = { type: "text", text: 12345 };
    const r = mcpResultToProxyResult({ content: [item] }, 1_000_000);
    expect(r.content[0]!.text).toBe(JSON.stringify(item));
  });

  test("a non-'text' item whose 'text' field happens to be a string is still JSON-stringified as a whole, not passed through raw", () => {
    const item = { type: "image", text: "not-really-text", data: "AAAA" };
    const r = mcpResultToProxyResult({ content: [item] }, 1_000_000);
    expect(r.content[0]!.text).toBe(JSON.stringify(item));
  });

  test("the byte cap boundary is strictly-greater-than, not greater-or-equal", () => {
    const text = "x".repeat(10);
    const exactBytes = Buffer.byteLength(text, "utf8");

    const atExactCap = mcpResultToProxyResult({ content: [{ type: "text", text }] }, exactBytes);
    expect(atExactCap.isError).toBeUndefined();
    expect(atExactCap.content[0]!.text).toBe(text);

    const oneUnderCap = mcpResultToProxyResult({ content: [{ type: "text", text }] }, exactBytes - 1);
    expect(oneUnderCap.isError).toBe(true);
    expect(oneUnderCap.content[0]!.text).toContain("exceeded");
  });
});

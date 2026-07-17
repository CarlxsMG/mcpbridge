/**
 * Stryker mutation-testing backstop — cluster C6 (proxy.ts L616-679):
 * always-mode tool mock short-circuit, response-cache lookup (hit/miss), and
 * request-coalescing key derivation for concurrent identical REST GET calls.
 *
 * All calls are driven through the public proxyToolCall entry point per the
 * module's hard privacy boundary — no direct imports of dispatchToolCall.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { config } from "../../config.js";
import { getDb, __resetDbForTesting } from "../../db/connection.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import { mcpUpstream, buildTransport, type McpConnParams } from "../../mcp/mcp-upstream.js";
import { setToolMock } from "../../tool-meta/tool-mock.js";
import { setToolCacheConfig, __resetCacheForTesting } from "../../tool-policies/response-cache.js";
import { setToolCoalesce, __resetCoalesceForTesting } from "../../tool-policies/coalesce.js";
import { createMcpKey } from "../../security/mcp-key-store.js";
import { cacheEvents, getLegacyMetricsSnapshot } from "../../observability/metrics.js";
import * as logger from "../../logger.js";
import * as usageMod from "../../observability/usage.js";
import type { RestToolDefinition } from "../../mcp/types.js";
import type { DiscoveredMcpTool } from "../../mcp/mcp-discovery.js";

// lower-case only — the registry's TOOL_NAME_RE rejects uppercase client names.
const CLIENT_MOCK = "mutc6mock-mock";
const CLIENT_CACHE = "mutc6mock-cache";
const CLIENT_COAL = "mutc6mock-coal";
const MCP_CLIENT = "mutc6mock-mcpkind";

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "get-item",
    method: "GET",
    endpoint: "/item",
    description: "d",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    ...overrides,
  };
}

async function reg(client: string, tools: RestToolDefinition[] = [makeTool()]): Promise<void> {
  await registry.register(client, tools, "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

const originalFetch = globalThis.fetch;
function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  (config as Record<string, unknown>).retryBaseDelayMs = 1;
  __resetDbForTesting();
  __resetCacheForTesting();
  __resetCoalesceForTesting();
  for (const c of [CLIENT_MOCK, CLIENT_CACHE, CLIENT_COAL, MCP_CLIENT]) removeCircuitBreaker(c);
  globalThis.fetch = originalFetch;
}
beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});

/** Last tool_call_log row for a client, ordered by insertion (most recent first). */
function lastLogRow(
  client: string,
): { key_id: number | null; status_class: string; is_error: number; duration_ms: number } | null {
  return getDb()
    .query(
      `SELECT key_id, status_class, is_error, duration_ms FROM tool_call_log WHERE client_name = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(client) as { key_id: number | null; status_class: string; is_error: number; duration_ms: number } | null;
}

// ---------------------------------------------------------------------------
// Mock / virtualization short-circuit (L620-631)
// ---------------------------------------------------------------------------
describe("mock short-circuit — 'always' mode (L620-631)", () => {
  test("enabled 'always' mock short-circuits before any fetch, with correct recordToolCall/recordUsage/log bookkeeping (kills L620 kind-ternary, L621 compound condition, L622 recordToolCall isError, L623/L626/L627/L628 recordUsage fields, L631 log call)", async () => {
    await reg(CLIENT_MOCK);
    const { record, rawKey } = createMcpKey("c6-mock-key", null, null, null);
    setToolMock(CLIENT_MOCK, "get-item", { enabled: true, mode: "always", response: "mocked-response-text" });

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ real: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    const before = getLegacyMetricsSnapshot();
    try {
      const res = await proxyToolCall(`${CLIENT_MOCK}__get-item`, {}, rawKey);
      const after = getLegacyMetricsSnapshot();

      // L620: kind==='rest' ternary must actually gate mockCfg lookup, and
      // L621: the always-mode short-circuit must run — never reaches fetch.
      expect(fetchCalls).toBe(0);
      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toBe("mocked-response-text");

      // L622: recordToolCall(0, false) — isError must stay false.
      expect(after.totalToolCalls - before.totalToolCalls).toBe(1);
      expect(after.errorToolCalls - before.errorToolCalls).toBe(0);

      // L623/L626/L627/L628: recordUsage(...) fields, incl. keyId via ?? (not &&).
      const row = lastLogRow(CLIENT_MOCK);
      expect(row).not.toBeNull();
      expect(row!.key_id).toBe(record.id);
      expect(row!.status_class).toBe("2xx");
      expect(row!.is_error).toBe(0);
      expect(row!.duration_ms).toBe(0);

      // L631: log("info", "Tool call served from mock", {tool, client}).
      const call = logSpy.mock.calls.find((c) => c[0] === "info" && String(c[1]).includes("served from mock"));
      expect(call).toBeDefined();
      expect(call?.[2]).toMatchObject({ tool: `${CLIENT_MOCK}__get-item`, client: CLIENT_MOCK });
    } finally {
      logSpy.mockRestore();
    }
  });

  test("mock configured but enabled:false does NOT short-circuit (kills L621 enabled&&mode compound mutants)", async () => {
    await reg(CLIENT_MOCK);
    setToolMock(CLIENT_MOCK, "get-item", { enabled: false, mode: "always", response: "SHOULD-NOT-BE-SEEN" });
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ real: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const res = await proxyToolCall(`${CLIENT_MOCK}__get-item`, {});
    expect(fetchCalls).toBe(1);
    expect(res.content[0].text).not.toBe("SHOULD-NOT-BE-SEEN");
  });

  test("mode:'fallback' (not 'always') does NOT short-circuit even though enabled:true (kills L621 mode==='always' StringLiteral mutant)", async () => {
    await reg(CLIENT_MOCK);
    setToolMock(CLIENT_MOCK, "get-item", { enabled: true, mode: "fallback", response: "SHOULD-NOT-BE-SEEN" });
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ real: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const res = await proxyToolCall(`${CLIENT_MOCK}__get-item`, {});
    expect(fetchCalls).toBe(1);
    expect(res.content[0].text).not.toBe("SHOULD-NOT-BE-SEEN");
  });

  // Kills L626 OptionalChaining `callerKey?.id ?? null` -> `callerKey.id`: called
  // with NO callerToken at all, so `callerKey` resolves to `null` inside
  // dispatchToolCall. Real code: `null?.id ?? null` safely evaluates to `null`.
  // Mutant: `null.id` throws a synchronous TypeError, which propagates out of
  // dispatchToolCall unhandled (proxyToolCall wraps it in no try/catch) and
  // rejects the returned promise instead of resolving with the mocked result —
  // so this test would fail on `await` under the mutant, not just on content.
  test("an 'always' mock with NO callerToken resolves normally and records a null keyId (kills L626 OptionalChaining)", async () => {
    await reg(CLIENT_MOCK);
    setToolMock(CLIENT_MOCK, "get-item", { enabled: true, mode: "always", response: "mocked-no-key" });

    const res = await proxyToolCall(`${CLIENT_MOCK}__get-item`, {});
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe("mocked-no-key");

    const row = lastLogRow(CLIENT_MOCK);
    expect(row).not.toBeNull();
    expect(row!.key_id).toBeNull();
  });

  describe("kind check via a real MCP-kind upstream", () => {
    let callCount = 0;
    function factory(_p: McpConnParams): Transport {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "up", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: "echo", description: "e", inputSchema: { type: "object", properties: {} } }],
      }));
      server.setRequestHandler(CallToolRequestSchema, async () => {
        callCount++;
        return { content: [{ type: "text", text: "real-echo-response" }] };
      });
      void server.connect(serverT);
      return clientT;
    }
    const TOOLS: DiscoveredMcpTool[] = [
      { name: "echo", upstreamName: "echo", description: "Echoes", inputSchema: { type: "object", properties: {} } },
    ];

    beforeEach(async () => {
      callCount = 0;
      mcpUpstream.__setTransportFactoryForTesting(factory);
      await registry.registerMcp(MCP_CLIENT, TOOLS, "http://mcp.test/mcp", "streamable-http", "127.0.0.1", "127.0.0.1");
    });
    afterEach(async () => {
      await registry.unregister(MCP_CLIENT);
      await mcpUpstream.disconnect(MCP_CLIENT);
      mcpUpstream.__setTransportFactoryForTesting(buildTransport);
    });

    test("an 'always' mock configured on an MCP-kind tool is ignored — dispatch still reaches the real upstream (kills L620 full kind-ternary set)", async () => {
      setToolMock(MCP_CLIENT, "echo", { enabled: true, mode: "always", response: "SHOULD-NOT-BE-SEEN" });
      const res = await proxyToolCall(`${MCP_CLIENT}__echo`, {});
      expect(callCount).toBe(1);
      expect(res.content[0].text).toBe("real-echo-response");
      expect(res.content[0].text).not.toBe("SHOULD-NOT-BE-SEEN");
    });
  });
});

// ---------------------------------------------------------------------------
// Response cache — lookup gate + hit/miss bookkeeping (L643-662)
// ---------------------------------------------------------------------------
describe("response cache — lookup, hit, and miss bookkeeping (L643-662)", () => {
  test("GET tool with cache enabled: miss then hit, with correct cacheEvents labels, recordUsage row, recordToolCall isError, and log message on the hit (kills L643 method check, L646 conditional, L649 hit-event args, L650 recordToolCall isError, L651/L654/L655/L656 recordUsage row incl. ?? keyId, L659 log call, L662 miss-event args)", async () => {
    await reg(CLIENT_CACHE);
    const { record, rawKey } = createMcpKey("c6-cache-key", null, null, null);
    setToolCacheConfig(CLIENT_CACHE, "get-item", { enabled: true, ttlSeconds: 60 });

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ n: fetchCalls }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const incSpy = spyOn(cacheEvents, "inc");
    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      // 1st call: miss — populates the cache.
      const r1 = await proxyToolCall(`${CLIENT_CACHE}__get-item`, {}, rawKey);
      expect(r1.isError).toBeUndefined();
      expect(fetchCalls).toBe(1);
      const missCall = incSpy.mock.calls.find((c) => (c[0] as Record<string, string>).outcome === "miss");
      expect(missCall?.[0]).toEqual({ client: CLIENT_CACHE, outcome: "miss" });

      const before = getLegacyMetricsSnapshot();
      // 2nd call: hit — must not reach the upstream again.
      const r2 = await proxyToolCall(`${CLIENT_CACHE}__get-item`, {}, rawKey);
      const after = getLegacyMetricsSnapshot();
      expect(fetchCalls).toBe(1); // still 1 — served from cache
      expect(r2.content[0].text).toBe(r1.content[0].text);

      // L650: recordToolCall(0, false) on the hit path.
      expect(after.totalToolCalls - before.totalToolCalls).toBe(1);
      expect(after.errorToolCalls - before.errorToolCalls).toBe(0);

      // L649: cacheEvents.inc({client, outcome:"hit"}).
      const hitCall = incSpy.mock.calls.find((c) => (c[0] as Record<string, string>).outcome === "hit");
      expect(hitCall?.[0]).toEqual({ client: CLIENT_CACHE, outcome: "hit" });

      // L651/L654/L655/L656: recordUsage(...) row for the hit, incl. keyId via ?? (not &&).
      const row = lastLogRow(CLIENT_CACHE);
      expect(row).not.toBeNull();
      expect(row!.key_id).toBe(record.id);
      expect(row!.status_class).toBe("2xx");
      expect(row!.is_error).toBe(0);
      expect(row!.duration_ms).toBe(0);

      // L659: log("info", "Tool call served from cache", {tool, client}).
      const call = logSpy.mock.calls.find((c) => c[0] === "info" && String(c[1]).includes("served from cache"));
      expect(call).toBeDefined();
      expect(call?.[2]).toMatchObject({ tool: `${CLIENT_CACHE}__get-item`, client: CLIENT_CACHE });
    } finally {
      incSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test("cache disabled: cacheEvents.inc is never called and every call reaches the upstream (kills L646 conditional forced-true mutants)", async () => {
    await reg(CLIENT_CACHE);
    setToolCacheConfig(CLIENT_CACHE, "get-item", { enabled: false, ttlSeconds: 60 });
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ n: fetchCalls }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const incSpy = spyOn(cacheEvents, "inc");
    try {
      await proxyToolCall(`${CLIENT_CACHE}__get-item`, {});
      await proxyToolCall(`${CLIENT_CACHE}__get-item`, {});
      expect(fetchCalls).toBe(2);
      const relevant = incSpy.mock.calls.filter((c) => (c[0] as Record<string, string>).client === CLIENT_CACHE);
      expect(relevant.length).toBe(0);
    } finally {
      incSpy.mockRestore();
    }
  });

  test("POST tool with cache config enabled is never looked up / cached (kills L643 method-ternary mutants)", async () => {
    await reg(CLIENT_CACHE, [makeTool({ name: "post-item", method: "POST", endpoint: "/item" })]);
    setToolCacheConfig(CLIENT_CACHE, "post-item", { enabled: true, ttlSeconds: 60 });
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ n: fetchCalls }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const incSpy = spyOn(cacheEvents, "inc");
    try {
      await proxyToolCall(`${CLIENT_CACHE}__post-item`, {});
      await proxyToolCall(`${CLIENT_CACHE}__post-item`, {});
      expect(fetchCalls).toBe(2);
      const relevant = incSpy.mock.calls.filter((c) => (c[0] as Record<string, string>).client === CLIENT_CACHE);
      expect(relevant.length).toBe(0);
    } finally {
      incSpy.mockRestore();
    }
  });

  // Kills L651 ObjectLiteral `{...}` -> `{}` on the cache-HIT recordUsage(...)
  // call specifically (distinct from the mock-path recordUsage object at L623,
  // and from the miss-path recordUsage(s) reached via runRest — those are
  // covered elsewhere). Spies on recordUsage directly (module-namespace spy,
  // same idiom as the `logger.log` spy above) rather than reading the DB row,
  // because under this exact mutant the row-based assertion coincidentally
  // still passes: recordUsage({}) still inserts a row (client_name/tool_name/
  // key_id all bind as SQL NULL, is_error binds 0, duration_ms binds NaN ->
  // Math.round/Math.max produce NaN which better-sqlite/bun:sqlite silently
  // coerces), and the immediately-preceding MISS call's real recordUsage(...)
  // (same key, same "2xx"/false/~0ms shape) already left a row indistinguishable
  // by content from the expected hit-path row — so the DB-row assertion block
  // in the sibling test above provably cannot tell the two calls apart. Only a
  // direct spy on the exact call arguments closes this gap.
  test("cache hit invokes recordUsage with the exact usage-event object, not an empty one (kills L651 ObjectLiteral)", async () => {
    await reg(CLIENT_CACHE, [makeTool({ name: "get-item2", endpoint: "/item2" })]);
    const { record, rawKey } = createMcpKey("c6-cache-key-spy", null, null, null);
    setToolCacheConfig(CLIENT_CACHE, "get-item2", { enabled: true, ttlSeconds: 60 });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    // 1st call: miss — populates the cache.
    await proxyToolCall(`${CLIENT_CACHE}__get-item2`, {}, rawKey);

    const usageSpy = spyOn(usageMod, "recordUsage");
    try {
      // 2nd call: hit.
      const r2 = await proxyToolCall(`${CLIENT_CACHE}__get-item2`, {}, rawKey);
      expect(r2.isError).toBeUndefined();
      expect(usageSpy).toHaveBeenCalledWith({
        clientName: CLIENT_CACHE,
        toolName: "get-item2",
        keyId: record.id,
        statusClass: "2xx",
        isError: false,
        durationMs: 0,
      });
    } finally {
      usageSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Request coalescing — eligibility + key derivation (L674-677)
// ---------------------------------------------------------------------------
describe("coalesce eligibility and key derivation (L674-677)", () => {
  /** Fetch mock that echoes the ?id= query param back in the JSON body, so
   * piggybacked (wrongly-coalesced) calls are distinguishable from genuinely
   * independent ones. */
  function idEchoFetch(): { getCalls: () => number } {
    let calls = 0;
    globalThis.fetch = (async (url: string | URL) => {
      calls++;
      const u = new URL(String(url));
      const id = u.searchParams.get("id") ?? "none";
      return new Response(JSON.stringify({ id }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { getCalls: () => calls };
  }

  test("REST GET tool with coalescing enabled: concurrent identical calls share a single fetch (baseline for L674)", async () => {
    await reg(CLIENT_COAL);
    setToolCoalesce(CLIENT_COAL, "get-item", { enabled: true });
    const { getCalls } = idEchoFetch();

    const [r1, r2] = await Promise.all([
      proxyToolCall(`${CLIENT_COAL}__get-item`, { id: "1" }),
      proxyToolCall(`${CLIENT_COAL}__get-item`, { id: "1" }),
    ]);
    expect(getCalls()).toBe(1);
    expect(r1.content[0].text).toBe(r2.content[0].text);
  });

  test("REST POST tool with coalescing enabled is NOT coalesced (kills L674 method-part / &&->|| mutants)", async () => {
    await reg(CLIENT_COAL, [makeTool({ name: "post-item", method: "POST", endpoint: "/item" })]);
    setToolCoalesce(CLIENT_COAL, "post-item", { enabled: true });
    const { getCalls } = idEchoFetch();

    await Promise.all([
      proxyToolCall(`${CLIENT_COAL}__post-item`, { id: "1" }),
      proxyToolCall(`${CLIENT_COAL}__post-item`, { id: "1" }),
    ]);
    expect(getCalls()).toBe(2);
  });

  test("cache disabled but coalescing enabled: concurrent calls with DIFFERENT args are NOT coalesced together (kills L645 '' fallback StringLiteral and L676 '||' fallback mutants)", async () => {
    await reg(CLIENT_COAL);
    // No setToolCacheConfig call at all — cacheCfg is null, responseCacheEnabled
    // is false, so responseCacheKey falls back to "" (L645). Real code: the
    // coalesceKey OR-fallback (L676) then recomputes a fresh, args-scoped
    // cacheKey(...) since "" is falsy — so id:"1" and id:"2" get DISTINCT
    // coalesce keys and are dispatched independently.
    setToolCoalesce(CLIENT_COAL, "get-item", { enabled: true });
    const { getCalls } = idEchoFetch();

    const [r1, r2] = await Promise.all([
      proxyToolCall(`${CLIENT_COAL}__get-item`, { id: "1" }),
      proxyToolCall(`${CLIENT_COAL}__get-item`, { id: "2" }),
    ]);
    expect(getCalls()).toBe(2);
    expect((JSON.parse(r1.content[0].text ?? "") as { id: string }).id).toBe("1");
    expect((JSON.parse(r2.content[0].text ?? "") as { id: string }).id).toBe("2");
  });

  test("coalescing disabled entirely: two concurrent identical GET calls are NOT coalesced (sanity check for the coalesceCfg?.enabled gate)", async () => {
    await reg(CLIENT_COAL);
    // No setToolCoalesce call — coalescing stays off for this tool.
    const { getCalls } = idEchoFetch();

    await Promise.all([
      proxyToolCall(`${CLIENT_COAL}__get-item`, { id: "1" }),
      proxyToolCall(`${CLIENT_COAL}__get-item`, { id: "1" }),
    ]);
    expect(getCalls()).toBe(2);
  });

  // NOTE — equivalent mutant, verified by static analysis (not runtime
  // mutation — src/proxy/proxy.ts must not be edited, per this suite's
  // constraints): L674 ConditionalExpression `client.kind === "rest"` ->
  // `true` (id 498 in the mutation report; this is ONLY the first half of the
  // '&&', forced true in isolation — distinct from the other L674 sub-mutants
  // above/below it, which the existing POST-tool test already kills: id 499
  // EqualityOperator, id 500 StringLiteral, id 502 EqualityOperator, id 503
  // MethodExpression, id 504 StringLiteral, id 495-497/501 ConditionalExpression
  // /LogicalOperator on the compound expression — all "Killed").
  //
  // First attempt: an MCP-kind client with an 'always' coalesce config, spying
  // on getToolCoalesce and asserting it's never called (real code: `kind !==
  // "rest"` short-circuits the '&&' before ever touching `tool.method`).
  // Investigated whether this genuinely distinguishes the mutant before
  // committing to it as a test, by reading how MCP-kind tools are actually
  // persisted: `Registry.registerMcp()` -> `RegistryPersistence.
  // persistMcpRegistration()` (src/mcp/registry-persistence.ts) hardcodes
  // `method: "POST"` for every MCP-kind tool, unconditionally, on every
  // registration AND every re-registration (`ON CONFLICT ... method =
  // excluded.method`, and `excluded.method` is itself always `'POST'` from
  // the same INSERT's literal values) — never read from the discovered tool,
  // never overridable (grep across src/ for `SET method` / `kind: "mcp"` /
  // `UpstreamKind` confirms exactly one write site for `kind`, and zero write
  // sites for an MCP tool's `method` other than this hardcoded `'POST'`; the
  // type itself is `UpstreamKind = "rest" | "mcp"`, only two values, and there
  // is no test-only backdoor in registry.ts to inject a synthetic client/tool
  // pair bypassing registerMcp()/register()). So for EVERY MCP-kind tool
  // reachable through the public API, `tool.method.toUpperCase() === "GET"`
  // is always `false` — meaning the mutant's `true && tool.method.
  // toUpperCase() === "GET"` and the real code's `false && ...`
  // (short-circuited) are behaviourally identical for every MCP-kind call: a
  // spy-based "getToolCoalesce not called" test would show NOT called under
  // BOTH the real code (never evaluated) AND the mutant (evaluated, but
  // `"POST" === "GET"` is false, so the `&&` still yields false and the outer
  // ternary still picks the `null` branch) — i.e. it would falsely appear to
  // "pass" as a kill without actually discriminating the two. Built and ran
  // this test to confirm before deciding whether to keep it: it does pass,
  // but per the above it is not evidence of a kill, only evidence that
  // MCP-kind dispatch doesn't crash — so it was removed rather than kept with
  // a misleading kill claim. Since `client.kind === "rest"` can only ever be
  // forced true for clients where it already IS true (REST clients — a no-op
  // for the mutant) or clients where the OTHER side of the `&&` is
  // structurally guaranteed false regardless (MCP clients — `method` can
  // never be "GET"), there is no reachable state, through the public
  // proxyToolCall API, where this specific sub-mutant changes observable
  // behaviour. Equivalent.
});

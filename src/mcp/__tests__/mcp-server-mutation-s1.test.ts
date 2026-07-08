/**
 * Stryker mutation-testing backstop for src/mcp/mcp-server.ts — CLUSTER S1
 * ONLY: the header-parsing helpers (`extractBearerFromHeader`,
 * `extractEndUserId`, `extraHeaders`, `callerTokenFromExtra`, source
 * ~L46-68), `scopedToolList`'s bundle-composite loop (~L77-91), and
 * `mcpParamsForScope` (~L99-110). Other clusters of this same file (tools/list
 * search-tool branch, tools/call's system/client/bundle gates, the
 * ListResourcesRequestSchema/etc. HANDLER bodies + notifyToolsChanged, etc.)
 * are covered by sibling `mcp-server-mutation-s*.test.ts` files written by
 * other agents in this series (see e.g. mcp-server-mutation-s3.test.ts,
 * mcp-server-mutation-s5.test.ts) — this file adds exactly ONE new test file
 * so those parallel passes never conflict on the same path. mcp-server.ts
 * itself is NOT modified (file under test).
 *
 * NOTE ON OVERLAP WITH S5: mcp-server-mutation-s5.test.ts's "available scope"
 * test (a single enabled MCP-kind client, real upstream data round-tripped)
 * incidentally already kills L100's ConditionalExpression("true")/StringLiteral
 * ("client"->"") mutants — forcing that guard to unconditionally return null
 * (or forcing the string comparison to always be true) would make S5's
 * client-scope success case wrongly degrade to the empty/"unavailable" shape.
 * This file therefore does NOT re-test L100 in isolation (would be pure
 * duplication); it focuses on the mcpParamsForScope internals S5's simpler
 * single-client setup structurally cannot reach: the confused-deputy `.find()`
 * equality (L101, needs TWO differently-kinded clients), the three distinct
 * reasons L102's guard returns null (no client / REST-kind / disabled MCP-kind
 * — S5 only exercises "no client" via a non-"client" scope, never a
 * REST-kind-or-disabled *client-scoped* session), and L103/105/106/108 (the
 * returned object's exact field values — mcpUrl-over-base_url preference,
 * the "streamable-http" transport default, and authHeaders — all of which
 * are invisible to S5's test because `registry.registerMcp()` always sets
 * `base_url` equal to `mcpUrl` and always requires an explicit `transport`
 * argument, so those fields can never actually diverge through the public
 * registration API; see the "internals" test below for how this file works
 * around that).
 *
 * TWO HARNESSES, per the task's split:
 *   - HEADER-DEPENDENT (extractBearerFromHeader's exact token slice,
 *     extractEndUserId's exact string passthrough) need a REAL caller
 *     Authorization/X-End-User-Id header reaching `extra.requestInfo.headers`,
 *     which bare InMemoryTransport never populates (only `authInfo`, never
 *     `requestInfo` — see node_modules/@modelcontextprotocol/sdk's
 *     dist/esm/inMemory.js). These boot a real Express app via
 *     setupTransports() and drive it with real fetch(), copying the
 *     reg()/initSession()/parseSseJson() idioms from transports-sharded.test.ts
 *     / transports-bundle.test.ts verbatim.
 *   - STRUCTURAL (scope-membership, bundle-composite iteration,
 *     mcpParamsForScope's client-lookup/guard logic) uses the lightweight
 *     InMemoryTransport Client<->Server harness the task describes — no HTTP
 *     needed since none of it depends on header values.
 *
 * TECHNIQUE — reaching past registry.ts's private `clients` Map: the
 * mcpUrl-vs-base_url (L105) and default-transport (L106) mutants require a
 * live "mcp"-kind, enabled client whose `mcpUrl`/`base_url` fields actually
 * differ and whose `mcpTransport` is genuinely omitted. There is no public
 * registry API that can produce this — `registerMcp()` unconditionally does
 * `base_url: mcpUrl` (see registry.ts's persistMcpRegistration call site) and
 * requires a non-optional `transport` argument, so both fields are always
 * forced in lockstep through every real registration path. This file reaches
 * past that (TypeScript-only) privacy with a cast, the same "reach past TS
 * privacy to the real runtime shape" pattern already used by
 * mcp-upstream-mutation.test.ts for SDK transport internals — inserting a
 * `RegisteredClient` object directly into the live Map so the two fields can
 * genuinely diverge, then observing what `mcpParamsForScope` actually builds
 * from it via a capturing `mcpUpstream.__setTransportFactoryForTesting()`
 * factory (the same "install a fake transport factory on the shared pool"
 * technique proxy-mcp-dispatch.test.ts and mcp-server-mutation-s5.test.ts
 * already use, just capturing the received `McpConnParams` instead of only
 * serving fake data through it).
 *
 * EQUIVALENT-COVERAGE NOTE (not a true equivalent mutant, just documented
 * per house convention rather than silently dropped): the "bundle with ZERO
 * composites doesn't throw" test below (L83's `?? []` -> `&& []` mutant)
 * does NOT actually kill 83:33-83:70. `getBundleComposites()` can only ever
 * return `undefined` when the bundle itself doesn't exist in `liveBundles`
 * (see bundles.ts) — but scopedToolList's bundle branch already returned `[]`
 * three lines earlier via `isBundleEnabled()` in that exact case, so by the
 * time L83's `?? []` runs, `getBundleComposites(scope.name)` is GUARANTEED to
 * be a real (possibly empty) `Set` object, never `undefined` — a `Set`
 * instance is always truthy regardless of its size. So `X ?? []` (real) and
 * `X && []` (mutant) only diverge when `X` is a NON-EMPTY Set: `?? []`
 * returns `X` itself (iterates the real composite names); `&& []` evaluates
 * the truthy left operand and returns the literal `[]` on the right (iterates
 * nothing, silently dropping every composite regardless of how many there
 * are). A zero-composite bundle can't distinguish these — both produce zero
 * iterations either way. The "bundle WITH a real composite" test below is
 * the one that actually kills 83:33-83:70 (verified by the reasoning above,
 * not just asserted); the zero-composites test is kept anyway because the
 * task explicitly asks for it and it is still a genuine no-crash regression
 * check (confirms the fallback path — whichever one is live — never throws).
 *
 * GENUINE EQUIVALENT MUTANTS (verified after a verify1 Stryker run against
 * this cluster's first pass — documented per house convention, not dropped):
 *
 *   - 82:62-82:64 ArrayDeclaration (`keys ? registry.getMcpToolsForKeys(keys)
 *     : []` -> `: ["Stryker was here"]`) is unreachable for the SAME root
 *     cause as the 83:33-83:70 discussion above, one line earlier: `keys`
 *     (`getBundleToolKeys(scope.name)`) reads the identical `liveBundles`
 *     cache entry as `isBundleEnabled()`, which already gated this whole
 *     branch three lines earlier. Once `isBundleEnabled(name)` is true, that
 *     cache entry — and therefore `keys` — is GUARANTEED to be a real
 *     (possibly empty) `Set` object, never `undefined`; an empty `Set` is
 *     still a truthy object reference in JS, so the ternary's `: []` branch
 *     can never actually fire. Unlike 83:33-83:70 (which a NON-empty
 *     composites Set genuinely distinguishes), there is no analogous
 *     "non-empty vs. mutant" distinction available here — `keys ? X : []`'s
 *     two branches only diverge on `keys`'s truthiness, which is exactly
 *     the part that's unreachable, not on its contents.
 *   - 178:102-178:107 BooleanLiteral and 179:45-179:54 OptionalChaining
 *     (both inside the CallToolRequestSchema handler's bundle branch, ~L177-
 *     179 — see mcp-server-mutation-s3.test.ts for that branch's own
 *     detailed coverage) are equivalent for the identical reason, traced one
 *     level further: `isBundleComposite`'s value (which 178's `?? false`
 *     feeds into) is only ever externally observable at L179's `||` check
 *     and L190's `if (isBundleComposite)` — and BOTH of those are only
 *     reached after `!isBundleEnabled(scope.name)` has already evaluated to
 *     `false` earlier in the SAME `||`/gate, meaning the bundle is
 *     confirmed enabled+existing by the time either mutant's target value
 *     would matter. Same for 179's `keys?.has(name)`: it is the right
 *     operand of `!isBundleEnabled(...) || (...)`, only evaluated when the
 *     bundle is already confirmed enabled (short-circuit), at which point
 *     `keys` is guaranteed defined by the same cache invariant as 82 above.
 *     A hard-deleted bundle (`deleteBundle()` truly removes the
 *     `liveBundles` entry, unlike merely disabling one) was investigated as
 *     a way to reach these with `keys`/`getBundleComposites` genuinely
 *     `undefined` — it does make the LEFT-HAND values `undefined`, but the
 *     surrounding `!isBundleEnabled(...) ||` and `if (isBundleComposite)`
 *     gates independently already reject the call for the SAME deleted-
 *     bundle reason before either mutant's specific fallback value can ever
 *     be observed.
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
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { registry } from "../../mcp/registry.js";
import { createMcpServer, type McpServerScope } from "../../mcp/mcp-server.js";
import { mcpUpstream, buildTransport, type McpConnParams } from "../../mcp/mcp-upstream.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { initBundles, createBundle } from "../../admin/tool-composition/bundles.js";
import { initComposites, createComposite, updateComposite } from "../../admin/tool-composition/composites.js";
import { createConsumer } from "../../admin/entities/consumers.js";
import { createMcpKey } from "../../security/mcp-key-store.js";
import { setUpstreamAuth, clearUpstreamAuth } from "../../backend-auth/upstream-auth.js";
import { withConfig } from "../../__tests__/_utils/with-config.js";
import type { RestToolDefinition, RegisteredClient } from "../../mcp/types.js";

// ===========================================================================
// Shared fixtures
// ===========================================================================

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

async function reg(name: string, tools: RestToolDefinition[] = [makeTool()]): Promise<void> {
  await registry.register(name, tools, "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

/** Lightweight harness — exactly the idiom the task describes. */
async function connectClient(scope: McpServerScope): Promise<{ client: Client; server: Server }> {
  const server = createMcpServer(scope);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "s1-test-client", version: "1.0" }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  initBundles();
  initComposites();
  globalThis.fetch = originalFetch;
});

afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  globalThis.fetch = originalFetch;
});

// ===========================================================================
// HEADER-DEPENDENT — real HTTP harness (real Authorization / X-End-User-Id
// header values reaching extra.requestInfo.headers).
// ===========================================================================

describe("header-dependent helpers (real HTTP — InMemoryTransport cannot carry extra.requestInfo)", () => {
  let baseUrl = "";
  let activeServer: HttpServer | null = null;
  let cleanupFn: (() => void) | null = null;

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

  function parseSseJson(text: string): { result?: unknown; error?: unknown; id?: unknown } {
    const match = text.match(/data: (.+)/);
    if (!match) throw new Error(`Could not parse SSE body: ${text}`);
    return JSON.parse(match[1]);
  }

  async function initSession(path: string, extraHeaders: Record<string, string> = {}): Promise<string | null> {
    const initRes = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...extraHeaders },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "s1-test", version: "1.0" } },
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
        ...extraHeaders,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    return sessionId;
  }

  async function toolsList(
    path: string,
    sessionId: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body?: { tools: { name: string }[] } }> {
    const res = await fetch(`${baseUrl}${path}`, {
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

  async function toolsCall(
    path: string,
    sessionId: string,
    toolName: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body?: { isError?: boolean; content?: { type: string; text: string }[] } }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
        ...extraHeaders,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 3, params: { name: toolName, arguments: {} } }),
    });
    if (res.status !== 200) return { status: res.status };
    const parsed = parseSseJson(await res.text());
    return {
      status: res.status,
      body: parsed.result as { isError?: boolean; content?: { type: string; text: string }[] },
    };
  }

  afterEach(async () => {
    await stopApp();
  });

  // 49:10-49:32 MethodExpression [Survived] "header.slice(7)" —
  // extractBearerFromHeader's token-extraction slice, re-derived fresh inside
  // the tools/list handler (callerTokenFromExtra) on every call, independent
  // of whatever the Express-level rootMcpAuth middleware already validated
  // with its OWN (unmutated) bearer-extraction function. A wrong slice
  // offset here produces a token that doesn't safeCompare-equal
  // config.adminApiKeys's real value, so resolveSystemRole (called a second
  // time, inside the handler) fails and system tools silently vanish from
  // tools/list even though the request was otherwise let through.
  test("system-scope tools/list resolves the real role from a correctly-sliced 'Bearer <token>' header", async () => {
    await withConfig({ adminApiKeys: ["s1-root-admin-key"] }, async () => {
      await startApp();
      const authHeader = { Authorization: "Bearer s1-root-admin-key" };
      const sessionId = await initSession("/mcp", authHeader);
      expect(sessionId).not.toBeNull();
      const list = await toolsList("/mcp", sessionId!, authHeader);
      expect(list.status).toBe(200);
      const names = list.body?.tools.map((t) => t.name) ?? [];
      // Any wrong slice() offset (too few/many chars trimmed) yields a token
      // that isn't exactly "s1-root-admin-key", so resolveSystemRole would
      // fail and this list would be empty instead.
      expect(names).toContain("sys_list_clients");
    });
  });

  // 55:28-55:36 StringLiteral [Survived] ("string" -> "") on
  // extractEndUserId's `typeof header === "string"` check. Mutating the
  // string literal makes the comparison permanently false (typeof never
  // equals ""), so extractEndUserId would ALWAYS return undefined regardless
  // of the real header value — collapsing every caller's asserted identity
  // to the SAME "no identity" bucket. Proven via a real, externally
  // observable proxyToolCall side effect keyed off the exact endUserId
  // string: per-end-user rate limiting (src/admin/entities/consumers.ts),
  // which only fires when a consumer has opted in AND the caller actually
  // asserts a non-blank identity distinguishable from another caller's.
  //
  // EQUIVALENT (seen in a later verify run): 55:10-55:36 ConditionalExpression
  // ("true") forces the ternary's CONDITION itself (not just the "string"
  // literal above) to always take the true-branch, returning `header`
  // unconditionally instead of `typeof header === "string" ? header :
  // undefined`. Same reasoning as transports.ts's documented 18:10
  // isValidSessionId equivalent: `header` (after the preceding
  // `Array.isArray(value) ? value[0] : value` unwrap) is always `string |
  // undefined` for a real HTTP request — Node only arrayifies a small
  // hardcoded set of header names (set-cookie, etc.), and "x-end-user-id"
  // isn't one of them. So `header` is either a real string (both real code
  // and the forced-true mutant return that SAME string) or `undefined`
  // (real code's false-branch explicitly returns `undefined`; the
  // forced-true mutant returns `header` itself, which is ALSO `undefined`
  // in that case) — the two branches are only reachable with values that
  // make them produce an identical result either way.
  test("x-end-user-id header value reaches proxyToolCall's endUserId, rate-limiting exactly the asserted identity (not a blank/constant placeholder)", async () => {
    await reg("s1-svc", [makeTool({ name: "get-users" })]);
    const consumer = createConsumer({ name: "s1-team", monthlyQuota: null, endUserRateLimitPerMin: 2, actor: null });
    const { rawKey } = createMcpKey("s1-key", null, null, null, consumer.id);
    // Mock only the OUTBOUND backend call (proxy.ts's fetch to the pinned
    // "s1-svc" upstream) -- our own test client's real HTTP calls to the
    // local Express app (`baseUrl`, set once startApp() below resolves) must
    // still go through the real fetch, or the harness can't drive the
    // server at all.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (baseUrl && url.startsWith(baseUrl)) return originalFetch(input, init);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await startApp();
    const authHeader = { Authorization: `Bearer ${rawKey}` };
    const sessionId = await initSession("/mcp/s1-svc", authHeader);
    expect(sessionId).not.toBeNull();

    const aliceHeaders = { ...authHeader, "x-end-user-id": "alice" };
    const r1 = await toolsCall("/mcp/s1-svc", sessionId!, "s1-svc__get-users", aliceHeaders);
    expect(r1.body?.isError).toBeUndefined();
    const r2 = await toolsCall("/mcp/s1-svc", sessionId!, "s1-svc__get-users", aliceHeaders);
    expect(r2.body?.isError).toBeUndefined();
    const r3 = await toolsCall("/mcp/s1-svc", sessionId!, "s1-svc__get-users", aliceHeaders);
    expect(r3.body?.isError).toBe(true);
    expect(r3.body?.content?.[0]?.text.toLowerCase()).toContain("end-user rate limit");

    // A DIFFERENTLY-VALUED header must be unaffected. Under the mutant,
    // extractEndUserId always returns undefined, so resolveEndUserId's
    // header-argument would always be undefined for BOTH "alice" and "bob" —
    // with no `__end_user` arg present either, resolveEndUserId returns
    // `null` and the whole rate-limit check is skipped entirely, meaning
    // "alice"'s 3rd call above would NOT have been blocked either (already
    // caught above) — this second assertion additionally confirms "bob" is
    // tracked as a genuinely separate bucket from "alice", not merely that
    // rate limiting fires at all.
    const bobHeaders = { ...authHeader, "x-end-user-id": "bob" };
    const r4 = await toolsCall("/mcp/s1-svc", sessionId!, "s1-svc__get-users", bobHeaders);
    expect(r4.body?.isError).toBeUndefined();
  });
});

// ===========================================================================
// STRUCTURAL — scopedToolList's bundle-composite loop (L77-91).
// ===========================================================================

describe("scopedToolList — bundle composites (L83, L85)", () => {
  test("a bundle with zero composites does not throw and advertises only its plain tools (see file-header EQUIVALENT-COVERAGE note — this does not by itself kill 83:33-83:70)", async () => {
    await reg("s1-c1", [makeTool({ name: "t1" })]);
    await createBundle("s1-nocomposites", undefined, [{ client: "s1-c1", tool: "t1" }], "test");

    const { client, server } = await connectClient({ kind: "bundle", name: "s1-nocomposites" });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).filter((n) => n !== "search_tools")).toEqual(["s1-c1__t1"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  // 83:33-83:70 LogicalOperator ("?? []" -> "&& []"), 83:72-86:6
  // BlockStatement (for-loop body emptied), 85:11-85:14 ConditionalExpression
  // "false" direction ("if (def) tools.push(def)" forced never-to-push).
  test("a bundle with a real enabled composite advertises it alongside its plain tools", async () => {
    await reg("s1-compdep", [makeTool({ name: "dep-tool" })]);
    const created = await createComposite(
      "s1-mycomp",
      "does a thing",
      { type: "object", properties: {} },
      [{ targetClient: "s1-compdep", targetTool: "dep-tool", argsTemplate: {} }],
      "test",
    );
    expect(created.ok).toBe(true);
    await createBundle("s1-withcomposite", undefined, [{ client: "s1-compdep", tool: "dep-tool" }], "test", [
      "s1-mycomp",
    ]);

    const { client, server } = await connectClient({ kind: "bundle", name: "s1-withcomposite" });
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).filter((n) => n !== "search_tools");
      expect(names.sort()).toEqual(["s1-compdep__dep-tool", "s1-mycomp"]);
      const compositeDef = tools.find((t) => t.name === "s1-mycomp");
      expect(compositeDef?.description).toBe("does a thing");
    } finally {
      await client.close();
      await server.close();
    }
  });

  // 85:11-85:14 ConditionalExpression "true" direction ("if (def)" forced to
  // unconditionally push, even when getAdvertisedComposite() returns
  // undefined for a disabled composite). Under the mutant, tools.push(undefined)
  // would run, producing a malformed tools/list entry that fails the SDK's
  // response-schema validation on the client side (a Tool object cannot be
  // undefined) — real code must instead silently skip it.
  test("a bundle referencing a DISABLED composite excludes it (does not push a bogus entry) without throwing", async () => {
    await reg("s1-compdep2", [makeTool({ name: "dep-tool" })]);
    await createComposite(
      "s1-mycomp2",
      "disabled one",
      { type: "object", properties: {} },
      [{ targetClient: "s1-compdep2", targetTool: "dep-tool", argsTemplate: {} }],
      "test",
    );
    await updateComposite("s1-mycomp2", { enabled: false });
    await createBundle("s1-withdisabledcomposite", undefined, [{ client: "s1-compdep2", tool: "dep-tool" }], "test", [
      "s1-mycomp2",
    ]);

    const { client, server } = await connectClient({ kind: "bundle", name: "s1-withdisabledcomposite" });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).filter((n) => n !== "search_tools")).toEqual(["s1-compdep2__dep-tool"]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// ===========================================================================
// STRUCTURAL — mcpParamsForScope (L99-110), via resources/prompts
// passthrough. A generic working transport factory is installed for this
// whole block so that IF a mutant wrongly makes mcpParamsForScope non-null
// for a scope/client that must be "unavailable", the divergence is actually
// OBSERVABLE (a real, distinguishable non-empty result) instead of silently
// looking like "[]" again via an unrelated real-network failure.
// ===========================================================================

describe("mcpParamsForScope — resources/prompts passthrough (L99-110)", () => {
  function genericFactory(_p: McpConnParams): Transport {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = new Server(
      { name: "s1-generic-upstream", version: "1.0.0" },
      { capabilities: { resources: {}, prompts: {} } },
    );
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [{ uri: "mem://s1-generic", name: "Generic" }],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
      contents: [{ uri: req.params.uri, text: "generic-content" }],
    }));
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: "generic-prompt" }] }));
    server.setRequestHandler(GetPromptRequestSchema, async () => ({
      messages: [{ role: "user", content: { type: "text", text: "generic" } }],
    }));
    void server.connect(serverT);
    return clientT;
  }

  const TOUCHED_NAMES = [
    "s1-ghost",
    "s1-restonly",
    "s1-mcpdisabled",
    "s1-target",
    "s1-other",
    "s1-mcp-client",
    "s1-collide",
    "s1-first",
    "s1-second",
  ];

  beforeEach(() => {
    mcpUpstream.__setTransportFactoryForTesting(genericFactory);
  });

  afterEach(async () => {
    for (const n of TOUCHED_NAMES) await mcpUpstream.disconnect(n);
    mcpUpstream.__setTransportFactoryForTesting(buildTransport);
    clearUpstreamAuth("s1-mcp-client");
  });

  // 100:7-100:30 ConditionalExpression ("true") / 100:22-100:30 StringLiteral
  // ("client" -> "") — already killed by mcp-server-mutation-s5.test.ts's
  // "available scope" positive test (forcing this guard to always fire, for
  // EVERY scope kind including "client", would break that test's real-upstream
  // round trip). Included here only for the bundle-scope half of the task's
  // explicit "system AND bundle" ask; a bundle scope hits the exact same
  // `scope.kind !== "client"` comparison as system scope, so this adds no
  // additional kill beyond what's already proven, and is kept cheap.
  test("a bundle-scoped session's resources/prompts are the unavailable shape, same as any non-'client' scope", async () => {
    const { client, server } = await connectClient({ kind: "bundle", name: "s1-anybundle" });
    try {
      expect((await client.listResources()).resources).toEqual([]);
      expect((await client.listPrompts()).prompts).toEqual([]);
      await expect(client.readResource({ uri: "x://y" })).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
    }
  });

  // 102:7-102:39 — sub-case (a): no client registered under this name at all.
  test("client scope naming a client that was never registered is unavailable", async () => {
    const { client, server } = await connectClient({ kind: "client", name: "s1-ghost" });
    try {
      expect((await client.listResources()).resources).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  // 101:53-101:74 EqualityOperator ("===" -> "!=="), which would flip
  // `.find((c) => c.name === scope.name)` into "find any OTHER client" —
  // confused-deputy on the resources/prompts passthrough path, mirroring the
  // tools/call exact-membership defense elsewhere in this file. "s1-target"
  // is REST-kind (so real code's `.find()` result — whichever it finds — must
  // still yield null via the kind check at L102, this ALSO independently
  // covers 102's sub-case (b), a REST-kind client). "s1-other" is a live,
  // enabled MCP-kind client the mutant would wrongly select instead: under
  // the flipped comparison, `.find(c => c.name !== "s1-target")` returns
  // "s1-other" (the only OTHER registered client), which passes L102's kind
  // check, so mcpParamsForScope would build real, non-null params for the
  // WRONG upstream — reachable via the shared genericFactory above (which
  // ignores which client name it was asked to connect as), turning "resources
  // unavailable" into "resources leak through from a different client".
  test("client scope resolves the SAME-NAMED client, not a differently-kinded other one that happens to also be registered", async () => {
    await reg("s1-target"); // REST-kind
    await registry.registerMcp("s1-other", [], "http://s1-other.test/mcp", "streamable-http", "127.0.0.1", "127.0.0.1"); // MCP-kind, enabled

    const { client, server } = await connectClient({ kind: "client", name: "s1-target" });
    try {
      expect((await client.listResources()).resources).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  // 102:7-102:39 — sub-case (c): a live MCP-kind client that is currently
  // disabled.
  test("client scope naming a disabled MCP-kind client is unavailable", async () => {
    await registry.registerMcp(
      "s1-mcpdisabled",
      [],
      "http://s1-mcpdisabled.test/mcp",
      "streamable-http",
      "127.0.0.1",
      "127.0.0.1",
    );
    await registry.setClientEnabled("s1-mcpdisabled", false);

    const { client, server } = await connectClient({ kind: "client", name: "s1-mcpdisabled" });
    try {
      expect((await client.listResources()).resources).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  // 102:7-102:39 sub-case (d) positive control + 103:10-109:4 ObjectLiteral
  // (whole returned object emptied to `{}`) + 105:10-105:42 LogicalOperator
  // ("client.mcpUrl ?? client.base_url" -> "&&") + 106:39-106:56 StringLiteral
  // (the "streamable-http" default emptied to "") + 108:18-108:66
  // LogicalOperator ("getUpstreamAuthHeaders(...) ?? undefined" -> "&&
  // undefined"). One client, inserted directly into registry's live `clients`
  // Map (see file header) so mcpUrl/base_url can genuinely diverge and
  // mcpTransport can be genuinely omitted — impossible through the public
  // registerMcp() API. A capturing transport factory observes exactly the
  // McpConnParams mcpParamsForScope actually built.
  test("an enabled, MCP-kind client scope builds the real McpConnParams — correct url (mcpUrl over base_url), default transport, and real authHeaders", async () => {
    const CORRECT_URL = "http://s1-correct-upstream.test/mcp";
    const WRONG_URL = "http://s1-wrong-base.test/base";
    // registerMcp() through the public API first, so the `clients` DB row
    // exists (client_upstream_auth.client_name below is FK-constrained on
    // it) — it always sets base_url === mcpUrl and always sets mcpTransport,
    // so the live in-memory object is then hand-edited (not re-inserted) to
    // diverge base_url from mcpUrl and to genuinely omit mcpTransport, which
    // is exactly the "reach past TS privacy to the real runtime shape"
    // technique described in the file header — registerMcp's own DB
    // persistence is untouched, only this one live object's fields differ
    // from what it originally wrote.
    await registry.registerMcp("s1-mcp-client", [], CORRECT_URL, "streamable-http", "127.0.0.1", "127.0.0.1");
    const liveClient = (registry as unknown as { clients: Map<string, RegisteredClient> }).clients.get(
      "s1-mcp-client",
    )!;
    liveClient.base_url = WRONG_URL; // deliberately different from mcpUrl now
    delete (liveClient as { mcpTransport?: unknown }).mcpTransport; // must fall back to the "streamable-http" default

    // setUpstreamAuth (encrypt-at-write) and the later resources fetch
    // (decrypt-at-read, inside getUpstreamAuthHeaders) both need a real
    // secret-box key configured -- unset by default in the test environment
    // (see security/secret-box.test.ts's own "throws when unconfigured"
    // coverage), so this whole exchange runs under a scoped override.
    await withConfig({ secretEncryptionKey: "s1-test-secret-encryption-key-32b" }, async () => {
      setUpstreamAuth("s1-mcp-client", "bearer", { token: "s1-upstream-secret" }, null);

      let captured: McpConnParams | undefined;
      mcpUpstream.__setTransportFactoryForTesting((p: McpConnParams): Transport => {
        captured = p;
        return genericFactory(p);
      });

      const { client, server } = await connectClient({ kind: "client", name: "s1-mcp-client" });
      try {
        const resources = await client.listResources();
        // Non-empty proves p was non-null AND the connection actually reached
        // the (generic, always-succeeding) factory — the ObjectLiteral-emptied
        // mutant alone wouldn't fail this specific assertion (the factory
        // ignores its input), which is exactly why the field-level assertions
        // below, not this one, are what carries 103/105/106/108.
        expect(resources.resources).toEqual([{ uri: "mem://s1-generic", name: "Generic" }]);

        expect(captured).toBeDefined();
        expect(captured?.name).toBe("s1-mcp-client");
        // 105: real code must prefer mcpUrl; under "&&" with a truthy mcpUrl,
        // the wrong value (base_url) would be selected instead.
        expect(captured?.url).toBe(CORRECT_URL);
        expect(captured?.url).not.toBe(WRONG_URL);
        // 106: mcpTransport was omitted -- must fall back to this exact default.
        expect(captured?.transport).toBe("streamable-http");
        // 108: a real, non-null upstream credential must reach authHeaders
        // as-is, not be discarded to undefined.
        expect(captured?.authHeaders).toEqual({ Authorization: "Bearer s1-upstream-secret" });
        // Sanity companion to 103 (not independently cited): resolvedIp too.
        expect(captured?.resolvedIp).toBe("127.0.0.1");
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  // 100:7-100:30 ConditionalExpression [Survived] "false" — the OTHER
  // direction of this same guard, NOT the "true" direction discussed above
  // (which is genuinely already killed by s5's positive test). Forcing the
  // guard to "false" means "if (scope.kind !== \"client\") return null;"
  // NEVER fires, for ANY scope kind. For an actual client scope this is a
  // no-op (the real condition is already false there), so the divergence is
  // only observable for a NON-client scope — and only THEN if it also
  // reaches something a real client scope's own resources could match. The
  // existing bundle-scope test above ("s1-anybundle") does NOT distinguish
  // this: no client happens to share that bundle's name, so `.find()`
  // returns undefined regardless of whether the early-return ran, and both
  // real code and this mutant land on "null" via different routes. The
  // genuine gap is a NAME COLLISION: a bundle and a client sharing the
  // exact same name, where the client is a live, enabled MCP-kind one the
  // mutant would wrongly resolve into for a BUNDLE-scoped session.
  test("a bundle scope does not leak resources through a same-named MCP-kind client (100:7-100:30 'false' direction)", async () => {
    await registry.registerMcp(
      "s1-collide",
      [],
      "http://s1-collide.test/mcp",
      "streamable-http",
      "127.0.0.1",
      "127.0.0.1",
    );
    const { client, server } = await connectClient({ kind: "bundle", name: "s1-collide" });
    try {
      // Under the real guard, scope.kind !== "client" short-circuits before
      // the client .find() ever runs, so the same-named client is never
      // considered — resources/prompts must stay the "unavailable" shape
      // even though a live, enabled, MCP-kind client of the identical name
      // genuinely exists in the registry.
      expect((await client.listResources()).resources).toEqual([]);
      expect((await client.listPrompts()).prompts).toEqual([]);
      await expect(client.readResource({ uri: "x://y" })).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
      await registry.unregister("s1-collide");
    }
  });

  // 101:53-101:74 ConditionalExpression [Survived] "true" — forces
  // ".find((c) => c.name === scope.name)" to always match, returning the
  // FIRST client in registry.listClients() regardless of name. The existing
  // "SAME-NAMED client" test above does NOT distinguish this direction: it
  // registers "s1-target" BEFORE "s1-other", so an "always match the first
  // one" mutant would coincidentally also land on "s1-target" (the correct
  // answer, just for the wrong reason) — same outcome as real code. To
  // distinguish, the WRONG (first-registered) client must itself be a live,
  // enabled MCP-kind client too, registered BEFORE the real target, so the
  // "always true" mutant demonstrably resolves to the WRONG upstream.
  test("client scope resolves the correctly-NAMED client even when a different, earlier-registered MCP-kind client exists (101:53-101:74 'true' direction)", async () => {
    // Registered FIRST — an "always match" mutant would wrongly select this one.
    await registry.registerMcp("s1-first", [], "http://s1-first.test/mcp", "streamable-http", "127.0.0.1", "127.0.0.1");
    // The real target, registered SECOND, with a distinguishable URL.
    const TARGET_URL = "http://s1-second-real-target.test/mcp";
    await registry.registerMcp("s1-second", [], TARGET_URL, "streamable-http", "127.0.0.1", "127.0.0.1");

    let captured: McpConnParams | undefined;
    mcpUpstream.__setTransportFactoryForTesting((p: McpConnParams): Transport => {
      captured = p;
      return genericFactory(p);
    });

    const { client, server } = await connectClient({ kind: "client", name: "s1-second" });
    try {
      await client.listResources();
      expect(captured).toBeDefined();
      expect(captured?.name).toBe("s1-second");
      expect(captured?.url).toBe(TARGET_URL);
    } finally {
      await client.close();
      await server.close();
      await registry.unregister("s1-first");
      await registry.unregister("s1-second");
    }
  });
});

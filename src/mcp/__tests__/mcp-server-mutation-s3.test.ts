/**
 * Stryker mutation-testing backstop for src/mcp/mcp-server.ts — CLUSTER S3
 * ONLY: `tools/call`'s client-scope confused-deputy check and bundle-scope
 * membership/composite-dispatch gate (source ~L160-193 as of this writing).
 * Other clusters of this same file (system-role gate, resources/prompts
 * passthrough, tools/list, header-dependent caller-token plumbing, etc.) are
 * covered by sibling `mcp-server-mutation-s*.test.ts` files written by other
 * agents in this series — this file adds exactly ONE new test file so those
 * parallel passes never conflict on the same path.
 *
 * mcp-server.ts itself is NOT modified (file under test). Every mutant cited
 * below is structural (scope-membership / bundle-composite logic) with no
 * dependency on real request headers, so the LIGHTWEIGHT InMemoryTransport
 * harness (Client <-> Server directly, see `connect()` below) is used
 * throughout — no real HTTP, matching this cluster's own instructions.
 * Registry/bundle/composite setup mirrors transports-sharded.test.ts /
 * transports-bundle.test.ts / composites.test.ts's own reg()/createBundle()/
 * createComposite() idioms; only the transport differs.
 *
 * EQUIVALENT MUTANT (documented per house convention rather than dropped):
 *   - 179:45-179:54 OptionalChaining (`keys?.has(name)` -> `keys.has(name)`,
 *     stripping the `?.`). `keys` (`getBundleToolKeys(scope.name)`) and
 *     `isBundleEnabled(scope.name)` are BOTH derived, independently, from the
 *     exact same `liveBundles.get(scope.name)` lookup (see bundles.ts):
 *       getBundleToolKeys  = liveBundles.get(name)?.toolKeys
 *       isBundleEnabled    = liveBundles.get(name)?.enabled === true
 *     `LiveBundle.toolKeys` is typed as a plain `Set<string>` — every code
 *     path that creates or updates a live bundle entry (createBundle,
 *     updateBundle, initBundles/reloadLiveCache) always assigns it a real
 *     `Set` (`new Set(...)`), NEVER `undefined`. So `keys` can only be
 *     `undefined` when `liveBundles.get(scope.name)` itself is `undefined`
 *     (the bundle doesn't exist) — and in that exact same case
 *     `isBundleEnabled(scope.name)` is unconditionally `false` too (an
 *     undefined entry can't have `.enabled === true`). Both reads happen
 *     synchronously with no `await` between them (L177 and L179), so the map
 *     cannot mutate in between within one request. The guard is
 *     `if (!isBundleEnabled(...) || (!keys?.has(name) && ...))` — whenever
 *     `keys` is `undefined`, `!isBundleEnabled(...)` is *already* `true`,
 *     which short-circuits the `||` before the right operand (containing
 *     `keys?.has`) is ever evaluated. There is therefore no reachable state
 *     where the stripped-`?.` mutant's `keys.has(...)` call could execute
 *     against a genuinely-undefined `keys` — verified by reading every
 *     mutation site in bundles.ts (createBundle/updateBundle/initBundles),
 *     none of which can produce an entry with `enabled: true` and
 *     `toolKeys: undefined`. Test F below empirically confirms the adjacent,
 *     genuinely-reachable sibling mutant at 178:56-178:92 (same `?.` pattern,
 *     but on `getBundleComposites`, which is NOT gated by `isBundleEnabled`
 *     the same way, since it's read unconditionally on L178 before the L179
 *     `if` even runs) and shows no throw there either, reinforcing that this
 *     file's whole guard chain is throw-safe by construction. Left
 *     undistinguished by design.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { createMcpServer, type McpServerScope } from "../../mcp/mcp-server.js";
import { initBundles, createBundle, updateBundle } from "../../admin/tool-composition/bundles.js";
import { initComposites, createComposite } from "../../admin/tool-composition/composites.js";
import type { RestToolDefinition } from "../../mcp/types.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function tool(name: string, properties: Record<string, unknown> = {}): RestToolDefinition {
  return {
    name,
    method: "POST",
    endpoint: `/${name}`,
    description: `tool ${name}`,
    inputSchema: { type: "object", properties },
  };
}

async function reg(name: string, tools: RestToolDefinition[]): Promise<void> {
  await registry.register(name, tools, "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

/** A fetch mock that ignores the URL and always succeeds with `body`, for tests that only care about success-vs-Unknown-tool, not the exact echoed payload. */
function okFetch(body: unknown = { ok: true }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

async function connect(scope: McpServerScope): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer(scope);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "s3-test-client", version: "1.0" }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function text(result: unknown): string | undefined {
  return (result as { content?: { text?: string }[] })?.content?.[0]?.text;
}

const OBJ_SCHEMA = { type: "object", properties: {} };

const CLIENT_NAMES = ["s3-acme", "s3-evil", "s3-widget", "s3-svc", "s3-other", "s3-chain"];

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  initComposites();
  initBundles();
  for (const n of CLIENT_NAMES) removeCircuitBreaker(n);
  globalThis.fetch = originalFetch;
});

afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  initComposites();
  initBundles();
  for (const n of CLIENT_NAMES) removeCircuitBreaker(n);
  globalThis.fetch = originalFetch;
});

// ===========================================================================
// 168:11-168:59 ConditionalExpression [Survived] "true", and
// 168:11-168:20 BooleanLiteral [Survived] ("resolved" -> "!resolved")
// "if (!resolved || resolved.client.name !== scope.name)" — exact
// client-membership, not a name-prefix test.
// ===========================================================================

describe("client-scope confused-deputy defense (L168)", () => {
  test("a fully-qualified tool key belonging to a different client is rejected by exact membership, not admitted by a name-prefix match", async () => {
    // "s3-acme" (this scope) and "s3-evil" (a totally separate client). A session
    // scoped to /mcp/s3-acme must not be able to reach s3-evil's tool by sending
    // its fully-qualified key "s3-evil__sometool" — resolveTool canonically maps
    // it to the OTHER client s3-evil, and the L168 check must reject it because
    // resolved.client.name !== scope.name (kills the "!==" -> "===" inversion,
    // which would otherwise let the confused-deputy call through).
    //
    // Note: the sharper "s3-acme__evil" variant (a client whose NAME extends this
    // scope's across the "__" separator) is now blocked at the door by
    // validateClientName/validateToolIdentity — see registry-separator-rejection
    // .test.ts. The runtime exact-membership check remains the second layer and
    // still guards every cross-client fully-qualified call, which is what this
    // test exercises.
    await reg("s3-acme", [tool("sometool")]);
    await reg("s3-evil", [tool("sometool")]);
    globalThis.fetch = okFetch({ from: "whichever-client-actually-ran" });

    const { client, close } = await connect({ kind: "client", name: "s3-acme" });
    try {
      // registry.resolveTool("s3-evil__sometool") canonically resolves to the
      // OTHER client "s3-evil" — the exact-match check must reject it.
      const evil = await client.callTool({ name: "s3-evil__sometool", arguments: {} });
      expect(evil.isError).toBe(true);
      expect(text(evil)).toBe("Unknown tool: s3-evil__sometool");

      // Positive case: a tool that DOES canonically belong to "s3-acme" must
      // still succeed — proves this isn't simply "always reject" under the
      // ConditionalExpression "true" mutant (which would break this call too),
      // and isn't a false pass-through under the BooleanLiteral swap either
      // (which would tend to treat a resolvable tool as if it never resolved).
      const own = await client.callTool({ name: "s3-acme__sometool", arguments: {} });
      expect(own.isError).toBeFalsy();
      expect(text(own)).not.toContain("Unknown tool");
    } finally {
      await close();
    }
  });

  test("a tool name that resolves to no client at all is a clean 'Unknown tool', not a thrown error (guards the '!resolved' short-circuit itself)", async () => {
    await reg("s3-acme", [tool("sometool")]);
    const { client, close } = await connect({ kind: "client", name: "s3-acme" });
    try {
      const result = await client.callTool({ name: "s3-acme__nonexistent-tool", arguments: {} });
      expect(result.isError).toBe(true);
      expect(text(result)).toBe("Unknown tool: s3-acme__nonexistent-tool");
    } finally {
      await close();
    }
  });
});

// ===========================================================================
// 176:9-176:32 ConditionalExpression [Survived] "true" on
// "if (scope.kind === \"bundle\")" — bundle-only logic must never fire for a
// client-scoped session.
// ===========================================================================

describe("bundle-only branch never fires for a client scope (L176)", () => {
  test("a legitimate client-scoped tool call reaches real dispatch, not the bundle membership gate", async () => {
    await reg("s3-widget", [tool("spin")]);
    globalThis.fetch = okFetch({ spun: true });

    const { client, close } = await connect({ kind: "client", name: "s3-widget" });
    try {
      const result = await client.callTool({ name: "s3-widget__spin", arguments: {} });
      // Under the 176:9 ConditionalExpression forced to "true", scope.name
      // ("s3-widget") would be treated as if it were a BUNDLE name. No bundle
      // literally named "s3-widget" exists, so isBundleEnabled("s3-widget") is
      // false, and the (wrongly-entered) L179 gate would short-circuit true and
      // return "Unknown tool: s3-widget__spin" instead of ever reaching the
      // real dispatch below it.
      expect(result.isError).toBeFalsy();
      expect(text(result)).not.toContain("Unknown tool");
    } finally {
      await close();
    }
  });
});

// ===========================================================================
// 178:33-178:108 (isBundleComposite computation: ConditionalExpression false,
// LogicalOperator "&&"->"||"), 178:56-178:107 LogicalOperator ("?? false" ->
// "&& false"), 178:56-178:92 OptionalChaining (getBundleComposites(...).has),
// and 179's Unknown-tool gate (ConditionalExpression true/false,
// "&&"->"||", isBundleEnabled). All four use one shared bundle/composite
// fixture set below.
// ===========================================================================

describe("bundle composite-membership + Unknown-tool gate (L177-184)", () => {
  async function seed(): Promise<void> {
    await reg("s3-svc", [tool("member")]);
    await reg("s3-other", [tool("realtool")]);
    await createComposite(
      "s3-combo",
      undefined,
      OBJ_SCHEMA,
      [{ targetClient: "s3-svc", targetTool: "member", argsTemplate: {} }],
      "t",
    );
    // In its composites[] (not its plain tools[]) — the point of this fixture.
    await createBundle("s3-bundle-in", undefined, [{ client: "s3-svc", tool: "member" }], "t", ["s3-combo"]);
    // Enabled, but has neither the composite nor any tools — the "not a member
    // of THIS bundle" fixture.
    await createBundle("s3-bundle-out", undefined, [], "t", []);
  }

  test("(a) a composite that IS both globally known AND a member of this bundle's composites[] dispatches successfully, not as Unknown tool", async () => {
    await seed();
    globalThis.fetch = okFetch({ ran: "composite" });
    const { client, close } = await connect({ kind: "bundle", name: "s3-bundle-in" });
    try {
      const result = await client.callTool({ name: "s3-combo", arguments: {} });
      // If mis-routed to the ordinary "Unknown tool" gate (178's ConditionalExpression
      // forced false / the "&&"->"||" LogicalOperator collapsing isBundleComposite to
      // false / the "?? false"->"&& false" swap doing the same), this would instead
      // be `{isError: true, content: [{text: "Unknown tool: s3-combo"}]}`.
      expect(result.isError).toBeFalsy();
      expect(text(result)).not.toContain("Unknown tool");
    } finally {
      await close();
    }
  });

  test("(b) a composite that IS globally known but is NOT in THIS bundle's composites[] is an ordinary unknown tool, not silently admitted", async () => {
    await seed();
    const { client, close } = await connect({ kind: "bundle", name: "s3-bundle-out" });
    try {
      // Under the 178 "&&"->"||" LogicalOperator mutant, `hasComposite("s3-combo")`
      // alone (true) would short-circuit isBundleComposite to true regardless of
      // whether THIS bundle actually lists it — wrongly admitting it here.
      const result = await client.callTool({ name: "s3-combo", arguments: {} });
      expect(result.isError).toBe(true);
      expect(text(result)).toBe("Unknown tool: s3-combo");
    } finally {
      await close();
    }
  });

  test("(c) a name that is neither a plain bundle member nor any known composite is rejected", async () => {
    await seed();
    const { client, close } = await connect({ kind: "bundle", name: "s3-bundle-in" });
    try {
      const result = await client.callTool({ name: "totally-made-up-tool", arguments: {} });
      expect(result.isError).toBe(true);
      expect(text(result)).toBe("Unknown tool: totally-made-up-tool");
    } finally {
      await close();
    }
  });

  test("(d) a plain bundle-member tool (not a composite) is admitted and dispatched, distinct from the composite path", async () => {
    await seed();
    globalThis.fetch = okFetch({ ran: "plain-member" });
    const { client, close } = await connect({ kind: "bundle", name: "s3-bundle-in" });
    try {
      const result = await client.callTool({ name: "s3-svc__member", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(text(result)).not.toContain("Unknown tool");
    } finally {
      await close();
    }
  });

  test("(e) a disabled bundle rejects even its own legitimate member tool (isBundleEnabled half of the L179 gate)", async () => {
    await seed();
    await updateBundle("s3-bundle-in", { enabled: false });
    const { client, close } = await connect({ kind: "bundle", name: "s3-bundle-in" });
    try {
      const result = await client.callTool({ name: "s3-svc__member", arguments: {} });
      expect(result.isError).toBe(true);
      expect(text(result)).toBe("Unknown tool: s3-svc__member");
    } finally {
      await close();
    }
  });

  test("(f) a real, enabled tool belonging to an entirely different, non-bundled client is rejected through an unrelated bundle scope, not silently dispatched", async () => {
    await seed();
    globalThis.fetch = okFetch({ from: "s3-other" });
    // "s3-other__realtool" is a perfectly legitimate, enabled tool — just not a
    // member of "s3-bundle-out" (which has neither tools nor composites). Under
    // the 179 ConditionalExpression forced to "false" (the whole Unknown-tool
    // gate skipped) or the "&&"->"||" LogicalOperator swap, this call would
    // incorrectly fall through to real dispatch and succeed instead of being
    // rejected at the gate.
    const { client, close } = await connect({ kind: "bundle", name: "s3-bundle-out" });
    try {
      const result = await client.callTool({ name: "s3-other__realtool", arguments: {} });
      expect(result.isError).toBe(true);
      expect(text(result)).toBe("Unknown tool: s3-other__realtool");
    } finally {
      await close();
    }
  });

  // 178:56-178:92 OptionalChaining ("getBundleComposites(scope.name)?.has(name)"
  // -> "...().has(name)"). Unlike L179's sibling optional-chain (see the
  // documented-equivalent header comment above), THIS one is unconditionally
  // evaluated on L178 before L179's `if` even runs, and getBundleComposites is
  // NOT correlated with any other gate the way keys/isBundleEnabled are — so a
  // nonexistent bundle scope (getBundleComposites returns undefined) combined
  // with a real, globally-known composite name (hasComposite true, so the
  // right operand of `&&` really is evaluated) is a genuinely reachable state.
  test("(g) a nonexistent bundle scope does not throw when the called name IS a real global composite (no bundle ever created with this name)", async () => {
    await seed(); // registers "s3-combo" globally; "s3-bundle-ghost" is never created
    const { client, close } = await connect({ kind: "bundle", name: "s3-bundle-ghost" });
    try {
      // Real code: getBundleComposites("s3-bundle-ghost") is undefined; `?.has`
      // short-circuits to undefined, `?? false` makes isBundleComposite false;
      // isBundleEnabled("s3-bundle-ghost") is also false, so the L179 gate
      // returns a clean "Unknown tool" — no throw, no rejected RPC call. Under
      // the stripped-`?.` mutant, `undefined.has("s3-combo")` throws
      // synchronously inside the handler instead.
      const result = await client.callTool({ name: "s3-combo", arguments: {} });
      expect(result.isError).toBe(true);
      expect(text(result)).toBe("Unknown tool: s3-combo");
    } finally {
      await close();
    }
  });
});

// ===========================================================================
// 190:11-190:28 ConditionalExpression [Survived] both "true" and "false", and
// 190:30-192:8 BlockStatement [Survived] (the composite-dispatch block
// emptied) — "if (isBundleComposite) { return runComposite(...); }".
// ===========================================================================

describe("composite (macro) dispatch actually runs through runComposite, and only for composites (L190)", () => {
  test("a composite call is threaded through runComposite's multi-step chaining (a result no single plain call could produce), while a same-bundle plain-member call bypasses it entirely", async () => {
    await reg("s3-chain", [tool("one"), tool("two", { n: { type: "number" } })]);
    // /one always returns {value: 41}; /two echoes back {result: n+1} using
    // whatever "n" it was actually POSTed (not chained internally in any way).
    globalThis.fetch = (async (url: string, opts: RequestInit) => {
      if (String(url).includes("/one")) {
        return new Response(JSON.stringify({ value: 41 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const body = JSON.parse(String(opts?.body ?? "{}")) as { n?: number };
      const n = typeof body.n === "number" ? body.n : 0;
      return new Response(JSON.stringify({ result: n + 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await createComposite(
      "s3-chain-combo",
      undefined,
      OBJ_SCHEMA,
      [
        { targetClient: "s3-chain", targetTool: "one", argsTemplate: {} },
        { targetClient: "s3-chain", targetTool: "two", argsTemplate: { n: { $ref: "steps.0.json.value" } } },
      ],
      "t",
    );
    await createBundle("s3-bundle-chain", undefined, [{ client: "s3-chain", tool: "two" }], "t", ["s3-chain-combo"]);

    const { client, close } = await connect({ kind: "bundle", name: "s3-bundle-chain" });
    try {
      // Composite path: step 0 ("one") produces {value:41}; step 1 ("two") is
      // called with n=41 (threaded from step 0's JSON output) -> {result:42}.
      // Under the 190 ConditionalExpression forced to "false" (or the block
      // emptied), this call would instead fall through past the bundle branch
      // to a direct `proxyToolCall("s3-chain-combo", ...)` — but
      // "s3-chain-combo" was never registered as a real client__tool, so that
      // would produce `{isError:true, text:"Unknown tool: s3-chain-combo"}`
      // instead of the {"result":42} below. Under "true" forced for EVERY
      // call (see the plain-member call below), runComposite would run even
      // for non-composite names.
      // Compared as parsed JSON, not a raw string: applyRedaction() (proxy.ts)
      // pretty-prints any application/json response body even with zero
      // redaction paths configured, so the exact whitespace isn't stable.
      const composite = await client.callTool({ name: "s3-chain-combo", arguments: {} });
      expect(composite.isError).toBeFalsy();
      expect(JSON.parse(text(composite) ?? "null")).toEqual({ result: 42 });

      // Plain-member path: calling "two" directly with its own n=5 must NOT be
      // routed through runComposite (which would ignore the caller's own args
      // and instead build them from a template) — the raw echo below (n=5 ->
      // result:6) proves no chaining occurred and this went through ordinary
      // proxyToolCall dispatch. Under the 190 ConditionalExpression forced to
      // "true", isBundleComposite is never actually consulted here (name
      // "s3-chain__two" isn't a real composite name so isBundleComposite is
      // still false on L178 regardless) — so this specific call doesn't
      // distinguish that direction, but IS what proves the composite result
      // above is genuinely a product of chaining, not a coincidence.
      const direct = await client.callTool({ name: "s3-chain__two", arguments: { n: 5 } });
      expect(direct.isError).toBeFalsy();
      expect(JSON.parse(text(direct) ?? "null")).toEqual({ result: 6 });
    } finally {
      await close();
    }
  });
});

/**
 * Stryker mutation-testing backstop — cluster C4: dispatchToolCall's early
 * structural + auth gates (roughly proxy.ts L475-L546): disabled client/tool,
 * unreachable client status, MCP-key scope, consumer monthly quota,
 * per-end-user rate limit, and the sensitive-tool __confirm/elevated gate.
 *
 * Every test drives these gates indirectly through the public proxyToolCall
 * entry point (proxy.ts exports no other testable surface) — see CLAUDE.md /
 * the sibling proxy test files for the established idiom this file follows.
 *
 * Note on line numbers cited in comments below: they are the actual current
 * line numbers in src/proxy/proxy.ts (verified by reading the file), which in
 * a couple of spots differ slightly from the original cluster assignment's
 * line numbers (off by a handful of lines, likely due to comment reflow
 * between the mutation-testing snapshot and HEAD) — matched by content, not
 * by raw offset.
 *
 * NOTE on the FIRST `isDeleting(client.name)` check (proxy.ts's own L479-480,
 * right after resolveTool — do not confuse with the SECOND recheck deep
 * inside runRest, which is C9's territory): its ConditionalExpression->'false'
 * / BlockStatement->'{}' / StringLiteral->'""' mutants are proven EQUIVALENT
 * through the public API, not chased with a dedicated test here. Confirmed by
 * reading src/mcp/registry.ts's `teardownLiveClient` (the body between
 * `deletingClients.add(name)` and the `finally`'s `deletingClients.delete(name)`)
 * plus src/lib/async-lock.ts's `createKeyedMutex`: teardownLiveClient has ZERO
 * internal `await`s, so once its synchronous body starts executing (after the
 * single microtask hop to acquire withLock's per-name mutex), add+delete both
 * complete within that SAME microtask turn — no other code, however it polls
 * (microtask or macrotask), can ever observe `isDeleting(name)===true` from
 * outside. This is the same structural conclusion the pre-existing
 * src/mcp/__tests__/registry-isdeleting.test.ts (TEST 3b) already documented
 * from a prior session ("we can't truly observe mid-execution").
 *
 * NOTE — equivalent mutant, verified empirically (L480 ObjectLiteral
 * `{ isError: true }` -> `{}` on the isDeleting-branch outcome, distinct from
 * the condition itself covered above): re-examined the above claim's own
 * consequence directly rather than by inspection alone. Hypothesis tested:
 * `registry.unregister(name)` internally does `withLock(name, async () =>
 * teardownLiveClient(name))`; `withLock`'s only await before invoking the
 * callback is `await prev` on an (for a fresh, uncontended name) *already
 * resolved* promise. Since an `await` on an already-resolved native promise
 * still costs exactly one microtask hop (not zero), the theory was that
 * `registry.unregister(name)` (NOT awaited) followed by a single `await
 * Promise.resolve()` in the caller might resume *after* that one hop lands
 * but *before* teardownLiveClient's synchronous body (add -> ... -> delete)
 * finishes — i.e. genuinely observe `isDeleting(name) === true` from outside.
 * Built and ran exactly this (`const p = registry.unregister(CLIENT); await
 * Promise.resolve(); const r = await proxyToolCall(...); await p;`) — first
 * as an isolated microtask-ordering repro of the withLock/teardownLiveClient
 * shape (confirmed `isDeleting` is already back to `false` after that one
 * tick, every run), then for real against this suite's proxyToolCall, 5x in a
 * row. Every run produced `{"isError":true,"content":[{"type":"text","text":
 * "Unknown tool: mutc4probe__get-item"}]}` — i.e. by the time the caller's
 * single microtask hop resumes, teardownLiveClient hasn't just already
 * cleared `deletingClients`, it has *also already deleted the client + tool
 * from the registry entirely*, so `registry.resolveTool()` at the very top of
 * dispatchToolCall (L464, with zero gates in between) already returns
 * `undefined` and short-circuits to the "Unknown tool" result — the call
 * never even reaches L479's `isDeleting` check, let alone L480's branch body.
 * Root cause: `await` on an *already-settled* promise resolves via a plain
 * microtask (PromiseResolveThenableJob-style), and the queued continuation
 * for the CALLER's `await Promise.resolve()` was enqueued strictly after
 * `withLock`'s own `await prev` continuation — so by FIFO microtask ordering,
 * `withLock`'s continuation (which synchronously runs the entire zero-await
 * `teardownLiveClient` body to completion, since calling a sync function
 * inside an async arrow with no internal `await` never yields) always drains
 * first, in full, before the caller's continuation gets a turn. This doesn't
 * just fail to falsify the pre-existing NOTE above — it strengthens it: the
 * unreachable window isn't merely un-pollable, it's provably narrower than
 * the smallest unit of external scheduling (one microtask), and the
 * `proxy-isdeleting-guard.test.ts` sibling file's own TEST 4a already
 * encodes the same discovery via its "isDeleting never became true" fallback
 * branch. No revision to the existing NOTE was needed.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import { createConsumer } from "../../admin/entities/consumers.js";
import { createMcpKey } from "../../security/mcp-key-store.js";
import { setToolSensitive } from "../../tool-meta/tool-sensitivity.js";
import type { RestToolDefinition } from "../../mcp/types.js";

// Registry client names are validated against /^[a-z0-9][a-z0-9_-]{0,62}$/
// (lowercase only) — the assigned "mutC4auth" prefix is lowercased here to a
// still-unique, collision-free name for this cluster's tests.
const CLIENT = "mutc4auth";

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "get-item",
    method: "GET",
    endpoint: "/item",
    description: "d",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}
async function reg(tools: RestToolDefinition[] = [makeTool()]): Promise<void> {
  await registry.register(CLIENT, tools, "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

const originalFetch = globalThis.fetch;
function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  (config as Record<string, unknown>).retryBaseDelayMs = 1;
  __resetDbForTesting();
  removeCircuitBreaker(CLIENT);
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

function okFetch(body: unknown = { ok: true }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Disabled client/tool gate — proxy.ts ~L475-477:
//   if (!client.enabled || !tool.enabled) {
//     return toolResult(`Tool '${mcpToolName}' is disabled`, { isError: true });
//   }
// ---------------------------------------------------------------------------
describe("dispatchToolCall — disabled client/tool gate", () => {
  // Kills L475 (full conditional set incl. '||' -> '&&', '!' removal,
  // condition -> true/false, BlockStatement) and L476 (StringLiteral /
  // ObjectLiteral / BooleanLiteral false on the disabled-client outcome).
  test("disabled client blocks the call before any fetch, with the tool key in the message", async () => {
    await reg();
    await registry.setClientEnabled(CLIENT, false);
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(`Tool '${CLIENT}__get-item' is disabled`);
    expect(fetchCalled).toBe(false);
  });

  // Kills the '||' -> '&&' mutation on L475: a disabled *tool* alone (client
  // still enabled) must still block — with '&&' it would incorrectly pass.
  test("disabled tool (client enabled) blocks the call before any fetch", async () => {
    await reg();
    await registry.setToolEnabled(CLIENT, "get-item", false);
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("is disabled");
    expect(fetchCalled).toBe(false);
  });

  // Baseline: both enabled -> the gate must NOT fire. Kills 'condition -> true'
  // (which would block every call) and confirms the '!' operators are intact.
  test("both client and tool enabled — the call proceeds to fetch", async () => {
    await reg();
    globalThis.fetch = okFetch();
    const res = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(res.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unreachable client status gate — proxy.ts ~L483-484:
//   if (client.status === "unreachable") {
//     return toolResult(`Client '${client.name}' is unreachable`, { isError: true });
//   }
// ---------------------------------------------------------------------------
describe("dispatchToolCall — unreachable client status gate", () => {
  // Kills L483 (Conditional set incl. condition -> true/false, StringLiteral
  // on the "unreachable" comparand, BlockStatement) and L484 (StringLiteral /
  // ObjectLiteral / BooleanLiteral false on the outcome).
  test("status 'unreachable' blocks the call before any fetch, with the client name in the message", async () => {
    await reg();
    registry.markClientStatus(CLIENT, "unreachable");
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(`Client '${CLIENT}' is unreachable`);
    expect(fetchCalled).toBe(false);
  });

  // Baseline: a freshly-registered client defaults to "healthy" -> the gate
  // must NOT fire. Kills 'condition -> true' (which would block every call
  // regardless of status).
  test("default 'healthy' status does not block — fetch is reached", async () => {
    await reg();
    globalThis.fetch = okFetch();
    const res = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(res.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MCP-key scope enforcement — proxy.ts ~L502-504:
//   if (callerKey && !isToolInKeyScope(callerKey.scopes, client.name, mcpToolName)) {
//     return toolResult(`API key is not authorized to call tool '${mcpToolName}'`, { isError: true });
//   }
// Basics are already covered by proxy-key-scope.test.ts; this is a light,
// same-file check of the exact conditional structure for this cluster.
// ---------------------------------------------------------------------------
describe("dispatchToolCall — MCP key scope gate", () => {
  test("an out-of-scope key is rejected before any fetch; an in-scope key proceeds", async () => {
    await reg();
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { rawKey: outOfScope } = createMcpKey("k1", { clients: ["some-other-client"] }, null, null);
    const rejected = await proxyToolCall(`${CLIENT}__get-item`, {}, outOfScope);
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain("not authorized to call tool");
    expect(fetchCalled).toBe(false);

    const { rawKey: inScope } = createMcpKey("k2", { clients: [CLIENT] }, null, null);
    const allowed = await proxyToolCall(`${CLIENT}__get-item`, {}, inScope);
    expect(allowed.isError).toBeUndefined();
    expect(fetchCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Consumer monthly quota gate — proxy.ts ~L507-516:
//   if (callerKey?.consumerId != null) {
//     const consumer = getConsumer(callerKey.consumerId);
//     const quota = checkConsumerQuota(callerKey.consumerId, consumer);
//     if (quota.exceeded) {
//       return toolResult(`Monthly quota exceeded for this API key's consumer (${quota.used}/${quota.quota})`, { isError: true });
//     }
//     ...
// ---------------------------------------------------------------------------
describe("dispatchToolCall — consumer monthly quota gate", () => {
  // Kills the 'if (quota.exceeded)' conditional set and the message/isError
  // mutants: exact used/quota numbers must appear, isError must be true.
  test("blocks once used >= monthlyQuota, with the exact used/quota numbers in the message", async () => {
    await reg();
    globalThis.fetch = okFetch();
    const consumer = createConsumer({ name: `${CLIENT}-quota`, monthlyQuota: 1, actor: null });
    const { rawKey } = createMcpKey("k", null, null, null, consumer.id);

    const first = await proxyToolCall(`${CLIENT}__get-item`, {}, rawKey);
    expect(first.isError).toBeUndefined();

    const second = await proxyToolCall(`${CLIENT}__get-item`, {}, rawKey);
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toBe("Monthly quota exceeded for this API key's consumer (1/1)");
  });

  // Also exercises the 'callerKey?.consumerId != null' guard from the other
  // side: a key with no consumer at all must never be blocked, however many
  // calls it makes.
  test("a key with no consumer is never blocked by the quota gate", async () => {
    await reg();
    globalThis.fetch = okFetch();
    const { rawKey } = createMcpKey("k", null, null, null);
    for (let i = 0; i < 3; i++) {
      expect((await proxyToolCall(`${CLIENT}__get-item`, {}, rawKey)).isError).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Per-end-user rate limit gate — proxy.ts ~L524-533:
//   const assertedEndUserId = resolveEndUserId(opts?.endUserId, args);
//   if (assertedEndUserId !== null) {
//     const endUserRl = checkEndUserRateLimit(callerKey.consumerId, assertedEndUserId, consumer);
//     if (endUserRl.limited) {
//       return toolResult(`End-user rate limit exceeded — retry after ${endUserRl.retryAfterSeconds}s`, { isError: true });
//     }
//   }
// ---------------------------------------------------------------------------
describe("dispatchToolCall — per-end-user rate limit gate", () => {
  // Kills the OptionalChaining mutant on 'opts?.endUserId' (no opts object at
  // all is passed here — a non-optional 'opts.endUserId' would throw a
  // TypeError reading a property of undefined) AND the
  // 'assertedEndUserId !== null' -> always-true mutant: the consumer HAS
  // opted in (endUserRateLimitPerMin set), so if the block were forced to run
  // with a null asserted id, checkEndUserRateLimit's rawEndUserId.slice(...)
  // would throw on null, failing this test.
  test("no opts object and no __end_user arg => the check is skipped without throwing", async () => {
    await reg();
    globalThis.fetch = okFetch();
    const consumer = createConsumer({
      name: `${CLIENT}-eu-noassert`,
      monthlyQuota: null,
      endUserRateLimitPerMin: 5,
      actor: null,
    });
    const { rawKey } = createMcpKey("k", null, null, null, consumer.id);
    // Deliberately a 3-arg call — opts is `undefined` at runtime.
    const res = await proxyToolCall(`${CLIENT}__get-item`, {}, rawKey);
    expect(res.isError).toBeUndefined();
  });

  // Kills 'assertedEndUserId !== null' -> always-false / BlockStatement (the
  // block must actually run and block), 'if (endUserRl.limited)' full set,
  // and the message/isError mutants on the blocked outcome. Also proves a
  // different end-user under the same key/consumer is unaffected (per-id
  // bucketing, not a single shared counter).
  test("blocks the asserted end-user id after its per-minute cap; a different id is unaffected", async () => {
    await reg();
    globalThis.fetch = okFetch();
    const consumer = createConsumer({
      name: `${CLIENT}-eu-limit`,
      monthlyQuota: null,
      endUserRateLimitPerMin: 1,
      actor: null,
    });
    const { rawKey } = createMcpKey("k", null, null, null, consumer.id);

    const first = await proxyToolCall(`${CLIENT}__get-item`, {}, rawKey, { endUserId: "alice" });
    expect(first.isError).toBeUndefined();

    const second = await proxyToolCall(`${CLIENT}__get-item`, {}, rawKey, { endUserId: "alice" });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain("End-user rate limit exceeded");
    expect(second.content[0].text).toMatch(/retry after \d+s/);

    const bob = await proxyToolCall(`${CLIENT}__get-item`, {}, rawKey, { endUserId: "bob" });
    expect(bob.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Sensitive-tool __confirm/elevated gate — proxy.ts ~L538-546:
//   if (isToolSensitive(client.name, tool.name, tool.method)) {
//     const confirmed = (args as Record<string, unknown>).__confirm === true;
//     if (!confirmed && callerKey?.elevated !== true) {
//       return toolResult(`Tool '${mcpToolName}' is sensitive — pass {"__confirm": true} ...`, { isError: true });
//     }
//   }
// ---------------------------------------------------------------------------
describe("dispatchToolCall — sensitive-tool __confirm/elevated gate", () => {
  // Kills 'isToolSensitive(...)' conditional -> always-true (a non-sensitive
  // tool must never require confirmation).
  test("a non-sensitive tool needs no confirmation", async () => {
    await reg();
    globalThis.fetch = okFetch();
    const res = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(res.isError).toBeUndefined();
  });

  // Kills 'isToolSensitive(...)' -> always-false / BlockStatement, and the
  // '!confirmed && callerKey?.elevated !== true' conditional-> always-false
  // case: an un-confirmed, non-elevated call to a sensitive tool must block,
  // with the exact message content.
  test("a sensitive tool blocks without __confirm and without an elevated key", async () => {
    await reg();
    setToolSensitive(CLIENT, "get-item", true);
    globalThis.fetch = okFetch();
    const res = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toContain(`Tool '${CLIENT}__get-item' is sensitive`);
    expect(text).toContain('{"__confirm": true}');
    expect(text).toContain("elevated key");
  });

  // Kills the UnaryOperator removal on '!confirmed' (confirmed -> would then
  // wrongly require elevation too) and the '&&' -> '||' flip (see the
  // elevated-key test below for the other half of that mutant).
  test("__confirm: true (exact boolean) allows a non-elevated caller through", async () => {
    await reg();
    setToolSensitive(CLIENT, "get-item", true);
    globalThis.fetch = okFetch();
    const res = await proxyToolCall(`${CLIENT}__get-item`, { __confirm: true });
    expect(res.isError).toBeUndefined();
  });

  // Kills the '===' -> '==' mutation on '__confirm === true': 1 == true is
  // loosely true in JS but must NOT satisfy a strict-equality confirmation.
  test("__confirm: 1 (truthy, but not === true) is not accepted as confirmation", async () => {
    await reg();
    setToolSensitive(CLIENT, "get-item", true);
    globalThis.fetch = okFetch();
    const res = await proxyToolCall(`${CLIENT}__get-item`, { __confirm: 1 });
    expect(res.isError).toBe(true);
  });

  // Kills the '&&' -> '||' flip and the 'elevated !== true' -> '=== true'
  // flip: an elevated key must bypass the gate even with zero __confirm.
  test("an elevated key bypasses the gate even with no __confirm at all", async () => {
    await reg();
    setToolSensitive(CLIENT, "get-item", true);
    globalThis.fetch = okFetch();
    const { rawKey } = createMcpKey("elevated-key", null, null, null, null, true);
    const res = await proxyToolCall(`${CLIENT}__get-item`, {}, rawKey);
    expect(res.isError).toBeUndefined();
  });

  // Kills the 'elevated !== true' -> '=== true' flip from the other side: a
  // resolved, non-elevated managed key must still need __confirm.
  test("a non-elevated managed key still needs __confirm", async () => {
    await reg();
    setToolSensitive(CLIENT, "get-item", true);
    globalThis.fetch = okFetch();
    const { rawKey } = createMcpKey("plain-key", null, null, null);
    const res = await proxyToolCall(`${CLIENT}__get-item`, {}, rawKey);
    expect(res.isError).toBe(true);
  });
});

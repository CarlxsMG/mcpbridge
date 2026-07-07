/**
 * Stryker mutation-testing backstop — cluster C3 (proxy.ts L321-458):
 * proxyToolCall's tracing-span wrapper + traffic-capture recording,
 * resolveEndUserId (header vs __end_user arg precedence), and runApprovalGate
 * (files a pending approval ticket or validates+consumes an existing one).
 *
 * All calls are driven through the public proxyToolCall entry point per the
 * module's hard privacy boundary — no direct imports of dispatchToolCall /
 * resolveEndUserId / runApprovalGate (they are module-private).
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import { tracingEnabled, flush, _internalsForTesting } from "../../observability/tracing.js";
import { listTraffic } from "../../observability/traffic.js";
import { setApprovalRequired, getApproval, decideApproval } from "../../admin/entities/approvals.js";
import { createConsumer } from "../../admin/entities/consumers.js";
import { createMcpKey } from "../../security/mcp-key-store.js";
import { withConfig } from "../../__tests__/_utils/with-config.js";
import * as logger from "../../logger.js";
import type { RestToolDefinition } from "../../mcp/types.js";

// lower-case only — the registry's TOOL_NAME_RE rejects uppercase client names.
const CLIENT = "mutc3wrap";

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "do-x",
    method: "POST",
    endpoint: "/do",
    description: "d",
    inputSchema: { type: "object", properties: { a: { type: "string" } } },
    ...overrides,
  };
}
async function reg(tools: RestToolDefinition[] = [makeTool()]): Promise<void> {
  await registry.register(CLIENT, tools, "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

const originalFetch = globalThis.fetch;
const originalOtelEndpoint = config.otelEndpoint;
function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  (config as Record<string, unknown>).retryBaseDelayMs = 1;
  (config as Record<string, unknown>).trafficCaptureEnabled = false;
  (config as Record<string, unknown>).otelEndpoint = originalOtelEndpoint;
  __resetDbForTesting();
  removeCircuitBreaker(CLIENT);
  globalThis.fetch = originalFetch;
  _internalsForTesting.clear();
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

function extractSpan(captured: Record<string, unknown> | null): Record<string, unknown> {
  const rs = (captured as unknown as { resourceSpans: Record<string, unknown>[] }).resourceSpans[0];
  const scopeSpans = (rs.scopeSpans as Record<string, unknown>[])[0];
  return (scopeSpans.spans as Record<string, unknown>[])[0];
}

// ---------------------------------------------------------------------------
// SECTION 1 — proxyToolCall tracing-span wrapper (L386-395)
// ---------------------------------------------------------------------------
describe("proxyToolCall — tracing-span wrapper", () => {
  test("tracing disabled: dispatch runs directly and no span is ever buffered (kills L386 tracingEnabled()/Conditional set)", async () => {
    await reg();
    globalThis.fetch = okFetch();
    expect(tracingEnabled()).toBe(false);
    const r = await proxyToolCall(`${CLIENT}__do-x`, {});
    expect(r.isError).toBeUndefined();
    expect(_internalsForTesting.bufferLength()).toBe(0);
  });

  // NOTE on L386's `if (!tracingEnabled())` ConditionalExpression->'false'
  // mutant (forces proxyToolCall to always take the tracing/span-wrapping
  // branch, regardless of whether tracing is actually enabled): proven
  // EQUIVALENT, not chased further. `endSpan()` (src/observability/tracing.ts)
  // carries its OWN internal `if (!tracingEnabled()) return;` guard — a span
  // object still gets constructed by startSpan() under the mutant, but
  // endSpan() immediately no-ops and discards it since tracing is genuinely
  // off, so `_internalsForTesting.bufferLength()` (and every other externally
  // observable effect) is identical either way. proxy.ts's own tracingEnabled()
  // check is redundant with tracing.ts's, by design (a cheap early-out to skip
  // constructing the span object at all in the common no-tracing case).

  test("tracing enabled: a successful call emits a CLIENT span named 'tool_call <tool>' carrying mcp.tool + mcp.tool.is_error=false, status OK=1 (kills L386, L388 else-branch BlockStatement, L389 name/attrs, L393 endSpan attrs ObjectLiteral, L394 is_error=false path)", async () => {
    await withConfig({ otelEndpoint: "http://otel.mutc3.local/v1/traces" }, async () => {
      await reg();
      let captured: Record<string, unknown> | null = null;
      globalThis.fetch = (async (url: string, opts: RequestInit) => {
        if (String(url).includes("otel.mutc3.local")) {
          captured = JSON.parse(String(opts.body));
          return new Response("{}", { status: 200 });
        }
        return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;

      const r = await proxyToolCall(`${CLIENT}__do-x`, {});
      expect(r.isError).toBeUndefined();
      expect(_internalsForTesting.bufferLength()).toBe(1);
      await flush();

      const span = extractSpan(captured);
      expect(span.name).toBe(`tool_call ${CLIENT}__do-x`);
      const attrs = span.attributes as { key: string; value: Record<string, unknown> }[];
      expect(attrs.find((a) => a.key === "mcp.tool")?.value.stringValue).toBe(`${CLIENT}__do-x`);
      expect(attrs.find((a) => a.key === "mcp.tool.is_error")?.value.boolValue).toBe(false);
      expect((span.status as { code: number }).code).toBe(1);
    });
  });

  test("tracing enabled: an error result carries mcp.tool.is_error=true and status ERROR=2 (kills L394 'result.isError !== true' full set + BooleanLiteral false)", async () => {
    await withConfig({ otelEndpoint: "http://otel.mutc3.local/v1/traces" }, async () => {
      await reg();
      let captured: Record<string, unknown> | null = null;
      globalThis.fetch = (async (url: string, opts: RequestInit) => {
        if (String(url).includes("otel.mutc3.local")) {
          captured = JSON.parse(String(opts.body));
          return new Response("{}", { status: 200 });
        }
        return new Response("boom", { status: 500, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;

      const r = await proxyToolCall(`${CLIENT}__do-x`, {});
      expect(r.isError).toBe(true);
      await flush();

      const span = extractSpan(captured);
      const attrs = span.attributes as { key: string; value: Record<string, unknown> }[];
      expect(attrs.find((a) => a.key === "mcp.tool.is_error")?.value.boolValue).toBe(true);
      expect((span.status as { code: number }).code).toBe(2);
    });
  });

  test("sessionId in ToolCallOpts is attached as mcp.session_id; absent -> attribute omitted entirely (kills L395 OptionalChaining 'opts.sessionId' + conditional-spread ObjectLiteral)", async () => {
    await withConfig({ otelEndpoint: "http://otel.mutc3.local/v1/traces" }, async () => {
      await reg();
      let captured: Record<string, unknown> | null = null;
      globalThis.fetch = (async (url: string, opts: RequestInit) => {
        if (String(url).includes("otel.mutc3.local")) {
          captured = JSON.parse(String(opts.body));
          return new Response("{}", { status: 200 });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;

      await proxyToolCall(`${CLIENT}__do-x`, {}, undefined, { sessionId: "sess-c3-1" });
      await flush();
      const span1 = extractSpan(captured);
      const attrs1 = span1.attributes as { key: string; value: Record<string, unknown> }[];
      expect(attrs1.find((a) => a.key === "mcp.session_id")?.value.stringValue).toBe("sess-c3-1");

      captured = null;
      await proxyToolCall(`${CLIENT}__do-x`, {});
      await flush();
      const span2 = extractSpan(captured);
      const attrs2 = span2.attributes as { key: string; value: Record<string, unknown> }[];
      expect(attrs2.find((a) => a.key === "mcp.session_id")).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// SECTION 2 — traffic-capture recording (L402-411)
// ---------------------------------------------------------------------------
describe("proxyToolCall — traffic capture recording", () => {
  test("capture off (default): nothing is recorded (baseline for the guard at L402)", async () => {
    await reg();
    globalThis.fetch = okFetch();
    const r = await proxyToolCall(`${CLIENT}__do-x`, {});
    expect(r.isError).toBeUndefined();
    expect(listTraffic({}).items).toHaveLength(0);
  });

  test("capture on + known tool + valid caller key: records the real client/tool name and the resolved keyId (kills L402 capture guard, L406/L407 ?? -> && + OptionalChaining removed, L408 ?? -> && + OptionalChaining removed)", async () => {
    await reg();
    (config as Record<string, unknown>).trafficCaptureEnabled = true;
    globalThis.fetch = okFetch({ r: 1 });
    const { rawKey, record } = createMcpKey("k", null, null, "tester");

    const r = await proxyToolCall(`${CLIENT}__do-x`, {}, rawKey);
    expect(r.isError).toBeUndefined();
    const items = listTraffic({}).items;
    expect(items).toHaveLength(1);
    expect(items[0].clientName).toBe(CLIENT);
    expect(items[0].toolName).toBe("do-x");
    expect(items[0].keyId).toBe(record.id);
  });

  test("capture on + unknown tool: still records a row, with clientName/toolName/keyId all literally null (kills L406/L407 ?? -> && producing `undefined` on the STRICT-table insert, which would throw and silently drop the row instead)", async () => {
    (config as Record<string, unknown>).trafficCaptureEnabled = true;
    const r = await proxyToolCall(`${CLIENT}__does-not-exist`, {});
    expect(r.isError).toBe(true);
    const items = listTraffic({}).items;
    expect(items).toHaveLength(1);
    expect(items[0].clientName).toBeNull();
    expect(items[0].toolName).toBeNull();
    expect(items[0].keyId).toBeNull();
  });

  test("capture on + no callerToken: keyId is null (ternary else-branch)", async () => {
    await reg();
    (config as Record<string, unknown>).trafficCaptureEnabled = true;
    globalThis.fetch = okFetch();
    const r = await proxyToolCall(`${CLIENT}__do-x`, {});
    expect(r.isError).toBeUndefined();
    const items = listTraffic({}).items;
    expect(items[0].keyId).toBeNull();
  });

  test("capture on + a truthy but unresolvable callerToken: keyId resolves to null without throwing (kills L408 OptionalChaining removed on resolveMcpKeyByToken(...)?.id)", async () => {
    await reg();
    (config as Record<string, unknown>).trafficCaptureEnabled = true;
    globalThis.fetch = okFetch();
    const r = await proxyToolCall(`${CLIENT}__do-x`, {}, "totally-bogus-token-not-a-real-key");
    expect(r.isError).toBeUndefined();
    const items = listTraffic({}).items;
    expect(items).toHaveLength(1);
    expect(items[0].keyId).toBeNull();
  });

  test("durationMs reflects real elapsed time, not Date.now()+started (kills L411 ArithmeticOperator + instead of -)", async () => {
    await reg();
    (config as Record<string, unknown>).trafficCaptureEnabled = true;
    globalThis.fetch = okFetch();
    await proxyToolCall(`${CLIENT}__do-x`, {});
    const items = listTraffic({}).items;
    expect(items).toHaveLength(1);
    // A real elapsed duration for a mocked local fetch is a few ms at most.
    // `Date.now() + started` would instead be roughly double the current
    // epoch (~3.5 trillion ms) — wildly outside any sane bound.
    expect(items[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(items[0].durationMs).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------
// SECTION 3 — resolveEndUserId: header vs __end_user arg precedence (L362-367)
// ---------------------------------------------------------------------------
describe("resolveEndUserId — header vs __end_user arg precedence", () => {
  async function setupConsumerKey(limitPerMin: number): Promise<string> {
    await reg([makeTool({ name: "get-x", method: "GET", endpoint: "/x" })]);
    const c = createConsumer({
      name: "c3-consumer",
      monthlyQuota: null,
      endUserRateLimitPerMin: limitPerMin,
      actor: null,
    });
    const { rawKey } = createMcpKey("k", null, null, "tester", c.id);
    return rawKey;
  }

  test("header value is trimmed before use as the rate-limit identity (kills L363 MethodExpression .trim() removed)", async () => {
    const rawKey = await setupConsumerKey(1);
    globalThis.fetch = okFetch();
    const r1 = await proxyToolCall(`${CLIENT}__get-x`, {}, rawKey, { endUserId: "  padded-user  " });
    expect(r1.isError).toBeUndefined();
    // Same identity once trimmed -> the single-per-minute budget is already spent.
    const r2 = await proxyToolCall(`${CLIENT}__get-x`, {}, rawKey, { endUserId: "padded-user" });
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text.toLowerCase()).toContain("end-user rate limit");
  });

  test("__end_user arg value is trimmed before use as the rate-limit identity (kills L366 MethodExpression .trim() removed)", async () => {
    const rawKey = await setupConsumerKey(1);
    globalThis.fetch = okFetch();
    const r1 = await proxyToolCall(`${CLIENT}__get-x`, { __end_user: "  padded-arg  " }, rawKey);
    expect(r1.isError).toBeUndefined();
    const r2 = await proxyToolCall(`${CLIENT}__get-x`, { __end_user: "padded-arg" }, rawKey);
    expect(r2.isError).toBe(true);
  });

  test("a whitespace-only header is treated as absent and falls back to the __end_user arg (kills L363 ternary/StringLiteral + L364 'if (fromHeader)' conditional)", async () => {
    const rawKey = await setupConsumerKey(1);
    globalThis.fetch = okFetch();
    const r1 = await proxyToolCall(`${CLIENT}__get-x`, { __end_user: "fallback-user" }, rawKey, { endUserId: "   " });
    expect(r1.isError).toBeUndefined();
    // Same fallback (arg) identity reused -> budget spent, proving the blank
    // header did NOT itself become the (constant) identity used both times.
    const r2 = await proxyToolCall(`${CLIENT}__get-x`, { __end_user: "fallback-user" }, rawKey, { endUserId: "   " });
    expect(r2.isError).toBe(true);
  });

  test("header wins over a *different* asserted arg identity on every call (kills L364 Conditional in the true-branch direction)", async () => {
    const rawKey = await setupConsumerKey(1);
    globalThis.fetch = okFetch();
    const r1 = await proxyToolCall(`${CLIENT}__get-x`, { __end_user: "arg-user-1" }, rawKey, { endUserId: "hdr-user" });
    expect(r1.isError).toBeUndefined();
    // Different arg identity each call, but the SAME header identity -> still
    // limited, proving the header (not the varying arg) determines identity.
    const r2 = await proxyToolCall(`${CLIENT}__get-x`, { __end_user: "arg-user-2" }, rawKey, { endUserId: "hdr-user" });
    expect(r2.isError).toBe(true);
  });

  test("both header and arg absent: no identity asserted, never end-user-rate-limited even with a budget of 1 (kills L367 LogicalOperator || -> &&)", async () => {
    const rawKey = await setupConsumerKey(1);
    globalThis.fetch = okFetch();
    for (let i = 0; i < 3; i++) {
      const r = await proxyToolCall(`${CLIENT}__get-x`, {}, rawKey);
      expect(r.isError).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// SECTION 4 — runApprovalGate: file a new ticket / validate+consume (L425-456)
// ---------------------------------------------------------------------------
describe("runApprovalGate — ticket lifecycle internals", () => {
  test("no __approval_id files a new pending ticket, logs it, and returns a descriptive isError result naming the ticket id (kills L431 BlockStatement, L433 ternary absent-case, L435 branch, L445 log text/meta, L447 message template, L448 opts/isError)", async () => {
    await reg();
    setApprovalRequired(CLIENT, "do-x", true);
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      const r = await proxyToolCall(`${CLIENT}__do-x`, { a: "1" });
      expect(r.isError).toBe(true);
      expect(fetched).toBe(0);
      const id = Number(r.content[0].text.match(/#(\d+)/)![1]);
      expect(r.content[0].text).toBe(
        `Tool '${CLIENT}__do-x' requires human approval. Queued as approval #${id}. Once approved, re-call with {"__approval_id": ${id}}.`,
      );
      const call = logSpy.mock.calls.find((c) => c[0] === "info" && c[1] === "Tool call queued for approval");
      expect(call).toBeDefined();
      expect(call?.[2]).toMatchObject({ tool: `${CLIENT}__do-x`, client: CLIENT, approval_id: id });
    } finally {
      logSpy.mockRestore();
    }
  });

  test("requestedBy on the new ticket is the caller's managed-key id when present, else null (kills L441 LogicalOperator ?? -> && + OptionalChaining removed)", async () => {
    await reg();
    setApprovalRequired(CLIENT, "do-x", true);
    globalThis.fetch = okFetch();

    // No callerToken at all -> requestedBy must be null.
    const rAnon = await proxyToolCall(`${CLIENT}__do-x`, { a: "anon" });
    const idAnon = Number(rAnon.content[0].text.match(/#(\d+)/)![1]);
    expect(getApproval(idAnon)?.requestedBy).toBeNull();

    // A real managed key -> requestedBy must be that key's numeric id (never null).
    const { rawKey, record } = createMcpKey("approver-caller", null, null, "tester");
    const rKeyed = await proxyToolCall(`${CLIENT}__do-x`, { a: "keyed" }, rawKey);
    const idKeyed = Number(rKeyed.content[0].text.match(/#(\d+)/)![1]);
    expect(getApproval(idKeyed)?.requestedBy).toBe(record.id);
  });

  test("a non-number __approval_id (e.g. a string) is treated as absent — files a new ticket instead of attempting to consume (kills L433 typeof ternary + StringLiteral)", async () => {
    await reg();
    setApprovalRequired(CLIENT, "do-x", true);
    globalThis.fetch = okFetch();
    const r = await proxyToolCall(`${CLIENT}__do-x`, { a: "1", __approval_id: "1" as unknown as number });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("requires human approval");
  });

  test("an __approval_id for a ticket that doesn't exist returns consumeApproval's own not-found message and never reaches the backend (kills L452 decision.ok/Conditional/BlockStatement, L453 opts/isError)", async () => {
    await reg();
    setApprovalRequired(CLIENT, "do-x", true);
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const r = await proxyToolCall(`${CLIENT}__do-x`, { a: "1", __approval_id: 999999 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`Approval #999999 not found for this tool`);
    expect(fetched).toBe(0);
  });

  test("a valid, approved, matching-args ticket lets the call proceed to the real dispatch exactly once (kills L435 approvalId!==null branch + L452 decision.ok===true skip-to-null)", async () => {
    await reg();
    setApprovalRequired(CLIENT, "do-x", true);
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response('{"done":true}', { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const r1 = await proxyToolCall(`${CLIENT}__do-x`, { a: "1" });
    const id = Number(r1.content[0].text.match(/#(\d+)/)![1]);
    decideApproval(id, "approved", "admin", null);

    const r2 = await proxyToolCall(`${CLIENT}__do-x`, { a: "1", __approval_id: id });
    expect(r2.isError).toBeUndefined();
    expect(fetched).toBe(1);
  });
});

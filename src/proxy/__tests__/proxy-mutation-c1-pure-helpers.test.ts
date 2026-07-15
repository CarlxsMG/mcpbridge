import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { config } from "../../config.js";
import { __resetDbForTesting, getDb } from "../../db/connection.js";
import { proxyToolCall, abortClientRequests } from "../../proxy/proxy.js";
import { setPaginationConfig } from "../../tool-policies/pagination.js";
import type { RestToolDefinition } from "../../mcp/types.js";

// ---------------------------------------------------------------------------
// Cluster C1 (L1-224): parseRetryAfter, httpStatusClass, readBodyWithCap,
// inflightControllers/trackRequest/untrackRequest/abortClientRequests, the
// Ajv singleton's constructor options, and getOrCompile's validator cache.
//
// All targets are module-private except `abortClientRequests`, so every
// mutant is driven indirectly through `proxyToolCall(...)` with a mocked
// `fetch` and/or targeted config overrides, per the file's own conventions.
// ---------------------------------------------------------------------------

// NOTE: the registry's client-name regex is lowercase-only
// (/^[a-z0-9][a-z0-9_-]{0,62}$/), so the assigned cluster prefix "mutC1helpers"
// is lowercased here to "mutc1helpers" while keeping it unique across clusters.
const CLIENT = "mutc1helpers";

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

/** Reads the status_class column of the most recently inserted usage row. */
function lastStatusClass(): string | undefined {
  const row = getDb().query(`SELECT status_class FROM tool_call_log ORDER BY id DESC LIMIT 1`).get() as
    { status_class: string } | undefined;
  return row?.status_class;
}

// ---------------------------------------------------------------------------
// Ajv singleton constructor options (L75-81)
// ---------------------------------------------------------------------------

describe("Ajv singleton options", () => {
  test("strict:false tolerates a vendor-extension keyword in inputSchema (kills L77 strict->true)", async () => {
    const TOOL_NAME = "vendor-ext-tool";
    await reg([
      makeTool({
        name: TOOL_NAME,
        method: "POST",
        endpoint: "/vendor",
        inputSchema: {
          type: "object",
          properties: { a: { type: "string" } },
          "x-vendor-ext": true, // unknown keyword — strict:true would throw at compile time
        },
      }),
    ]);
    globalThis.fetch = okFetch();
    const result = await proxyToolCall(`${CLIENT}__${TOOL_NAME}`, { a: "hi" });
    expect(result.isError).toBeUndefined();
  });

  test("useDefaults:true fills in a schema default for a missing optional property (kills L79 useDefaults->false)", async () => {
    const TOOL_NAME = "default-tool";
    await reg([
      makeTool({
        name: TOOL_NAME,
        method: "GET",
        endpoint: "/default",
        inputSchema: {
          type: "object",
          properties: { greeting: { type: "string", default: "hi" } },
        },
      }),
    ]);
    let capturedUrl: string | undefined;
    globalThis.fetch = (async (url: unknown) => {
      capturedUrl = String(url);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const result = await proxyToolCall(`${CLIENT}__${TOOL_NAME}`, {});
    expect(result.isError).toBeUndefined();
    // With useDefaults:true, the missing `greeting` property is filled with its
    // schema default and ends up in the outgoing GET query string.
    expect(capturedUrl).toContain("greeting=hi");
  });

  // NOTE (equivalent mutant, not tested): L76 allErrors:false->true is not
  // observably different through proxyToolCall — the code only ever reads
  // `validate.errors?.[0]`, and Ajv reports the SAME first error regardless of
  // whether it stops after the first violation or collects every violation.
  // Round 2 re-verification: constructed two live Ajv instances (allErrors
  // false vs true, otherwise identical to the singleton's options above) and
  // diffed `.errors[0]` after validating the same deliberately-multi-error
  // object against several schema shapes (plain multi-property type/required
  // violations, and an `anyOf` schema — the one construct where Ajv's
  // internals are known to sometimes reorder errors). In every case
  // `errors[0]` was byte-for-byte identical between the two instances; only
  // `errors.length` and the entries AFTER index 0 differed. Ajv's compiled
  // validator always evaluates keywords in the same fixed order regardless
  // of allErrors — the flag only controls whether it returns immediately
  // after the first failure or keeps accumulating — so the first error is
  // invariant.
  // Round 3 re-verification: reran the same comparison against a wider
  // battery (5 schema shapes total, adding `allOf`+`required` and nested
  // `oneOf` combinations on top of the round-2 set) using the project's own
  // `ajv`/`ajv-formats` packages with the exact constructor options from the
  // singleton above (`strict:false, removeAdditional:'all', useDefaults:true,
  // coerceTypes:false`) — `errors[0]` (by `JSON.stringify` equality) was
  // identical between allErrors:false and allErrors:true for every shape,
  // confirming the flag genuinely never affects which error sorts first.
});

// ---------------------------------------------------------------------------
// getOrCompile validator cache (L87-99)
// ---------------------------------------------------------------------------

describe("getOrCompile validator cache", () => {
  // Regression coverage for the P1 fix: registry.register()/registerMcp()/
  // teardownLiveClient() now call invalidateCompiledSchemasForClient() (see
  // schema-validator.ts) at every point they already bust invalidatePinnedIp/
  // removeCircuitBreaker/clearLbState/purgeClientCache, so a re-registration
  // under the same client+tool key always recompiles against the CURRENT
  // schema instead of serving a stale cached validator.

  test("re-registration with a STRICTER schema is enforced immediately — the security-relevant direction (an admin tightening a schema to close off a dangerous value must not leave the old permissive validator live)", async () => {
    const TOOL_NAME = "cache-poison-tool";
    const looseSchema = { type: "object", properties: {} };
    const strictSchema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };

    await reg([makeTool({ name: TOOL_NAME, method: "POST", endpoint: "/cache", inputSchema: looseSchema })]);
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const first = await proxyToolCall(`${CLIENT}__${TOOL_NAME}`, {});
    expect(first.isError).toBeUndefined(); // loose schema allows the empty call through — compiles + caches it
    expect(fetchCalls).toBe(1);

    // Re-register the SAME client+tool name with a schema that now requires 'a'.
    await registry.unregister(CLIENT);
    await reg([makeTool({ name: TOOL_NAME, method: "POST", endpoint: "/cache", inputSchema: strictSchema })]);

    // With the cache correctly invalidated on teardown/re-registration, this
    // call is validated against the CURRENT strict schema and rejected —
    // proving the stale, more-permissive validator is no longer reachable.
    const second = await proxyToolCall(`${CLIENT}__${TOOL_NAME}`, {});
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain("Argument validation failed");
    expect(fetchCalls).toBe(1); // still 1 — the second call never reached fetch
  });

  test("re-registration with a LOOSER schema is also picked up immediately (cache invalidation is unconditional, not direction-specific)", async () => {
    const TOOL_NAME = "cache-poison-tool-loosen";
    const strictSchema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    const looseSchema = { type: "object", properties: {} };

    await reg([makeTool({ name: TOOL_NAME, method: "POST", endpoint: "/cache", inputSchema: strictSchema })]);
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const first = await proxyToolCall(`${CLIENT}__${TOOL_NAME}`, {});
    expect(first.isError).toBe(true); // missing required 'a' — compiles + caches the strict validator
    expect(fetchCalls).toBe(0);

    await registry.unregister(CLIENT);
    await reg([makeTool({ name: TOOL_NAME, method: "POST", endpoint: "/cache", inputSchema: looseSchema })]);

    const second = await proxyToolCall(`${CLIENT}__${TOOL_NAME}`, {});
    expect(second.isError).toBeUndefined();
    expect(fetchCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// trackRequest / untrackRequest / abortClientRequests (L106-130)
// ---------------------------------------------------------------------------

describe("abortClientRequests / in-flight request tracking", () => {
  test("is a safe no-op for a client with no tracked requests (kills L124 ConditionalExpression->true)", () => {
    expect(() => abortClientRequests(`${CLIENT}-never-tracked`)).not.toThrow();
  });

  test("aborts ALL concurrent in-flight requests for a client, not just the most recently tracked one (kills L111, L122, L124, L125)", async () => {
    await reg();
    let fetchCalls = 0;
    globalThis.fetch = ((_url: string, opts: RequestInit) => {
      fetchCalls++;
      const signal = opts.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => reject(new DOMException("Aborted", "AbortError"));
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort);
      });
    }) as unknown as typeof fetch;

    // Two overlapping calls to the SAME client. Since the client's base URL is
    // a raw IP literal, there is no await between dispatch start and
    // trackRequest() for either call, so both controllers register into
    // inflightControllers before either call's fetch actually resolves.
    const p1 = proxyToolCall(`${CLIENT}__get-item`, {});
    const p2 = proxyToolCall(`${CLIENT}__get-item`, {});

    for (let i = 0; i < 40 && fetchCalls < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fetchCalls).toBe(2);

    abortClientRequests(CLIENT);

    const [r1, r2] = await Promise.all([p1, p2]);
    // If trackRequest's `if (!inflightControllers.has(clientName))` were forced
    // true, the second trackRequest call would overwrite the map entry with a
    // fresh empty Set, dropping the first call's controller — so only ONE of
    // these two would ever actually receive the abort and error out.
    expect(r1.isError).toBe(true);
    expect(r2.isError).toBe(true);
  }, 8000);

  // NOTE (unobservable via the public API, not tested): L118 untrackRequest's
  // body being emptied and L119's optional-chaining removal on
  // `inflightControllers.get(clientName)?.delete` have no externally
  // observable effect — untrackRequest only ever runs with a clientName that
  // trackRequest already seeded a Set for (so `.get()` is never undefined at
  // that call site), and calling `.abort()` on an already-completed,
  // no-longer-referenced AbortController is inert. Both would only manifest
  // as an unbounded memory leak, not a functional difference.
  //
  // Round 2 re-verification of L118 specifically: could a stale (never
  // untracked) controller from a COMPLETED request cause a LATER
  // abortClientRequests(sameClient) call to abort a *different*,
  // still-in-flight request incorrectly? No — abortClientRequests already
  // aborts EVERY controller currently tracked for that client by design
  // (that's its whole job), so a leaked stale entry adds nothing beyond a
  // harmless extra `.abort()` call on an AbortController whose fetch has
  // already settled (no listener is attached to that signal any more, so
  // the call is a pure no-op). trackRequest also always allocates a brand
  // new `AbortController()` per call (L110), so a leaked stale entry can
  // never be the SAME object as a subsequent request's controller and thus
  // can never suppress or duplicate an abort for it. There is no reachable
  // sequence of proxyToolCall/abortClientRequests calls that produces a
  // different externally-observable result with this line's body emptied.
  //
  // Round 3 re-verification of L119 specifically (the OptionalChaining
  // removal, `inflightControllers.get(clientName)?.delete(controller)` ->
  // `inflightControllers.get(clientName).delete(controller)`): this only
  // throws if `.get(clientName)` is `undefined` at the point untrackRequest
  // runs. `trackRequest` unconditionally seeds `inflightControllers.set(
  // clientName, new Set())` (L111-113) before returning a controller, and
  // untrackRequest is only ever invoked (proxy.ts's `finally` block) with
  // the SAME clientName + controller pair from the SAME call's trackRequest.
  // Grepped the whole `src/` tree for every reference to
  // `inflightControllers`: it appears only in proxy.ts itself (trackRequest,
  // untrackRequest, abortClientRequests) and in this test file — no other
  // module ever touches the map, and the only two things done to it besides
  // `.set()`/`.get()` are `.delete(controller)` (removing a Set ENTRY, not
  // the map key) and `.clear()` inside abortClientRequests (emptying a Set
  // in place, again never removing the outer map key). So the map key for a
  // registered client, once created, is never removed for the lifetime of
  // the process — `.get(clientName)` cannot be `undefined` at this call
  // site, confirming the optional chaining is dead defensive code.
});

// ---------------------------------------------------------------------------
// parseRetryAfter (L132-157)
// ---------------------------------------------------------------------------

describe("parseRetryAfter — 429 Retry-After header parsing", () => {
  test("integer-seconds Retry-After makes the retry wait ~2s before succeeding (kills L138 true/headerValue, L142 true/false/block, L143 arithmetic, most L144 boundary mutants)", async () => {
    await reg();
    (config as Record<string, unknown>).retryMaxAttempts = 1;
    (config as Record<string, unknown>).retryBaseDelayMs = 1;

    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "2" } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const start = Date.now();
    const result = await proxyToolCall(`${CLIENT}__get-item`, {});
    const elapsed = Date.now() - start;

    expect(result.isError).toBeUndefined();
    expect(call).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(1300);
  }, 8000);

  // Round 3: this test used to build `future` from a live `Date.now() + 2000`
  // and was intermittently flaky under load — HTTP-date strings are
  // second-granular (`toUTCString()` drops milliseconds), so depending on
  // what fraction of a second `Date.now()` happened to land on at
  // construction time, up to ~999ms of the intended 2000ms offset could be
  // silently truncated away, occasionally pushing the real wait below the
  // 1300ms assertion floor (observed failure: elapsed ~1328ms total
  // including setup, i.e. the actual scheduled wait was uncomfortably close
  // to the 1300ms floor). Freezing `Date.now()` for the call removes the
  // jitter: `dateMs - Date.now()` is deterministically exactly 2000ms.
  test("HTTP-date Retry-After makes the retry wait until that date (kills L150 booleanliteral/true/false/block, L151 arithmetic)", async () => {
    await reg();
    (config as Record<string, unknown>).retryMaxAttempts = 1;
    (config as Record<string, unknown>).retryBaseDelayMs = 1;

    const FIXED_NOW = Date.UTC(2026, 0, 1, 0, 0, 0, 0); // whole-second aligned
    const future = new Date(FIXED_NOW + 2000).toUTCString();
    const originalDateNow = Date.now;
    Date.now = () => FIXED_NOW;

    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": future } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const realStart = performance.now();
      const result = await proxyToolCall(`${CLIENT}__get-item`, {});
      const elapsed = performance.now() - realStart;

      expect(result.isError).toBeUndefined();
      expect(call).toBe(2);
      expect(elapsed).toBeGreaterThanOrEqual(1300);
    } finally {
      Date.now = originalDateNow;
    }
  }, 8000);

  test("a Retry-After exactly equal to retryAfterMaxMs is still honored (inclusive upper boundary — kills L144 EqualityOperator '<=' -> '<')", async () => {
    await reg();
    const originalMax = config.retryAfterMaxMs;
    (config as Record<string, unknown>).retryAfterMaxMs = 1000;
    (config as Record<string, unknown>).retryMaxAttempts = 1;
    (config as Record<string, unknown>).retryBaseDelayMs = 1;

    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "1" } }); // 1000ms == max
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const start = Date.now();
      const result = await proxyToolCall(`${CLIENT}__get-item`, {});
      const elapsed = Date.now() - start;
      expect(result.isError).toBeUndefined();
      expect(call).toBe(2);
      expect(elapsed).toBeGreaterThanOrEqual(650);
    } finally {
      (config as Record<string, unknown>).retryAfterMaxMs = originalMax;
    }
  }, 8000);

  test("a Retry-After far exceeding retryAfterMaxMs is rejected and the retry proceeds immediately (kills L144 LogicalOperator '&&'->'||')", async () => {
    await reg();
    (config as Record<string, unknown>).retryMaxAttempts = 1;
    (config as Record<string, unknown>).retryBaseDelayMs = 1;

    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) {
        // ~11.5 days — comfortably beyond the default 30s retryAfterMaxMs.
        return new Response("slow down", { status: 429, headers: { "retry-after": "999999" } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const start = Date.now();
    const result = await proxyToolCall(`${CLIENT}__get-item`, {});
    const elapsed = Date.now() - start;

    expect(result.isError).toBeUndefined();
    expect(call).toBe(2);
    // Real code rejects the out-of-range value and proceeds without sleeping on
    // it (only the negligible retryBaseDelayMs=1 backoff applies). An OR-mutant
    // would instead treat it as a "valid" multi-day wait and hang far past this
    // deadline.
    expect(elapsed).toBeLessThan(1000);
  }, 8000);

  // Round 2: lower retryAfterMaxMs to a small test-local ceiling so an
  // over-ceiling Retry-After only needs to be a couple of seconds to prove
  // the point — no multi-day sleep required. Real code: ms(2000) > max(100)
  // so parseRetryAfter rejects it and returns null; the call site's
  // `waitMs !== null && waitMs > 0` guard then never fires, and the retry
  // fires again almost immediately. A ConditionalExpression->'true' mutant
  // on L144's `if (ms >= 0 && ms <= config.retryAfterMaxMs)` collapses the
  // range check to unconditional-return, so it would hand back the raw
  // 2000ms and the retry would actually sleep it — pushing elapsed well past
  // the 1000ms assertion below without ever timing out the test itself.
  test("an integer-seconds Retry-After exceeding a (test-lowered) retryAfterMaxMs is rejected and the retry proceeds fast, not after sleeping the full over-ceiling duration (kills L144 ConditionalExpression->'true')", async () => {
    await reg();
    const originalMax = config.retryAfterMaxMs;
    (config as Record<string, unknown>).retryAfterMaxMs = 100;
    (config as Record<string, unknown>).retryMaxAttempts = 1;
    (config as Record<string, unknown>).retryBaseDelayMs = 1;

    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "2" } }); // 2000ms, well over the 100ms ceiling
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const start = Date.now();
      const result = await proxyToolCall(`${CLIENT}__get-item`, {});
      const elapsed = Date.now() - start;
      expect(result.isError).toBeUndefined();
      expect(call).toBe(2);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      (config as Record<string, unknown>).retryAfterMaxMs = originalMax;
    }
  }, 8000);

  // Round 2: same technique as the previous test, applied to the HTTP-date
  // branch (L152 is L144's structural twin one branch down). A future date
  // 1500ms out, with the ceiling lowered to 100ms, is rejected by real code
  // (ms(~1500) > max(100) -> null -> no sleep).
  //
  // Round 3 — re-derived from the actual survivor list in
  // reports/mutation/result.json (line/column ranges, not just line numbers)
  // rather than line numbers alone, since L152 turns out to carry FIVE
  // distinct surviving mutants across three separate AST nodes (the whole
  // `ms >= 0 && ms <= config.retryAfterMaxMs` condition, and its two
  // operands independently). Empirically simulated all of them against this
  // exact (ms~1500, max=100) input via a standalone `bun` script mirroring
  // real vs. mutant + the call site's `waitMs !== null && waitMs > 0` guard:
  // this single scenario discriminates real (`no-wait`) from THREE of the
  // five survivors, all because they each cause the over-ceiling raw ms
  // (~1500) to be handed back and slept on instead of rejected:
  //   - LogicalOperator `&&` -> `||`              (ms>=0 is true, so `||`
  //     short-circuits true regardless of the ceiling check)
  //   - ConditionalExpression on the whole condition -> `true`
  //   - ConditionalExpression on the right operand (`ms <= config.retryAfterMaxMs`) -> `true`
  // (The remaining two L152 survivors — the LEFT operand's
  // ConditionalExpression->'true' and EqualityOperator `>=`->`>` — are
  // documented as equivalent below; the boundary EqualityOperator `<=`->`<`
  // is killed by the dedicated exact-boundary test right after this one.)
  test("an HTTP-date Retry-After exceeding a (test-lowered) retryAfterMaxMs is rejected and the retry proceeds fast, not after sleeping the full over-ceiling duration (kills L152 LogicalOperator '&&'->'||', ConditionalExpression->'true' on both the whole condition and its right operand)", async () => {
    await reg();
    const originalMax = config.retryAfterMaxMs;
    (config as Record<string, unknown>).retryAfterMaxMs = 100;
    (config as Record<string, unknown>).retryMaxAttempts = 1;
    (config as Record<string, unknown>).retryBaseDelayMs = 1;

    const future = new Date(Date.now() + 1500).toUTCString(); // ~1500ms out, well over the 100ms ceiling
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": future } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const start = Date.now();
      const result = await proxyToolCall(`${CLIENT}__get-item`, {});
      const elapsed = Date.now() - start;
      expect(result.isError).toBeUndefined();
      expect(call).toBe(2);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      (config as Record<string, unknown>).retryAfterMaxMs = originalMax;
    }
  }, 8000);

  // Round 3: the one L152 survivor that genuinely needs an exact-equality
  // hit — EqualityOperator `ms <= config.retryAfterMaxMs` -> `ms <
  // config.retryAfterMaxMs` — only diverges from real code at ms EXACTLY
  // equal to the ceiling (confirmed by simulating both across (ms, max)
  // pairs straddling the boundary: at ms=max-1 and ms=max+1 both operators
  // agree; only at ms=max itself does `<=` accept while `<` reject).
  //
  // Unlike L144's integer-seconds twin (pure arithmetic, `seconds * 1000`,
  // no wall-clock read — trivial to land exactly on a boundary), L152's `ms`
  // is `dateMs - Date.now()`, a genuine wall-clock read. HTTP-date strings
  // are also second-granular (`toUTCString()` drops milliseconds), so
  // constructing a header from `Date.now() + N` and hoping the runtime's
  // OWN later `Date.now()` call lands exactly N ms after it (see the
  // now-superseded caveat that used to sit in the NOTE below) is not
  // reliably reproducible — sub-millisecond scheduling jitter would push
  // the real `ms` to either side of the ceiling unpredictably, flaking the
  // assertion. Freezing `Date.now()` for the call removes that jitter
  // entirely: with a fixed clock, `dateMs - Date.now()` is exactly
  // `retryAfterMaxMs` by construction, deterministically, every run.
  test("an HTTP-date Retry-After landing exactly at retryAfterMaxMs (deterministic via a frozen Date.now) is still honored — inclusive upper boundary (kills L152 EqualityOperator '<=' -> '<')", async () => {
    await reg();
    const originalMax = config.retryAfterMaxMs;
    const originalDateNow = Date.now;
    (config as Record<string, unknown>).retryAfterMaxMs = 1000; // whole seconds only -- HTTP-date has no sub-second precision
    (config as Record<string, unknown>).retryMaxAttempts = 1;
    (config as Record<string, unknown>).retryBaseDelayMs = 1;

    const FIXED_NOW = Date.UTC(2026, 0, 1, 0, 0, 0, 0); // already whole-second aligned (:000ms)
    const future = new Date(FIXED_NOW + 1000).toUTCString(); // exactly retryAfterMaxMs ahead of the frozen "now"
    Date.now = () => FIXED_NOW;

    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": future } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      // Real wall-clock elapsed time (via performance.now(), NOT Date.now() --
      // that's frozen above and only affects parseRetryAfter's internal `ms`
      // computation, not the actual timer that `await new Promise(...)` waits on).
      const realStart = performance.now();
      const result = await proxyToolCall(`${CLIENT}__get-item`, {});
      const elapsed = performance.now() - realStart;
      expect(result.isError).toBeUndefined();
      expect(call).toBe(2);
      // Real: ms(1000) <= max(1000) is true (inclusive) -> honored -> the
      // retry loop actually sleeps ~1000ms before the second attempt. A
      // `<=`->`<` mutant makes `1000 < 1000` false -> rejected -> null -> no
      // sleep at all, so the retry would fire almost immediately instead.
      expect(elapsed).toBeGreaterThanOrEqual(650);
    } finally {
      Date.now = originalDateNow;
      (config as Record<string, unknown>).retryAfterMaxMs = originalMax;
    }
  }, 8000);

  // NOTE (equivalent/unobservable, not tested — re-verified empirically in
  // round 2 and round 3, see the bun -e transcripts in the round sessions for
  // the exact input batteries used):
  //  - L137 (`if (!headerValue) return null`) body emptied: for a null/absent
  //    header, parseInt(null) and Date.parse(null) both yield NaN regardless,
  //    so the function still falls through to the same final `return null`.
  //  - L138 ConditionalExpression->false: same reasoning as L137 for the
  //    null/empty-string case: skipping the early return doesn't change the
  //    eventual result. Confirmed for null, "", and non-numeric-leading
  //    strings alike — parseInt and Date.parse both yield NaN for all of
  //    them, so execution still falls through to the same final
  //    `return null` regardless of whether the guard fires.
  //  - L144 EqualityOperator `ms >= 0` -> `ms > 0`: the call site additionally
  //    guards with `waitMs !== null && waitMs > 0` before sleeping, so a
  //    boundary value of exactly ms=0 behaves identically (no sleep) whether
  //    parseRetryAfter returns 0 or null — unobservable through the wait timing.
  //  - L150 (`if (!isNaN(dateMs))`) ConditionalExpression->'true': the ONLY
  //    way to reach this line at all is for the integer-seconds branch above
  //    to have already fallen through (i.e. `Number.isFinite(seconds)` was
  //    false), and forcing this guard to unconditional-true only changes
  //    behavior for inputs where `dateMs` really is NaN — but in that case
  //    `ms = NaN - Date.now()` is NaN, so the inner `ms >= 0 && ms <= max`
  //    check is false either way and both variants fall through to the same
  //    `return null`. Empirically re-verified against a battery of inputs
  //    (null, "", digit-leading, garbage, "GMT", a real but out-of-range
  //    HTTP-date, etc.) — every case produced an identical result.
  //  - L152 EqualityOperator `ms >= 0` -> `ms > 0`, AND separately L152
  //    ConditionalExpression on the LEFT operand (`ms >= 0`) -> `true` (two
  //    distinct surviving mutants, same node region, columns 9-16): both
  //    only ever change parseRetryAfter's return value for ms < 0 (a
  //    past-date Retry-After) or ms === 0 — cases where real code returns
  //    `null` but either mutant would instead return the raw (non-positive)
  //    `ms`. The call site's `waitMs !== null && waitMs > 0` guard treats
  //    "null" and "any number <= 0" identically (both skip the sleep), so
  //    this is unobservable through proxyToolCall regardless of how the
  //    caller measures it (wait/no-wait, elapsed time, or call count).
  //    Round 3 re-verification: simulated real vs. both mutants (run through
  //    the same call-site guard) across a battery spanning ms from -1e12 up
  //    through +1e9 (crossing 0, the ceiling, and deep negative/positive
  //    territory) — every single sample produced an identical observable
  //    outcome (same wait/no-wait decision, same wait duration when one was
  //    scheduled). There is no ms value, not just the ms=0 boundary, where
  //    either of these two mutants is distinguishable from real code via the
  //    public API.
  //  - L152's remaining three survivors (LogicalOperator `&&`->`||`, and the
  //    ConditionalExpression->'true' variants on the whole condition and the
  //    RIGHT operand) are killed by the "exceeding a (test-lowered)
  //    retryAfterMaxMs" test above; the EqualityOperator `<=`->`<` on the
  //    right operand is killed by the dedicated exact-boundary test above.
});

// ---------------------------------------------------------------------------
// httpStatusClass (L159-164)
// ---------------------------------------------------------------------------

describe("httpStatusClass classification", () => {
  async function callWithStatus(status: number): Promise<void> {
    await reg();
    globalThis.fetch = (async () =>
      new Response("err", { status, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    const result = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(result.isError).toBe(true);
  }

  test("300 classifies as 3xx (lower boundary — kills L161 boundary set)", async () => {
    await callWithStatus(300);
    expect(lastStatusClass()).toBe("3xx");
  });

  test("399 classifies as 3xx (upper boundary — kills L161 boundary set)", async () => {
    await callWithStatus(399);
    expect(lastStatusClass()).toBe("3xx");
  });

  test("400 classifies as 4xx (lower boundary — kills L162 boundary set)", async () => {
    await callWithStatus(400);
    expect(lastStatusClass()).toBe("4xx");
  });

  test("499 classifies as 4xx (upper boundary — kills L162 boundary set)", async () => {
    await callWithStatus(499);
    expect(lastStatusClass()).toBe("4xx");
  });

  test("500 classifies as 5xx fallback (kills L163 StringLiteral->'')", async () => {
    await callWithStatus(500);
    expect(lastStatusClass()).toBe("5xx");
  });

  // Round 2: a status that lands in NONE of the three explicit ranges (101 is
  // neither 2xx, 3xx, nor 4xx — it only satisfies the final unconditional
  // "5xx" fallback) is the sharpest possible input for catching a
  // ConditionalExpression->'true' mutant on ANY of the three earlier branch
  // guards: whichever branch gets forced to unconditional-true will short-
  // circuit BEFORE the real "5xx" fallback is reached and return the wrong
  // label instead. A single assertion therefore kills all three:
  //   - L160 ConditionalExpression->'true' (2xx guard forced true -> "2xx")
  //   - L160 EqualityOperator '>=' -> '<' on `status >= 200` (101 < 200 is
  //     true, and 101 < 300 is also true, so the AND becomes true -> "2xx")
  //   - L161 ConditionalExpression->'true' (3xx guard forced true -> "3xx")
  //   - L162 ConditionalExpression->'true' (4xx guard forced true -> "4xx")
  // bun's Response constructor accepts status 101 with a body (verified
  // empirically), and 101 isn't in RETRYABLE_STATUSES, so it reaches the
  // non-retryable-error path on the first attempt exactly like the boundary
  // tests above.
  test("101 (matches none of the three explicit ranges) classifies as the 5xx fallback, not a false-positive from an earlier always-true branch (kills L160 ConditionalExpression->true, L160 EqualityOperator->'status < 200', L161 ConditionalExpression->true, L162 ConditionalExpression->true)", async () => {
    await callWithStatus(101);
    expect(lastStatusClass()).toBe("5xx");
  });

  // NOTE (unreachable via proxyToolCall, confirmed equivalent — not tested):
  // httpStatusClass's "2xx" branch is structurally dead code from every
  // reachable call site, so THREE separate L160 survivors on that branch are
  // all equivalent for the same underlying reason:
  //   - ConditionalExpression->'false' (id57, columns 7-36, the whole
  //     `status >= 200 && status < 300` condition forced to never match)
  //   - EqualityOperator '>=' -> '>' on `status >= 200` (id60, columns 7-20)
  //   - StringLiteral '"2xx"' -> '""' (id65, columns 45-50, the branch's
  //     return value itself)
  //
  // Round 3 re-verification — grepped every call site of `httpStatusClass(`
  // in proxy.ts (there are four, not two):
  //   - L1093 and L1109: `httpStatusClass(response.status)`, both inside the
  //     non-retryable-error block that only runs AFTER `if (response.ok) {
  //     ...; return toolResult(...); }` at L939 has already returned for any
  //     2xx response — so `response.status` is guaranteed non-2xx here.
  //   - L1159 and L1176: `httpStatusClass(lastStatus ?? 0)` in the
  //     exhausted-retries final block. `lastStatus` is assigned exactly once,
  //     at L1076 (`lastStatus = response.status;`), which sits AFTER that
  //     same L939 `if (response.ok) return` — every attempt that returns a
  //     2xx status exits the function immediately at L939 without ever
  //     reaching L1076, so `lastStatus` can never hold a 2xx value either
  //     (there is no code path where a 2xx response is retried and then
  //     "falls through" to a later failed attempt while leaving a stale 2xx
  //     `lastStatus` behind).
  // So `status` is provably never in [200,300) at any of the four call
  // sites, meaning the "2xx" branch (its guard AND its return value) is
  // unreachable dead code from httpStatusClass's only caller — forcing the
  // guard to never match, changing `>=` to `>`, or blanking the string it
  // returns are all equally unobservable through proxyToolCall.
  // (The SIBLING ConditionalExpression->'true' mutant on the same line is a
  // different story — see the 101 test above, which does kill it, since
  // forcing the branch to always match short-circuits BEFORE the real
  // "5xx" fallback for an out-of-range status like 101, which IS reachable.)
});

// ---------------------------------------------------------------------------
// readBodyWithCap (L166-200)
// ---------------------------------------------------------------------------

describe("readBodyWithCap — streaming body read bounded by maxResponseBytes", () => {
  test("a response with a null body stream falls back to response.text() (kills L171 optional-chaining removal, L172 fallback-branch mutants)", async () => {
    await reg();
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const result = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("");
  });

  test("a body delivered across multiple stream chunks is reassembled in the correct order (kills L197 AssignmentOperator '+=' -> '-=')", async () => {
    await reg();
    globalThis.fetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"a":'));
          controller.enqueue(new TextEncoder().encode("1}"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const result = await proxyToolCall(`${CLIENT}__get-item`, {});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ a: 1 });
  });

  test("a body exactly at maxResponseBytes is NOT capped (exclusive '>' boundary — kills L185 EqualityOperator '>' -> '>=')", async () => {
    await reg();
    const original = config.maxResponseBytes;
    (config as Record<string, unknown>).maxResponseBytes = 10;
    try {
      const body = "1234567890"; // exactly 10 bytes
      globalThis.fetch = (async () =>
        new Response(body, { status: 200, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
      const result = await proxyToolCall(`${CLIENT}__get-item`, {});
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe(body);
    } finally {
      (config as Record<string, unknown>).maxResponseBytes = original;
    }
  });

  test("a body exceeding maxResponseBytes by 1 byte IS capped", async () => {
    await reg();
    const original = config.maxResponseBytes;
    (config as Record<string, unknown>).maxResponseBytes = 10;
    try {
      const body = "12345678901"; // 11 bytes
      globalThis.fetch = (async () =>
        new Response(body, { status: 200, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
      const result = await proxyToolCall(`${CLIENT}__get-item`, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("exceeded");
    } finally {
      (config as Record<string, unknown>).maxResponseBytes = original;
    }
  });

  // NOTE (relies on Stryker's own timeout detection, not independently
  // tested): L180 (`while (true) { ... }` body emptied) and L182 (`if (done)
  // break` forced false) both turn the read loop into a non-terminating
  // loop. Every other test in this file that reads a real body (all of the
  // above, plus every test in the rest of the suite) already exercises this
  // loop to completion; under either mutant those SAME tests would simply
  // hang and be killed by Stryker's per-mutant timeout rather than by an
  // assertion, so no dedicated test is added here.
  //
  // NOTE (equivalent, not tested): L183 (`if (value)` forced true) is only
  // observably different when `reader.read()` resolves `{ done: false, value:
  // undefined }` — a combination the Streams spec never produces for a real
  // fetch Response's Uint8Array body (a defined chunk is guaranteed whenever
  // done is false), so this is unreachable through any legitimately
  // constructed Response/ReadableStream.
  // Round 2 re-verification: the one case the original claim didn't
  // explicitly rule out is a *zero-length* chunk (`new Uint8Array(0)`) rather
  // than a missing one — since `totalBytes += value.byteLength` and
  // `chunks.push(value)` would both be no-ops for it either way, it seemed
  // worth checking concretely. Built a ReadableStream that explicitly
  // enqueues an empty `Uint8Array(0)` chunk followed by a real one and ran
  // both the real `if (value)` guard and a hardcoded `if (true)` version of
  // readBodyWithCap's loop against it side by side: both produced the
  // identical decoded string. This confirms the guard is equivalent even for
  // the zero-length-chunk edge case — a real (even empty) Uint8Array object
  // is always truthy, so `if (value)` was already true for it before the
  // mutant forces it; the mutant can only matter for `value === undefined`
  // or `null`, which the Streams spec guarantees never happens while
  // `done: false`.
  // Round 3 re-verification: ran a standalone `bun` script against Bun's own
  // fetch `Response` reader directly (not a hand-built polyfill) covering an
  // empty-string body, a `null` body (204), and a stream that explicitly
  // enqueues a zero-length `Uint8Array(0)` chunk before a real one. Observed
  // reads: `{done:true, value:undefined}` only ever appears on the FINAL
  // read (after `done` has already been checked and would `break` at L182);
  // every `done:false` read — including the explicit zero-length chunk —
  // always carried a defined `Uint8Array`, confirming Bun's runtime matches
  // the WHATWG spec guarantee this equivalence claim depends on.
});

// ---------------------------------------------------------------------------
// buildPinnedUrl (L216-222), reached via fetchAllPages's "page" strategy.
// Primarily C2's territory (fetchAllPages), included here for extra coverage
// since it was called out on this cluster's survivor list.
// ---------------------------------------------------------------------------

describe("buildPinnedUrl via pagination follow-up pages", () => {
  test("page-strategy pagination follows successive pages using pinned-IP URLs (kills L217 BlockStatement, L218 StringLiteral->'')", async () => {
    await reg([makeTool({ name: "get-list", endpoint: "/list" })]);
    setPaginationConfig(CLIENT, "get-list", {
      enabled: true,
      strategy: "page",
      itemsPath: "items",
      pageParam: "page",
      maxPages: 10,
    });
    let calls = 0;
    globalThis.fetch = (async (url: unknown) => {
      calls++;
      const u = new URL(String(url));
      // A broken buildPinnedUrl (empty body, or always "") would either throw
      // constructing this URL or fail this hostname check before we even get here.
      expect(u.hostname).toBe("1.2.3.4");
      const p = u.searchParams.get("page");
      if (!p) {
        return new Response(JSON.stringify({ items: [1, 2] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (p === "2") {
        return new Response(JSON.stringify({ items: [3] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await proxyToolCall(`${CLIENT}__get-list`, {});
    expect(JSON.parse(result.content[0].text).items).toEqual([1, 2, 3]);
    expect(calls).toBe(3);
  });
});

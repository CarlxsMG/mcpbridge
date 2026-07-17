/**
 * Stryker mutation-testing backstop — cluster C2 (proxy.ts L224-321):
 * fetchAllPages — aggregates a paginated JSON GET response across cursor/page/
 * link strategies, bounded by maxPages and a byte cap, stopping gracefully on
 * non-JSON/empty/cross-host-link/byte-cap conditions.
 *
 * fetchAllPages is module-private; every mutant below is driven indirectly via
 * the public proxyToolCall entry point, using setPaginationConfig(...) plus a
 * mocked fetch that varies its JSON response per call (tracked via a counter
 * closure).
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { proxyToolCall, abortClientRequests } from "../../proxy/proxy.js";
import { setPaginationConfig } from "../../tool-policies/pagination.js";
import * as pagination from "../../tool-policies/pagination.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "mutc2page";

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "get-list",
    method: "GET",
    endpoint: "/list",
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

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

// ---------------------------------------------------------------------------
// Cursor strategy
// ---------------------------------------------------------------------------
describe("fetchAllPages — cursor strategy", () => {
  test(
    "aggregates 3 pages across cursor follow-ups, stopping when next cursor is null " +
      "(kills L232/L234/L242/L245/L249-259/L264/L265/L267/L269 default-path avoidance/L307/L309: " +
      "the whole primary-body-parse, items-spread, fetchPage request shape, cursor branch selection, " +
      "cursor-param query build, and post-fetch re-check-and-continue chain must all fire in sequence)",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "cursor",
        itemsPath: "data",
        cursorResponsePath: "next",
        cursorParam: "cursor",
        maxPages: 10,
      });
      let calls = 0;
      const seenCursors: (string | null)[] = [];
      globalThis.fetch = (async (url: string, opts: RequestInit) => {
        calls++;
        const u = new URL(String(url));
        const c = u.searchParams.get("cursor");
        seenCursors.push(c);
        // Kills L251/L252/L253 (fetch options object/Content-Type/redirect+Host):
        // assert the follow-up request always carries the pinned-transport shape.
        // Normalize via Headers (rather than bracket access) since the primary
        // request's headers arrive as a Headers instance (outboundTraceHeaders)
        // while fetchPage's own follow-up requests use a plain object literal.
        const headers = new Headers(opts.headers as HeadersInit);
        expect(opts.method).toBe("GET");
        expect(opts.redirect).toBe("error");
        expect(headers.get("content-type")).toBe("application/json");
        expect(headers.get("host")).toBe("1.2.3.4");
        if (!c) return json({ data: [1, 2], next: "c1" });
        if (c === "c1") return json({ data: [3, 4], next: "c2" });
        return json({ data: [5], next: null });
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-list`, {});
      expect(r.isError).toBeUndefined();
      expect(JSON.parse(r.content[0].text ?? "").data).toEqual([1, 2, 3, 4, 5]);
      expect(calls).toBe(3);
      expect(seenCursors).toEqual([null, "c1", "c2"]);
    },
  );

  test(
    "cursorParam defaults to 'cursor' when omitted (kills L267 LogicalOperator ?? -> && " +
      "and its StringLiteral default: with && the key degenerates to key 'undefined' whenever " +
      "cursorParam is unset, so the follow-up would never carry a real 'cursor' query key)",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "cursor",
        itemsPath: "data",
        cursorResponsePath: "next",
        maxPages: 5,
      });
      let calls = 0;
      let sawCursorKey = false;
      globalThis.fetch = (async (url: string) => {
        calls++;
        const u = new URL(String(url));
        if (calls === 1) return json({ data: [1], next: "c1" });
        if (u.searchParams.get("cursor") === "c1") sawCursorKey = true;
        return json({ data: [2], next: null });
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-list`, {});
      expect(JSON.parse(r.content[0].text ?? "").data).toEqual([1, 2]);
      expect(sawCursorKey).toBe(true);
      expect(calls).toBe(2);
    },
  );

  test(
    "cursorResponsePath omitted -> cursor can never be extracted, pagination stops after page 1 " +
      "(kills L245/L308 StringLiteral default '' — the default must resolve to the whole-body path, " +
      "not throw or coincidentally find a cursor)",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "cursor",
        itemsPath: "data",
        cursorParam: "cursor",
        maxPages: 10,
      });
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return json({ data: [1, 2], next: "c1" });
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-list`, {});
      expect(r.isError).toBeUndefined();
      expect(JSON.parse(r.content[0].text ?? "").data).toEqual([1, 2]);
      expect(calls).toBe(1);
    },
  );

  test(
    "cursorResponsePath omitted, page 1 body poisoned with a field literally named " +
      "'Stryker was here!' -- the real '' default still ignores it and stops after page 1 " +
      "(kills L245 StringLiteral default '' -> 'Stryker was here!': getByPath(obj, '') returns the " +
      "whole body object unconditionally with NO property lookup at all, whereas the mutated default " +
      "would perform a single-segment key lookup that WOULD find this poisoned field and wrongly " +
      "resolve a next cursor, continuing to page 2 -- see the L308 equivalence note below for why the " +
      "same trick can't be repeated to isolate the second occurrence of this default)",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "cursor",
        itemsPath: "data",
        cursorParam: "cursor",
        maxPages: 10,
      });
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return json({ data: [1, 2], "Stryker was here!": "c1" });
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-list`, {});
      expect(r.isError).toBeUndefined();
      expect(JSON.parse(r.content[0].text ?? "").data).toEqual([1, 2]);
      expect(calls).toBe(1);
    },
  );

  test(
    "an empty items array on a follow-up page stops aggregation gracefully, keeping earlier pages " +
      "(kills L301 full guard set: '!items || items.length === 0' on the RE-fetched page, distinct " +
      "from the identical guard on the first page at L240)",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "cursor",
        itemsPath: "data",
        cursorResponsePath: "next",
        cursorParam: "cursor",
        maxPages: 10,
      });
      let calls = 0;
      globalThis.fetch = (async (url: string) => {
        calls++;
        const c = new URL(String(url)).searchParams.get("cursor");
        if (!c) return json({ data: [1, 2], next: "c1" });
        // Follow-up page claims there IS a next cursor, but returns no items —
        // must stop on the empty-items guard, not chase the (irrelevant) cursor.
        return json({ data: [], next: "c2" });
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-list`, {});
      expect(JSON.parse(r.content[0].text ?? "").data).toEqual([1, 2]);
      expect(calls).toBe(2);
    },
  );

  test(
    "a follow-up page returning a non-2xx status stops aggregation gracefully " +
      "(regression coverage for the '!res.ok || res.text === null' guard at L292; see the " +
      "equivalence note below for why this specific combination — like the ok=true/text=null one — " +
      "can't actually distinguish either L292 mutant: fetchPage sets text to null unconditionally " +
      "whenever ok is false, so '!res.ok' and 'res.text === null' are always simultaneously true " +
      "here, and && / || agree; the ConditionalExpression 'false' mutant is masked the same way as " +
      "the ok=true/text=null case, by the redundant L301 '!items' guard one line later)",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "cursor",
        itemsPath: "data",
        cursorResponsePath: "next",
        cursorParam: "cursor",
        maxPages: 10,
      });
      let calls = 0;
      globalThis.fetch = (async (url: string) => {
        calls++;
        const c = new URL(String(url)).searchParams.get("cursor");
        if (!c) return json({ data: [1, 2], next: "c1" });
        return new Response("server error", { status: 500 });
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-list`, {});
      expect(r.isError).toBeUndefined();
      expect(JSON.parse(r.content[0].text ?? "").data).toEqual([1, 2]);
      expect(calls).toBe(2);
    },
  );

  test(
    "a follow-up page whose fetch throws stops aggregation gracefully instead of failing the call " +
      "(kills L287/L289 try/catch -> break around the fetchPage call)",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "cursor",
        itemsPath: "data",
        cursorResponsePath: "next",
        cursorParam: "cursor",
        maxPages: 10,
      });
      let calls = 0;
      globalThis.fetch = (async (url: string) => {
        calls++;
        const c = new URL(String(url)).searchParams.get("cursor");
        if (!c) return json({ data: [1, 2], next: "c1" });
        throw new Error("network blip");
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-list`, {});
      expect(r.isError).toBeUndefined();
      expect(JSON.parse(r.content[0].text ?? "").data).toEqual([1, 2]);
      expect(calls).toBe(2);
    },
  );

  test(
    "a follow-up page with a non-JSON body stops aggregation gracefully " +
      "(kills L295/L297 try/catch -> break around JSON.parse(res.text))",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "cursor",
        itemsPath: "data",
        cursorResponsePath: "next",
        cursorParam: "cursor",
        maxPages: 10,
      });
      let calls = 0;
      globalThis.fetch = (async (url: string) => {
        calls++;
        const c = new URL(String(url)).searchParams.get("cursor");
        if (!c) return json({ data: [1, 2], next: "c1" });
        return new Response("not-json{{", { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-list`, {});
      expect(r.isError).toBeUndefined();
      expect(JSON.parse(r.content[0].text ?? "").data).toEqual([1, 2]);
      expect(calls).toBe(2);
    },
  );

  test(
    "the aggregate byte cap stops pagination early, keeping earlier pages but dropping later ones " +
      "(kills L304 AssignmentOperator += -> -=, and L305 boundary set on 'totalBytes > ctx.maxBytes')",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "cursor",
        itemsPath: "data",
        cursorResponsePath: "next",
        cursorParam: "cursor",
        maxPages: 10,
      });
      const page1Body = { data: [1], next: "c1" };
      const page2Body = { data: [2, 3], next: "c2" };
      const page3Body = { data: [4], next: null };
      const page1Len = JSON.stringify(page1Body).length;
      const page2Len = JSON.stringify(page2Body).length;
      // Cap is crossed the instant page2's bytes are added to page1's — but
      // page2's OWN size alone stays under the cap so its per-page read succeeds.
      const cap = page1Len + page2Len - 1;
      const original = config.maxResponseBytes;
      (config as Record<string, unknown>).maxResponseBytes = cap;
      let calls = 0;
      try {
        globalThis.fetch = (async (url: string) => {
          calls++;
          const c = new URL(String(url)).searchParams.get("cursor");
          if (!c) return json(page1Body);
          if (c === "c1") return json(page2Body);
          return json(page3Body); // must never be reached
        }) as unknown as typeof fetch;
        const r = await proxyToolCall(`${CLIENT}__get-list`, {});
        expect(r.isError).toBeUndefined();
        expect(JSON.parse(r.content[0].text ?? "").data).toEqual([1, 2, 3]);
        expect(calls).toBe(2);
      } finally {
        (config as Record<string, unknown>).maxResponseBytes = original;
      }
    },
  );

  test(
    "the aggregate byte cap boundary is strict '>', not '>=': totalBytes landing EXACTLY at the " +
      "cap after a follow-up page still lets pagination continue to the next page " +
      "(kills L305 EqualityOperator '>' -> '>=')",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "cursor",
        itemsPath: "data",
        cursorResponsePath: "next",
        cursorParam: "cursor",
        maxPages: 10,
      });
      const page1Body = { data: [1], next: "c1" };
      const page2Body = { data: [2, 3], next: "c2" };
      const page3Body = { data: [4], next: null };
      const page1Len = JSON.stringify(page1Body).length;
      const page2Len = JSON.stringify(page2Body).length;
      // Cap set to EXACTLY totalBytes-after-page2 (page1 + page2, no slack either way).
      const cap = page1Len + page2Len;
      const original = config.maxResponseBytes;
      (config as Record<string, unknown>).maxResponseBytes = cap;
      let calls = 0;
      try {
        globalThis.fetch = (async (url: string) => {
          calls++;
          const c = new URL(String(url)).searchParams.get("cursor");
          if (!c) return json(page1Body);
          if (c === "c1") return json(page2Body);
          return json(page3Body); // must be reached: exact-boundary must NOT stop the loop
        }) as unknown as typeof fetch;
        const r = await proxyToolCall(`${CLIENT}__get-list`, {});
        expect(r.isError).toBeUndefined();
        expect(JSON.parse(r.content[0].text ?? "").data).toEqual([1, 2, 3, 4]);
        expect(calls).toBe(3);
      } finally {
        (config as Record<string, unknown>).maxResponseBytes = original;
      }
    },
  );

  test(
    "a follow-up page that exceeds the response byte cap while streaming its OWN body " +
      "(res.ok=true but readBodyWithCap returns null) stops aggregation gracefully, keeping page 1 " +
      "(regression coverage for the 'ok=true, text=null' combination at L292; see the equivalence " +
      "note below -- this specific combination does NOT distinguish either L292 mutant, since " +
      "JSON.parse(null) parses to the JS value null without throwing and L301's '!items' guard " +
      "unconditionally breaks the loop one line later regardless of which branch got there)",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "cursor",
        itemsPath: "data",
        cursorResponsePath: "next",
        cursorParam: "cursor",
        maxPages: 10,
      });
      const original = config.maxResponseBytes;
      // Page 1's own body is 26 bytes (must fit, since the PRIMARY response is read through
      // the same capped reader too); page 2's is padded well past the cap so ITS OWN
      // readBodyWithCap call — independent per page — returns null.
      (config as Record<string, unknown>).maxResponseBytes = 30;
      let calls = 0;
      try {
        globalThis.fetch = (async (url: string) => {
          calls++;
          const c = new URL(String(url)).searchParams.get("cursor");
          if (!c) return json({ data: [1, 2], next: "c1" }); // 26 bytes — fits
          return json({ data: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], next: "c2" }); // 69 bytes — overflows
        }) as unknown as typeof fetch;
        const r = await proxyToolCall(`${CLIENT}__get-list`, {});
        expect(r.isError).toBeUndefined();
        expect(JSON.parse(r.content[0].text ?? "").data).toEqual([1, 2]);
        expect(calls).toBe(2);
      } finally {
        (config as Record<string, unknown>).maxResponseBytes = original;
      }
    },
  );

  test(
    "a follow-up page with a genuinely valid, well-formed JSON body has its items correctly " +
      "merged in (kills L297 BlockStatement->'{}' on the follow-up JSON.parse try-body: if the " +
      "assignment were skipped, `body` would stay undefined regardless of how well-formed res.text " +
      "is, extractItems(undefined, ...) would return null, and the L301 guard would silently drop " +
      "this page's items instead of merging them)",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "cursor",
        itemsPath: "data",
        cursorResponsePath: "next",
        cursorParam: "cursor",
        maxPages: 10,
      });
      let calls = 0;
      globalThis.fetch = (async (url: string) => {
        calls++;
        const c = new URL(String(url)).searchParams.get("cursor");
        if (!c) return json({ data: [1, 2], next: "c1" });
        return json({ data: [3, 4], next: null }); // valid, well-formed JSON
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-list`, {});
      expect(r.isError).toBeUndefined();
      expect(JSON.parse(r.content[0].text ?? "").data).toEqual([1, 2, 3, 4]);
      expect(calls).toBe(2);
    },
  );

  test(
    "an external abort mid-pagination (via abortClientRequests, the same mechanism a client " +
      "deregistration uses) actually cancels the in-flight follow-up fetch, stopping pagination at " +
      "page 1 (kills L250 ArrayDeclaration->'[]': AbortSignal.any([ctx.externalSignal, " +
      "AbortSignal.timeout(...)]) emptied to AbortSignal.any([]) would never abort — neither on " +
      "external cancellation nor on timeout — so the follow-up fetch would instead fall through to " +
      "our deliberately-short fallback resolution and wrongly continue pagination)",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "cursor",
        itemsPath: "data",
        cursorResponsePath: "next",
        cursorParam: "cursor",
        maxPages: 10,
      });
      let calls = 0;
      globalThis.fetch = (async (url: string, opts: RequestInit) => {
        calls++;
        const c = new URL(String(url)).searchParams.get("cursor");
        if (!c) return json({ data: [1, 2], next: "c1" });
        // Follow-up (page 2) request: race the composed signal's abort against a short
        // fallback resolution so this test can never hang, regardless of which side wins.
        return new Promise<Response>((resolve, reject) => {
          const signal = opts.signal as AbortSignal;
          const onAbort = (): void => {
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
          };
          signal.addEventListener("abort", onAbort);
          setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve(json({ data: [3, 4], next: null }));
          }, 250);
          // Fire the external cancellation now that our listener is armed — this must
          // reach the composed follow-up signal for the real (unmutated) code to win the race.
          abortClientRequests(CLIENT);
        });
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-list`, {});
      expect(r.isError).toBeUndefined();
      expect(JSON.parse(r.content[0].text ?? "").data).toEqual([1, 2]);
      expect(calls).toBe(2);
    },
  );

  test(
    "maxPages=1 makes the follow-up loop never execute at all, even with an endless cursor " +
      "(kills L261 MethodExpression Math.min -> Math.max: with max(1,100)=100 the loop would run " +
      "up to 99 follow-ups instead of the correct min(1,100)=1 meaning zero follow-ups)",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "cursor",
        itemsPath: "data",
        cursorResponsePath: "next",
        cursorParam: "cursor",
        maxPages: 1,
      });
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return json({ data: [calls], next: `c${calls}` }); // never-ending cursor
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-list`, {});
      expect(JSON.parse(r.content[0].text ?? "").data).toEqual([1]);
      expect(calls).toBe(1);
    },
  );

  test(
    "maxPages=3 fetches exactly 3 pages (1 primary + 2 follow-ups) against an endless cursor " +
      "(kills L262 full boundary set on 'page < limit' + UpdateOperator page--)",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "cursor",
        itemsPath: "data",
        cursorResponsePath: "next",
        cursorParam: "cursor",
        maxPages: 3,
      });
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return json({ data: [calls], next: `c${calls}` }); // never-ending cursor
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-list`, {});
      expect(JSON.parse(r.content[0].text ?? "").data).toEqual([1, 2, 3]);
      expect(calls).toBe(3);
    },
  );

  // NOTE — equivalent mutants, verified empirically (see round-2 harness notes):
  //
  // L308 StringLiteral default '' -> 'Stryker was here!' (the RECHECK's cursorResponsePath
  // default, distinct from L245's initial one) is unreachable in isolation. Both L245 and L308
  // read the exact same `cfg.cursorResponsePath` field via `?? ""`: when the field is configured,
  // `??` short-circuits and NEITHER default expression is ever evaluated (dead at both sites
  // simultaneously); when the field is omitted, L245's real (unmutated) default ALWAYS resolves
  // to `getByPath(obj, "")` = the whole parsed body object, whose typeof is never "string"/"number"
  // (a body that carries the required items array can only be an object or an array, both
  // typeof "object") — so nextCursorValue always returns null there, and `if (!cursor) break`
  // (L265) stops the loop before ANY follow-up fetch happens, meaning L308's recheck code can
  // never execute in that configuration either. The "cursorResponsePath omitted, page 1 body
  // poisoned with a field literally named 'Stryker was here!'" test above empirically confirms
  // this: even with the mutant's exact replacement string planted as a real top-level key, calls
  // stays 1 (proving page 2 is never reached) whenever cursorResponsePath is omitted and L245
  // itself is unmutated — which is exactly the situation Stryker's isolated-mutant run applies to
  // L308's mutant.
  //
  // L274 ConditionalExpression '!link -> false' (the link-strategy loop-top `if (!link) break`)
  // and L309 ConditionalExpression '!cursor -> false' (the cursor-strategy post-recheck
  // `if (!cursor) break`) are both masked by a redundant guard elsewhere in the same function:
  //   - L274: `link` is typed `string | null` and can only be falsy as `null` or `""`. Both
  //     `new URL(null)` and `new URL("")` throw ("<val> cannot be parsed as a URL" — verified via
  //     `bun -e`), and that throw is caught by the adjacent `try { linkUrl = new URL(link); }
  //     catch { break; }` (L276-280), which breaks the loop anyway. So whether L274 breaks first
  //     or the URL-parse catch does, the observable outcome (zero further fetches, identical
  //     aggregate) is the same.
  //   - L309: even if this break is skipped, the loop's OWN top-of-iteration guard for cursor
  //     strategy, `if (cfg.strategy === "cursor") { if (!cursor) break; ... }` (L264-265), is
  //     unmutated and re-checks the SAME `cursor` value (already set to null by the unmutated
  //     L308 one line earlier) on the very next iteration, before any URL is built or fetch is
  //     attempted — so no extra network call or aggregate change ever occurs either way. A
  //     side-by-side `bun -e` simulation of both control-flow variants against the same 2-page
  //     mock dataset produced byte-identical `{ calls, all }` results for both, confirming there
  //     is no input that distinguishes them through the public API.
  //
  // L312 ConditionalExpression '!link -> false' (the link-strategy post-recheck `if (!link)
  // break`, mirroring L309 for the cursor strategy) is equivalent by the identical argument:
  // skipping this break just lets the for-loop reach the next iteration, whose OWN
  // top-of-iteration guard at L274 (`if (cfg.strategy === "link") { if (!link) break; }`,
  // unmutated) re-checks the SAME now-null `link` value (set one line earlier at L311) before
  // any URL is built or fetch attempted — so the loop still terminates after the exact same
  // number of fetches either way.
  //
  // L236 BlockStatement '{}' (the primary-body JSON.parse catch, `catch { return null; }` ->
  // `catch {}`) is equivalent for the same "redundant guard one line later" shape as L292/L308.
  // Emptying the catch block doesn't re-throw or swallow silently forever — it just lets
  // execution fall through past the try/catch with `firstBody` still `undefined` (its
  // `let firstBody: unknown;` declaration is never assigned on the parse-failure path). The very
  // next statement, `extractItems(firstBody, cfg.itemsPath)` (L239), receives `undefined` and
  // returns falsy for any itemsPath (property access and array traversal on `undefined` both
  // short-circuit to `undefined` rather than throwing), which trips the existing
  // `if (!firstItems || firstItems.length === 0) return null;` guard at L240 one line later —
  // the exact same `return null` outcome the unmutated catch block produces directly. The
  // "a non-JSON first page leaves the original raw text untouched" test above already exercises
  // this path (JSON.parse throws on `"not-json-at-all{{"`) and passes identically whether the
  // catch block executes explicitly or falls through to the L240 guard.
});

// ---------------------------------------------------------------------------
// Page strategy
// ---------------------------------------------------------------------------
describe("fetchAllPages — page strategy", () => {
  test(
    "page numbers increment 2, 3, ... and stop on the first empty page " +
      "(kills L269 branch selection, L271 pageParam default LogicalOperator+StringLiteral, " +
      "L313 BlockStatement->'{}' (pageNum would never advance) and L314 UpdateOperator pageNum--)",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "page",
        itemsPath: "items",
        maxPages: 5,
      });
      let calls = 0;
      const seenPages: (string | null)[] = [];
      globalThis.fetch = (async (url: string) => {
        calls++;
        const p = new URL(String(url)).searchParams.get("page");
        seenPages.push(p);
        if (!p) return json({ items: [1, 2] });
        if (p === "2") return json({ items: [3] });
        return json({ items: [] });
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-list`, {});
      expect(r.isError).toBeUndefined();
      expect(JSON.parse(r.content[0].text ?? "").items).toEqual([1, 2, 3]);
      expect(calls).toBe(3);
      // The follow-up sequence must be exactly page=2 then page=3 — a
      // decrement (page--) or a stuck-at-2 (empty else branch) would diverge.
      expect(seenPages).toEqual([null, "2", "3"]);
    },
  );

  test(
    "page strategy never invokes the cursor/link extraction helpers, even though their initial " +
      "computation is gated by ternaries that (if broken) would call them regardless of strategy " +
      "(kills L245 ConditionalExpression 'cfg.strategy===\"cursor\" -> true' and L246 " +
      "ConditionalExpression 'cfg.strategy===\"link\" -> true': the resulting `cursor`/`link` " +
      "local variables are only ever READ inside their own strategy's branches, so forcing either " +
      "ternary to always take its true branch has no effect on the final aggregate or call count — " +
      "the only way to observe it is that nextCursorValue/parseNextLink would be CALLED at all, " +
      "which is exactly what these spies pin down)",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "page",
        itemsPath: "items",
        maxPages: 5,
      });
      const cursorSpy = spyOn(pagination, "nextCursorValue");
      const linkSpy = spyOn(pagination, "parseNextLink");
      try {
        let calls = 0;
        globalThis.fetch = (async (url: string) => {
          calls++;
          const p = new URL(String(url)).searchParams.get("page");
          if (!p) return json({ items: [1, 2] });
          if (p === "2") return json({ items: [3] });
          return json({ items: [] });
        }) as unknown as typeof fetch;
        const r = await proxyToolCall(`${CLIENT}__get-list`, {});
        expect(r.isError).toBeUndefined();
        expect(JSON.parse(r.content[0].text ?? "").items).toEqual([1, 2, 3]);
        expect(calls).toBe(3);
        expect(cursorSpy).not.toHaveBeenCalled();
        expect(linkSpy).not.toHaveBeenCalled();
      } finally {
        cursorSpy.mockRestore();
        linkSpy.mockRestore();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Link strategy
// ---------------------------------------------------------------------------
describe("fetchAllPages — link strategy", () => {
  test(
    "follows rel=next on the same host across 3 pages, stopping when no Link header is returned " +
      "(kills L246 branch selection, L249-258 fetchPage call/return shape, L273/L274 else-branch and " +
      "!link guard, L276/L278 URL-parse try/catch, L310/L312 re-check branch + !link guard)",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", { enabled: true, strategy: "link", itemsPath: "", maxPages: 10 });
      let calls = 0;
      globalThis.fetch = (async (url: string) => {
        calls++;
        const p = new URL(String(url)).searchParams.get("page");
        if (!p) return json([1, 2], { link: '<http://1.2.3.4/list?page=2>; rel="next"' });
        if (p === "2") return json([3, 4], { link: '<http://1.2.3.4/list?page=3>; rel="next"' });
        return json([5]); // no Link header -> must stop here
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-list`, {});
      expect(r.isError).toBeUndefined();
      expect(JSON.parse(r.content[0].text ?? "")).toEqual([1, 2, 3, 4, 5]);
      expect(calls).toBe(3);
    },
  );

  test(
    "a cross-host link next URL is NOT followed (SSRF-safe) " +
      "(kills L281 full boundary set on 'linkUrl.host !== ctx.originalHost')",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", { enabled: true, strategy: "link", itemsPath: "", maxPages: 10 });
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return json([1, 2], { link: '<http://9.9.9.9/list?page=2>; rel="next"' });
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-list`, {});
      expect(r.isError).toBeUndefined();
      expect(JSON.parse(r.content[0].text ?? "")).toEqual([1, 2]);
      expect(calls).toBe(1);
    },
  );

  test(
    "a malformed Link next URL stops aggregation gracefully instead of crashing the call " +
      "(kills L276 BlockStatement->'{}' and L278 catch->break: without the break, using the " +
      "never-assigned linkUrl throws and the whole tool call would fail instead of degrading)",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", { enabled: true, strategy: "link", itemsPath: "", maxPages: 10 });
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        // Not a parseable absolute URL — new URL(...) throws.
        return json([1, 2], { link: '<::not a url::>; rel="next"' });
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-list`, {});
      expect(r.isError).toBeUndefined();
      expect(JSON.parse(r.content[0].text ?? "")).toEqual([1, 2]);
      expect(calls).toBe(1);
    },
  );

  test(
    "the primary response has NO Link header at all -> zero follow-up fetches are attempted " +
      "(regression coverage for L274's loop-top '!link' guard on its very first evaluation; see " +
      "the equivalence note in the cursor-strategy block above for why L274's ConditionalExpression " +
      "'-> false' mutant can't actually be distinguished here: `link` can only be falsy as `null` " +
      "or `''`, and `new URL(...)` throws for both — caught by the adjacent try/catch which breaks " +
      "the loop anyway — so this test protects real behavior without being a kill for that mutant)",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", { enabled: true, strategy: "link", itemsPath: "", maxPages: 10 });
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return json([1, 2]); // no Link header on the primary response
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-list`, {});
      expect(r.isError).toBeUndefined();
      expect(JSON.parse(r.content[0].text ?? "")).toEqual([1, 2]);
      expect(calls).toBe(1);
    },
  );
});

// ---------------------------------------------------------------------------
// Pagination silently skipped: non-paginable first body
// ---------------------------------------------------------------------------
describe("fetchAllPages — first body not paginable", () => {
  test(
    "a non-JSON first page leaves the original raw text untouched (kills L234 JSON.parse try; " +
      "L236's catch->'{}' is an equivalent mutant here — see notes)",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "cursor",
        itemsPath: "data",
        cursorResponsePath: "next",
        cursorParam: "cursor",
        maxPages: 10,
      });
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return new Response("not-json-at-all{{", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-list`, {});
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toBe("not-json-at-all{{");
      expect(calls).toBe(1);
    },
  );

  test(
    "an empty items array on the first page leaves the original body untouched " +
      "(kills L240 empty-items half of the full guard set)",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "cursor",
        itemsPath: "data",
        cursorResponsePath: "next",
        cursorParam: "cursor",
        maxPages: 10,
      });
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return json({ data: [], next: "c1" });
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-list`, {});
      expect(r.isError).toBeUndefined();
      expect(JSON.parse(r.content[0].text ?? "").data).toEqual([]);
      expect(calls).toBe(1);
    },
  );

  test(
    "itemsPath pointing at a non-array field leaves the original body untouched " +
      "(kills L240 absent/non-array half of the full guard set, and L242's ArrayDeclaration " +
      "would be unreachable here since fetchAllPages returns null before constructing `all`)",
    async () => {
      await reg();
      setPaginationConfig(CLIENT, "get-list", {
        enabled: true,
        strategy: "cursor",
        itemsPath: "data",
        cursorResponsePath: "next",
        cursorParam: "cursor",
        maxPages: 10,
      });
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return json({ data: "not-an-array", next: "c1" });
      }) as unknown as typeof fetch;
      const r = await proxyToolCall(`${CLIENT}__get-list`, {});
      expect(r.isError).toBeUndefined();
      expect(JSON.parse(r.content[0].text ?? "").data).toBe("not-an-array");
      expect(calls).toBe(1);
    },
  );
});

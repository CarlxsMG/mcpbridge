/**
 * Stryker mutation backstop — cluster C9 (proxy.ts L816-936): pinned-IP
 * resolution (LB / canary / primary + TTL re-resolution via
 * refreshPinIfStale), the second isDeleting recheck, in-flight tracking,
 * URL/body construction per HTTP method, upstream auth headers + OAuth
 * bearer injection, idempotent-method + retry-eligibility determination,
 * and the exponential-backoff retry delay formula.
 *
 * Every test drives proxyToolCall(...) — proxy.ts exports nothing else.
 * Each client name is unique per test (prefix mutC9pin) so pinnedIpCache /
 * load-balancer inflight state can never leak between tests or clash with
 * another cluster's own test file.
 *
 * NOTE on the SECOND `isDeleting(client.name)` recheck (deep inside runRest,
 * post-Ajv-validation, pre-fetch — do not confuse with the FIRST check near
 * the top of dispatchToolCall, C4's territory): its
 * ConditionalExpression->'false' / StringLiteral->'""' / ObjectLiteral->'{}' /
 * BooleanLiteral->'false' mutants are proven EQUIVALENT through the public
 * API, not chased with a dedicated test here — see the identical structural
 * argument documented in proxy-mutation-c4-gates-auth.test.ts's header
 * (teardownLiveClient's zero-internal-await synchronous body means the
 * `deletingClients.add`/`delete` pair always completes within a single
 * microtask turn, so no external poll can ever observe the true-window at
 * EITHER isDeleting() call site).
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { registry } from "../../mcp/registry.js";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import type { RestToolDefinition } from "../../mcp/types.js";
import {
  setLb,
  addUpstream,
  incInflight,
  decInflight,
  __resetLbForTesting,
} from "../../tool-policies/load-balancer.js";
import * as loadBalancer from "../../tool-policies/load-balancer.js";
import { setCanary } from "../../tool-policies/canary.js";
import { setUpstreamAuth } from "../../backend-auth/upstream-auth.js";
import * as upstreamAuth from "../../backend-auth/upstream-auth.js";
import { setClientOAuth, __setOAuthDepsForTesting, __resetOAuthForTesting } from "../../backend-auth/oauth.js";

const CLIENT = "mutc9pin";

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

/** Registers a client whose health_url/ip/base_url/resolved_ip all share `baseHost`. */
async function reg(
  name: string,
  tools: RestToolDefinition[] = [makeTool()],
  baseHost = "1.2.3.4",
  retryNonSafe = false,
): Promise<void> {
  await registry.register(
    name,
    tools,
    `http://${baseHost}/health`,
    baseHost,
    `http://${baseHost}`,
    baseHost,
    retryNonSafe,
  );
}

function okFetch(body: unknown = { ok: true }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const originalFetch = globalThis.fetch;
const originalSecretKey = config.secretEncryptionKey;

function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  (config as Record<string, unknown>).retryBaseDelayMs = 1;
  (config as Record<string, unknown>).secretEncryptionKey = originalSecretKey;
  __resetDbForTesting();
  __resetLbForTesting();
  __resetOAuthForTesting();
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

// ---------------------------------------------------------------------------
// Pin-IP cache seeding — first-ever access to a client name (L826, L827, L830)
// ---------------------------------------------------------------------------

describe("pin-IP cache seeding on first access (L826-827, L830)", () => {
  const NAME = `${CLIENT}-seed`;

  // Kills L826 Conditional (`if (!pinnedIpCache.has(client.name))` forced to
  // always-true or always-false) and L827 ObjectLiteral '{}': a
  // fresh-to-this-Map client name MUST seed the cache from client.resolved_ip
  // on the very first call (skipping the seed, or seeding `{}`, leaves `pin`
  // undefined and the subsequent `pinIp = pin.ip` throws) — and a second call
  // must reuse the exact same resolved_ip without any observable change.
  test("first-ever call seeds the pin cache from client.resolved_ip; a second call reuses it", async () => {
    await reg(NAME);
    const hosts: string[] = [];
    globalThis.fetch = (async (url: string) => {
      hosts.push(new URL(String(url)).hostname);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const r1 = await proxyToolCall(`${NAME}__get-item`, {});
    expect(r1.isError).toBeUndefined();
    const r2 = await proxyToolCall(`${NAME}__get-item`, {});
    expect(r2.isError).toBeUndefined();

    expect(hosts).toEqual(["1.2.3.4", "1.2.3.4"]);
  });
});

// ---------------------------------------------------------------------------
// Second isDeleting recheck (L851-852) — EQUIVALENT, verified empirically.
//
// teardownLiveClient() in mcp/registry.ts (`deletingClients.add(name)` ...
// `deletingClients.delete(name)`) contains NO `await` between the add and
// the delete — every step in between (abortClientRequests, the *unawaited*
// `void mcpUpstream.disconnect(...)`, removeCircuitBreaker, tool-index
// cleanup, notifyToolsChanged) is fully synchronous. Per JS run-to-completion
// semantics, a synchronous span with no internal `await` can NEVER be
// observed mid-flight by any other concurrently-running async function —
// there is no yield point for proxyToolCall's own (unrelated) awaits to
// interleave into. Confirmed with a standalone timing simulation (`bun -e`)
// mirroring the exact shape (sync set/delete critical section raced against
// a slow real async await point, e.g. a DNS-shaped `setTimeout`): the flag
// was observed `false` both immediately before AND immediately after the
// slow await resumed, in every run — the `true` window is structurally
// unobservable from outside. This makes L852's three result-construction
// mutants (StringLiteral->'""', ObjectLiteral->'{}', BooleanLiteral->'false'
// on the `toolResult("Client is being unregistered", { isError: true })`
// call) equivalent together with the branch's own already-documented
// unreachability: since the branch can never execute, what it constructs
// when mutated is unobservable. Left deliberately unkilled.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LB-guard on incInflight (L856) — a plain, non-LB primary call must never
// touch the LB in-flight counter at all.
// ---------------------------------------------------------------------------

describe("incInflight is only called when lbKey is defined (L856)", () => {
  const NAME = `${CLIENT}-nolb-inflight`;

  test("a plain client with no LB pool configured never calls incInflight", async () => {
    await reg(NAME);
    globalThis.fetch = okFetch();

    const incSpy = spyOn(loadBalancer, "incInflight");
    try {
      const r = await proxyToolCall(`${NAME}__get-item`, {});
      expect(r.isError).toBeUndefined();
      // If L856's `if (lbKey)` were forced to always-true, incInflight would
      // be invoked here even though lbChoice (and thus lbKey) is undefined
      // for a plain, non-LB-configured client.
      expect(incSpy).not.toHaveBeenCalled();
    } finally {
      incSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// LB pin-IP branch (L818) — distinguishes lbChoice.resolvedIp from the
// client's own resolved_ip / the primary-else-branch seed.
// ---------------------------------------------------------------------------

describe("LB pin-IP branch: lbChoice.resolvedIp is used, not client.resolved_ip (L818)", () => {
  const NAME = `${CLIENT}-lb`;

  test("least-conn routes away from a busy primary to the pool member's own pinned IP", async () => {
    await reg(NAME);
    await addUpstream(NAME, "http://5.6.7.9", 1);
    setLb(NAME, { strategy: "least-conn", primaryWeight: 1, enabled: true });

    // Make the primary look busier than the pool member before selection runs.
    incInflight(`${NAME}#http://1.2.3.4`);

    let lastHost = "";
    globalThis.fetch = (async (url: string) => {
      lastHost = new URL(String(url)).hostname;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const r = await proxyToolCall(`${NAME}__get-item`, {});
    expect(r.isError).toBeUndefined();
    // If L818's `if (lbChoice)` were forced false, or its body emptied, the
    // request would fall through to the client's own resolved_ip (1.2.3.4)
    // instead of the LB-selected pool member's pinned IP (5.6.7.9).
    expect(lastHost).toBe("5.6.7.9");

    decInflight(`${NAME}#http://1.2.3.4`);
  });
});

// ---------------------------------------------------------------------------
// Canary secondary pin-IP branch (L822-823)
// ---------------------------------------------------------------------------

describe("canary secondary pin-IP branch: canary.secondaryResolvedIp is used (L822-823)", () => {
  const NAME = `${CLIENT}-canary`;

  test("canary at 100% routes to the secondary's own pinned IP, not the client's", async () => {
    await reg(NAME);
    await setCanary(NAME, { secondaryBaseUrl: "http://5.6.7.10", mode: "canary", weight: 100, enabled: true });

    let lastHost = "";
    globalThis.fetch = (async (url: string) => {
      lastHost = new URL(String(url)).hostname;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const r = await proxyToolCall(`${NAME}__get-item`, {});
    expect(r.isError).toBeUndefined();
    // If L822's `else if (route.useSecondary)` were forced false, or its
    // BlockStatement (L823) emptied, this would fall through to the primary
    // client resolved_ip (1.2.3.4) instead of the canary secondary (5.6.7.10).
    expect(lastHost).toBe("5.6.7.10");
  });
});

// ---------------------------------------------------------------------------
// isRawIpLiteral gate (L833): a literal-IP base_url must NEVER be routed
// through refreshPinIfStale, even once the cached pin looks stale — verified
// without any real DNS lookup by using a literal PRIVATE IP: if the gate were
// bypassed, refreshPinIfStale's internal validateBackendUrl would reject it.
// ---------------------------------------------------------------------------

describe("literal-IP hosts skip TTL re-resolution even once stale (L833)", () => {
  const NAME = `${CLIENT}-literal-stale`;

  test("a literal-IP base_url keeps working after the 5-minute TTL window elapses", async () => {
    await registry.register(
      NAME,
      [makeTool()],
      "http://127.0.0.1/health",
      "127.0.0.1",
      "http://127.0.0.1",
      "127.0.0.1",
    );
    globalThis.fetch = okFetch();

    const r1 = await proxyToolCall(`${NAME}__get-item`, {});
    expect(r1.isError).toBeUndefined();

    // Force the pin to look stale on the next call by mocking Date.now() far
    // beyond IP_PIN_TTL_MS (5 minutes) past the moment it was seeded.
    const future = Date.now() + 6 * 60 * 1000;
    const dateSpy = spyOn(Date, "now").mockReturnValue(future);
    try {
      const r2 = await proxyToolCall(`${NAME}__get-item`, {});
      // Correct code: hostname "127.0.0.1" is a raw IP literal, so the
      // re-resolution branch (L834-841) is skipped unconditionally regardless
      // of staleness -> still succeeds. If L833's isRawIpLiteral() result
      // were forced to `false` (or the whole gate negated), a "stale" literal
      // pin would incorrectly flow into refreshPinIfStale ->
      // validateBackendUrl("http://127.0.0.1/", ...) -> rejected as a
      // blocked private range -> isError:true.
      expect(r2.isError).toBeUndefined();
    } finally {
      dateSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Hostname (non-literal) clients: staleness genuinely triggers re-resolution
// via refreshPinIfStale, and a private/loopback result is rejected as a
// DNS-rebind (L834, L837, L839). Uses "localhost", which resolves locally
// without needing external network access.
// ---------------------------------------------------------------------------

describe("hostname clients actually re-resolve once stale, and reject a private-IP rebind (L834, L837, L839)", () => {
  const NAME = `${CLIENT}-hostname-stale`;

  test("a stale pin for a hostname base_url that now resolves to a loopback IP is rejected", async () => {
    await registry.register(NAME, [makeTool()], "http://1.2.3.4/health", "1.2.3.4", "http://localhost", "127.0.0.1");
    globalThis.fetch = okFetch();

    // Fresh pin -> refreshPinIfStale short-circuits before any DNS lookup.
    const r1 = await proxyToolCall(`${NAME}__get-item`, {});
    expect(r1.isError).toBeUndefined();

    const future = Date.now() + 6 * 60 * 1000;
    const dateSpy = spyOn(Date, "now").mockReturnValue(future);
    try {
      const r2 = await proxyToolCall(`${NAME}__get-item`, {});
      // "localhost" resolves to a loopback address -> blocked private range ->
      // refreshPinIfStale throws -> proxy.ts's catch (L837-839) returns the
      // "now resolves to private IP" error instead of a bare Failed-to-reach.
      expect(r2.isError).toBe(true);
      expect(r2.content[0].text).toMatch(/private ip/i);
    } finally {
      dateSpy.mockRestore();
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// GET query-string construction (L858-865)
// ---------------------------------------------------------------------------

describe("GET query-string construction (L858-865)", () => {
  const NAME = `${CLIENT}-get-query`;

  test("non-empty args are appended as a '?'-prefixed query string; empty args add no '?'", async () => {
    await reg(NAME, [
      makeTool({
        name: "get-item",
        method: "GET",
        endpoint: "/item",
        inputSchema: { type: "object", properties: { foo: { type: "string" }, n: { type: "number" } } },
      }),
    ]);
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = String(url);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const r1 = await proxyToolCall(`${NAME}__get-item`, { foo: "bar", n: 42 });
    expect(r1.isError).toBeUndefined();
    expect(capturedUrl).toContain("?");
    expect(capturedUrl).toContain("foo=bar");
    expect(capturedUrl).toContain("n=42");

    const r2 = await proxyToolCall(`${NAME}__get-item`, {});
    expect(r2.isError).toBeUndefined();
    expect(capturedUrl.includes("?")).toBe(false);
  });

  // Kills L858's ConditionalExpression->'false' and StringLiteral->'""'
  // survivors: `method === "GET" || method === "DELETE"` must match DELETE
  // too, not just GET. If either the whole condition were forced false, or
  // the "DELETE" (or "GET") literal blanked to "", a DELETE call would fall
  // through to the body-building branches below instead of appending a query
  // string, and this URL assertion would fail.
  test("a DELETE call also appends its args as a '?'-prefixed query string, not a body", async () => {
    const NAME = `${CLIENT}-delete-query`;
    await reg(NAME, [
      makeTool({
        name: "del-item",
        method: "DELETE",
        endpoint: "/item",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
      }),
    ]);
    let capturedUrl = "";
    let capturedBody: BodyInit | null | undefined;
    globalThis.fetch = (async (url: string, opts?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = opts?.body;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const r = await proxyToolCall(`${NAME}__del-item`, { id: "x" });
    expect(r.isError).toBeUndefined();
    expect(capturedUrl).toContain("?");
    expect(capturedUrl).toContain("id=x");
    expect(capturedBody).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DELETE / PUT retry opt-in via client.retry_non_safe_methods (L888-890)
// ---------------------------------------------------------------------------

describe("DELETE retry eligibility depends on retry_non_safe_methods (L888-890)", () => {
  test("DELETE without retry_non_safe_methods does not retry a transient 503", async () => {
    const NAME = `${CLIENT}-delete-off`;
    await reg(NAME, [makeTool({ name: "del-item", method: "DELETE", endpoint: "/item" })], "1.2.3.4", false);
    (config as Record<string, unknown>).retryMaxAttempts = 2;
    (config as Record<string, unknown>).retryBaseDelayMs = 1;
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response("down", { status: 503 });
    }) as unknown as typeof fetch;

    const r = await proxyToolCall(`${NAME}__del-item`, { id: "x" });
    expect(r.isError).toBe(true);
    // Not opted in -> DELETE is not idempotent here -> single attempt only.
    expect(callCount).toBe(1);
  });

  test("DELETE with retry_non_safe_methods=true retries a transient 503 and then succeeds", async () => {
    const NAME = `${CLIENT}-delete-on`;
    await reg(NAME, [makeTool({ name: "del-item", method: "DELETE", endpoint: "/item" })], "1.2.3.4", true);
    (config as Record<string, unknown>).retryMaxAttempts = 1;
    (config as Record<string, unknown>).retryBaseDelayMs = 1;
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount === 1) return new Response("down", { status: 503 });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const r = await proxyToolCall(`${NAME}__del-item`, { id: "x" });
    expect(r.isError).toBeUndefined();
    expect(callCount).toBe(2);
  });

  // Kills L889's "PUT" leg specifically: the DELETE-on/off tests above only
  // exercise the "DELETE" string literal in
  // `client.retry_non_safe_methods === true && (method === "DELETE" || method === "PUT")`.
  // If the "PUT" literal were blanked to "" (or that whole OR-leg forced
  // false) while "DELETE" stayed intact, a PUT call would silently stop
  // being eligible for opt-in retries and this test would observe a single
  // attempt instead of two.
  test("PUT with retry_non_safe_methods=true retries a transient 503 and then succeeds", async () => {
    const NAME = `${CLIENT}-put-on`;
    await reg(NAME, [makeTool({ name: "put-item", method: "PUT", endpoint: "/item" })], "1.2.3.4", true);
    (config as Record<string, unknown>).retryMaxAttempts = 1;
    (config as Record<string, unknown>).retryBaseDelayMs = 1;
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount === 1) return new Response("down", { status: 503 });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const r = await proxyToolCall(`${NAME}__put-item`, { name: "x" });
    expect(r.isError).toBeUndefined();
    expect(callCount).toBe(2);
  });
});

// Kills L888's "GET" leg of `alwaysSafe = method === "GET" || method === "HEAD" || method === "OPTIONS"`
// in isolation from the exponential-backoff timing test above: forcing just
// the "GET" leg to `false` (StringLiteral->'""') or the whole disjunction to
// `false` (ConditionalExpression->'false') leaves alwaysSafe permanently
// false for a real GET call, dropping isIdempotent to `optedIn` (also false,
// since GET isn't DELETE/PUT) -> a single attempt only. This assertion is a
// pure call-count check, independent of any elapsed-time tolerance. The
// HEAD/OPTIONS legs of the same disjunction are pinned down separately below
// (HEAD/OPTIONS tools can't be *registered* through the real API, so those
// two tests use a different technique — see the comment there).
describe("GET retry eligibility does not depend on retry_non_safe_methods (L888)", () => {
  test("a plain GET client (retry_non_safe_methods left unset) still retries a transient 503", async () => {
    const NAME = `${CLIENT}-get-alwayssafe`;
    await reg(NAME, [makeTool({ name: "get-item", method: "GET", endpoint: "/item" })], "1.2.3.4", false);
    (config as Record<string, unknown>).retryMaxAttempts = 1;
    (config as Record<string, unknown>).retryBaseDelayMs = 1;
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount === 1) return new Response("down", { status: 503 });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const r = await proxyToolCall(`${NAME}__get-item`, {});
    expect(r.isError).toBeUndefined();
    expect(callCount).toBe(2);
  });
});

describe("POST is never retried regardless of retry_non_safe_methods (L888-890)", () => {
  test("POST does not retry a transient 503 even with retry_non_safe_methods=true", async () => {
    const NAME = `${CLIENT}-post-noretry`;
    await reg(NAME, [makeTool({ name: "create-item", method: "POST", endpoint: "/item" })], "1.2.3.4", true);
    (config as Record<string, unknown>).retryMaxAttempts = 2;
    (config as Record<string, unknown>).retryBaseDelayMs = 1;
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response("down", { status: 503 });
    }) as unknown as typeof fetch;

    const r = await proxyToolCall(`${NAME}__create-item`, { name: "x" });
    expect(r.isError).toBe(true);
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// alwaysSafe also matches HEAD and OPTIONS, not just GET (L888) — closes the
// two remaining survivors left open by the GET/DELETE/PUT/POST tests above
// (which only pin down the "GET" leg, plus the retry_non_safe_methods
// opt-in path): a ConditionalExpression->'false' on each of the
// `method === "HEAD"` / `method === "OPTIONS"` legs, and a StringLiteral->''
// on one of those two literals.
//
// registry.register()'s VALID_METHODS gate (mcp/registry.ts) rejects any
// tool whose method isn't one of GET/POST/PUT/PATCH/DELETE — HEAD and
// OPTIONS can never reach runRest through any real registration path
// (manual registration, cURL/Postman import, and OpenAPI discovery all
// funnel through register()). To exercise L888's HEAD/OPTIONS legs
// directly, register a normal GET tool, then mutate the LIVE registered
// tool object's `.method` in place: resolveTool() looks the tool up by
// reference from `client.tools` (`client.tools.find(...)` in
// mcp/registry.ts), so runRest sees whatever `.method` value sits on that
// object at call time, regardless of how it originally got there.
// `tool.method.toUpperCase()` (proxy.ts L848) operates on a plain `string`
// at runtime — TypeScript's literal-union typing on RestToolDefinition is
// compile-time only — so this is a faithful exercise of the real L888
// comparison, not a fabricated code path.
// ---------------------------------------------------------------------------

describe("alwaysSafe also matches HEAD and OPTIONS, not just GET (L888)", () => {
  test("a HEAD-method tool retries a transient 503 even with retry_non_safe_methods unset", async () => {
    const NAME = `${CLIENT}-head-alwayssafe`;
    await reg(NAME, [makeTool({ name: "head-item", method: "GET", endpoint: "/item" })], "1.2.3.4", false);
    const client = registry.getClient(NAME)!;
    (client.tools[0] as { method: string }).method = "HEAD";

    (config as Record<string, unknown>).retryMaxAttempts = 1;
    (config as Record<string, unknown>).retryBaseDelayMs = 1;
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount === 1) return new Response("down", { status: 503 });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const r = await proxyToolCall(`${NAME}__head-item`, {});
    // Real code: alwaysSafe is true for HEAD -> isIdempotent true -> the
    // failed first attempt is retried and the second attempt succeeds. A
    // `method === "HEAD"` ConditionalExpression->false mutant (or a
    // StringLiteral->'' on the "HEAD" literal) drops alwaysSafe to false
    // here — this client never opted in via retry_non_safe_methods, and
    // HEAD isn't DELETE/PUT either, so optedIn is false too -> single
    // attempt only -> isError:true.
    expect(r.isError).toBeUndefined();
    expect(callCount).toBe(2);
  });

  test("an OPTIONS-method tool retries a transient 503 even with retry_non_safe_methods unset", async () => {
    const NAME = `${CLIENT}-options-alwayssafe`;
    await reg(NAME, [makeTool({ name: "options-item", method: "GET", endpoint: "/item" })], "1.2.3.4", false);
    const client = registry.getClient(NAME)!;
    (client.tools[0] as { method: string }).method = "OPTIONS";

    (config as Record<string, unknown>).retryMaxAttempts = 1;
    (config as Record<string, unknown>).retryBaseDelayMs = 1;
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount === 1) return new Response("down", { status: 503 });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const r = await proxyToolCall(`${NAME}__options-item`, {});
    // Same reasoning as the HEAD test above, pinned to the "OPTIONS" leg
    // specifically: a ConditionalExpression->false or StringLiteral->'' on
    // `method === "OPTIONS"` would drop alwaysSafe (and thus isIdempotent)
    // to false, leaving only a single attempt.
    expect(r.isError).toBeUndefined();
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// RETRYABLE_STATUSES + retry loop boundary + exponential backoff formula
// (L892, L900-905)
// ---------------------------------------------------------------------------

describe("GET retries a 503 and waits a real exponential-backoff delay (L892, L900-905)", () => {
  test("succeeds on the second attempt after waiting >= BASE_DELAY ms", async () => {
    const NAME = `${CLIENT}-get-retry`;
    await reg(NAME, [makeTool({ name: "get-item", method: "GET", endpoint: "/item" })]);
    (config as Record<string, unknown>).retryMaxAttempts = 1;
    (config as Record<string, unknown>).retryBaseDelayMs = 50;
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount === 1) return new Response("down", { status: 503 });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const start = Date.now();
    const r = await proxyToolCall(`${NAME}__get-item`, {});
    const elapsed = Date.now() - start;

    expect(r.isError).toBeUndefined();
    expect(callCount).toBe(2);
    // Kills L900 (attempt-- instead of attempt++ — would make `attempt > 0`
    // false on the retry, skipping the delay entirely) and the L904
    // arithmetic mutants that would grossly under/over-scale the formula
    // `BASE_DELAY * 2^(attempt-1) + rand*BASE_DELAY` (at attempt=1 this is
    // BASE_DELAY..2*BASE_DELAY). Also kills L892 (RETRYABLE_STATUSES emptied
    // -> 503 would never be retried -> callCount would stay 1).
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(50 * 5);
  });
});

describe("no artificial delay before the first attempt (L903)", () => {
  test("a call that succeeds immediately does not wait a backoff delay", async () => {
    const NAME = `${CLIENT}-nodelay`;
    await reg(NAME, [makeTool({ name: "get-item", method: "GET", endpoint: "/item" })]);
    (config as Record<string, unknown>).retryMaxAttempts = 1;
    (config as Record<string, unknown>).retryBaseDelayMs = 200;
    globalThis.fetch = okFetch();

    const start = Date.now();
    const r = await proxyToolCall(`${NAME}__get-item`, {});
    const elapsed = Date.now() - start;

    expect(r.isError).toBeUndefined();
    // If L903's `if (attempt > 0)` were forced true, the first attempt would
    // incur an unwanted ~200ms delay before ever calling fetch.
    expect(elapsed).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// Exponential-backoff delay formula grows correctly across attempts (L904):
// `BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * BASE_DELAY`.
//
// Records every `ms` argument passed to the global setTimeout while active,
// delegating to the real timer so awaited promises still resolve normally —
// same technique as spyOnSetTimeoutDelays in
// proxy-mutation-c11-error-retry.test.ts, reproduced locally here since
// each mutation-cluster test file is self-contained.
// ---------------------------------------------------------------------------

function spyOnSetTimeoutDelays(): { delays: unknown[]; restore: () => void } {
  const original = globalThis.setTimeout;
  const delays: unknown[] = [];
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
    fn: (...args: unknown[]) => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    delays.push(ms);
    return original(fn as never, ms, ...rest);
  }) as typeof setTimeout;
  return {
    delays,
    restore: () => {
      globalThis.setTimeout = original;
    },
  };
}

describe("exponential-backoff delay formula grows correctly across attempts (L904)", () => {
  test("attempt 1's delay falls in [BASE_DELAY, 2*BASE_DELAY) and attempt 2's in [2*BASE_DELAY, 3*BASE_DELAY)", async () => {
    const NAME = `${CLIENT}-backoff-growth`;
    await reg(NAME, [makeTool({ name: "get-item", method: "GET", endpoint: "/item" })]);
    (config as Record<string, unknown>).retryMaxAttempts = 2;
    const BASE_DELAY = 10;
    (config as Record<string, unknown>).retryBaseDelayMs = BASE_DELAY;

    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      // Fail the first two attempts (attempt 0 and attempt 1) so both the
      // attempt-1 and attempt-2 retry delays get computed and awaited;
      // succeed on the third (attempt 2).
      if (callCount <= 2) return new Response("down", { status: 503 });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const { delays, restore } = spyOnSetTimeoutDelays();
    try {
      const r = await proxyToolCall(`${NAME}__get-item`, {});
      expect(r.isError).toBeUndefined();
      expect(callCount).toBe(3);
      expect(delays.length).toBe(2);

      const [delay1, delay2] = delays;
      expect(typeof delay1).toBe("number");
      expect(typeof delay2).toBe("number");

      // Real: attempt=1 -> BASE_DELAY*2^0 + jitter[0,BASE_DELAY) = [10, 20).
      // The `*` -> `-` mutant (BASE_DELAY - 2^(attempt-1) + jitter) instead
      // gives [9, 19) here — overlapping, so this bound alone doesn't
      // reliably kill it, but it does pin the real formula's shape and
      // combines with the attempt-2 bound below (which the `-` mutant can
      // never satisfy) to kill it deterministically.
      expect(delay1 as number).toBeGreaterThanOrEqual(BASE_DELAY);
      expect(delay1 as number).toBeLessThan(BASE_DELAY * 2);

      // Real: attempt=2 -> BASE_DELAY*2^1 + jitter[0,BASE_DELAY) = [20, 30).
      // The `*` -> `-` mutant instead gives BASE_DELAY - 2 + jitter =
      // [8, 18) here (max 18 < 20) and a structural `/`-based mutant
      // (BASE_DELAY / Math.pow(2, attempt-1), losing the jitter term and
      // inverting growth) gives exactly 5 — neither can ever land in
      // [20, 30), so this bound alone deterministically kills both L904
      // ArithmeticOperator mutants regardless of Math.random()'s draw.
      expect(delay2 as number).toBeGreaterThanOrEqual(BASE_DELAY * 2);
      expect(delay2 as number).toBeLessThan(BASE_DELAY * 3);

      // Real exponential growth: attempt 2's delay is always >= attempt 1's
      // (the ranges [10,20) and [20,30) don't overlap). A mutant that
      // inverts growth direction (division instead of multiplication)
      // would shrink instead of grow.
      expect(delay2 as number).toBeGreaterThan(delay1 as number);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// fetchOptions body vs no-body shape + headers (L912-929)
// ---------------------------------------------------------------------------

describe("fetchOptions body vs no-body shape (L912-929)", () => {
  test("POST sends a JSON body with Content-Type + Host headers", async () => {
    const NAME = `${CLIENT}-body-post`;
    await reg(NAME, [
      makeTool({
        name: "create-item",
        method: "POST",
        endpoint: "/item",
        inputSchema: { type: "object", properties: { name: { type: "string" } } },
      }),
    ]);
    let captured: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, opts?: RequestInit) => {
      captured = opts;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const r = await proxyToolCall(`${NAME}__create-item`, { name: "alice" });
    expect(r.isError).toBeUndefined();
    expect(captured?.body).toBe(JSON.stringify({ name: "alice" }));
    const h = new Headers(captured?.headers);
    expect(h.get("content-type")).toBe("application/json");
    expect(h.get("host")).toBe("1.2.3.4");
  });

  test("GET sends no body but still carries Content-Type + Host headers", async () => {
    const NAME = `${CLIENT}-body-get`;
    await reg(NAME, [makeTool({ name: "get-item", method: "GET", endpoint: "/item" })]);
    let captured: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, opts?: RequestInit) => {
      captured = opts;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const r = await proxyToolCall(`${NAME}__get-item`, {});
    expect(r.isError).toBeUndefined();
    expect(captured?.body).toBeUndefined();
    const h = new Headers(captured?.headers);
    expect(h.get("content-type")).toBe("application/json");
    expect(h.get("host")).toBe("1.2.3.4");
  });

  // Kills L913's ConditionalExpression->'true' survivor: `body !== undefined
  // ? {with-body shape} : {no-body shape}` forced to always take the
  // with-body shape. Empirically confirmed (bun -e) that an object literal
  // that explicitly assigns an `undefined`-valued `body` property has that
  // key present (`'body' in obj` -> true, `Object.keys` includes "body"),
  // whereas an object literal that never mentions `body` at all does not —
  // so a real fetch() mock CAN distinguish "with-body shape carrying
  // body:undefined" from "no-body shape" via property presence, not just
  // value. For a real GET call, `body` stays `undefined` in proxy.ts's own
  // scope either way, so `captured?.body` alone (asserted above) can't tell
  // the branches apart — but `'body' in captured!` can.
  test("GET's fetchOptions omits the body KEY entirely (not merely undefined-valued)", async () => {
    const NAME = `${CLIENT}-body-key-get`;
    await reg(NAME, [makeTool({ name: "get-item", method: "GET", endpoint: "/item" })]);
    let captured: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, opts?: RequestInit) => {
      captured = opts;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const r = await proxyToolCall(`${NAME}__get-item`, {});
    expect(r.isError).toBeUndefined();
    expect(captured).toBeDefined();
    expect("body" in captured!).toBe(false);
    expect(Object.keys(captured!)).not.toContain("body");
  });
});

// ---------------------------------------------------------------------------
// Upstream auth headers spread onto the outbound request (L875)
// ---------------------------------------------------------------------------

describe("per-client upstream auth headers are spread onto the outbound request (L875)", () => {
  test("a configured bearer credential is injected as Authorization", async () => {
    const NAME = `${CLIENT}-upauth`;
    (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, 5).toString("base64");
    await reg(NAME);
    setUpstreamAuth(NAME, "bearer", { token: "up-secret-c9" }, null);

    let captured: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, opts?: RequestInit) => {
      captured = opts;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const r = await proxyToolCall(`${NAME}__get-item`, {});
    expect(r.isError).toBeUndefined();
    const h = new Headers(captured?.headers);
    // If L875's ObjectLiteral were forced to `{}` (or `?? {}` mutated to
    // `&& {}`), this header would be silently dropped.
    expect(h.get("authorization")).toBe("Bearer up-secret-c9");
  });
});

// ---------------------------------------------------------------------------
// Outbound OAuth2 client-credentials bearer injection (L879)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Regression: a throw during credential resolution (between trackRequest/
// incInflight and buildRestRequest's return) must still release the LB
// in-flight counter and the reqController tracking entry — not leak them.
// See dispatch-rest.ts's buildRestRequest try/catch around the upstream-auth
// header lookup + OAuth bearer mint.
// ---------------------------------------------------------------------------

describe("a throw during credential resolution still releases in-flight tracking", () => {
  const NAME = `${CLIENT}-cred-throw`;

  test("getUpstreamAuthHeaders throwing propagates the error AND pairs incInflight with decInflight", async () => {
    await reg(NAME);
    await addUpstream(NAME, "http://5.6.7.12", 1);
    setLb(NAME, { strategy: "round-robin", primaryWeight: 1, enabled: true });

    const incSpy = spyOn(loadBalancer, "incInflight");
    const decSpy = spyOn(loadBalancer, "decInflight");
    const authSpy = spyOn(upstreamAuth, "getUpstreamAuthHeaders").mockImplementation(() => {
      throw new Error("boom-credential-resolution");
    });
    try {
      // Before the fix, this throw happened between trackRequest/incInflight
      // (inside buildRestRequest) and dispatchRestToolCall's try/finally
      // (which only starts after buildRestRequest returns) — leaking the LB
      // in-flight counter and the inflightControllers entry forever.
      await expect(proxyToolCall(`${NAME}__get-item`, {})).rejects.toThrow(/boom-credential-resolution/);

      expect(incSpy).toHaveBeenCalledTimes(1);
      expect(decSpy).toHaveBeenCalledTimes(1);
      expect(incSpy.mock.calls[0]?.[0]).toBe(decSpy.mock.calls[0]?.[0]);
    } finally {
      authSpy.mockRestore();
      incSpy.mockRestore();
      decSpy.mockRestore();
    }

    // A follow-up call (auth resolution no longer throwing) must succeed
    // normally, proving no leaked in-flight/tracking state wedged the client.
    globalThis.fetch = okFetch();
    const r = await proxyToolCall(`${NAME}__get-item`, {});
    expect(r.isError).toBeUndefined();
  });
});

describe("outbound OAuth2 bearer injection (L879)", () => {
  test("a minted OAuth token is injected as Authorization: Bearer", async () => {
    const NAME = `${CLIENT}-oauth`;
    (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, 6).toString("base64");
    await reg(NAME);
    await setClientOAuth(NAME, { tokenUrl: "http://5.6.7.11/token", clientId: "id", clientSecret: "s" });
    __setOAuthDepsForTesting({
      fetch: (async () =>
        new Response(JSON.stringify({ access_token: "mutc9-tok", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });

    let captured: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, opts?: RequestInit) => {
      captured = opts;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const r = await proxyToolCall(`${NAME}__get-item`, {});
    expect(r.isError).toBeUndefined();
    const h = new Headers(captured?.headers);
    // If L879's `if (oauthBearer)` were forced false, or the template were
    // blanked to '', the minted token would never reach the backend request.
    expect(h.get("authorization")).toBe("Bearer mutc9-tok");
  });
});

/**
 * Stryker mutation-testing backstop for src/backend-auth/oauth.ts.
 * Baseline 66.28% (57/86) — the existing oauth.test.ts covers config CRUD,
 * cache-hit/refresh-after-expiry, and proxy-injection happy paths, but never
 * inspects the actual outbound token-mint request (method/headers/body/scope),
 * never exercises the INVALID_URL or SECRETS_PROVIDER_ERROR branches, never
 * feeds the mint fetcher a non-ok response / missing access_token / missing
 * expires_in, never calls getOAuthBearer for a client with no oauth config at
 * all, and never exercises __resetOAuthForTesting's own effect directly (every
 * existing test only ever uses it as inert setup via a shared beforeEach that
 * always immediately re-stubs the clock/fetch afterward).
 *
 * 85:27-85:43 ArrowFunction [Survived] `() => undefined` on `nowFn`'s initial
 * module-load declaration is a DOCUMENTED EQUIVALENT — the same DI-helper-
 * initial-value class as load-balancer.ts/quarantine.ts/response-cache.ts:
 * every test file touching this module resets the clock in `beforeEach`
 * before the first assertion of the first test ever runs.
 *
 * 124:39-124:75 StringLiteral [Survived] (the `token endpoint HTTP ${status}`
 * error message, emptied) and 126:68-126:109 StringLiteral [Survived] (the
 * "token endpoint returned no access_token" message, emptied) are both
 * DOCUMENTED EQUIVALENTS — both errors are thrown deep inside the mint
 * fetcher and immediately swallowed by getOAuthBearer's own `catch { return
 * null; }`, with no logger or other consumer ever reading `.message`. No
 * reachable code path observes either string's content.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import * as secretsIndex from "../../secrets/index.js";
import { localProvider } from "../../secrets/local-provider.js";
import {
  setClientOAuth,
  getOAuthBearer,
  __setOAuthDepsForTesting,
  __resetOAuthForTesting,
} from "../../backend-auth/oauth.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "svc";
const getTool: RestToolDefinition = {
  name: "get-x",
  method: "GET",
  endpoint: "/x",
  description: "x",
  inputSchema: { type: "object", properties: {} },
};
async function reg(): Promise<void> {
  await registry.register(CLIENT, [getTool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

const origKey = config.secretEncryptionKey;
function configureSecretBox(): void {
  (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, 7).toString("base64");
}

/** Installs a fetch stub returning a fixed JSON body, capturing every call's args. */
function jsonFetch(status: number, body: unknown): { calls: () => Array<{ url: string; opts: RequestInit }> } {
  const calls: Array<{ url: string; opts: RequestInit }> = [];
  __setOAuthDepsForTesting({
    fetch: (async (url: string, opts: RequestInit) => {
      calls.push({ url, opts });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
  return { calls: () => calls };
}

function resetAll(): void {
  (config as Record<string, unknown>).secretEncryptionKey = origKey;
  __resetDbForTesting();
  __resetOAuthForTesting();
  removeCircuitBreaker(CLIENT);
}
beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});

// 57:7-57:19 ConditionalExpression [Survived] false (`!check.valid` forced
// false), 57:28-57:85 ObjectLiteral [Survived] (the INVALID_URL return object
// emptied), 57:48-57:61 StringLiteral [Survived] `""` ("INVALID_URL" emptied).
describe("setClientOAuth — an invalid tokenUrl is rejected", () => {
  test("a malformed tokenUrl returns ok:false, error:INVALID_URL with a reason", async () => {
    await reg();
    configureSecretBox();
    const result = await setClientOAuth(CLIENT, { tokenUrl: "not-a-valid-url", clientId: "id", clientSecret: "s" });
    expect(result).toEqual({ ok: false, error: "INVALID_URL", reason: expect.any(String) });
  });
});

// 62:17-64:4 BlockStatement [Survived] (the whole catch body emptied),
// 63:12-63:116 ObjectLiteral [Survived], 63:18-63:23 BooleanLiteral [Survived]
// true (`err instanceof Error` forced true), 63:32-63:56 StringLiteral
// [Survived] `""` ("SECRETS_PROVIDER_ERROR" emptied). Both directions of the
// ternary are needed: an Error instance (real `.message`) and a non-Error
// throw (real `String(err)`).
describe("setClientOAuth — a secrets-provider encryption failure surfaces as SECRETS_PROVIDER_ERROR", () => {
  test("encryptSecret throwing an Error surfaces its message", async () => {
    await reg();
    configureSecretBox();
    const spy = spyOn(localProvider, "encryptSecret").mockRejectedValueOnce(new Error("boom"));
    try {
      const result = await setClientOAuth(CLIENT, { tokenUrl: "http://5.6.7.8/t", clientId: "id", clientSecret: "s" });
      expect(result).toEqual({ ok: false, error: "SECRETS_PROVIDER_ERROR", reason: "boom" });
    } finally {
      spy.mockRestore();
    }
  });
  test("encryptSecret throwing a non-Error value surfaces its String() form", async () => {
    await reg();
    configureSecretBox();
    const spy = spyOn(localProvider, "encryptSecret").mockImplementationOnce(() => Promise.reject("nope"));
    try {
      const result = await setClientOAuth(CLIENT, { tokenUrl: "http://5.6.7.8/t", clientId: "id", clientSecret: "s" });
      expect(result).toEqual({ ok: false, error: "SECRETS_PROVIDER_ERROR", reason: "nope" });
    } finally {
      spy.mockRestore();
    }
  });
});

// 92:48-96:2 BlockStatement [Survived] (__resetOAuthForTesting's whole body
// emptied) and 94:11-94:27 ArrowFunction [Survived] `() => undefined` (its
// OWN `nowFn = () => Date.now()` reassignment — distinct from the equivalent
// module-load declaration at L85, since every OTHER test immediately
// re-stubs the clock right after this call, never observing its real-clock
// fallback in isolation).
describe("__resetOAuthForTesting — actually clears stale token caches and restores a real clock", () => {
  test("a stale cached token for the same client is not reused after a manual reset", async () => {
    await reg();
    configureSecretBox();
    await setClientOAuth(CLIENT, { tokenUrl: "http://5.6.7.8/t", clientId: "id", clientSecret: "s" });
    const t0 = 1_000_000;
    __setOAuthDepsForTesting({ now: () => t0 });
    jsonFetch(200, { access_token: "tok1", expires_in: 3600 });
    __setOAuthDepsForTesting({ now: () => t0 });
    expect(await getOAuthBearer(CLIENT)).toBe("tok1");

    __resetOAuthForTesting();
    // Deliberately do NOT re-run setClientOAuth — the client_oauth DB row
    // persists (reset never touches the DB); only the in-memory token cache
    // and clock are under test here.
    const f2 = jsonFetch(200, { access_token: "tok2", expires_in: 3600 });
    expect(await getOAuthBearer(CLIENT)).toBe("tok2");
    expect(f2.calls().length).toBe(1);
  });

  test("the real clock resumes ticking after a manual reset (two quick calls still hit cache once)", async () => {
    await reg();
    configureSecretBox();
    await setClientOAuth(CLIENT, { tokenUrl: "http://5.6.7.8/t", clientId: "id", clientSecret: "s" });
    __resetOAuthForTesting();
    // No __setOAuthDepsForTesting({now: ...}) call here on purpose — this
    // exercises nowFn's reset-time fallback to the REAL Date.now(), not an
    // injected stub.
    const f = jsonFetch(200, { access_token: "tokA", expires_in: 3600 });
    expect(await getOAuthBearer(CLIENT)).toBe("tokA");
    expect(await getOAuthBearer(CLIENT)).toBe("tokA");
    expect(f.calls().length).toBe(1);
  });
});

// 111:42-115:10 ObjectLiteral [Survived] (the URLSearchParams body object
// emptied), 112:23-112:43 StringLiteral [Survived] ("client_credentials"
// emptied), 116:13-116:22 ConditionalExpression [Survived] true/false
// (`if (row.scope)` forced both ways), 116:33-116:40 StringLiteral [Survived]
// `""` ("scope" key emptied), 118:53-123:10 ObjectLiteral [Survived] (the
// whole fetch options object emptied), 119:19-119:25 StringLiteral [Survived]
// `""` ("POST" emptied), 120:20-120:75 ObjectLiteral [Survived] (headers
// object emptied), 120:38-120:73 StringLiteral [Survived] `""`
// (content-type value emptied). None of the existing tests inspect the
// actual outbound mint request at all.
describe("the outbound token-mint request has the real method/headers/body", () => {
  test("with a configured scope: POST, content-type header, and a scope param in the body", async () => {
    await reg();
    configureSecretBox();
    await setClientOAuth(CLIENT, {
      tokenUrl: "http://5.6.7.8/t",
      clientId: "my-id",
      clientSecret: "my-secret",
      scope: "read write",
    });
    const f = jsonFetch(200, { access_token: "tok", expires_in: 3600 });
    await getOAuthBearer(CLIENT);
    expect(f.calls().length).toBe(1);
    const { opts } = f.calls()[0];
    expect(opts.method).toBe("POST");
    expect(new Headers(opts.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(opts.body as string);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe("my-id");
    expect(params.get("client_secret")).toBe("my-secret");
    expect(params.get("scope")).toBe("read write");
  });

  test("without a configured scope: no scope param in the body at all", async () => {
    await reg();
    configureSecretBox();
    await setClientOAuth(CLIENT, { tokenUrl: "http://5.6.7.8/t", clientId: "my-id", clientSecret: "my-secret" });
    const f = jsonFetch(200, { access_token: "tok", expires_in: 3600 });
    await getOAuthBearer(CLIENT);
    const params = new URLSearchParams(f.calls()[0].opts.body as string);
    expect(params.has("scope")).toBe(false);
  });
});

// 124:13-124:21 ConditionalExpression [Survived] false (`if (!resp.ok) throw`
// forced false) and 152:11-154:4 BlockStatement [Survived] (getOAuthBearer's
// own `catch { return null; }` body emptied). Both are only jointly
// observable: the throw only fires if the first guard is real, and the
// `null` return only happens if the catch body is real. The response body
// deliberately carries a VALID access_token — a body without one lets the
// downstream "missing access_token" guard (L126) independently throw and
// mask this mutant entirely (confirmed: an earlier version of this test used
// a body with no access_token and the mutant survived, since both real and
// forced-false code paths converged on the same L126 throw either way).
describe("getOAuthBearer — a non-ok token-endpoint response yields null", () => {
  test("a 500 response from the token endpoint returns null, not a thrown error", async () => {
    await reg();
    configureSecretBox();
    await setClientOAuth(CLIENT, { tokenUrl: "http://5.6.7.8/t", clientId: "id", clientSecret: "s" });
    jsonFetch(500, { access_token: "should-not-be-used", expires_in: 3600 });
    expect(await getOAuthBearer(CLIENT)).toBeNull();
  });
});

// 126:13-126:50 ConditionalExpression [Survived] false (`typeof
// json.access_token !== "string"` forced false).
describe("getOAuthBearer — a response missing access_token yields null, not undefined", () => {
  test("a 200 response with no access_token field returns null", async () => {
    await reg();
    configureSecretBox();
    await setClientOAuth(CLIENT, { tokenUrl: "http://5.6.7.8/t", clientId: "id", clientSecret: "s" });
    jsonFetch(200, { expires_in: 3600 });
    expect(await getOAuthBearer(CLIENT)).toBeNull();
  });
});

// 127:24-127:59 ConditionalExpression [Survived] true/false + EqualityOperator
// [Survived] (`===`->`!==`) + 127:51-127:59 StringLiteral [Survived] `""`
// ("number" emptied) — all on `typeof json.expires_in === "number" ?
// json.expires_in : 3600`. Two tests, each isolating one branch:
describe("cacheSet's TTL honors the token endpoint's real expires_in over the 3600s default", () => {
  test("a small, real expires_in causes an early refresh, not the 3600s default", async () => {
    await reg();
    configureSecretBox();
    await setClientOAuth(CLIENT, { tokenUrl: "http://5.6.7.8/t", clientId: "id", clientSecret: "s" });
    const t0 = 1_000_000;
    __setOAuthDepsForTesting({ now: () => t0 });
    const f = jsonFetch(200, { access_token: "tok1", expires_in: 60 }); // effective TTL = 60s - 30s skew = 30s
    __setOAuthDepsForTesting({ now: () => t0 });
    expect(await getOAuthBearer(CLIENT)).toBe("tok1");
    __setOAuthDepsForTesting({ now: () => t0 + 31_000 }); // past the 30s effective TTL
    expect(await getOAuthBearer(CLIENT)).toBe("tok1"); // re-minted, same stub token
    expect(f.calls().length).toBe(2);
  });

  test("a missing expires_in falls back to the 3600s default, not NaN", async () => {
    await reg();
    configureSecretBox();
    await setClientOAuth(CLIENT, { tokenUrl: "http://5.6.7.8/t", clientId: "id", clientSecret: "s" });
    const t0 = 2_000_000;
    __setOAuthDepsForTesting({ now: () => t0 });
    const f = jsonFetch(200, { access_token: "tokX" }); // no expires_in at all
    __setOAuthDepsForTesting({ now: () => t0 });
    expect(await getOAuthBearer(CLIENT)).toBe("tokX");
    __setOAuthDepsForTesting({ now: () => t0 + 10 }); // 10ms later — well within a real 3600s-30s TTL
    expect(await getOAuthBearer(CLIENT)).toBe("tokX");
    expect(f.calls().length).toBe(1); // cached, not re-minted
  });
});

// 147:7-147:11 ConditionalExpression [Survived] false (`!row` forced false).
// The internal crash on a null row is swallowed by the outer catch either
// way, so the return value alone can't distinguish real from mutant — but
// the mutant reaches into the try block far enough to call getSecretsProvider()
// before the null-dereference throws, which the real early-return never does.
describe("getOAuthBearer — a client with no oauth config returns null without touching the secrets provider", () => {
  test("an unconfigured client short-circuits before getSecretsProvider is ever called", async () => {
    await reg();
    const spy = spyOn(secretsIndex, "getSecretsProvider");
    try {
      expect(await getOAuthBearer(CLIENT)).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

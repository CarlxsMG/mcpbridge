/**
 * Outbound OAuth2 client-credentials — config validation, token cache/refresh,
 * and proxy injection of the minted Bearer on the upstream request.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../registry.js";
import { removeCircuitBreaker } from "../circuit-breaker.js";
import { proxyToolCall } from "../proxy.js";
import { getClientOAuth, setClientOAuth, getOAuthBearer, __setOAuthDepsForTesting, __resetOAuthForTesting } from "../oauth.js";
import type { RestToolDefinition } from "../types.js";

const CLIENT = "svc";
const getTool: RestToolDefinition = { name: "get-x", method: "GET", endpoint: "/x", description: "x", inputSchema: { type: "object", properties: {} } };
async function reg(): Promise<void> {
  await registry.register(CLIENT, [getTool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

const originalFetch = globalThis.fetch;
const origKey = config.secretEncryptionKey;
function configureSecretBox(): void {
  (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, 7).toString("base64");
}
function tokenFetch(token: string): { count: () => number } {
  let n = 0;
  __setOAuthDepsForTesting({
    fetch: (async () => {
      n++;
      return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
  return { count: () => n };
}
function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  (config as Record<string, unknown>).secretEncryptionKey = origKey;
  __resetDbForTesting();
  __resetOAuthForTesting();
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

describe("config", () => {
  test("unknown client / no secret-box / happy path / read-model hides secret", async () => {
    await reg();
    expect(await setClientOAuth("ghost", { tokenUrl: "http://5.6.7.8/t", clientId: "id", clientSecret: "s" })).toMatchObject({ ok: false, error: "CLIENT_NOT_FOUND" });
    expect(await setClientOAuth(CLIENT, { tokenUrl: "http://5.6.7.8/t", clientId: "id", clientSecret: "s" })).toMatchObject({ ok: false, error: "SECRET_BOX_UNCONFIGURED" });
    configureSecretBox();
    expect(await setClientOAuth(CLIENT, { tokenUrl: "http://5.6.7.8/t", clientId: "id", clientSecret: "s", scope: "read" })).toEqual({ ok: true });
    expect(getClientOAuth(CLIENT)).toEqual({ tokenUrl: "http://5.6.7.8/t", clientId: "id", scope: "read" });
    expect(await setClientOAuth(CLIENT, null)).toEqual({ ok: true });
    expect(getClientOAuth(CLIENT)).toBeNull();
  });
});

describe("token cache + refresh", () => {
  test("mints once, caches, then refreshes after expiry", async () => {
    await reg();
    configureSecretBox();
    await setClientOAuth(CLIENT, { tokenUrl: "http://5.6.7.8/t", clientId: "id", clientSecret: "s" });
    const t0 = 1_000_000;
    __setOAuthDepsForTesting({ now: () => t0 });
    const f = tokenFetch("tok1"); // also re-sets deps fetch; re-apply clock
    __setOAuthDepsForTesting({ now: () => t0 });

    expect(await getOAuthBearer(CLIENT)).toBe("tok1");
    expect(await getOAuthBearer(CLIENT)).toBe("tok1");
    expect(f.count()).toBe(1); // cached

    // Move well past the token's 3600s TTL.
    __setOAuthDepsForTesting({ now: () => t0 + 3_601_000 });
    expect(await getOAuthBearer(CLIENT)).toBe("tok1");
    expect(f.count()).toBe(2); // refreshed
  });
});

describe("proxy integration", () => {
  test("injects the minted token as an Authorization: Bearer header", async () => {
    await reg();
    configureSecretBox();
    await setClientOAuth(CLIENT, { tokenUrl: "http://5.6.7.8/t", clientId: "id", clientSecret: "s" });
    tokenFetch("tok-xyz");
    let auth: string | undefined;
    globalThis.fetch = (async (_url: string, opts: RequestInit) => {
      auth = new Headers(opts.headers).get("authorization") ?? undefined;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await proxyToolCall(`${CLIENT}__get-x`, {});
    expect(auth).toBe("Bearer tok-xyz");
  });
});

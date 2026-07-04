/**
 * Store-level tests + proxy header injection for per-client upstream auth.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { proxyToolCall } from "../proxy.js";
import {
  setUpstreamAuth,
  getUpstreamAuthInfo,
  clearUpstreamAuth,
  getUpstreamAuthHeaders,
} from "../security/upstream-auth.js";
import type { RestToolDefinition } from "../mcp/types.js";

const originalKey = config.secretEncryptionKey;
const originalFetch = globalThis.fetch;

function makeTool(): RestToolDefinition {
  return {
    name: "get-users",
    method: "GET",
    endpoint: "/users",
    description: "Returns a list of users",
    inputSchema: { type: "object", properties: {} },
  };
}

async function reg(name: string): Promise<void> {
  await registry.register(name, [makeTool()], "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

let captured: RequestInit | undefined;
function captureFetch(): void {
  captured = undefined;
  globalThis.fetch = (async (_url: string, opts: RequestInit) => {
    captured = opts;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}
function capturedHeaders(): Record<string, string> {
  return (captured?.headers ?? {}) as Record<string, string>;
}

beforeEach(async () => {
  __resetDbForTesting();
  (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, 9).toString("base64");
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  (config as Record<string, unknown>).secretEncryptionKey = originalKey;
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

describe("upstream-auth store", () => {
  test("set / get info / clear", async () => {
    await reg("svc");
    expect(getUpstreamAuthInfo("svc").configured).toBe(false);

    setUpstreamAuth("svc", "bearer", { token: "t" }, null);
    const info = getUpstreamAuthInfo("svc");
    expect(info.configured).toBe(true);
    expect(info.type).toBe("bearer");

    expect(clearUpstreamAuth("svc")).toBe(true);
    expect(getUpstreamAuthInfo("svc").configured).toBe(false);
    expect(clearUpstreamAuth("svc")).toBe(false);
  });

  test("getUpstreamAuthHeaders returns null when nothing is configured", async () => {
    await reg("svc");
    expect(getUpstreamAuthHeaders("svc")).toBeNull();
  });
});

describe("proxy upstream-auth injection", () => {
  test("injects a bearer Authorization header without clobbering Host", async () => {
    await reg("svc");
    setUpstreamAuth("svc", "bearer", { token: "up-secret" }, null);
    captureFetch();
    const res = await proxyToolCall("svc__get-users", {});
    expect(res.isError).toBeUndefined();
    const h = capturedHeaders();
    expect(h.Authorization).toBe("Bearer up-secret");
    expect(h.Host).toBe("example.com");
  });

  test("injects basic auth", async () => {
    await reg("svc");
    setUpstreamAuth("svc", "basic", { username: "u", password: "p" }, null);
    captureFetch();
    await proxyToolCall("svc__get-users", {});
    expect(capturedHeaders().Authorization).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });

  test("injects a custom header", async () => {
    await reg("svc");
    setUpstreamAuth("svc", "header", { value: "abc123" }, "X-Api-Key");
    captureFetch();
    await proxyToolCall("svc__get-users", {});
    expect(capturedHeaders()["X-Api-Key"]).toBe("abc123");
  });

  test("no injection when the credential can't be decrypted (wrong key)", async () => {
    await reg("svc");
    setUpstreamAuth("svc", "bearer", { token: "up-secret" }, null);
    // Rotate the key so decryption fails — proxy must proceed unauthenticated.
    (config as Record<string, unknown>).secretEncryptionKey = Buffer.alloc(32, 1).toString("base64");
    captureFetch();
    const res = await proxyToolCall("svc__get-users", {});
    expect(res.isError).toBeUndefined();
    expect(capturedHeaders().Authorization).toBeUndefined();
  });
});

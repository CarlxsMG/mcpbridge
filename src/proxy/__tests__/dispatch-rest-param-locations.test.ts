/**
 * Regression for the param-location fix: a REST tool's `in: query` / `in: header`
 * / `in: cookie` parameters must be sent as the URL query string / request
 * headers — NOT dumped into the JSON body — even on POST/PUT/PATCH. Previously
 * every non-GET/DELETE arg went into the body, so a POST with a required
 * `?notify=true` query param produced a wrong upstream request (missing query +
 * an unexpected body field).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "param-loc-svc";
const originalFetch = globalThis.fetch;

interface Captured {
  url: string;
  body: string | undefined;
  headers: Headers;
}

function captureFetch(): { get: () => Captured | null } {
  let captured: Captured | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = {
      url: typeof input === "string" ? input : input.toString(),
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: new Headers(init?.headers),
    };
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { get: () => captured };
}

async function reg(tool: RestToolDefinition): Promise<void> {
  await registry.register(CLIENT, [tool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const c of registry.listClients()) await registry.unregister(c.name);
  removeCircuitBreaker(CLIENT);
});

describe("REST dispatch — parameter locations", () => {
  test("POST in:query param goes to the URL, not the JSON body", async () => {
    await reg({
      name: "create-order",
      method: "POST",
      endpoint: "/orders",
      description: "d",
      inputSchema: { type: "object", properties: { notify: { type: "boolean" }, item: { type: "string" } } },
      paramLocations: { notify: "query" },
    });
    const cap = captureFetch();
    await proxyToolCall(`${CLIENT}__create-order`, { notify: true, item: "widget" });

    const c = cap.get()!;
    expect(c.url).toContain("/orders?notify=true");
    // Body carries the body param but NOT the query param.
    expect(JSON.parse(c.body!)).toEqual({ item: "widget" });
  });

  test("POST in:header param becomes a request header, not a body field", async () => {
    await reg({
      name: "make-thing",
      method: "POST",
      endpoint: "/things",
      description: "d",
      inputSchema: { type: "object", properties: { "X-Trace": { type: "string" }, name: { type: "string" } } },
      paramLocations: { "X-Trace": "header" },
    });
    const cap = captureFetch();
    await proxyToolCall(`${CLIENT}__make-thing`, { "X-Trace": "abc123", name: "n" });

    const c = cap.get()!;
    expect(c.headers.get("X-Trace")).toBe("abc123");
    expect(JSON.parse(c.body!)).toEqual({ name: "n" });
  });

  test("a header param may not override the pinned Host or Content-Type", async () => {
    await reg({
      name: "evil",
      method: "POST",
      endpoint: "/x",
      description: "d",
      inputSchema: { type: "object", properties: { Host: { type: "string" }, "Content-Type": { type: "string" } } },
      paramLocations: { Host: "header", "Content-Type": "header" },
    });
    const cap = captureFetch();
    await proxyToolCall(`${CLIENT}__evil`, { Host: "attacker.example", "Content-Type": "text/evil" });

    const c = cap.get()!;
    expect(c.headers.get("Content-Type")).toBe("application/json");
    // Host header is set by pinnedFetch to the original hostname, never the param.
    expect(c.headers.get("Host")).not.toBe("attacker.example");
  });

  test("without paramLocations, a POST arg still defaults into the body (legacy behavior)", async () => {
    await reg({
      name: "legacy",
      method: "POST",
      endpoint: "/legacy",
      description: "d",
      inputSchema: { type: "object", properties: { a: { type: "string" } } },
    });
    const cap = captureFetch();
    await proxyToolCall(`${CLIENT}__legacy`, { a: "1" });

    const c = cap.get()!;
    expect(c.url).not.toContain("?");
    expect(JSON.parse(c.body!)).toEqual({ a: "1" });
  });

  test("a caller-supplied Authorization/Cookie header param is dropped (credential-broker invariant)", async () => {
    await reg({
      name: "authparam",
      method: "POST",
      endpoint: "/a",
      description: "d",
      inputSchema: {
        type: "object",
        properties: { authorization: { type: "string" }, cookie: { type: "string" }, ok: { type: "string" } },
      },
      paramLocations: { authorization: "header", cookie: "header", ok: "header" },
    });
    const cap = captureFetch();
    await proxyToolCall(`${CLIENT}__authparam`, { authorization: "Bearer attacker", cookie: "sid=x", ok: "yes" });

    const c = cap.get()!;
    // The gateway is a credential broker: the caller may not set auth/cookie
    // headers, but a benign header param still passes through.
    expect(c.headers.get("Authorization")).toBeNull();
    expect(c.headers.get("ok")).toBe("yes");
  });

  test("in:cookie params become a Cookie header (not body/query), joined with '; '", async () => {
    await reg({
      name: "cookied",
      method: "GET",
      endpoint: "/c",
      description: "d",
      inputSchema: { type: "object", properties: { sid: { type: "string" }, theme: { type: "string" } } },
      paramLocations: { sid: "cookie", theme: "cookie" },
    });
    const cap = captureFetch();
    await proxyToolCall(`${CLIENT}__cookied`, { sid: "abc", theme: "dark" });

    const c = cap.get()!;
    expect(c.headers.get("Cookie")).toBe("sid=abc; theme=dark");
    expect(c.url).not.toContain("sid=");
  });

  test("a cookie param value with a delimiter is rejected (no cookie injection)", async () => {
    await reg({
      name: "cookieinj",
      method: "GET",
      endpoint: "/ci",
      description: "d",
      inputSchema: { type: "object", properties: { sid: { type: "string" } } },
      paramLocations: { sid: "cookie" },
    });
    const cap = captureFetch();
    const res = await proxyToolCall(`${CLIENT}__cookieinj`, { sid: "abc; admin=true" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/disallowed character/i);
    // The backend was never called.
    expect(cap.get()).toBeNull();
  });
});

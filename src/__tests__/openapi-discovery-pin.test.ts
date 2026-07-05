/**
 * TEST 1 — DNS pinning in openapi-discovery.ts
 *
 * Verifies that when an `ipPin` is provided, discoverToolsFromOpenApi:
 *   1. Replaces the hostname in the fetched URL with the pinned IP.
 *   2. Sends a Host header matching the original hostname.
 *   3. Sets redirect: "error".
 *   4. Does NOT modify the URL when ipPin is absent (backward compat).
 *   5. Preserves non-standard ports when replacing the hostname.
 *   6. Preserves path + query when replacing the hostname.
 */
import { describe, test, expect, afterEach } from "bun:test";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Minimal valid OpenAPI spec returned by every mock
const MINIMAL_SPEC = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Test API", version: "1.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        summary: "Ping",
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Helper — capture what fetch was called with
// ---------------------------------------------------------------------------

interface CapturedCall {
  url: string;
  options: RequestInit;
}

function mockFetchCapture(): { captured: CapturedCall | null } {
  const state: { captured: CapturedCall | null } = { captured: null };
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
    state.captured = {
      url: typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url,
      options: options ?? {},
    };
    return new Response(MINIMAL_SPEC, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return state;
}

// ---------------------------------------------------------------------------
// TEST 1a: IP pin replaces hostname + sets Host header + redirect:error
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — DNS pin: URL hostname replaced", () => {
  test("fetched URL uses pinned IP, not original hostname", async () => {
    const state = mockFetchCapture();
    const { discoverToolsFromOpenApi } = await import("../discovery/openapi-discovery.js");

    await discoverToolsFromOpenApi({
      openapiUrl: "https://example.com/openapi.json",
      ipPin: { resolvedIp: "93.184.216.34", hostname: "example.com" },
    });

    expect(state.captured).not.toBeNull();
    const fetchedUrl = state.captured!.url;
    // Hostname must be replaced with pinned IP
    expect(fetchedUrl).toContain("93.184.216.34");
    expect(fetchedUrl).not.toContain("example.com/");
  });

  test("Host header equals the original hostname", async () => {
    const state = mockFetchCapture();
    const { discoverToolsFromOpenApi } = await import("../discovery/openapi-discovery.js");

    await discoverToolsFromOpenApi({
      openapiUrl: "https://example.com/openapi.json",
      ipPin: { resolvedIp: "93.184.216.34", hostname: "example.com" },
    });

    const headers = state.captured!.options.headers as Record<string, string> | undefined;
    expect(headers).toBeDefined();
    // Accept both "Host" and "host" (case-insensitive)
    const hostValue = headers?.["Host"] ?? headers?.["host"] ?? headers?.["HOST"];
    expect(hostValue).toBe("example.com");
  });

  test("redirect option is 'error'", async () => {
    const state = mockFetchCapture();
    const { discoverToolsFromOpenApi } = await import("../discovery/openapi-discovery.js");

    await discoverToolsFromOpenApi({
      openapiUrl: "https://example.com/openapi.json",
      ipPin: { resolvedIp: "93.184.216.34", hostname: "example.com" },
    });

    expect(state.captured!.options.redirect).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// TEST 1b: Without ipPin the URL is unchanged (backward compat)
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — DNS pin: no ipPin leaves URL unchanged", () => {
  test("URL is fetched as-is when ipPin is omitted", async () => {
    const state = mockFetchCapture();
    const { discoverToolsFromOpenApi } = await import("../discovery/openapi-discovery.js");

    await discoverToolsFromOpenApi({
      openapiUrl: "https://example.com/openapi.json",
    });

    expect(state.captured).not.toBeNull();
    expect(state.captured!.url).toBe("https://example.com/openapi.json");
  });
});

// ---------------------------------------------------------------------------
// TEST 1c: Non-standard port is preserved after hostname replacement
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — DNS pin: port preserved", () => {
  test("port 8443 is retained after hostname replacement", async () => {
    const state = mockFetchCapture();
    const { discoverToolsFromOpenApi } = await import("../discovery/openapi-discovery.js");

    await discoverToolsFromOpenApi({
      openapiUrl: "https://example.com:8443/spec.json",
      ipPin: { resolvedIp: "1.2.3.4", hostname: "example.com" },
    });

    expect(state.captured!.url).toContain(":8443");
    expect(state.captured!.url).toContain("1.2.3.4");
  });
});

// ---------------------------------------------------------------------------
// TEST 1d: Path and query are preserved after hostname replacement
// ---------------------------------------------------------------------------

describe("discoverToolsFromOpenApi — DNS pin: path+query preserved", () => {
  test("path and query string are retained after hostname replacement", async () => {
    const state = mockFetchCapture();
    const { discoverToolsFromOpenApi } = await import("../discovery/openapi-discovery.js");

    await discoverToolsFromOpenApi({
      openapiUrl: "https://example.com/api/spec.yaml?v=2",
      ipPin: { resolvedIp: "1.2.3.4", hostname: "example.com" },
    });

    const url = state.captured!.url;
    expect(url).toContain("/api/spec.yaml");
    expect(url).toContain("v=2");
    expect(url).toContain("1.2.3.4");
    expect(url).not.toContain("example.com/");
  });
});

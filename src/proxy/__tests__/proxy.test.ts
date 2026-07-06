import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";

// ---------------------------------------------------------------------------
// Proxy retry — signal isolation
//
// Bug detected: if the composed AbortSignal from attempt-0 were reused on
// attempt-1 it would already be aborted, causing the second fetch to fail
// immediately instead of succeeding.
// ---------------------------------------------------------------------------

const CLIENT = "proxy-test-client";
const TOOL = "get-item";

// Speed up retry delays so tests complete fast.
const originalRetryBaseDelayMs = config.retryBaseDelayMs;
const originalRetryMaxAttempts = config.retryMaxAttempts;

beforeEach(async () => {
  (config as Record<string, unknown>).retryBaseDelayMs = 1;
  (config as Record<string, unknown>).retryMaxAttempts = 2;
  // Clean slate
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  __resetDbForTesting();
  removeCircuitBreaker(CLIENT);

  await registry.register(
    CLIENT,
    [
      {
        name: TOOL,
        method: "GET",
        endpoint: "/item",
        description: "get an item",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    "http://1.2.3.4/health",
    "1.2.3.4",
    "http://1.2.3.4",
    "1.2.3.4",
  );
});

afterEach(async () => {
  (config as Record<string, unknown>).retryBaseDelayMs = originalRetryBaseDelayMs;
  (config as Record<string, unknown>).retryMaxAttempts = originalRetryMaxAttempts;
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  __resetDbForTesting();
  removeCircuitBreaker(CLIENT);
});

describe("proxyToolCall — signal isolation across retry attempts", () => {
  test("second fetch receives a fresh (non-aborted) signal after timeout on first attempt", async () => {
    // Track signals captured per fetch call
    const capturedSignals: AbortSignal[] = [];

    // First call: throws an AbortError (simulating a timeout)
    // Second call: returns 200 OK
    let callCount = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async function fakeFetch(
      _url: string | URL | Request,
      options?: RequestInit,
    ): Promise<Response> {
      callCount++;
      if (options?.signal) {
        capturedSignals.push(options.signal as AbortSignal);
      }
      if (callCount === 1) {
        const err = new DOMException("The operation was aborted", "AbortError");
        throw err;
      }
      // Return a real Response object on second call
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } as typeof fetch;

    try {
      const { proxyToolCall } = await import("../../proxy/proxy.js");
      const result = await proxyToolCall(`${CLIENT}__${TOOL}`, {});

      // Must succeed on second attempt
      expect(result.isError).toBeUndefined();
      expect(result.content[0].type).toBe("text");

      // Both attempts must have fired
      expect(callCount).toBeGreaterThanOrEqual(2);

      // The signal passed to the second fetch must NOT be aborted at call time
      // (it was recorded before await resolved, so it reflects the state at invocation)
      expect(capturedSignals.length).toBeGreaterThanOrEqual(2);
      expect(capturedSignals[1].aborted).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — Response header allowlist
//
// Confirms that upstream Set-Cookie / Authorization headers are NOT forwarded
// to the MCP caller. The result carries only body text, never headers.
// ---------------------------------------------------------------------------

describe("proxyToolCall — Fix 1: response header allowlist", () => {
  test("Set-Cookie from upstream is not present in the tool result", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async function fakeFetch(): Promise<Response> {
      return new Response(JSON.stringify({ data: "ok" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "session=evil; HttpOnly",
          authorization: "Bearer leaked-token",
          "www-authenticate": 'Bearer realm="api"',
        },
      });
    } as unknown as typeof fetch;

    try {
      const { proxyToolCall } = await import("../../proxy/proxy.js");
      const result = await proxyToolCall(`${CLIENT}__${TOOL}`, {});

      // Result must not be an error
      expect(result.isError).toBeUndefined();

      // The content array should contain only body text — no header fields
      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain("set-cookie");
      expect(resultStr).not.toContain("session=evil");
      expect(resultStr).not.toContain("leaked-token");
      expect(resultStr).not.toContain("www-authenticate");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — Path traversal rejection
//
// The registry (Sprint 2 hardening) now validates endpoint templates at
// registration time, so a '..' endpoint is rejected before it can be stored.
// This is strictly stronger than the runtime proxy check.
// ---------------------------------------------------------------------------

describe("proxyToolCall — Fix 2: path traversal rejection", () => {
  const TRAVERSAL_TOOL = "traversal-tool";

  test("registry rejects endpoint template with '..' segment at registration time", async () => {
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async function fakeFetch(): Promise<Response> {
      fetchCalled = true;
      return new Response("should not reach", { status: 200 });
    } as unknown as typeof fetch;

    try {
      await expect(
        registry.register(
          CLIENT,
          [
            {
              name: TRAVERSAL_TOOL,
              method: "GET",
              endpoint: "/users/:id/../admin",
              description: "get admin via traversal",
              inputSchema: { type: "object", properties: { id: { type: "string" } } },
            },
          ],
          "http://1.2.3.4/health",
          "1.2.3.4",
          "http://1.2.3.4",
          "1.2.3.4",
        ),
      ).rejects.toThrow(/invalid path segment/i);

      // fetch must never be called because registration was rejected
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — Body cap on error response path
//
// A non-retryable error response with a body exceeding maxResponseBytes must
// be truncated rather than OOM-ing the bridge.
// ---------------------------------------------------------------------------

describe("proxyToolCall — Fix 3: body cap on error response path", () => {
  test("oversized error body is truncated and returns isError result", async () => {
    const originalMaxResponseBytes = config.maxResponseBytes;
    // Set a very small cap so we exercise truncation without allocating large buffers
    (config as Record<string, unknown>).maxResponseBytes = 10;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async function fakeFetch(): Promise<Response> {
      // Return a 400 with a body larger than the 10-byte cap
      const largeBody = "x".repeat(100);
      return new Response(largeBody, {
        status: 400,
        headers: { "content-type": "text/plain" },
      });
    } as unknown as typeof fetch;

    try {
      const { proxyToolCall } = await import("../../proxy/proxy.js");
      const result = await proxyToolCall(`${CLIENT}__${TOOL}`, {});

      expect(result.isError).toBe(true);
      // The result text should indicate truncation, not the full large body
      expect(result.content[0].text).toContain("truncated");
      expect(result.content[0].text).toContain("10");
    } finally {
      globalThis.fetch = originalFetch;
      (config as Record<string, unknown>).maxResponseBytes = originalMaxResponseBytes;
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 1 (Sprint 3) — Ajv-based argument validation
//
// Verifies that the Ajv validator correctly handles enum, format, null,
// nested objects, and unknown-property stripping — all cases the old
// imperative validator missed.
// ---------------------------------------------------------------------------

const AJV_CLIENT = "ajv-test-client";

async function registerAjvClient(toolName: string, schema: Record<string, unknown>): Promise<void> {
  for (const c of registry.listClients()) {
    await registry.unregister(c.name);
  }
  removeCircuitBreaker(AJV_CLIENT);
  await registry.register(
    AJV_CLIENT,
    [
      {
        name: toolName,
        method: "POST",
        endpoint: "/validate",
        description: "validation test tool",
        inputSchema: schema,
      },
    ],
    "http://1.2.3.4/health",
    "1.2.3.4",
    "http://1.2.3.4",
    "1.2.3.4",
  );
}

describe("proxyToolCall — Ajv validation: email format", () => {
  const TOOL_NAME = "email-tool";

  beforeEach(async () => {
    await registerAjvClient(TOOL_NAME, {
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
      },
      required: ["email"],
    });
  });

  afterEach(async () => {
    for (const c of registry.listClients()) {
      await registry.unregister(c.name);
    }
    removeCircuitBreaker(AJV_CLIENT);
    // Restore the default registration for outer afterEach
    await registry.register(
      CLIENT,
      [
        {
          name: TOOL,
          method: "GET",
          endpoint: "/item",
          description: "get an item",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      "http://1.2.3.4/health",
      "1.2.3.4",
      "http://1.2.3.4",
      "1.2.3.4",
    );
  });

  test("rejects invalid email format", async () => {
    const { proxyToolCall } = await import("../../proxy/proxy.js");
    const result = await proxyToolCall(`${AJV_CLIENT}__${TOOL_NAME}`, { email: "not-an-email" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Argument validation failed");
  });

  test("accepts valid email format", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      const { proxyToolCall } = await import("../../proxy/proxy.js");
      const result = await proxyToolCall(`${AJV_CLIENT}__${TOOL_NAME}`, { email: "user@example.com" });
      expect(result.isError).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("proxyToolCall — Ajv validation: enum constraint", () => {
  const TOOL_NAME = "enum-tool";

  beforeEach(async () => {
    await registerAjvClient(TOOL_NAME, {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["a", "b"] },
      },
      required: ["mode"],
    });
  });

  afterEach(async () => {
    for (const c of registry.listClients()) {
      await registry.unregister(c.name);
    }
    removeCircuitBreaker(AJV_CLIENT);
    await registry.register(
      CLIENT,
      [
        {
          name: TOOL,
          method: "GET",
          endpoint: "/item",
          description: "get an item",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      "http://1.2.3.4/health",
      "1.2.3.4",
      "http://1.2.3.4",
      "1.2.3.4",
    );
  });

  test("rejects value not in enum", async () => {
    const { proxyToolCall } = await import("../../proxy/proxy.js");
    const result = await proxyToolCall(`${AJV_CLIENT}__${TOOL_NAME}`, { mode: "c" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Argument validation failed");
  });
});

describe("proxyToolCall — Ajv validation: nullable field", () => {
  const TOOL_NAME = "nullable-tool";

  beforeEach(async () => {
    await registerAjvClient(TOOL_NAME, {
      type: "object",
      properties: {
        value: { type: ["string", "null"] },
      },
    });
  });

  afterEach(async () => {
    for (const c of registry.listClients()) {
      await registry.unregister(c.name);
    }
    removeCircuitBreaker(AJV_CLIENT);
    await registry.register(
      CLIENT,
      [
        {
          name: TOOL,
          method: "GET",
          endpoint: "/item",
          description: "get an item",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      "http://1.2.3.4/health",
      "1.2.3.4",
      "http://1.2.3.4",
      "1.2.3.4",
    );
  });

  test("accepts null for nullable field", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      const { proxyToolCall } = await import("../../proxy/proxy.js");
      const result = await proxyToolCall(`${AJV_CLIENT}__${TOOL_NAME}`, { value: null });
      expect(result.isError).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("proxyToolCall — Ajv validation: nested object", () => {
  const TOOL_NAME = "nested-tool";

  beforeEach(async () => {
    await registerAjvClient(TOOL_NAME, {
      type: "object",
      properties: {
        address: {
          type: "object",
          properties: {
            zip: { type: "string" },
          },
          required: ["zip"],
        },
      },
      required: ["address"],
    });
  });

  afterEach(async () => {
    for (const c of registry.listClients()) {
      await registry.unregister(c.name);
    }
    removeCircuitBreaker(AJV_CLIENT);
    await registry.register(
      CLIENT,
      [
        {
          name: TOOL,
          method: "GET",
          endpoint: "/item",
          description: "get an item",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      "http://1.2.3.4/health",
      "1.2.3.4",
      "http://1.2.3.4",
      "1.2.3.4",
    );
  });

  test("rejects when required nested field is wrong type", async () => {
    const { proxyToolCall } = await import("../../proxy/proxy.js");
    const result = await proxyToolCall(`${AJV_CLIENT}__${TOOL_NAME}`, { address: { zip: 12345 } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Argument validation failed");
  });
});

describe("proxyToolCall — Ajv validation: unknown additional property stripped", () => {
  const TOOL_NAME = "strip-tool";

  beforeEach(async () => {
    await registerAjvClient(TOOL_NAME, {
      type: "object",
      properties: {
        name: { type: "string" },
      },
    });
  });

  afterEach(async () => {
    for (const c of registry.listClients()) {
      await registry.unregister(c.name);
    }
    removeCircuitBreaker(AJV_CLIENT);
    await registry.register(
      CLIENT,
      [
        {
          name: TOOL,
          method: "GET",
          endpoint: "/item",
          description: "get an item",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      "http://1.2.3.4/health",
      "1.2.3.4",
      "http://1.2.3.4",
      "1.2.3.4",
    );
  });

  test("unknown additional property is stripped and NOT forwarded in the request body", async () => {
    let capturedBody: string | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, opts?: RequestInit) => {
      capturedBody = opts?.body as string | undefined;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const { proxyToolCall } = await import("../../proxy/proxy.js");
      const result = await proxyToolCall(`${AJV_CLIENT}__${TOOL_NAME}`, { name: "alice", secret: "hunter2" });
      expect(result.isError).toBeUndefined();
      // The body sent upstream must NOT contain the unknown key
      expect(capturedBody).toBeDefined();
      expect(capturedBody).not.toContain("secret");
      expect(capturedBody).not.toContain("hunter2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

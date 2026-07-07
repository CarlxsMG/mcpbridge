/**
 * Streaming-format normalization — the pure NDJSON/SSE parser, config
 * persistence, and proxy integration (a streaming body becomes one
 * `{ events: [...] }` JSON result).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import { getStreamingConfig, setStreamingConfig, parseStream } from "../../proxy/streaming.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "svc";
const streamTool: RestToolDefinition = {
  name: "get-stream",
  method: "GET",
  endpoint: "/stream",
  description: "stream",
  inputSchema: { type: "object", properties: {} },
};
async function reg(): Promise<void> {
  await registry.register(CLIENT, [streamTool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

const originalFetch = globalThis.fetch;
function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
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

describe("parseStream", () => {
  test("ndjson: one JSON value per non-blank line, skipping junk", () => {
    expect(parseStream('{"a":1}\n\n{"a":2}\nnotjson\n', "ndjson", 100)).toEqual([{ a: 1 }, { a: 2 }]);
  });
  test("ndjson: respects the event cap", () => {
    expect(parseStream('{"a":1}\n{"a":2}\n{"a":3}', "ndjson", 2)).toEqual([{ a: 1 }, { a: 2 }]);
  });
  test("sse: data payloads, [DONE] dropped, non-JSON kept as string", () => {
    expect(parseStream('data: {"x":1}\n\ndata: hello\n\ndata: [DONE]', "sse", 100)).toEqual([{ x: 1 }, "hello"]);
  });
  test("sse: multi-line data joins before parsing", () => {
    expect(parseStream('data: {"x":\ndata: 1}\n', "sse", 100)).toEqual([{ x: 1 }]);
  });

  // Mutation backstop: enabled mapping + the sse join char + the sse event cap.
  test("sse multi-line NON-JSON data joins with a newline before being kept raw (kills L92)", () => {
    // Two non-JSON data lines: the join char is observable in the raw kept string.
    expect(parseStream("data: a\ndata: b", "sse", 100)).toEqual(["a\nb"]);
  });

  test("sse respects the event cap (kills L99)", () => {
    expect(parseStream("data: 1\n\ndata: 2\n\ndata: 3", "sse", 2)).toEqual([1, 2]);
  });
});

describe("getStreamingConfig — enabled mapping (mutation backstop)", () => {
  test("maps a disabled config to enabled:false (kills L37)", async () => {
    await reg();
    setStreamingConfig(CLIENT, "get-stream", { enabled: false, format: "sse", maxEvents: 10 });
    expect(getStreamingConfig(CLIENT, "get-stream")).toEqual({ enabled: false, format: "sse", maxEvents: 10 });
  });
});

describe("config persistence", () => {
  test("unknown tool -> false; set/get; clear", async () => {
    await reg();
    expect(setStreamingConfig(CLIENT, "nope", { enabled: true, format: "ndjson", maxEvents: 100 })).toBe(false);
    expect(setStreamingConfig(CLIENT, "get-stream", { enabled: true, format: "ndjson", maxEvents: 500 })).toBe(true);
    expect(getStreamingConfig(CLIENT, "get-stream")).toEqual({ enabled: true, format: "ndjson", maxEvents: 500 });
    expect(setStreamingConfig(CLIENT, "get-stream", null)).toBe(true);
    expect(getStreamingConfig(CLIENT, "get-stream")).toBeNull();
  });
});

describe("proxy integration", () => {
  test("an NDJSON body is normalized into { events: [...] }", async () => {
    await reg();
    setStreamingConfig(CLIENT, "get-stream", { enabled: true, format: "ndjson", maxEvents: 100 });
    globalThis.fetch = (async () =>
      new Response('{"a":1}\n{"a":2}\n{"a":3}\n', {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      })) as unknown as typeof fetch;
    const r = await proxyToolCall(`${CLIENT}__get-stream`, {});
    expect(JSON.parse(r.content[0].text).events).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  test("an SSE body is normalized, dropping the [DONE] sentinel", async () => {
    await reg();
    setStreamingConfig(CLIENT, "get-stream", { enabled: true, format: "sse", maxEvents: 100 });
    globalThis.fetch = (async () =>
      new Response('data: {"t":"a"}\n\ndata: {"t":"b"}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;
    const r = await proxyToolCall(`${CLIENT}__get-stream`, {});
    expect(JSON.parse(r.content[0].text).events).toEqual([{ t: "a" }, { t: "b" }]);
  });
});

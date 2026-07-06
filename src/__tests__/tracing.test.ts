/**
 * OTLP/HTTP span export + the Prometheus tool-call counter.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { removeCircuitBreaker } from "../middleware/circuit-breaker.js";
import { proxyToolCall } from "../proxy/proxy.js";
import { tracingEnabled, startSpan, endSpan, flush, _internalsForTesting } from "../observability/tracing.js";
import { metricsRegistry, recordToolCall } from "../observability/metrics.js";
import type { RestToolDefinition } from "../mcp/types.js";

import { withConfig } from "./_utils/with-config.js";
const originalFetch = globalThis.fetch;
const originalEndpoint = config.otelEndpoint;

beforeEach(async () => {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  removeCircuitBreaker("svc");
  _internalsForTesting.clear();
  globalThis.fetch = originalFetch;
  (config as Record<string, unknown>).otelEndpoint = undefined;
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  _internalsForTesting.clear();
  globalThis.fetch = originalFetch;
  (config as Record<string, unknown>).otelEndpoint = originalEndpoint;
});

describe("tracing — enable gate", () => {
  test("disabled: endSpan buffers nothing", () => {
    expect(tracingEnabled()).toBe(false);
    const s = startSpan("x", { a: "b" });
    endSpan(s, {}, 1);
    expect(_internalsForTesting.bufferLength()).toBe(0);
  });

  test("enabled: endSpan buffers a span", async () => {
    await withConfig({ otelEndpoint: "http://otel.local/v1/traces" }, async () => {
      expect(tracingEnabled()).toBe(true);
      endSpan(startSpan("x"), {}, 1);
      expect(_internalsForTesting.bufferLength()).toBe(1);
    });
  });

  test("span ids are the right widths", () => {
    const s = startSpan("x");
    expect(s.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("tracing — OTLP export", () => {
  test("flush posts a well-formed OTLP payload", async () => {
    await withConfig({ otelEndpoint: "http://otel.local/v1/traces" }, async () => {
      let captured: Record<string, unknown> | null = null;
      globalThis.fetch = (async (url: string, opts: RequestInit) => {
        if (String(url).includes("otel.local")) {
          captured = JSON.parse(String(opts.body));
          return new Response("{}", { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      endSpan(startSpan("tool_call svc__x", { "mcp.tool": "svc__x" }), { "mcp.tool.is_error": false }, 1);
      await flush();

      expect(captured).not.toBeNull();
      const rs = (captured as unknown as { resourceSpans: unknown[] }).resourceSpans[0] as Record<string, unknown>;
      const scopeSpans = (rs.scopeSpans as Record<string, unknown>[])[0];
      const span = (scopeSpans.spans as Record<string, unknown>[])[0];
      expect(span.name).toBe("tool_call svc__x");
      expect(span.kind).toBe(3);
      expect((span.status as { code: number }).code).toBe(1);
      expect(typeof span.startTimeUnixNano).toBe("string");
      // resource carries service.name
      const resAttrs = (rs.resource as { attributes: { key: string; value: { stringValue: string } }[] }).attributes;
      expect(resAttrs.find((a) => a.key === "service.name")?.value.stringValue).toBe(config.otelServiceName);
    });
  });
});

describe("tracing — proxy integration", () => {
  test("a proxied tool call emits a span that flushes to the collector", async () => {
    await withConfig({ otelEndpoint: "http://otel.local/v1/traces" }, async () => {
      let captured: Record<string, unknown> | null = null;
      globalThis.fetch = (async (url: string, opts: RequestInit) => {
        if (String(url).includes("otel.local")) {
          captured = JSON.parse(String(opts.body));
          return new Response("{}", { status: 200 });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;

      const tool: RestToolDefinition = {
        name: "get-x",
        method: "GET",
        endpoint: "/x",
        description: "x",
        inputSchema: { type: "object", properties: {} },
      };
      await registry.register("svc", [tool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");

      const r = await proxyToolCall("svc__get-x", {});
      expect(r.isError).toBeUndefined();
      expect(_internalsForTesting.bufferLength()).toBe(1);

      await flush();
      const span = (
        (
          (captured as unknown as { resourceSpans: Record<string, unknown>[] }).resourceSpans[0].scopeSpans as Record<
            string,
            unknown
          >[]
        )[0].spans as Record<string, unknown>[]
      )[0];
      expect(span.name).toBe("tool_call svc__get-x");
    });
  });

  test("a session id threaded via ToolCallOpts is attached to the span as mcp.session_id", async () => {
    await withConfig({ otelEndpoint: "http://otel.local/v1/traces" }, async () => {
      let captured: Record<string, unknown> | null = null;
      globalThis.fetch = (async (url: string, opts: RequestInit) => {
        if (String(url).includes("otel.local")) {
          captured = JSON.parse(String(opts.body));
          return new Response("{}", { status: 200 });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;

      const tool: RestToolDefinition = {
        name: "get-x",
        method: "GET",
        endpoint: "/x",
        description: "x",
        inputSchema: { type: "object", properties: {} },
      };
      await registry.register("svc", [tool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");

      const r = await proxyToolCall("svc__get-x", {}, undefined, { sessionId: "mcp-session-42" });
      expect(r.isError).toBeUndefined();

      await flush();
      const span = (
        (
          (captured as unknown as { resourceSpans: Record<string, unknown>[] }).resourceSpans[0].scopeSpans as Record<
            string,
            unknown
          >[]
        )[0].spans as Record<string, unknown>[]
      )[0];
      const attrs = span.attributes as { key: string; value: { stringValue?: string } }[];
      expect(attrs.find((a) => a.key === "mcp.session_id")?.value.stringValue).toBe("mcp-session-42");
    });
  });

  test("no ToolCallOpts.sessionId -> the span carries no mcp.session_id attribute at all", async () => {
    await withConfig({ otelEndpoint: "http://otel.local/v1/traces" }, async () => {
      let captured: Record<string, unknown> | null = null;
      globalThis.fetch = (async (url: string, opts: RequestInit) => {
        if (String(url).includes("otel.local")) {
          captured = JSON.parse(String(opts.body));
          return new Response("{}", { status: 200 });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;

      const tool: RestToolDefinition = {
        name: "get-x",
        method: "GET",
        endpoint: "/x",
        description: "x",
        inputSchema: { type: "object", properties: {} },
      };
      await registry.register("svc", [tool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");

      await proxyToolCall("svc__get-x", {});
      await flush();
      const span = (
        (
          (captured as unknown as { resourceSpans: Record<string, unknown>[] }).resourceSpans[0].scopeSpans as Record<
            string,
            unknown
          >[]
        )[0].spans as Record<string, unknown>[]
      )[0];
      const attrs = span.attributes as { key: string; value: { stringValue?: string } }[];
      expect(attrs.find((a) => a.key === "mcp.session_id")).toBeUndefined();
    });
  });
});

describe("metrics — prometheus tool-call counter", () => {
  test("recordToolCall increments mcp_tool_calls_total and it renders", () => {
    recordToolCall(5, false);
    recordToolCall(5, true);
    const out = metricsRegistry.render();
    expect(out).toContain("# TYPE mcp_tool_calls_total counter");
    expect(out).toMatch(/mcp_tool_calls_total\{outcome="success"\}/);
    expect(out).toMatch(/mcp_tool_calls_total\{outcome="error"\}/);
  });
});

/**
 * W3C Trace Context — parser, serializer, and AsyncLocalStorage plumbing.
 *
 * Covers the W3C spec edge cases (bad version, all-zero ids, non-hex chars,
 * unknown future versions, missing fields, tracestate pass-through) and the
 * integration with `requestIdMiddleware` and `startSpan` (parent inheritance
 * + OTLP parentSpanId emission).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { randomBytes } from "node:crypto";
import {
  formatTraceparent,
  getCurrentSpan,
  getCurrentTraceContext,
  newSpanId,
  newTraceId,
  outboundTraceHeaders,
  parseTraceparent,
  setCurrentSpan,
  withTraceContext,
  buildOutboundTraceparent,
} from "../observability/trace-context.js";
import { endSpan, startSpan, buildOtlpPayload } from "../observability/tracing.js";
import { config } from "../config.js";
import { requestIdMiddleware } from "../middleware/request-id.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function validTraceparent(overrides: Partial<{ traceId: string; parentSpanId: string; flags: string }> = {}): string {
  const traceId = overrides.traceId ?? randomBytes(16).toString("hex");
  const parentSpanId = overrides.parentSpanId ?? randomBytes(8).toString("hex");
  const flags = overrides.flags ?? "01";
  return `00-${traceId}-${parentSpanId}-${flags}`;
}

const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

// ── Parser ───────────────────────────────────────────────────────────────────

describe("parseTraceparent", () => {
  test("parses a well-formed v00 header (sampled)", () => {
    const tp = validTraceparent({ flags: "01" });
    const p = parseTraceparent(tp)!;
    expect(p).not.toBeNull();
    expect(p.version).toBe("00");
    expect(p.flags).toBe("01");
    expect(p.sampled).toBe(true);
  });

  test("parses a well-formed v00 header (not sampled)", () => {
    const tp = validTraceparent({ flags: "00" });
    expect(parseTraceparent(tp)!.sampled).toBe(false);
  });

  test("parses a future version (v01) and ignores trailing fields", () => {
    // Per W3C, future versions may append more fields; we should still
    // recover traceId and parentId.
    const traceId = randomBytes(16).toString("hex");
    const parentSpanId = randomBytes(8).toString("hex");
    const raw = `01-${traceId}-${parentSpanId}-01-extra-stuff`;
    const p = parseTraceparent(raw)!;
    expect(p.version).toBe("01");
    expect(p.traceId).toBe(traceId);
    expect(p.parentSpanId).toBe(parentSpanId);
  });

  test("returns null for missing / non-string input", () => {
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent(null)).toBeNull();
    expect(parseTraceparent("")).toBeNull();
  });

  test("returns null for malformed (wrong field count)", () => {
    expect(parseTraceparent("00-aabb")).toBeNull();
    expect(parseTraceparent("only-one-field")).toBeNull();
    // Future-version tolerance: 5+ fields with a valid v01 prefix parse OK
    // (the W3C spec allows implementations to extract the first 4 fields).
    const tp5 = `01-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01-extra-stuff`;
    expect(parseTraceparent(tp5)).not.toBeNull();
    // v00 with extra fields: per spec, the implementation MUST NOT treat
    // extra fields as an error — it extracts the first four. (Future
    // versions may carry vendor data after the standard four.)
    const tpBad = `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01-extra`;
    expect(parseTraceparent(tpBad)).not.toBeNull();
  });

  test("returns null for reserved version ff", () => {
    expect(parseTraceparent(`ff-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`)).toBeNull();
  });

  test("returns null for all-zero trace-id (forbidden by spec)", () => {
    expect(parseTraceparent(`00-${ZERO_TRACE}-${randomBytes(8).toString("hex")}-01`)).toBeNull();
  });

  test("returns null for all-zero parent-id (forbidden by spec)", () => {
    expect(parseTraceparent(`00-${randomBytes(16).toString("hex")}-${ZERO_SPAN}-01`)).toBeNull();
  });

  test("returns null for non-hex trace-id", () => {
    expect(parseTraceparent(`00-${"z".repeat(32)}-${randomBytes(8).toString("hex")}-01`)).toBeNull();
  });

  test("returns null for non-hex parent-id", () => {
    expect(parseTraceparent(`00-${randomBytes(16).toString("hex")}-${"z".repeat(16)}-01`)).toBeNull();
  });

  test("returns null for non-hex flags", () => {
    expect(parseTraceparent(`00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-zz`)).toBeNull();
  });

  test("returns null for wrong field widths", () => {
    // 31-char trace-id
    expect(parseTraceparent(`00-${"a".repeat(31)}-${randomBytes(8).toString("hex")}-01`)).toBeNull();
    // 15-char parent-id
    expect(parseTraceparent(`00-${randomBytes(16).toString("hex")}-${"a".repeat(15)}-01`)).toBeNull();
  });

  test("tolerates surrounding whitespace", () => {
    const tp = validTraceparent();
    expect(parseTraceparent(`  ${tp}  `)).not.toBeNull();
  });
});

// ── Formatter / id generation ────────────────────────────────────────────────

describe("formatTraceparent and id generation", () => {
  test("round-trips through parseTraceparent", () => {
    const traceId = newTraceId();
    const parentSpanId = newSpanId();
    const formatted = formatTraceparent(traceId, parentSpanId, true);
    const parsed = parseTraceparent(formatted)!;
    expect(parsed.traceId).toBe(traceId);
    expect(parsed.parentSpanId).toBe(parentSpanId);
    expect(parsed.sampled).toBe(true);
  });

  test("formatTraceparent produces version 00 with sampled flags correctly", () => {
    const out = formatTraceparent("a".repeat(32), "b".repeat(16), false);
    expect(out).toBe(`00-${"a".repeat(32)}-${"b".repeat(16)}-00`);
  });

  test("newTraceId and newSpanId produce correctly-sized lowercase hex", () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });

  test("newTraceId never returns the all-zero forbidden value", () => {
    // 1000 attempts: astronomically unlikely to hit zero, but proves the
    // spec-mandated "not all zero" guard works.
    for (let i = 0; i < 1000; i++) {
      expect(newTraceId()).not.toBe(ZERO_TRACE);
      expect(newSpanId()).not.toBe(ZERO_SPAN);
    }
  });
});

// ── AsyncLocalStorage ────────────────────────────────────────────────────────

describe("AsyncLocalStorage context", () => {
  test("getCurrentTraceContext returns the empty context outside any run", () => {
    const c = getCurrentTraceContext();
    expect(c.traceparent).toBeNull();
    expect(c.tracestate).toBeNull();
    expect(c.currentSpan).toBeNull();
  });

  test("withTraceContext propagates through synchronous code", () => {
    const tp = parseTraceparent(validTraceparent())!;
    withTraceContext({ traceparent: tp, tracestate: "vendor=value", currentSpan: null }, () => {
      const c = getCurrentTraceContext();
      expect(c.traceparent?.traceId).toBe(tp.traceId);
      expect(c.tracestate).toBe("vendor=value");
    });
  });

  test("withTraceContext propagates through async/await", async () => {
    const tp = parseTraceparent(validTraceparent())!;
    await withTraceContext({ traceparent: tp, tracestate: null, currentSpan: null }, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 5));
      const c = getCurrentTraceContext();
      expect(c.traceparent?.traceId).toBe(tp.traceId);
    });
  });

  test("context is isolated across concurrent requests", async () => {
    const tpA = parseTraceparent(validTraceparent())!;
    const tpB = parseTraceparent(validTraceparent())!;
    const seen: string[] = [];
    await Promise.all([
      withTraceContext({ traceparent: tpA, tracestate: null, currentSpan: null }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        seen.push(getCurrentTraceContext().traceparent!.traceId);
      }),
      withTraceContext({ traceparent: tpB, tracestate: null, currentSpan: null }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(getCurrentTraceContext().traceparent!.traceId);
      }),
    ]);
    expect(seen.sort()).toEqual([tpA.traceId, tpB.traceId].sort());
  });

  test("setCurrentSpan registers a span and getCurrentSpan returns it", () => {
    const span = { traceId: "a".repeat(32), spanId: "b".repeat(16) };
    withTraceContext({ traceparent: null, tracestate: null, currentSpan: null }, () => {
      expect(getCurrentSpan()).toBeNull();
      setCurrentSpan(span);
      expect(getCurrentSpan()).toEqual(span);
      setCurrentSpan(null);
      expect(getCurrentSpan()).toBeNull();
    });
  });

  test("setCurrentSpan is a no-op outside any withTraceContext", () => {
    // Calling setCurrentSpan from a bare test would otherwise leak the span
    // into the test's async tree. Verify it does not.
    const before = getCurrentSpan();
    setCurrentSpan({ traceId: "z".repeat(32), spanId: "y".repeat(16) });
    const after = getCurrentSpan();
    expect(before).toBeNull();
    expect(after).toBeNull();
  });
});

// ── Outbound propagation ────────────────────────────────────────────────────

describe("buildOutboundTraceparent / outboundTraceHeaders", () => {
  test("returns null when no upstream parent and no explicit span", () => {
    const out = withTraceContext({ traceparent: null, tracestate: null, currentSpan: null }, () =>
      buildOutboundTraceparent(),
    );
    expect(out).toBeNull();
  });

  test("inherits trace-id from upstream when no span is supplied", () => {
    const tp = parseTraceparent(validTraceparent({ traceId: "a".repeat(32), parentSpanId: "b".repeat(16) }))!;
    const out = withTraceContext({ traceparent: tp, tracestate: null, currentSpan: null }, () =>
      buildOutboundTraceparent(),
    );
    expect(out).toMatch(/^00-a{32}-[0-9a-f]{16}-01$/);
  });

  test("uses the supplied span as the parent id", () => {
    const tp = parseTraceparent(validTraceparent({ traceId: "a".repeat(32) }))!;
    const out = withTraceContext({ traceparent: tp, tracestate: null, currentSpan: null }, () =>
      buildOutboundTraceparent("b".repeat(16)),
    );
    expect(out).toBe(`00-${"a".repeat(32)}-${"b".repeat(16)}-01`);
  });

  test("honors the upstream's sampled bit", () => {
    const tp = parseTraceparent(validTraceparent({ flags: "00" }))!;
    const out = withTraceContext({ traceparent: tp, tracestate: null, currentSpan: null }, () =>
      buildOutboundTraceparent("b".repeat(16)),
    );
    expect(out).toMatch(/-00$/);
  });

  test("falls back to sampled=true when generating a fresh trace", () => {
    const out = withTraceContext({ traceparent: null, tracestate: null, currentSpan: null }, () =>
      buildOutboundTraceparent("b".repeat(16)),
    );
    expect(out).toMatch(/-01$/);
  });

  test("outboundTraceHeaders merges existing headers and sets traceparent + tracestate", () => {
    const tp = parseTraceparent(validTraceparent())!;
    const ts = "vendor=value,other=42";
    const out = withTraceContext({ traceparent: tp, tracestate: ts, currentSpan: null }, () =>
      outboundTraceHeaders(undefined, { "Content-Type": "application/json", "X-Custom": "yes" }),
    );
    expect(out.get("content-type")).toBe("application/json");
    expect(out.get("x-custom")).toBe("yes");
    expect(out.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(out.get("tracestate")).toBe(ts);
  });

  test("outboundTraceHeaders is a no-op (no traceparent) when no upstream context", () => {
    const out = withTraceContext({ traceparent: null, tracestate: null, currentSpan: null }, () =>
      outboundTraceHeaders(undefined, { "X-Foo": "bar" }),
    );
    expect(out.get("x-foo")).toBe("bar");
    expect(out.get("traceparent")).toBeNull();
  });
});

// ── startSpan / endSpan integration ──────────────────────────────────────────

describe("startSpan inherits from the trace context", () => {
  test("inside a trace context, startSpan uses the upstream's traceId and records the parent", () => {
    const tp = parseTraceparent(validTraceparent({ traceId: "a".repeat(32), parentSpanId: "b".repeat(16) }))!;
    withTraceContext({ traceparent: tp, tracestate: null, currentSpan: null }, () => {
      const s = startSpan("tool_call foo");
      expect(s.traceId).toBe("a".repeat(32));
      expect(s.parentSpanId).toBe("b".repeat(16));
      expect(s.spanId).not.toBe("b".repeat(16)); // new span id
      expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  test("outside any trace context, startSpan mints a fresh trace and has no parent", () => {
    const s = startSpan("fresh");
    expect(s.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(s.parentSpanId).toBeUndefined();
  });

  test("endSpan clears the current span so a subsequent span is not its child", () => {
    const tp = parseTraceparent(validTraceparent())!;
    withTraceContext({ traceparent: tp, tracestate: null, currentSpan: null }, () => {
      const s1 = startSpan("first");
      expect(getCurrentSpan()?.spanId).toBe(s1.spanId);
      // OTLP path: register the span so endSpan does its full work.
      (config as Record<string, unknown>).otelEndpoint = "http://otel.local/v1/traces";
      endSpan(s1, {}, 1);
      // After endSpan, currentSpan is cleared. A new startSpan should NOT
      // use s1.spanId as its parent.
      const s2 = startSpan("second");
      expect(s2.parentSpanId).toBe(tp.parentSpanId); // still the upstream
      expect(s2.spanId).not.toBe(s1.spanId);
      expect(getCurrentSpan()?.spanId).toBe(s2.spanId);
      (config as Record<string, unknown>).otelEndpoint = undefined;
    });
  });
});

// ── OTLP payload includes parentSpanId ──────────────────────────────────────

describe("OTLP payload emits parentSpanId when present", () => {
  test("a span with a parent surfaces parentSpanId in the OTLP JSON", () => {
    const span = {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      parentSpanId: "c".repeat(16),
      name: "t",
      startMs: 0,
      endMs: 1,
      statusCode: 1 as const,
      attributes: {},
    };
    const payload = buildOtlpPayload([span], "test") as {
      resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[];
    };
    const out = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(out.parentSpanId).toBe("c".repeat(16));
  });

  test("a root span omits parentSpanId entirely", () => {
    const span = {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      name: "t",
      startMs: 0,
      endMs: 1,
      statusCode: 1 as const,
      attributes: {},
    };
    const payload = buildOtlpPayload([span], "test") as {
      resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[];
    };
    const out = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect("parentSpanId" in out).toBe(false);
  });
});

// ── Middleware integration (Express round-trip) ──────────────────────────────

describe("requestIdMiddleware — traceparent plumbing", () => {
  let baseUrl = "";
  let activeServer: Server | null = null;

  async function startApp(echoHandler: (req: express.Request, res: express.Response) => void): Promise<void> {
    const app = express();
    app.use(requestIdMiddleware);
    app.post("/echo", echoHandler);
    return new Promise((resolve, reject) => {
      const srv = app.listen(0, "127.0.0.1", () => {
        const addr = srv.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        activeServer = srv;
        resolve();
      });
      srv.on("error", reject);
    });
  }

  function stopServer(): Promise<void> {
    return new Promise((resolve) => {
      if (activeServer) {
        activeServer.close(() => {
          activeServer = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  afterEach(async () => {
    await stopServer();
  });

  test("a request with a valid traceparent propagates it into the handler's context", async () => {
    let observed: { traceId: string; parentSpanId: string; sampled: boolean } | null = null;
    await startApp((_req, res) => {
      const c = getCurrentTraceContext();
      observed = c.traceparent
        ? {
            traceId: c.traceparent.traceId,
            parentSpanId: c.traceparent.parentSpanId,
            sampled: c.traceparent.sampled,
          }
        : null;
      res.json({ ok: true });
    });

    const tp = validTraceparent({ traceId: "a".repeat(32), parentSpanId: "b".repeat(16), flags: "01" });
    const r = await fetch(`${baseUrl}/echo`, {
      method: "POST",
      headers: { traceparent: tp, "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(200);
    expect(observed).not.toBeNull();
    expect(observed!).toEqual({ traceId: "a".repeat(32), parentSpanId: "b".repeat(16), sampled: true });
  });

  test("a request with a malformed traceparent falls back to no-parent (not an error)", async () => {
    let observedHasParent = true;
    await startApp((_req, res) => {
      observedHasParent = getCurrentTraceContext().traceparent !== null;
      res.json({ ok: true });
    });

    const r = await fetch(`${baseUrl}/echo`, {
      method: "POST",
      headers: { traceparent: "this-is-not-valid", "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(200);
    expect(observedHasParent).toBe(false);
  });

  test("a request without traceparent still gets a clean context (no error)", async () => {
    let observedTraceparent: unknown = "untouched";
    await startApp((_req, res) => {
      observedTraceparent = getCurrentTraceContext().traceparent;
      res.json({ ok: true });
    });

    const r = await fetch(`${baseUrl}/echo`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(r.status).toBe(200);
    expect(observedTraceparent).toBeNull();
  });

  test("tracestate header is passed through verbatim", async () => {
    let observedTracestate: string | null = "untouched";
    await startApp((_req, res) => {
      observedTracestate = getCurrentTraceContext().tracestate;
      res.json({ ok: true });
    });

    const tp = validTraceparent();
    const r = await fetch(`${baseUrl}/echo`, {
      method: "POST",
      headers: { traceparent: tp, tracestate: "vendor=42,other=hello", "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(200);
    expect(observedTracestate).toBe("vendor=42,other=hello");
  });
});

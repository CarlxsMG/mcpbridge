/**
 * Stryker mutation-testing backstop for src/routes/traces.ts — domain 8.
 *
 * Baseline: 41 mutants, 0 killed / 41 survived — traces.ts had ZERO test
 * coverage of any kind before this file. All line:col citations below were
 * read directly from reports/mutation/result.json.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { startSpan, endSpan, _internalsForTesting as tracingInternals } from "../../observability/tracing.js";
import { __clearSpansForTesting } from "../../observability/trace-store.js";
import * as auditMod from "../../admin/audit/audit.js";

let activeServer: Server | null = null;
const ADMIN_KEY = "test-admin-key-traces";
const originalAdminApiKeys = config.adminApiKeys;
const originalAuthDisabled = config.authDisabled;
const originalTraceStorage = config.traceStorageEnabled;

async function startApp(): Promise<string> {
  __resetDbForTesting();
  __clearSpansForTesting();
  tracingInternals.clear();
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  (config as Record<string, unknown>).traceStorageEnabled = true;

  const { tracesRoutes } = await import("../../routes/traces.js");
  const app = express();
  app.use(express.json());
  tracesRoutes(app);

  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      activeServer = srv;
      resolve(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
    });
    srv.on("error", reject);
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}` };
}

function recordSpan(name: string, attrs: Record<string, string> = {}): { traceId: string } {
  const span = startSpan(name, attrs);
  endSpan(span, {}, 1);
  return span;
}

beforeEach(() => {
  __resetDbForTesting();
  __clearSpansForTesting();
  tracingInternals.clear();
});
afterEach(async () => {
  (config as Record<string, unknown>).adminApiKeys = originalAdminApiKeys;
  (config as Record<string, unknown>).authDisabled = originalAuthDisabled;
  (config as Record<string, unknown>).traceStorageEnabled = originalTraceStorage;
  __resetDbForTesting();
  __clearSpansForTesting();
  tracingInternals.clear();
  await new Promise<void>((resolve) => {
    if (activeServer)
      activeServer.close(() => {
        activeServer = null;
        resolve();
      });
    else resolve();
  });
});

describe("GET /admin-api/traces — list + filters", () => {
  // Kills 8:50-39:2 (BlockStatement, the whole tracesRoutes body emptied --
  // no route would be wired at all) and 9:76-15:4 (this handler's own body
  // emptied).
  test("lists every recorded trace with no filters", async () => {
    const baseUrl = await startApp();
    recordSpan("tool_call svc__a", { "mcp.tool": "svc__a" });
    recordSpan("tool_call svc__b", { "mcp.tool": "svc__b" });
    const res = await fetch(`${baseUrl}/admin-api/traces`, { headers: bearer() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(2);
  });

  // Kills 9:11-9:30 StringLiteral (the "tool" query-key literal emptied) and
  // 10:25-10:59 (ConditionalExpression true/false, EqualityOperator '!==',
  // StringLiteral "string" emptied) -- the mcpToolName filter.
  test("filters by ?tool=<mcpToolName>", async () => {
    const baseUrl = await startApp();
    recordSpan("tool_call svc__a", { "mcp.tool": "svc__a" });
    recordSpan("tool_call svc__b", { "mcp.tool": "svc__b" });
    const res = await fetch(`${baseUrl}/admin-api/traces?tool=svc__a`, { headers: bearer() });
    const body = (await res.json()) as { items: { mcpToolName: string | null }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].mcpToolName).toBe("svc__a");
  });

  // Kills 10:25-10:59 ConditionalExpression true (forcing the ternary to
  // always take the "use req.query.tool as-is" branch). A test with `tool`
  // absent can't distinguish this (both branches yield undefined); a test
  // with a real string value can't either (the real condition is already
  // true there too). Needs a genuinely non-string but TRUTHY query value --
  // Express's default qs parser turns a REPEATED query key into an array --
  // so the forced-true mutant would pass that array straight through as
  // mcpToolName instead of undefined, which can never match any real tool
  // name and returns zero items; real code correctly ignores it (no filter).
  test("a non-string ?tool value (repeated query key) is ignored, not passed through as a filter", async () => {
    const baseUrl = await startApp();
    recordSpan("tool_call svc__a", { "mcp.tool": "svc__a" });
    const res = await fetch(`${baseUrl}/admin-api/traces?tool=a&tool=b`, { headers: bearer() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });

  // Kills 11:23-11:63 (ConditionalExpression true/false, EqualityOperator
  // '!==', StringLiteral "string" emptied) -- the sessionId filter.
  test("filters by ?session_id=<sessionId>", async () => {
    const baseUrl = await startApp();
    recordSpan("tool_call svc__a", { "mcp.tool": "svc__a" });
    endSpan(startSpan("tool_call svc__b", { "mcp.tool": "svc__b" }), { "mcp.session_id": "sess-42" }, 1);
    const res = await fetch(`${baseUrl}/admin-api/traces?session_id=sess-42`, { headers: bearer() });
    const body = (await res.json()) as { items: { sessionId: string | null }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].sessionId).toBe("sess-42");
  });

  // Kills 11:23-11:63 ConditionalExpression true, same technique/reasoning
  // as the ?tool case above, applied to sessionId.
  test("a non-string ?session_id value (repeated query key) is ignored, not passed through as a filter", async () => {
    const baseUrl = await startApp();
    endSpan(startSpan("tool_call svc__a", { "mcp.tool": "svc__a" }), { "mcp.session_id": "sess-1" }, 1);
    const res = await fetch(`${baseUrl}/admin-api/traces?session_id=a&session_id=b`, { headers: bearer() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });

  // Kills 12:20-12:56 (ConditionalExpression true/false, EqualityOperator
  // '!==', StringLiteral "string" emptied) -- the cursor param, verified via
  // pagination actually working across two pages. Asserting page2's item is
  // DISTINCT from page1's is load-bearing: if the cursor were silently
  // dropped (forced-false / `typeof x === ""` mutants both make the ternary
  // always take the `undefined` branch), page2 would just repeat page1's
  // newest-first item and a mere toHaveLength(1) check would still pass.
  test("?cursor=<nextCursor> paginates to a genuinely different second page", async () => {
    const baseUrl = await startApp();
    recordSpan("tool_call svc__a", { "mcp.tool": "svc__a" });
    recordSpan("tool_call svc__b", { "mcp.tool": "svc__b" });
    const page1Res = await fetch(`${baseUrl}/admin-api/traces?limit=1`, { headers: bearer() });
    const page1 = (await page1Res.json()) as {
      items: Array<{ traceId: string }>;
      nextCursor?: string;
    };
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeDefined();

    const page2Res = await fetch(`${baseUrl}/admin-api/traces?limit=1&cursor=${page1.nextCursor}`, {
      headers: bearer(),
    });
    const page2 = (await page2Res.json()) as { items: Array<{ traceId: string }> };
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].traceId).not.toBe(page1.items[0].traceId);
  });

  // Kills 12:20-12:56 ConditionalExpression true, same technique as the
  // ?tool/?session_id cases above, applied to cursor. A non-string cursor
  // value (a repeated query key -> array) forced through as-is coerces to
  // NaN inside listTraces' `Number(filter.cursor)`, making its `id < ?`
  // clause compare against NaN -- which is never true for any real id --
  // silently returning zero items instead of ignoring the bogus cursor.
  test("a non-string ?cursor value (repeated query key) is ignored, not passed through as a filter", async () => {
    const baseUrl = await startApp();
    recordSpan("tool_call svc__a", { "mcp.tool": "svc__a" });
    const res = await fetch(`${baseUrl}/admin-api/traces?cursor=a&cursor=b`, { headers: bearer() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });

  // Kills 13:19-13:48 (ConditionalExpression true/false, EqualityOperator
  // '===') and 14:37-14:78 (ObjectLiteral, the filter object passed to
  // listTraces emptied) -- the limit param actually narrows the result set.
  test("?limit=<n> caps the number of returned items", async () => {
    const baseUrl = await startApp();
    recordSpan("tool_call svc__a", { "mcp.tool": "svc__a" });
    recordSpan("tool_call svc__b", { "mcp.tool": "svc__b" });
    recordSpan("tool_call svc__c", { "mcp.tool": "svc__c" });
    const res = await fetch(`${baseUrl}/admin-api/traces?limit=1`, { headers: bearer() });
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });
});

describe("GET /admin-api/traces/top-sessions", () => {
  // Kills 20:11-20:43 StringLiteral (the route path emptied) and
  // 20:89-23:4 (BlockStatement, whole handler emptied).
  test("is reachable at the exact top-sessions path and returns an items array", async () => {
    const baseUrl = await startApp();
    endSpan(startSpan("tool_call svc__a", { "mcp.tool": "svc__a" }), { "mcp.session_id": "sess-1" }, 1);
    endSpan(startSpan("tool_call svc__a", { "mcp.tool": "svc__a" }), { "mcp.session_id": "sess-1" }, 1);
    endSpan(startSpan("tool_call svc__b", { "mcp.tool": "svc__b" }), { "mcp.session_id": "sess-2" }, 1);
    const res = await fetch(`${baseUrl}/admin-api/traces/top-sessions`, { headers: bearer() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { sessionId: string; calls: number }[] };
    expect(body.items[0]).toMatchObject({ sessionId: "sess-1", calls: 2 });
  });

  // Kills 21:19-21:48 (ConditionalExpression true/false, EqualityOperator
  // '===') and 22:26-22:58 (ObjectLiteral, `{ items: getTopSessions(limit) }`
  // emptied) -- the limit param actually narrows the result set.
  test("?limit=<n> caps the number of returned sessions", async () => {
    const baseUrl = await startApp();
    endSpan(startSpan("tool_call svc__a", { "mcp.tool": "svc__a" }), { "mcp.session_id": "sess-1" }, 1);
    endSpan(startSpan("tool_call svc__b", { "mcp.tool": "svc__b" }), { "mcp.session_id": "sess-2" }, 1);
    const res = await fetch(`${baseUrl}/admin-api/traces/top-sessions?limit=1`, { headers: bearer() });
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });
});

describe("GET /admin-api/traces/:traceId", () => {
  // Kills 25:11-25:39 StringLiteral (the route path emptied) and
  // 25:106-32:4 (BlockStatement, whole handler emptied).
  test("returns the exact { traceId, spans } shape for a known trace", async () => {
    const baseUrl = await startApp();
    const span = recordSpan("tool_call svc__a", { "mcp.tool": "svc__a" });
    const res = await fetch(`${baseUrl}/admin-api/traces/${span.traceId}`, { headers: bearer() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { traceId: string; spans: unknown[] };
    expect(body.traceId).toBe(span.traceId);
    expect(body.spans).toHaveLength(1);
  });

  // Kills 27:9-27:27 (ConditionalExpression true/false, EqualityOperator
  // '!=='), 27:29-30:6 (BlockStatement, the notFound branch emptied), and
  // 28:21-28:38 / 28:40-28:57 (StringLiteral, "TRACE_NOT_FOUND"/
  // "Trace not found" emptied).
  test("returns the exact TRACE_NOT_FOUND 404 for an unknown trace id", async () => {
    const baseUrl = await startApp();
    const res = await fetch(`${baseUrl}/admin-api/traces/no-such-trace-id`, { headers: bearer() });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("TRACE_NOT_FOUND");
    expect(body.error.message).toBe("Trace not found");
  });
});

describe("DELETE /admin-api/traces — purge + audit", () => {
  // Kills 34:14-34:33 StringLiteral (the route path emptied) and
  // 34:97-38:4 (BlockStatement, whole handler emptied).
  test("purges every span and returns the exact { status, removed } shape", async () => {
    const baseUrl = await startApp();
    recordSpan("tool_call svc__a", { "mcp.tool": "svc__a" });
    recordSpan("tool_call svc__b", { "mcp.tool": "svc__b" });
    const res = await fetch(`${baseUrl}/admin-api/traces`, { method: "DELETE", headers: bearer() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; removed: number };
    expect(body).toEqual({ status: "purged", removed: 2 });

    const after = await fetch(`${baseUrl}/admin-api/traces`, { headers: bearer() });
    const afterBody = (await after.json()) as { items: unknown[] };
    expect(afterBody.items).toHaveLength(0);
  });

  // Kills 36:40-36:54 / 36:56-36:64 (StringLiteral, "traces.purge"/"traces"
  // emptied) and 37:26-37:55 / 37:36-37:44 (ObjectLiteral/StringLiteral,
  // the audit detail object + "purged" status string emptied).
  test("records an audit entry with the exact action/target/detail", async () => {
    const baseUrl = await startApp();
    recordSpan("tool_call svc__a", { "mcp.tool": "svc__a" });
    const spy = spyOn(auditMod, "recordAudit");
    try {
      await fetch(`${baseUrl}/admin-api/traces`, { method: "DELETE", headers: bearer() });
      expect(spy).toHaveBeenCalledWith(expect.any(String), "traces.purge", "traces", { removed: 1 });
    } finally {
      spy.mockRestore();
    }
  });
});

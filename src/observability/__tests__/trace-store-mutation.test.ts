/**
 * Stryker mutation-testing backstop for src/observability/trace-store.ts —
 * domain 7.
 *
 * Baseline: 62 mutants, 50 killed / 12 survived. All line:col citations below
 * were read directly from reports/mutation/result.json.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { config } from "../../config.js";
import { __resetDbForTesting, getDb } from "../../db/connection.js";
import * as loggerMod from "../../logger.js";
import { startSpan, endSpan } from "../../observability/tracing.js";
import { listTraces, getTrace, __clearSpansForTesting } from "../../observability/trace-store.js";

const originalRandom = Math.random;
function resetAll(): void {
  (config as Record<string, unknown>).traceStorageEnabled = true;
  __resetDbForTesting();
  __clearSpansForTesting();
  Math.random = originalRandom;
}
beforeEach(() => resetAll());
afterEach(() => {
  resetAll();
  (config as Record<string, unknown>).traceStorageEnabled = false;
});

function spanRowCount(): number {
  return (getDb().query(`SELECT COUNT(*) as c FROM tool_spans`).get() as { c: number }).c;
}

describe("persistSpan — mcp.tool / mcp.session_id extraction is type-checked, not just presence-checked", () => {
  // Kills 84:23-84:70 ConditionalExpression true (`typeof span.attributes
  // ["mcp.tool"] === "string"` forced always-true). A NON-STRING mcp.tool
  // value (as opposed to a merely absent one, which the existing tests
  // already cover) distinguishes the type-check from a presence-check.
  test("a non-string mcp.tool attribute is not stored as mcpToolName", async () => {
    const span = startSpan("tool_call svc__x", { "mcp.tool": 12345 });
    endSpan(span, {}, 1);
    const trace = getTrace(span.traceId);
    expect(trace[0].mcpToolName).toBeNull();
  });

  // Kills 86:5-86:58 ConditionalExpression true (`typeof span.attributes
  // ["mcp.session_id"] === "string"` forced always-true) — same technique
  // for the session_id column, using a non-string value rather than an
  // absent one.
  test("a non-string mcp.session_id attribute is not stored as sessionId", async () => {
    const span = startSpan("tool_call svc__x", { "mcp.tool": "svc__x" });
    endSpan(span, { "mcp.session_id": 999 }, 1);
    const trace = getTrace(span.traceId);
    expect(trace[0].sessionId).toBeNull();
  });
});

describe("persistSpan — the DB-write catch block", () => {
  // Kills 105:17-108:4 BlockStatement (whole catch body emptied),
  // 106:9-106:15 / 106:17-106:58 StringLiteral (log level/message emptied),
  // and 106:60-106:119 ObjectLiteral (log meta object emptied).
  test("a DB write failure is logged with the exact level/message and does not throw", () => {
    const dbSpy = spyOn(getDb(), "query").mockImplementation(() => {
      throw new Error("simulated write failure");
    });
    const logSpy = spyOn(loggerMod, "log");
    try {
      expect(() => endSpan(startSpan("tool_call svc__x", { "mcp.tool": "svc__x" }), {}, 1)).not.toThrow();
      expect(logSpy).toHaveBeenCalledWith("warn", "Failed to persist span for trace viewer", {
        error: "simulated write failure",
      });
    } finally {
      dbSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe("persistSpan — probabilistic prune trigger", () => {
  // Kills 109:7-109:27 (ConditionalExpression true/false, EqualityOperator
  // '<=' and '>='). Needs the EXACT threshold value (0.02) to distinguish
  // `<` from `<=`, not just one value clearly on each side.
  test("Math.random() < 0.02 triggers a prune; >= 0.02 does not; exactly 0.02 must NOT (real < excludes it)", () => {
    (config as Record<string, unknown>).traceRetentionMs = 1000;
    const staleCreatedAt = Date.now() - 60_000;
    function seedStale(): void {
      getDb()
        .query(
          `INSERT INTO tool_spans (trace_id, span_id, name, mcp_tool_name, session_id, start_ms, end_ms, status_code, attributes_json, created_at)
           VALUES ('stale-trace', 'stale-span', 'x', NULL, NULL, 0, 1, 0, '{}', ?)`,
        )
        .run(staleCreatedAt);
    }
    function staleCount(): number {
      return (
        getDb().query(`SELECT COUNT(*) as c FROM tool_spans WHERE trace_id = 'stale-trace'`).get() as { c: number }
      ).c;
    }
    function record(): void {
      endSpan(startSpan("tool_call svc__x", { "mcp.tool": "svc__x" }), {}, 1);
    }

    seedStale();
    Math.random = () => 0.5; // clearly >= 0.02: must NOT prune
    record();
    expect(staleCount()).toBe(1);

    Math.random = () => 0.01; // clearly < 0.02: must prune
    record();
    expect(staleCount()).toBe(0);

    seedStale();
    Math.random = () => 0.02; // exact boundary: real `<` excludes it, must NOT prune
    record();
    expect(staleCount()).toBe(1);
  });
});

describe("listTraces — combining filters ANDs them, not just concatenates", () => {
  // Kills 145:42-145:49 StringLiteral (the " AND " join separator emptied) —
  // needs TWO simultaneous where-clauses, which no existing test does.
  test("mcpToolName + sessionId together narrow to only the matching trace", () => {
    endSpan(startSpan("tool_call a", { "mcp.tool": "match" }), { "mcp.session_id": "sess-match" }, 1);
    endSpan(startSpan("tool_call b", { "mcp.tool": "match" }), { "mcp.session_id": "sess-other" }, 1);
    endSpan(startSpan("tool_call c", { "mcp.tool": "other" }), { "mcp.session_id": "sess-match" }, 1);

    const result = listTraces({ mcpToolName: "match", sessionId: "sess-match" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].mcpToolName).toBe("match");
    expect(result.items[0].sessionId).toBe("sess-match");
  });
});

describe("__clearSpansForTesting", () => {
  // Kills 222:48-224:2 BlockStatement (whole body emptied) — this test-only
  // helper, used throughout the existing suite's own beforeEach/afterEach,
  // had zero coverage of its own.
  test("deletes every persisted span", () => {
    endSpan(startSpan("tool_call svc__x", { "mcp.tool": "svc__x" }), {}, 1);
    expect(spanRowCount()).toBeGreaterThan(0);
    __clearSpansForTesting();
    expect(spanRowCount()).toBe(0);
  });
});

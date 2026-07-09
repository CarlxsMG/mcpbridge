/**
 * Stryker mutation-testing backstop for src/observability/traffic.ts — domain 7.
 *
 * Baseline: 65 mutants, 38 killed / 27 survived. All line:col citations below
 * were read directly from reports/mutation/result.json.
 *
 * Documented equivalent (verified empirically, not assumed):
 *   71:30-71:32 ArrayDeclaration (`input.result.content ?? []` fallback
 *   emptied to Stryker's own sentinel `["Stryker was here"]`). The ONLY way
 *   to reach this fallback at all is a nullish `content` (undefined/null),
 *   and the very next step is `.map((c) => c.text ?? "")` — since
 *   "Stryker was here" is a bare STRING, not an object, `c.text` on it is
 *   `undefined` too (strings have no `.text` property), so it maps to `""`
 *   just like an empty array does. `[""].join("\n")` and `[].join("\n")`
 *   are both `""` — the two fallback arrays are indistinguishable through
 *   the resulting preview no matter what downstream assertion is written.
 *   Verified via a standalone scratch script comparing both fallback
 *   values across both nullish inputs (undefined and null) before
 *   accepting.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { config } from "../../config.js";
import { __resetDbForTesting, getDb } from "../../db/connection.js";
import * as loggerMod from "../../logger.js";
import { recordTraffic, listTraffic, pruneTraffic, __clearTrafficForTesting } from "../../observability/traffic.js";

const originalRandom = Math.random;
function resetAll(): void {
  (config as Record<string, unknown>).trafficMaxBodyBytes = 8_192;
  (config as Record<string, unknown>).trafficRetentionMs = 7 * 24 * 60 * 60_000;
  __resetDbForTesting();
  Math.random = originalRandom;
}
beforeEach(() => resetAll());
afterEach(() => resetAll());

function record(overrides: Partial<Parameters<typeof recordTraffic>[0]> = {}): void {
  recordTraffic({
    mcpToolName: "svc__t",
    clientName: "svc",
    toolName: "t",
    keyId: null,
    args: {},
    result: { content: [{ type: "text", text: "ok" }] },
    durationMs: 1,
    ...overrides,
  });
}

describe("rowTo — isError boolean mapping", () => {
  // Kills 54:14-54:30 ConditionalExpression false (`r.is_error === 1` forced
  // false). The existing test's errorsOnly filter only checks the SQL-level
  // row COUNT, never the mapped `.isError` field on the returned record.
  test("a recorded error result reads back isError: true, not just filterable at the SQL level", () => {
    record({ result: { content: [{ type: "text", text: "bad" }], isError: true } });
    const item = listTraffic({}).items[0];
    expect(item.isError).toBe(true);
  });
});

describe("recordTraffic — preview construction", () => {
  // Confirms the `?? []` fallback path itself doesn't throw on a nullish
  // content array (see header comment for why the ArrayDeclaration mutant at
  // 71:30-71:32 on this same fallback is a documented equivalent, not killed
  // by this or any other test).
  test("a result with no content array at all produces an empty preview, not a thrown error", () => {
    record({ result: { content: undefined as unknown as Array<{ type: string; text: string }> } });
    const item = listTraffic({}).items[0];
    expect(item.preview).toBe("");
  });

  // Kills 71:55-71:57 StringLiteral (`c.text ?? ""` fallback emptied) and
  // 71:64-71:68 StringLiteral (the "\n" join separator emptied) together:
  // a multi-part content array with one part missing `.text` entirely.
  test("multiple content parts are joined with newlines, and a missing .text falls back to an empty string", () => {
    record({
      result: {
        content: [
          { type: "text", text: "first" },
          { type: "text" } as unknown as { type: string; text: string },
          { type: "text", text: "third" },
        ],
      },
    });
    const item = listTraffic({}).items[0];
    expect(item.preview).toBe("first\n\nthird");
  });
});

describe("recordTraffic — the DB-write catch block", () => {
  // Kills 91:17-94:4 BlockStatement (whole catch body emptied), 92:9-92:15/
  // 92:17-92:51 StringLiteral (the log level/message emptied), and
  // 92:53-92:112 ObjectLiteral (the log meta object emptied).
  test("a DB write failure is logged with the exact level/message and does not throw", () => {
    const dbSpy = spyOn(getDb(), "query").mockImplementation(() => {
      throw new Error("simulated write failure");
    });
    const logSpy = spyOn(loggerMod, "log");
    try {
      expect(() => record()).not.toThrow();
      expect(logSpy).toHaveBeenCalledWith("warn", "Failed to record traffic capture", {
        error: "simulated write failure",
      });
    } finally {
      dbSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe("recordTraffic — probabilistic prune trigger", () => {
  // Kills 95:7-95:27 (ConditionalExpression true/false, EqualityOperator
  // '<=' and '>='). Observed indirectly via a stale row's survival, since
  // pruneTraffic() is called as a same-module internal reference (spying on
  // the export would not intercept it).
  test("Math.random() < 0.02 triggers a prune; >= 0.02 does not", () => {
    (config as Record<string, unknown>).trafficRetentionMs = 1000;
    const staleCreatedAt = Date.now() - 60_000; // well past the 1s retention window
    function seedStale(): void {
      getDb()
        .query(
          `INSERT INTO tool_traffic (mcp_tool_name, client_name, tool_name, key_id, args_json, preview, is_error, duration_ms, created_at)
           VALUES ('svc__stale', 'svc', 'stale', NULL, '{}', 'x', 0, 1, ?)`,
        )
        .run(staleCreatedAt);
    }
    function staleCount(): number {
      return (
        getDb().query(`SELECT COUNT(*) as c FROM tool_traffic WHERE mcp_tool_name = 'svc__stale'`).get() as {
          c: number;
        }
      ).c;
    }

    seedStale();
    Math.random = () => 0.5; // clearly >= 0.02: must NOT prune
    record();
    expect(staleCount()).toBe(1);

    Math.random = () => 0.01; // clearly < 0.02: must prune
    record();
    expect(staleCount()).toBe(0);

    // Exact boundary: real `<` excludes 0.02 itself (must NOT prune); the
    // `<=` mutant includes it (would wrongly prune). 0.5 vs 0.01 alone can't
    // distinguish `<` from `<=` since both agree away from the boundary.
    seedStale();
    Math.random = () => 0.02;
    record();
    expect(staleCount()).toBe(1);
  });
});

describe("listTraffic — clientName filter", () => {
  // Kills 113:7-113:24 (ConditionalExpression false), 113:26-116:4
  // (BlockStatement, whole if-body emptied), and 114:16-114:33 (StringLiteral,
  // the "client_name = ?" clause emptied) — none of the existing tests ever
  // filter by clientName.
  test("filters to only the matching clientName", () => {
    record({ clientName: "svc-a", toolName: "t" });
    record({ clientName: "svc-b", toolName: "t" });
    const items = listTraffic({ clientName: "svc-a" }).items;
    expect(items).toHaveLength(1);
    expect(items[0].clientName).toBe("svc-a");
  });

  // Kills 123:80-123:87 StringLiteral (the " AND " join separator emptied) —
  // needs TWO simultaneous where-clauses combined, which no existing test does.
  test("combining clientName and toolName filters ANDs them together, not just concatenates", () => {
    record({ clientName: "svc-a", toolName: "match" });
    record({ clientName: "svc-a", toolName: "other" });
    record({ clientName: "svc-b", toolName: "match" });
    const items = listTraffic({ clientName: "svc-a", toolName: "match" }).items;
    expect(items).toHaveLength(1);
    expect(items[0].clientName).toBe("svc-a");
    expect(items[0].toolName).toBe("match");
  });
});

describe("pruneTraffic — cutoff direction", () => {
  // Kills 134:18-134:49 ArithmeticOperator (`now - trafficRetentionMs` ->
  // `now + trafficRetentionMs`). The existing test forces `now` so far into
  // the future that both directions prune everything regardless of operator —
  // needs the DEFAULT `now` (real current time) so the real subtraction
  // produces a PAST cutoff (nothing pruned) while the addition mutant would
  // produce a FUTURE cutoff (wrongly pruning a just-inserted row).
  test("a just-inserted row survives a default-now prune (cutoff must be in the past, not the future)", () => {
    record();
    const before = listTraffic({}).items.length;
    expect(pruneTraffic()).toBe(0);
    expect(listTraffic({}).items).toHaveLength(before);
  });
});

describe("__clearTrafficForTesting", () => {
  // Kills 138:50-140:2 BlockStatement (whole body emptied) and 139:17-139:43
  // StringLiteral (the DELETE SQL emptied) — this test-only helper was itself
  // completely untested.
  test("deletes every traffic row", () => {
    record();
    expect(listTraffic({}).items.length).toBeGreaterThan(0);
    __clearTrafficForTesting();
    expect(listTraffic({}).items).toHaveLength(0);
  });
});

describe("truncate — preview length clamping", () => {
  // Kills 143:10-143:24 (ConditionalExpression false, EqualityOperator '>='),
  // 143:27-143:83 (StringLiteral, the truncation-marker template emptied),
  // 143:30-143:45 (MethodExpression, `.slice(0, max)` dropped), and
  // 143:60-143:74 (ArithmeticOperator, `s.length - max` -> `+`). None of the
  // existing tests' preview text ever exceeds trafficMaxBodyBytes.
  test("a preview longer than trafficMaxBodyBytes is clamped with an exact truncation marker", () => {
    (config as Record<string, unknown>).trafficMaxBodyBytes = 5;
    record({ result: { content: [{ type: "text", text: "abcdefghij" }] } });
    const item = listTraffic({}).items[0];
    expect(item.preview).toBe("abcde…[truncated 5 chars]");
  });

  // Kills the `>` vs `>=` boundary specifically: a preview EXACTLY at the
  // byte limit must NOT be truncated.
  test("a preview exactly at trafficMaxBodyBytes is left untouched, not truncated", () => {
    (config as Record<string, unknown>).trafficMaxBodyBytes = 5;
    record({ result: { content: [{ type: "text", text: "abcde" }] } });
    const item = listTraffic({}).items[0];
    expect(item.preview).toBe("abcde");
  });
});

describe("safeJson — args serialization fallback", () => {
  // Kills 148:33-148:39 StringLiteral (the `?? "null"` fallback text emptied)
  // — JSON.stringify returns `undefined` (not a string) for a value like a
  // bare function, which safeJson's own `?? "null"` catches.
  test("a value JSON.stringify itself returns undefined for falls back to the literal string 'null'", () => {
    record({ args: (() => {}) as unknown as Record<string, unknown> });
    const item = listTraffic({}).items[0];
    expect(item.argsJson).toBe("null");
  });

  // Kills 149:11-151:4 BlockStatement (catch body emptied) and 150:12-150:32
  // StringLiteral (the exact fallback string emptied) — a circular reference
  // makes JSON.stringify throw outright, not just return undefined.
  test("a value JSON.stringify throws on falls back to the exact '<unserializable>' marker", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    record({ args: circular });
    const item = listTraffic({}).items[0];
    expect(item.argsJson).toBe('"<unserializable>"');
  });
});

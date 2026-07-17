import { describe, test, expect, beforeEach } from "bun:test";

// Stryker mutation-testing backstop for src/mcp/registry-persistence.ts
// (410 LOC — every SQLite interaction the registry does). No dedicated
// test file existed before; only indirect coverage via registry.ts's own
// mutation-testing series. Drives RegistryPersistence's three methods and
// the three row->DTO converters DIRECTLY (all are exported), rather than
// through the full Registry class, since none of these mutants depend on
// the live in-memory map/lock layer Registry adds on top.
//
// Each test/comment cites the exact line:column, mutator, and replacement
// it kills, per the house convention established across this series (see
// reports/mutation/result.json / stryker.config.mjs's SCOPE HISTORY).

import {
  RegistryPersistence,
  rowToClientGuards,
  rowToToolGuards,
  rowToToolOverride,
  type ClientGuardRow,
  type ToolOverrideRow,
} from "../registry-persistence.js";
import { __resetDbForTesting, getDb } from "../../db/connection.js";
import type { RestToolDefinition } from "../../mcp/types.js";
import type { DiscoveredMcpTool } from "../../mcp/mcp-discovery.js";

const persistence = new RegistryPersistence();

beforeEach(() => {
  __resetDbForTesting();
});

function makeRestTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "get-thing",
    method: "GET",
    endpoint: "/thing",
    description: "d",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

function makeMcpTool(overrides: Partial<DiscoveredMcpTool> = {}): DiscoveredMcpTool {
  return {
    name: "do-thing",
    upstreamName: "do_thing",
    description: "d",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// rowToClientGuards — L64:7 (ConditionalExpression->false, EqualityOperator
// on `row.cb_reset_timeout_ms !== null`), L66:7 (EqualityOperator on
// `row.cb_window_ms !== null`). L63/L65's twin checks (failureThreshold,
// halfOpenTimeoutMs) are already covered elsewhere.
// ---------------------------------------------------------------------------

describe("rowToClientGuards — L64/L66 null checks", () => {
  const baseRow: ClientGuardRow = {
    cb_failure_threshold: null,
    cb_reset_timeout_ms: null,
    cb_half_open_timeout_ms: null,
    cb_window_ms: null,
    extra_json: null,
  };

  test("a real resetTimeoutMs is included; a null one is omitted (L64)", () => {
    const withValue = rowToClientGuards({ ...baseRow, cb_reset_timeout_ms: 5000 });
    expect(withValue?.circuitBreaker?.resetTimeoutMs).toBe(5000);

    const withNull = rowToClientGuards({ ...baseRow, cb_reset_timeout_ms: null });
    expect(withNull?.circuitBreaker?.resetTimeoutMs).toBeUndefined();
  });

  test("a real windowMs is included; a null one is omitted (L66)", () => {
    const withValue = rowToClientGuards({ ...baseRow, cb_window_ms: 60000 });
    expect(withValue?.circuitBreaker?.windowMs).toBe(60000);

    const withNull = rowToClientGuards({ ...baseRow, cb_window_ms: null });
    expect(withNull?.circuitBreaker?.windowMs).toBeUndefined();
  });

  test("a real halfOpenTimeoutMs is included; a null one is omitted (L65)", () => {
    const withValue = rowToClientGuards({ ...baseRow, cb_half_open_timeout_ms: 15000 });
    expect(withValue?.circuitBreaker?.halfOpenTimeoutMs).toBe(15000);

    const withNull = rowToClientGuards({ ...baseRow, cb_half_open_timeout_ms: null });
    expect(withNull?.circuitBreaker?.halfOpenTimeoutMs).toBeUndefined();
  });

  // L68:21 ConditionalExpression->true — `Object.keys(cb).length > 0 ? cb :
  // undefined`. Forcing this to always-true means `circuitBreaker` would be
  // an EMPTY object `{}` (not `undefined`) whenever every cb_* column is
  // null, instead of collapsing to `undefined` like every other guard-row
  // converter in this file does for an all-empty row.
  test("all cb_* columns null collapses circuitBreaker to undefined, not {} (L68)", () => {
    const result = rowToClientGuards(baseRow);
    expect(result?.circuitBreaker).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// rowToToolOverride — L90:7 ConditionalExpression->false. Forcing the
// "every field empty" guard to never fire means an all-null row would
// return `{description:undefined, params:undefined, displayName:undefined,
// driftNote:undefined}` instead of collapsing to `undefined` itself.
// ---------------------------------------------------------------------------

describe("rowToToolOverride — L90 all-empty collapse", () => {
  test("a row with every field null/empty collapses to undefined, not an all-undefined object", () => {
    const row: ToolOverrideRow = {
      description: null,
      param_overrides_json: null,
      display_name: null,
      drift_note: null,
    };
    expect(rowToToolOverride(row)).toBeUndefined();
  });

  test("a row with just a description does NOT collapse to undefined", () => {
    const row: ToolOverrideRow = {
      description: "custom",
      param_overrides_json: null,
      display_name: null,
      drift_note: null,
    };
    expect(rowToToolOverride(row)).toEqual({
      description: "custom",
      params: undefined,
      displayName: undefined,
      driftNote: undefined,
    });
  });

  // L90:69 ConditionalExpression->false — the `Object.keys(params).length
  // === 0` sub-check inside `(!params || Object.keys(params).length === 0)`.
  // A row where every OTHER field is empty but param_overrides_json is the
  // literal "{}" (an empty, parsed-but-vacuous object, distinct from `null`)
  // must still collapse to undefined — the mutant would treat a truthy-but-
  // empty params object as "non-empty" and skip the collapse.
  test("a row whose only 'content' is an empty params object still collapses to undefined", () => {
    const row: ToolOverrideRow = {
      description: null,
      param_overrides_json: "{}",
      display_name: null,
      drift_note: null,
    };
    expect(rowToToolOverride(row)).toBeUndefined();
  });

  // Also exercises rowToToolGuards' analogous null-collapse fields are
  // covered by name — not part of this survivor list, but keep both
  // converters exercised for a real, non-null row while we're here.
  test("rowToToolGuards maps a fully-populated row", () => {
    const guards = rowToToolGuards({
      rate_limit_per_min: 30,
      timeout_ms: 5000,
      allowed_key_hashes: JSON.stringify(["abc"]),
      extra_json: JSON.stringify({ x: 1 }),
    });
    expect(guards).toEqual({
      rateLimitPerMin: 30,
      timeoutMs: 5000,
      allowedKeyHashes: ["abc"],
      extra: { x: 1 },
    });
  });
});

// ---------------------------------------------------------------------------
// persistMcpRegistration — stale-tool deletion, L264/L266/L267/L268. A
// second registration with a SHRUNK tool set must delete the dropped tool's
// row (cascades to tool_guards/tool_overrides via FK).
// ---------------------------------------------------------------------------

describe("persistMcpRegistration — stale tool deletion (L264/L266/L267/L268)", () => {
  test("a tool dropped from the new registration is deleted from SQLite, not left behind", () => {
    persistence.persistMcpRegistration(
      "svc-mcp-stale",
      [makeMcpTool({ name: "a", upstreamName: "a" }), makeMcpTool({ name: "b", upstreamName: "b" })],
      "http://mcp.example.com",
      "streamable-http",
      "1.2.3.4",
      "1.2.3.4",
    );
    let rows = getDb().query(`SELECT name FROM tools WHERE client_name = ?`).all("svc-mcp-stale") as {
      name: string;
    }[];
    expect(rows.map((r) => r.name).sort()).toEqual(["a", "b"]);

    // Re-register with only "a" -- "b" must be deleted, not orphaned.
    persistence.persistMcpRegistration(
      "svc-mcp-stale",
      [makeMcpTool({ name: "a", upstreamName: "a" })],
      "http://mcp.example.com",
      "streamable-http",
      "1.2.3.4",
      "1.2.3.4",
    );
    rows = getDb().query(`SELECT name FROM tools WHERE client_name = ?`).all("svc-mcp-stale") as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(["a"]);
  });

  test("re-registering with the SAME tool set deletes nothing (the negative case)", () => {
    persistence.persistMcpRegistration(
      "svc-mcp-same",
      [makeMcpTool({ name: "a", upstreamName: "a" })],
      "http://mcp.example.com",
      "streamable-http",
      "1.2.3.4",
      "1.2.3.4",
    );
    persistence.persistMcpRegistration(
      "svc-mcp-same",
      [makeMcpTool({ name: "a", upstreamName: "a" })],
      "http://mcp.example.com",
      "streamable-http",
      "1.2.3.4",
      "1.2.3.4",
    );
    const rows = getDb().query(`SELECT name FROM tools WHERE client_name = ?`).all("svc-mcp-same") as {
      name: string;
    }[];
    expect(rows.map((r) => r.name)).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// persistMcpRegistration — L305:19 StringLiteral (the JS-side `method:
// "POST"` literal on the returned RegisteredTool, distinct from the SQL
// literal), L310:20 ConditionalExpression (enabled === 1 forced true),
// L322:25 ConditionalExpression (clientRow.enabled === 1 forced true).
// ---------------------------------------------------------------------------

describe("persistMcpRegistration — returned tool/client shape (L305/L310/L322)", () => {
  test("every MCP tool's returned method is exactly 'POST'", () => {
    const result = persistence.persistMcpRegistration(
      "svc-mcp-method",
      [makeMcpTool({ name: "a" })],
      "http://mcp.example.com",
      "streamable-http",
      "1.2.3.4",
      "1.2.3.4",
    );
    expect(result.tools[0]!.method).toBe("POST");
  });

  test("a disabled tool's re-registration returns enabled:false, not forced true (L310)", () => {
    persistence.persistMcpRegistration(
      "svc-mcp-tool-disabled",
      [makeMcpTool({ name: "a" })],
      "http://mcp.example.com",
      "streamable-http",
      "1.2.3.4",
      "1.2.3.4",
    );
    getDb().query(`UPDATE tools SET enabled = 0 WHERE client_name = ? AND name = ?`).run("svc-mcp-tool-disabled", "a");

    const result = persistence.persistMcpRegistration(
      "svc-mcp-tool-disabled",
      [makeMcpTool({ name: "a" })],
      "http://mcp.example.com",
      "streamable-http",
      "1.2.3.4",
      "1.2.3.4",
    );
    expect(result.tools[0]!.enabled).toBe(false);
  });

  test("a disabled client's re-registration returns enabled:false, not forced true (L322)", () => {
    persistence.persistMcpRegistration(
      "svc-mcp-client-disabled",
      [makeMcpTool({ name: "a" })],
      "http://mcp.example.com",
      "streamable-http",
      "1.2.3.4",
      "1.2.3.4",
    );
    getDb().query(`UPDATE clients SET enabled = 0 WHERE name = ?`).run("svc-mcp-client-disabled");

    const result = persistence.persistMcpRegistration(
      "svc-mcp-client-disabled",
      [makeMcpTool({ name: "a" })],
      "http://mcp.example.com",
      "streamable-http",
      "1.2.3.4",
      "1.2.3.4",
    );
    expect(result.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildPersistedClientFromDb — L381:23 (upstream_name ?? undefined, forced
// to &&), L384:18 (tool enabled === 1, forced !==), L402:31 (retry_non_safe_
// methods === 1), L406:15 / L407:21 (mcp_url / mcp_transport ?? undefined,
// forced to &&).
// ---------------------------------------------------------------------------

describe("buildPersistedClientFromDb — row->DTO mapping (L381/L384/L402/L406/L407)", () => {
  test("a REST tool's upstreamName is undefined, not null (L381)", () => {
    persistence.persistRestRegistration(
      "svc-hydrate-rest",
      [makeRestTool({ name: "a" })],
      "http://example.com/health",
      "1.2.3.4",
      "http://example.com",
      "1.2.3.4",
      false,
    );
    const detail = persistence.buildPersistedClientFromDb("svc-hydrate-rest");
    expect(detail!.tools[0]!.upstreamName).toBeUndefined();
  });

  test("paramLocations round-trips through the DB (migration 56) — present map and absent both hydrate correctly", () => {
    persistence.persistRestRegistration(
      "svc-paramloc",
      [
        makeRestTool({
          name: "with-loc",
          method: "POST",
          paramLocations: { notify: "query", "X-Trace": "header", sid: "cookie" },
        }),
        makeRestTool({ name: "no-loc", method: "POST" }),
      ],
      "http://example.com/health",
      "1.2.3.4",
      "http://example.com",
      "1.2.3.4",
      false,
    );
    const detail = persistence.buildPersistedClientFromDb("svc-paramloc")!;
    // A persistence round-trip regression here would silently revert routing to
    // the JSON body on every restart, with no other test failing.
    expect(detail.tools.find((t) => t.name === "with-loc")!.paramLocations).toEqual({
      notify: "query",
      "X-Trace": "header",
      sid: "cookie",
    });
    expect(detail.tools.find((t) => t.name === "no-loc")!.paramLocations).toBeUndefined();
  });

  test("a disabled tool hydrates as enabled:false, an enabled one as true (L384)", () => {
    persistence.persistRestRegistration(
      "svc-hydrate-toolenabled",
      [makeRestTool({ name: "a" }), makeRestTool({ name: "b" })],
      "http://example.com/health",
      "1.2.3.4",
      "http://example.com",
      "1.2.3.4",
      false,
    );
    getDb()
      .query(`UPDATE tools SET enabled = 0 WHERE client_name = ? AND name = ?`)
      .run("svc-hydrate-toolenabled", "a");

    const detail = persistence.buildPersistedClientFromDb("svc-hydrate-toolenabled")!;
    expect(detail.tools.find((t) => t.name === "a")!.enabled).toBe(false);
    expect(detail.tools.find((t) => t.name === "b")!.enabled).toBe(true);
  });

  test("retryNonSafeMethods hydrates both true and false correctly (L402)", () => {
    persistence.persistRestRegistration(
      "svc-hydrate-retry-true",
      [makeRestTool()],
      "http://example.com/health",
      "1.2.3.4",
      "http://example.com",
      "1.2.3.4",
      true,
    );
    persistence.persistRestRegistration(
      "svc-hydrate-retry-false",
      [makeRestTool()],
      "http://example.com/health",
      "1.2.3.4",
      "http://example.com",
      "1.2.3.4",
      false,
    );
    expect(persistence.buildPersistedClientFromDb("svc-hydrate-retry-true")!.retry_non_safe_methods).toBe(true);
    expect(persistence.buildPersistedClientFromDb("svc-hydrate-retry-false")!.retry_non_safe_methods).toBe(false);
  });

  // L403:16 ConditionalExpression->true — the CLIENT-level `enabled: row.
  // enabled === 1` field on the returned object (distinct from L384's
  // per-TOOL enabled field, already covered above).
  test("a disabled client hydrates with enabled:false, not forced true (L403)", () => {
    persistence.persistRestRegistration(
      "svc-hydrate-client-disabled",
      [makeRestTool()],
      "http://example.com/health",
      "1.2.3.4",
      "http://example.com",
      "1.2.3.4",
      false,
    );
    getDb().query(`UPDATE clients SET enabled = 0 WHERE name = ?`).run("svc-hydrate-client-disabled");

    const detail = persistence.buildPersistedClientFromDb("svc-hydrate-client-disabled")!;
    expect(detail.enabled).toBe(false);
  });

  test("a REST client's mcpUrl/mcpTransport hydrate as undefined, not null (L406/L407)", () => {
    persistence.persistRestRegistration(
      "svc-hydrate-mcpfields",
      [makeRestTool()],
      "http://example.com/health",
      "1.2.3.4",
      "http://example.com",
      "1.2.3.4",
      false,
    );
    const detail = persistence.buildPersistedClientFromDb("svc-hydrate-mcpfields")!;
    expect(detail.mcpUrl).toBeUndefined();
    expect(detail.mcpTransport).toBeUndefined();
  });

  test("an MCP client's mcpUrl/mcpTransport hydrate with their real values", () => {
    persistence.persistMcpRegistration(
      "svc-hydrate-mcpfields-mcp",
      [makeMcpTool()],
      "http://mcp.example.com",
      "sse",
      "1.2.3.4",
      "1.2.3.4",
    );
    const detail = persistence.buildPersistedClientFromDb("svc-hydrate-mcpfields-mcp")!;
    expect(detail.mcpUrl).toBe("http://mcp.example.com");
    expect(detail.mcpTransport).toBe("sse");
  });
});

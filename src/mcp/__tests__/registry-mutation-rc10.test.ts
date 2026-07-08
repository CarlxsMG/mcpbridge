import { describe, test, expect, beforeEach } from "bun:test";
import { registry } from "../../mcp/registry.js";
import { __resetDbForTesting, getDb } from "../../db/connection.js";
import { getCircuitBreaker, removeCircuitBreaker, getAllCircuitStates } from "../../middleware/circuit-breaker.js";
import { setToolTags } from "../../tool-meta/tool-tags.js";
import { setToolSensitive } from "../../tool-meta/tool-sensitivity.js";
import { setRedactionPaths } from "../../content-filtering/redaction.js";
import { createTeam, setClientTeam } from "../../admin/entities/teams.js";
import type { RestToolDefinition } from "../../mcp/types.js";
import type { DiscoveredMcpTool } from "../../mcp/mcp-discovery.js";

// ---------------------------------------------------------------------------
// Registry.getClientDetail — mutation-testing backstop (RC10)
//
// Targets the surviving mutants in getClientDetail() (src/mcp/registry.ts
// lines 1195-1315), the largest function in the file. It branches heavily on
// whether the client is currently LIVE (in-memory `this.clients` map — reads
// tags/sensitivity/redaction/guards/override straight off the live `tool`
// object plus a handful of policy-map lookups) vs NOT LIVE (every field,
// including per-tool guards/overrides, is reconstructed from SQLite via
// dedicated joins). Most fields are duplicated across both branches, so most
// mutants here need a LIVE-path test AND a NOT-LIVE-path test to be killed.
//
// How a NOT-LIVE client is produced without deleting its row: register
// normally, then call registry.unregister(name). unregister() only tears
// down in-memory (live) state — the DB rows for clients/tools/guards/
// overrides are left fully intact (see its own doc comment) — so
// getClientDetail(name) afterwards exercises the NOT-LIVE branch while still
// having real data to reconstruct. Verified via registry.getClient(name)
// being undefined while getClientDetail(name) still returns tools.
// ---------------------------------------------------------------------------

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "get-users",
    method: "GET",
    endpoint: "/users",
    description: "Returns a list of users",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

const DEFAULT_HEALTH = "http://example.com/health";
const DEFAULT_BASE = "http://example.com";
const DEFAULT_IP = "1.2.3.4";
const DEFAULT_RESOLVED_IP = "1.2.3.4";

async function reg(
  name: string,
  tools: RestToolDefinition[] = [makeTool()],
  ip = DEFAULT_IP,
  healthUrl = DEFAULT_HEALTH,
  baseUrl = DEFAULT_BASE,
  resolvedIp = DEFAULT_RESOLVED_IP,
) {
  await registry.register(name, tools, healthUrl, ip, baseUrl, resolvedIp);
}

beforeEach(async () => {
  for (const client of registry.listClients()) {
    await registry.unregister(client.name);
  }
  // Fresh in-memory SQLite per test — unregister() deliberately doesn't purge
  // persisted state, so a shared DB would leak tags/guards/overrides/teams
  // across tests that reuse generic names like "svc".
  __resetDbForTesting();
});

// ---------------------------------------------------------------------------
// L1213:9 ConditionalExpression -> false — `if (!row) return undefined;`
// ---------------------------------------------------------------------------

describe("getClientDetail — L1213 unknown client short-circuit", () => {
  test("L1213:9 ConditionalExpression->false — returns undefined for a never-registered client", () => {
    expect(registry.getClientDetail("never-registered-client")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// L1233:9 ConditionalExpression->false — `if (live) { ... } else { ... }`
// branch-selector itself (not just the fields duplicated across both sides)
// ---------------------------------------------------------------------------

describe("getClientDetail — L1233:9 branch-selector actually executes the live path for a live client", () => {
  test("a live client's tools come from the in-memory live.tools map, not the SQL reconstruction, even when the DB has since drifted out from under it", async () => {
    await reg("svc-branch-live", [makeTool({ name: "get-users" })]);
    expect(registry.getClient("svc-branch-live")).not.toBeUndefined(); // sanity: LIVE

    // Every *reachable* admin API keeps the LIVE and NOT-LIVE reconstructions
    // producing identical output by design: setToolGuards/setToolOverride
    // update both the live tool object and the DB row together, and
    // register() re-hydrates live tools straight from the DB on every call.
    // So the only way to prove the `if (live)` branch-selector itself
    // executed (as opposed to always falling through to the NOT-LIVE SQL
    // path) is to force a genuine divergence: write a tool_guards row
    // directly, bypassing the registry entirely, so the live tool's
    // `.guards` stays untouched while the DB row disagrees with it.
    getDb()
      .query(
        `INSERT INTO tool_guards (client_name, tool_name, rate_limit_per_min, timeout_ms, allowed_key_hashes, extra_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("svc-branch-live", "get-users", 77, null, null, null, Date.now());

    const detail = registry.getClientDetail("svc-branch-live");
    expect(detail?.live).toBe(true);
    const tool = detail?.tools.find((t) => t.name === "get-users");
    // Real (live-branch) code: guards are spread straight off the live tool
    // object, which setToolGuards never touched -- still undefined. A
    // ConditionalExpression->false mutant would force the NOT-LIVE
    // reconstruction path instead, which SQL-joins the row inserted above
    // and would report rateLimitPerMin: 77.
    expect(tool?.guards).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// L1233-1238 — LIVE branch: tags/sensitive/redactPaths `?? []` / `?? null` fallbacks
// ---------------------------------------------------------------------------

describe("getClientDetail — L1233/1236/1237/1238 LIVE branch tag/sensitivity/redaction mapping", () => {
  test("L1236/1237/1238 defaults — live tool with no tags/sensitivity/redaction configured", async () => {
    await reg("svc-live-empty", [makeTool({ name: "get-users" })]);
    const detail = registry.getClientDetail("svc-live-empty");
    expect(registry.getClient("svc-live-empty")).not.toBeUndefined(); // sanity: LIVE branch

    const tool = detail?.tools.find((t) => t.name === "get-users");
    expect(tool?.tags).toEqual([]);
    expect(tool?.sensitive).toBe(null);
    expect(tool?.redactPaths).toEqual([]);
  });

  test("L1236/1237/1238 populated — live tool with tags/sensitivity/redaction configured", async () => {
    await reg("svc-live-full", [makeTool({ name: "get-users" })]);
    expect(setToolTags("svc-live-full", "get-users", ["billing", "reporting"])).toBe(true);
    expect(setToolSensitive("svc-live-full", "get-users", true)).toBe(true);
    expect(setRedactionPaths("svc-live-full", "get-users", ["ssn", "card.number"])).toBe(true);

    const detail = registry.getClientDetail("svc-live-full");
    const tool = detail?.tools.find((t) => t.name === "get-users");
    expect(tool?.tags).toEqual(["billing", "reporting"]);
    expect(tool?.sensitive).toBe(true);
    expect(tool?.redactPaths).toEqual(["ssn", "card.number"]);
  });
});

// ---------------------------------------------------------------------------
// L1247/1261/1272 — NOT-LIVE branch: SQL-driven guard/override reconstruction
// ---------------------------------------------------------------------------

describe("getClientDetail — L1247/1261/1272 NOT-LIVE branch guard/override reconstruction", () => {
  test("NOT-LIVE tool carries the correct guards/override shape from SQL joins", async () => {
    await reg("svc-guards", [makeTool({ name: "get-users" })]);
    expect(
      await registry.setToolGuards("svc-guards", "get-users", {
        rateLimitPerMin: 12,
        timeoutMs: 2500,
        allowedKeyHashes: ["deadbeef"],
      }),
    ).toBe(true);
    expect(
      await registry.setToolOverride("svc-guards", "get-users", {
        description: "Custom description",
        displayName: "list-users",
      }),
    ).toBe(true);

    await registry.unregister("svc-guards");
    // Confirm the NOT-LIVE branch is actually exercised.
    expect(registry.getClient("svc-guards")).toBeUndefined();

    const detail = registry.getClientDetail("svc-guards");
    expect(detail).not.toBeUndefined();
    const tool = detail?.tools.find((t) => t.name === "get-users");
    expect(tool).not.toBeUndefined();

    expect(tool?.guards?.rateLimitPerMin).toBe(12);
    expect(tool?.guards?.timeoutMs).toBe(2500);
    expect(tool?.guards?.allowedKeyHashes).toEqual(["deadbeef"]);

    expect(tool?.override?.description).toBe("Custom description");
    expect(tool?.override?.displayName).toBe("list-users");

    // Same tool round-trips as enabled — kept in this test to prove the
    // not-live reconstruction's `enabled` mapping isn't just accidentally
    // right on a different (disabled) fixture; see the dedicated L1279 tests
    // below for the false case.
    expect(tool?.enabled).toBe(true);
  });

  test("NOT-LIVE tool with no guards/override reconstructs undefined for both", async () => {
    await reg("svc-no-guards", [makeTool({ name: "get-users" })]);
    await registry.unregister("svc-no-guards");

    const detail = registry.getClientDetail("svc-no-guards");
    const tool = detail?.tools.find((t) => t.name === "get-users");
    expect(tool).not.toBeUndefined();
    expect(tool?.guards).toBeUndefined();
    expect(tool?.override).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// L1276:25 LogicalOperator — `upstreamName: t.upstream_name ?? undefined` (NOT-LIVE branch)
// ---------------------------------------------------------------------------

describe("getClientDetail — L1276 NOT-LIVE upstreamName fallback", () => {
  test("L1276:25 LogicalOperator->&& — MCP-kind NOT-LIVE tool round-trips upstreamName", async () => {
    const tools: DiscoveredMcpTool[] = [
      { name: "echo", upstreamName: "raw-echo", description: "Echoes input", inputSchema: { type: "object" } },
    ];
    await registry.registerMcp("mcp-notlive", tools, "http://mcp.test/mcp", "streamable-http", "9.9.9.9", "9.9.9.9");
    await registry.unregister("mcp-notlive");
    expect(registry.getClient("mcp-notlive")).toBeUndefined();

    const detail = registry.getClientDetail("mcp-notlive");
    const tool = detail?.tools.find((t) => t.name === "echo");
    expect(tool?.upstreamName).toBe("raw-echo");
  });

  test("L1276:25 LogicalOperator->&& — REST NOT-LIVE tool (upstream_name NULL in DB) yields undefined, not null", async () => {
    await reg("svc-rest-notlive", [makeTool({ name: "get-users" })]);
    await registry.unregister("svc-rest-notlive");
    expect(registry.getClient("svc-rest-notlive")).toBeUndefined();

    const detail = registry.getClientDetail("svc-rest-notlive");
    const tool = detail?.tools.find((t) => t.name === "get-users");
    expect(tool).not.toBeUndefined();
    // Strict `undefined` check — the `&&` mutant would leave this `null`
    // (falsy short-circuit of `null && undefined`) instead of `undefined`,
    // which `toBeUndefined()` (a `=== undefined` check) catches.
    expect(tool?.upstreamName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// L1279:20 — NOT-LIVE branch `enabled: t.enabled === 1` (twin of the LIVE-branch check)
// ---------------------------------------------------------------------------

describe("getClientDetail — L1279 NOT-LIVE tool enabled mapping", () => {
  test("L1279:20 EqualityOperator/ConditionalExpression — disabled NOT-LIVE tool reports enabled:false", async () => {
    await reg("svc-disabled-tool", [makeTool({ name: "get-users" })]);
    expect(await registry.setToolEnabled("svc-disabled-tool", "get-users", false)).toBe(true);
    await registry.unregister("svc-disabled-tool");
    expect(registry.getClient("svc-disabled-tool")).toBeUndefined();

    const detail = registry.getClientDetail("svc-disabled-tool");
    const tool = detail?.tools.find((t) => t.name === "get-users");
    expect(tool?.enabled).toBe(false);
  });

  test("L1279:20 EqualityOperator/ConditionalExpression — enabled NOT-LIVE tool reports enabled:true", async () => {
    await reg("svc-enabled-tool", [makeTool({ name: "get-users" })]);
    await registry.unregister("svc-enabled-tool");

    const detail = registry.getClientDetail("svc-enabled-tool");
    const tool = detail?.tools.find((t) => t.name === "get-users");
    expect(tool?.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// L1282/1283/1284 — NOT-LIVE branch: tags/sensitive/redactPaths `?? []` / `?? null` fallbacks
// ---------------------------------------------------------------------------

describe("getClientDetail — L1282/1283/1284 NOT-LIVE branch tag/sensitivity/redaction mapping", () => {
  test("L1282/1283/1284 defaults — NOT-LIVE tool with no tags/sensitivity/redaction configured", async () => {
    await reg("svc-notlive-empty", [makeTool({ name: "get-users" })]);
    await registry.unregister("svc-notlive-empty");
    expect(registry.getClient("svc-notlive-empty")).toBeUndefined();

    const detail = registry.getClientDetail("svc-notlive-empty");
    const tool = detail?.tools.find((t) => t.name === "get-users");
    expect(tool?.tags).toEqual([]);
    expect(tool?.sensitive).toBe(null);
    expect(tool?.redactPaths).toEqual([]);
  });

  test("L1282/1283/1284 populated — NOT-LIVE tool with tags/sensitivity/redaction configured before unregister", async () => {
    await reg("svc-notlive-full", [makeTool({ name: "get-users" })]);
    expect(setToolTags("svc-notlive-full", "get-users", ["ops"])).toBe(true);
    expect(setToolSensitive("svc-notlive-full", "get-users", false)).toBe(true);
    expect(setRedactionPaths("svc-notlive-full", "get-users", ["password"])).toBe(true);

    await registry.unregister("svc-notlive-full");
    expect(registry.getClient("svc-notlive-full")).toBeUndefined();

    const detail = registry.getClientDetail("svc-notlive-full");
    const tool = detail?.tools.find((t) => t.name === "get-users");
    expect(tool?.tags).toEqual(["ops"]);
    expect(tool?.sensitive).toBe(false);
    expect(tool?.redactPaths).toEqual(["password"]);
  });
});

// ---------------------------------------------------------------------------
// L1298/1299/1300/1301 — final return object: enabled / live / ip
// ---------------------------------------------------------------------------

describe("getClientDetail — L1298 client-level enabled mapping", () => {
  test("L1298 EqualityOperator/ConditionalExpression — enabled client reports enabled:true", async () => {
    await reg("svc-client-enabled");
    const detail = registry.getClientDetail("svc-client-enabled");
    expect(detail?.enabled).toBe(true);
  });

  test("L1298 EqualityOperator/ConditionalExpression — disabled client reports enabled:false", async () => {
    await reg("svc-client-disabled");
    expect(await registry.setClientEnabled("svc-client-disabled", false)).toBe(true);
    const detail = registry.getClientDetail("svc-client-disabled");
    expect(detail?.enabled).toBe(false);
  });
});

describe("getClientDetail — L1299 `live` boolean field", () => {
  test("L1299 EqualityOperator/ConditionalExpression — live client reports live:true", async () => {
    await reg("svc-is-live");
    const detail = registry.getClientDetail("svc-is-live");
    expect(detail?.live).toBe(true);
  });

  test("L1299 EqualityOperator/ConditionalExpression — NOT-LIVE client reports live:false", async () => {
    await reg("svc-not-live");
    await registry.unregister("svc-not-live");
    const detail = registry.getClientDetail("svc-not-live");
    expect(detail?.live).toBe(false);
  });
});

// Note: the source has drifted since an earlier pass labeled the block below
// "L1300/1301" for `ip` -- the CURRENT source has `status: live?.status ?? null`
// at L1300 and `ip: live?.ip ?? row.ip` at L1301. The `status` field itself
// (distinct from the `live` boolean above and from `ip` below) was not yet
// pinned, so it gets its own correctly-labeled block here.
describe("getClientDetail — L1300:15 `status` fallback (`live?.status ?? null`)", () => {
  test("L1300:15 LogicalOperator->&& — live client with an explicit non-default status reports that real status", async () => {
    await reg("svc-status-live");
    registry.markClientStatus("svc-status-live", "unreachable");

    const detail = registry.getClientDetail("svc-status-live");
    expect(detail?.live).toBe(true);
    // A truthy `live.status` kills the `live?.status && null` mutant, which
    // would collapse this to null instead of the real "unreachable".
    expect(detail?.status).toBe("unreachable");
  });

  test("L1300:15 LogicalOperator->&& — NOT-LIVE client reports status:null specifically (not undefined, not a stale status)", async () => {
    await reg("svc-status-notlive");
    registry.markClientStatus("svc-status-notlive", "degraded");
    await registry.unregister("svc-status-notlive");
    expect(registry.getClient("svc-status-notlive")).toBeUndefined();

    const detail = registry.getClientDetail("svc-status-notlive");
    expect(detail?.status).toBe(null);
    expect(detail?.status).not.toBeUndefined();
    expect(detail?.status).not.toBe("degraded");
  });
});

describe("getClientDetail — L1300/1301 `ip` fallback (`live?.ip ?? row.ip`)", () => {
  test("L1300/1301 OptionalChaining/LogicalOperator — LIVE client's ip comes from the in-memory value", async () => {
    await reg("svc-ip-live", [makeTool()], "5.5.5.5");
    const detail = registry.getClientDetail("svc-ip-live");
    expect(detail?.ip).toBe("5.5.5.5");
  });

  test("L1300/1301 OptionalChaining/LogicalOperator — NOT-LIVE client's ip falls back to the DB row (live is undefined)", async () => {
    await reg("svc-ip-notlive", [makeTool()], "8.8.4.4");
    await registry.unregister("svc-ip-notlive");
    expect(registry.getClient("svc-ip-notlive")).toBeUndefined();

    const detail = registry.getClientDetail("svc-ip-notlive");
    // If the `?.` were stripped, `live.ip` on an undefined `live` would throw
    // instead of returning; if `??` became `&&`, this would be `undefined`
    // instead of the DB-persisted IP.
    expect(detail?.ip).toBe("8.8.4.4");
  });
});

// ---------------------------------------------------------------------------
// L1307:15 LogicalOperator — `teamId: row.team_id ?? null`
// ---------------------------------------------------------------------------

describe("getClientDetail — L1307 teamId fallback", () => {
  test("L1307:15 LogicalOperator->&& — client with no team assigned reports teamId:null", async () => {
    await reg("svc-no-team");
    const detail = registry.getClientDetail("svc-no-team");
    expect(detail?.teamId).toBe(null);
  });

  test("L1307:15 LogicalOperator->&& — client with a team assigned reports the real numeric teamId", async () => {
    await reg("svc-with-team");
    const team = createTeam("rc10-team", null);
    if (typeof team === "string") throw new Error(`createTeam failed: ${team}`);
    expect(setClientTeam("svc-with-team", team.id)).toBe(true);

    const detail = registry.getClientDetail("svc-with-team");
    // A truthy team_id kills the `row.team_id && null` mutant, which would
    // collapse this to null instead of the real id.
    expect(detail?.teamId).toBe(team.id);
  });
});

// ---------------------------------------------------------------------------
// L1309:28 — `retryNonSafeMethods: row.retry_non_safe_methods === 1`
//
// Note: an earlier pass's brief assumed L1309 was about consecutiveFailures/
// circuitBreakerState. The CURRENT source has `retryNonSafeMethods` at L1309
// and `consecutiveFailures` one line down at L1310 (see the block right
// below this one, which keeps its original "L1309/1310" label pointing at
// the field it actually covers: consecutiveFailures). This field is sourced
// from `row.*` (queried once up top, independent of the live/not-live
// branch), so a NOT-LIVE client is used below purely to match the house
// style of exercising the DB-reconstruction path, not because the field
// itself is branch-dependent.
// ---------------------------------------------------------------------------

describe("getClientDetail — L1309:28 retryNonSafeMethods field mapping", () => {
  test("L1309:28 EqualityOperator/ConditionalExpression — registered with retryNonSafeMethods:true reports true", async () => {
    await registry.register(
      "svc-retry-true",
      [makeTool({ name: "get-users" })],
      DEFAULT_HEALTH,
      DEFAULT_IP,
      DEFAULT_BASE,
      DEFAULT_RESOLVED_IP,
      true,
    );
    await registry.unregister("svc-retry-true");
    expect(registry.getClient("svc-retry-true")).toBeUndefined();

    const detail = registry.getClientDetail("svc-retry-true");
    // Kills ConditionalExpression->false (would report false regardless) and
    // EqualityOperator -> '!== 1' (would flip this to false).
    expect(detail?.retryNonSafeMethods).toBe(true);
  });

  test("L1309:28 EqualityOperator/ConditionalExpression — registered with default retryNonSafeMethods (false) reports false", async () => {
    await reg("svc-retry-false");
    await registry.unregister("svc-retry-false");
    expect(registry.getClient("svc-retry-false")).toBeUndefined();

    const detail = registry.getClientDetail("svc-retry-false");
    // Kills ConditionalExpression->true (would report true regardless) and
    // EqualityOperator -> '!== 1' (would flip this to true).
    expect(detail?.retryNonSafeMethods).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L1309/1310 — `consecutiveFailures: live?.consecutive_failures ?? null`
// ---------------------------------------------------------------------------

describe("getClientDetail — L1309/1310 consecutiveFailures fallback", () => {
  test("L1309/1310 — live client with a nonzero failure count reports the real number", async () => {
    await reg("svc-failures");
    registry.incrementConsecutiveFailures("svc-failures");
    registry.incrementConsecutiveFailures("svc-failures");
    registry.incrementConsecutiveFailures("svc-failures");

    const detail = registry.getClientDetail("svc-failures");
    expect(detail?.consecutiveFailures).toBe(3);
  });

  test("L1309/1310 — NOT-LIVE client reports consecutiveFailures:null (not 0, not undefined)", async () => {
    await reg("svc-failures-notlive");
    registry.incrementConsecutiveFailures("svc-failures-notlive");
    await registry.unregister("svc-failures-notlive");
    expect(registry.getClient("svc-failures-notlive")).toBeUndefined();

    const detail = registry.getClientDetail("svc-failures-notlive");
    expect(detail?.consecutiveFailures).toBe(null);
    expect(detail?.consecutiveFailures).not.toBe(0);
    expect(detail?.consecutiveFailures).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// L1312 LogicalOperator/StringLiteral — circuitBreakerState
// ---------------------------------------------------------------------------

describe("getClientDetail — L1312 circuitBreakerState", () => {
  test('L1312 LogicalOperator->&&/StringLiteral — live client with no recorded state defaults to exactly "closed"', async () => {
    await reg("svc-cb-default");
    const detail = registry.getClientDetail("svc-cb-default");
    expect(detail?.circuitBreakerState).toBe("closed");
  });

  test("L1312 LogicalOperator->&& — live client with a recorded non-closed state reports the real state", async () => {
    await reg("svc-cb-open");
    const cb = getCircuitBreaker("svc-cb-open");
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    expect(getAllCircuitStates()["svc-cb-open"]).toBe("open");

    const detail = registry.getClientDetail("svc-cb-open");
    // A truthy recorded state kills the `getAllCircuitStates()[name] && "closed"`
    // mutant, which would collapse this to "closed" instead of the real "open".
    expect(detail?.circuitBreakerState).toBe("open");

    removeCircuitBreaker("svc-cb-open");
  });

  test("L1312 ConditionalExpression/LogicalOperator — NOT-LIVE client reports circuitBreakerState:null", async () => {
    await reg("svc-cb-notlive");
    await registry.unregister("svc-cb-notlive");
    expect(registry.getClient("svc-cb-notlive")).toBeUndefined();

    const detail = registry.getClientDetail("svc-cb-notlive");
    expect(detail?.circuitBreakerState).toBe(null);
  });
});

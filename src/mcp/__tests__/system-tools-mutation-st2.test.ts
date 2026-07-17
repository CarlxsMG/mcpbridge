import { describe, test, expect, beforeEach, spyOn } from "bun:test";

// Stryker mutation backstop — ST2 (system-tools.ts lines 86-159, the 7
// READ-TIER tools: sys_list_clients, sys_get_client, sys_list_tools,
// sys_list_bundles, sys_list_keys, sys_metrics, sys_audit_tail). Each
// test/comment cites the exact line:column, mutator, and replacement it
// kills, per the house convention established across the P2/domain-3
// mutation-testing series (see reports/mutation/result.json).
//
// Drives the exported control surface directly — listSystemTools(role) +
// runSystemTool(name, args, auth) — rather than the full JSON-RPC/express
// harness sibling file (system-tools.test.ts) uses, since none of this
// file's mutants depend on transport plumbing.
//
// Two techniques, per the task brief:
//   1. BULK SCHEMA KILL: one exact `toEqual` per tool against a hand-
//      transcribed copy of its real {name, description, inputSchema} object
//      literal (via listSystemTools()) kills every StringLiteral/
//      ObjectLiteral/ArrayDeclaration/BooleanLiteral survivor inside that
//      tool's static schema — including its `tier: "read"` literal, which
//      isn't part of the projected shape but still gets killed as a side
//      effect: corrupting `tier` breaks roleMeetsTier's filter in
//      listSystemTools(), so the tool silently disappears from the
//      returned array and `.find(...)` returns `undefined`, which fails
//      the `toEqual` against a real object.
//   2. HANDLER-LOGIC tests: real calls through runSystemTool() for the
//      handful of mutants schema-toEqual can't reach (arrow-function
//      bodies, conditionals, template literals, filter wiring).
//
// beforeEach follows the project convention: fresh in-memory SQLite
// (__resetDbForTesting) + unregister every live in-memory client, since
// unregister() deliberately doesn't purge persisted state and a fresh DB
// alone wouldn't clear the registry's in-memory `this.clients` Map.

import { listSystemTools, runSystemTool } from "../system-tools.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../registry.js";
import type { RestToolDefinition } from "../types.js";
import type { SystemAuthResult } from "../../security/system-role.js";
import * as auditMod from "../../admin/audit/audit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(overrides: Partial<RestToolDefinition> = {}): RestToolDefinition {
  return {
    name: "get-thing",
    method: "GET",
    endpoint: "/thing",
    description: "probe tool",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

async function reg(name: string, tools: RestToolDefinition[] = [makeTool()]) {
  await registry.register(name, tools, "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

// A read-tier-only key is sufficient for every tool in this file's scope
// (all 7 are `tier: "read"`) — using the minimal qualifying role means a
// `tier` literal getting corrupted (e.g. "read" -> "") reliably knocks the
// tool out of `roleMeetsTier`'s filter rather than accidentally still
// passing via a higher rank.
const READ_AUTH: SystemAuthResult = { role: "viewer", elevated: false, keyId: 7, isEnvBearer: false };

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

function findTool(name: string) {
  return listSystemTools("viewer").find((t) => t.name === name);
}

// ===========================================================================
// 1. BULK SCHEMA-LITERAL KILL — one toEqual per tool
// ===========================================================================

describe("read-tier tool schemas — bulk toEqual kill via listSystemTools()", () => {
  // L92:13 StringLiteral->'""' ("q"), L93:19 ObjectLiteral->'{}' (q's schema
  // object), L95:18 ObjectLiteral->'{}' (enabled's schema object), L95:50
  // StringLiteral->'""' ("Filter by enabled state."). Also incidentally
  // covers L99:11 (tier "read") via the disappears-from-listSystemTools
  // mechanism described above (already independently killed elsewhere, but
  // this test would catch it too).
  test("sys_list_clients — L92:13, L93:19, L95:18, L95:50", () => {
    expect(findTool("sys_list_clients")).toEqual({
      name: "sys_list_clients",
      description: "List registered backend clients (REST or MCP upstreams), with enable/health status.",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "Filter by name substring." },
          enabled: { type: "boolean", description: "Filter by enabled state." },
        },
        additionalProperties: false,
      },
    });
  });

  // L102:3 ObjectLiteral->'{}' (whole tool entry), L103:11 StringLiteral
  // ("sys_get_client"), L104:18 StringLiteral (description), L107:19
  // ObjectLiteral (name's schema object), L107:58 StringLiteral ("Client
  // name."), L108:17 ArrayDeclaration (`required: ["name"]` -> `[]`),
  // L108:18 StringLiteral ("name" inside required), L109:29 BooleanLiteral
  // (additionalProperties false->true). Also incidentally covers L111:11
  // (tier "read").
  test("sys_get_client — L102:3, L103:11, L104:18, L107:19, L107:58, L108:17, L108:18, L109:29", () => {
    expect(findTool("sys_get_client")).toEqual({
      name: "sys_get_client",
      description: "Get full detail for one registered client, including its tools and health.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Client name." } },
        required: ["name"],
        additionalProperties: false,
      },
    });
  });

  // L122:18 StringLiteral (description), L123:18 ObjectLiteral (inputSchema
  // -> '{}'), L123:26 StringLiteral ("object"), L123:74 BooleanLiteral
  // (additionalProperties false->true). Also incidentally covers L124:11
  // (tier "read").
  test("sys_list_tools — L122:18, L123:18, L123:26, L123:74", () => {
    expect(findTool("sys_list_tools")).toEqual({
      name: "sys_list_tools",
      description: "List every (client, tool) pair across every registered client, live or not.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    });
  });

  // L127:3 ObjectLiteral (whole tool entry -> '{}'), L130:7 StringLiteral
  // (description), L131:26 StringLiteral ("object"), L131:74 BooleanLiteral
  // (additionalProperties false->true). Also incidentally covers L132:11
  // (tier "read").
  test("sys_list_bundles — L127:3, L130:7, L131:26, L131:74", () => {
    expect(findTool("sys_list_bundles")).toEqual({
      name: "sys_list_bundles",
      description:
        "List admin-curated MCP bundles (cross-client tool + composite selections served at /mcp-custom/:bundleName).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    });
  });

  // L136:11 StringLiteral (description), L137:18 StringLiteral ("object"),
  // L138:18 ObjectLiteral (inputSchema -> '{}'), L138:74 BooleanLiteral
  // (additionalProperties false->true). Also incidentally covers L139:11
  // (tier "read").
  test("sys_list_keys — L136:11, L137:18, L138:18, L138:74", () => {
    expect(findTool("sys_list_keys")).toEqual({
      name: "sys_list_keys",
      description: "List managed MCP API keys (metadata only — raw key values are never retrievable after creation).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    });
  });

  // L140:14 ArrowFunction->'() => undefined' — the handler itself
  // (`() => json(listMcpKeys())`). An emptied handler would return
  // `undefined`, breaking the JSON response shape.
  test("sys_list_keys L140 — handler calls through to listMcpKeys(), not undefined", async () => {
    const result = await runSystemTool("sys_list_keys", {}, READ_AUTH);
    expect(typeof result.content[0].text).toBe("string");
    const parsed = JSON.parse(result.content[0].text ?? "") as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
  });

  // L142:3 ObjectLiteral (whole tool entry -> '{}'), L143:11 StringLiteral
  // (description), L144:18 StringLiteral ("object"), L145:74 BooleanLiteral
  // (additionalProperties false->true). Also incidentally covers L146:11
  // (tier "read").
  test("sys_metrics — L142:3, L143:11, L144:18, L145:74", () => {
    expect(findTool("sys_metrics")).toEqual({
      name: "sys_metrics",
      description: "Snapshot of gateway metrics: uptime, active sessions, tool-call counts, average latency.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    });
  });

  // L149:3 ObjectLiteral (whole tool entry -> '{}'), L151:18 StringLiteral
  // (description), L153:13 StringLiteral ("object"), L154:28 ObjectLiteral
  // (limit's schema object -> '{}'), L154:36 StringLiteral ("number"),
  // L154:59 StringLiteral ("Max entries to return (default 50, max 200)."),
  // L155:29 BooleanLiteral (additionalProperties false->true).
  test("sys_audit_tail — L149:3, L151:18, L153:13, L154:28, L154:36, L154:59, L155:29", () => {
    expect(findTool("sys_audit_tail")).toEqual({
      name: "sys_audit_tail",
      description: "Tail the admin audit log (most recent entries first).",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number", description: "Max entries to return (default 50, max 200)." } },
        additionalProperties: false,
      },
    });
  });
});

// ===========================================================================
// 2. HANDLER-LOGIC tests — mutants the schema toEqual above cannot reach
// ===========================================================================

describe("sys_list_clients — handler logic", () => {
  // L100:14 ArrowFunction->'() => undefined'. An emptied handler returns
  // `undefined`, which json()'s JSON.stringify would render as the literal
  // string "undefined" — not a parseable `{items:[...]}` shape. Registering
  // a real client and asserting it round-trips through proves the handler
  // actually calls registry.listClientsSummary(...).
  test("L100:14 — handler calls through to registry.listClientsSummary(), not undefined", async () => {
    await reg("delta");
    const result = await runSystemTool("sys_list_clients", {}, READ_AUTH);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text ?? "") as { items: { name: string }[] };
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items.map((i) => i.name)).toContain("delta");
  });

  // L100:57 ObjectLiteral->'{}' (the `{ q, enabled }` filter object passed to
  // listClientsSummary) and L100:98 StringLiteral->'""' (the "enabled" arg
  // lookup key). Neither is reachable via {} args (case above) since both
  // opts would resolve to undefined either way — need real filter values
  // that would produce a DIFFERENT result set if either mutant landed.
  test("L100:57, L100:98 — q and enabled filter args are wired through to listClientsSummary", async () => {
    await reg("alpha-one");
    await reg("alpha-two");
    await reg("beta-one");
    await registry.setClientEnabled("alpha-two", false);

    // An emptied filter object ({}) would ignore `q` entirely and return all 3.
    const byQ = await runSystemTool("sys_list_clients", { q: "alpha" }, READ_AUTH);
    const byQParsed = JSON.parse(byQ.content[0].text ?? "") as { items: { name: string }[] };
    expect(byQParsed.items.map((i) => i.name).sort()).toEqual(["alpha-one", "alpha-two"]);

    // Corrupting the "enabled" lookup key means bool(args, "") is always
    // undefined regardless of what args.enabled holds, so the enabled
    // filter would never apply and the disabled client would still show up.
    const byEnabled = await runSystemTool("sys_list_clients", { enabled: true }, READ_AUTH);
    const byEnabledParsed = JSON.parse(byEnabled.content[0].text ?? "") as { items: { name: string }[] };
    expect(byEnabledParsed.items.map((i) => i.name).sort()).toEqual(["alpha-one", "beta-one"]);
  });
});

describe("sys_get_client — handler logic", () => {
  // No `name` arg at all.
  // Kills: L114:11 ConditionalExpression->'false' (skipping this branch
  // would fall through to getClientDetail(undefined) and a *different*
  // "Client not found: undefined" message instead), L114:36 StringLiteral
  // (the message text itself), L114:82 BooleanLiteral (isError:true->false).
  // Also incidentally covers L111:11 (tier "read": a corrupted tier would
  // reject with a tier-rank message instead of this exact text).
  test("L114:11, L114:36, L114:82 — missing name returns the exact error message", async () => {
    const result = await runSystemTool("sys_get_client", {}, READ_AUTH);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Missing required argument: name" }]);
  });

  // A `name` for a client that was never registered.
  // Kills: L116:11 ConditionalExpression->'false' variant (skipping the
  // not-found branch would fall through to json(undefined), producing a
  // non-string `text`), L116:38 StringLiteral (the template literal ->
  // empty template), L116:67 ObjectLiteral (`{isError:true}` -> `{}`),
  // L116:78 BooleanLiteral (isError:true->false).
  test("L116:11, L116:38, L116:67, L116:78 — unknown client returns the exact interpolated not-found message", async () => {
    const result = await runSystemTool("sys_get_client", { name: "ghost" }, READ_AUTH);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Client not found: ghost" }]);
  });

  // A real, registered client's name.
  // Kills: L113:30 StringLiteral (the "name" arg-lookup key — corrupting it
  // to "" would make str(args, "") miss the real `name` value entirely and
  // fall into the missing-argument branch instead of returning real detail),
  // and L116:11 ConditionalExpression->'true' variant (forcing the
  // not-found branch to always fire would wrongly reject even this real,
  // found client).
  test("L113:30, L116:11 (true variant) — an existing client returns its full detail via json()", async () => {
    await reg("beta", [makeTool({ name: "get-thing" })]);
    const result = await runSystemTool("sys_get_client", { name: "beta" }, READ_AUTH);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text ?? "") as { name: string; tools: { name: string }[] };
    expect(parsed.name).toBe("beta");
    expect(parsed.tools.map((t) => t.name)).toContain("get-thing");
  });

  // L69:10 ConditionalExpression->'true' — this is inside the str() helper
  // (`return typeof v === "string" ? v : undefined;`), not sys_get_client
  // itself. Forcing the whole ternary to always-true means str() returns
  // args[key] AS-IS regardless of its real type. A non-string "name" (a
  // number) distinguishes real code (rejects it as missing, since
  // typeof 123 !== "string") from the mutant (passes 123 straight through
  // to getClientDetail, producing a DIFFERENT "Client not found: 123"
  // message instead of "Missing required argument: name").
  test("L69 (str()) — a non-string 'name' is NOT passed through as-is", async () => {
    const result = await runSystemTool("sys_get_client", { name: 123 }, READ_AUTH);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Missing required argument: name" }]);
  });
});

describe("sys_list_tools / sys_list_bundles / sys_metrics — trivial handlers", () => {
  // L125:14 ArrowFunction->'() => undefined'. An emptied handler's
  // JSON.stringify(undefined) yields the JS value `undefined` (not the
  // string "undefined"), so result.content[0].text would not even be a
  // string — JSON.parse on it throws, failing the test either way. Also
  // incidentally covers L124:11 (tier "read": corruption would return a
  // tier-rejection string, which JSON.parse also can't parse as an array).
  test("sys_list_tools L125:14 — handler calls through to registry.listAllTools(), not undefined", async () => {
    await reg("gamma", [makeTool({ name: "get-thing" })]);
    const result = await runSystemTool("sys_list_tools", {}, READ_AUTH);
    expect(typeof result.content[0].text).toBe("string");
    const parsed = JSON.parse(result.content[0].text ?? "") as { client: string; tool: string }[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toContainEqual(expect.objectContaining({ client: "gamma", tool: "get-thing" }));
  });

  // L133:14 ArrowFunction->'() => undefined'. Also incidentally covers
  // L132:11 (tier "read").
  test("sys_list_bundles L133:14 — handler calls through to listBundles(), not undefined", async () => {
    const result = await runSystemTool("sys_list_bundles", {}, READ_AUTH);
    expect(typeof result.content[0].text).toBe("string");
    const parsed = JSON.parse(result.content[0].text ?? "") as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
  });

  // L147:14 ArrowFunction->'() => undefined'. Also incidentally covers
  // L146:11 (tier "read").
  test("sys_metrics L147:14 — handler calls through to getLegacyMetricsSnapshot(), not undefined", async () => {
    const result = await runSystemTool("sys_metrics", {}, READ_AUTH);
    expect(typeof result.content[0].text).toBe("string");
    const parsed = JSON.parse(result.content[0].text ?? "") as { uptimeSeconds: number; totalToolCalls: number };
    expect(typeof parsed.uptimeSeconds).toBe("number");
    expect(typeof parsed.totalToolCalls).toBe("number");
  });

  // L158:42 ObjectLiteral->'{}' (the `{limit: num(args,"limit")}` object
  // passed to listAuditLog) and L158:61 StringLiteral->'""' (the "limit" key
  // string) — not reachable via the schema toEqual above (that's static
  // data; this is the handler's own call-argument wiring). A call with NO
  // real audit rows can't distinguish these (both `{limit:5}` and `{}` would
  // return an empty list) — spy `listAuditLog` directly and assert the exact
  // argument object it receives.
  test("sys_audit_tail L158 — listAuditLog is called with the real {limit} object, not an emptied one or a corrupted key", async () => {
    const spy = spyOn(auditMod, "listAuditLog");
    try {
      const result = await runSystemTool("sys_audit_tail", { limit: 7 }, READ_AUTH);
      expect(spy).toHaveBeenCalledTimes(1);
      // An emptied ObjectLiteral would pass {}; a corrupted "limit" key would
      // pass { "": 7 } (num(args,"") reads the wrong property, itself
      // resolving to undefined since args[""] doesn't exist) -- either way
      // the real { limit: 7 } would not be observed.
      expect(spy.mock.calls[0]![0]).toEqual({ limit: 7 });
      expect(typeof result.content[0].text).toBe("string");
    } finally {
      spy.mockRestore();
    }
  });

  // L74:10 ConditionalExpression->'true' — this line is INSIDE the num()
  // helper (`return typeof v === "number" && Number.isFinite(v) ? v :
  // undefined;`), not bool() as a sibling cluster's file mislabeled it.
  // Forcing the whole ternary to always-true means num() returns args[key]
  // AS-IS regardless of its real type/finiteness. A non-number "limit"
  // (a numeric-looking STRING) distinguishes real code (rejects it,
  // returns undefined) from the mutant (passes the raw string through).
  test("sys_audit_tail L74 (num()) — a non-number 'limit' is NOT passed through as-is", async () => {
    const spy = spyOn(auditMod, "listAuditLog");
    try {
      await runSystemTool("sys_audit_tail", { limit: "7" }, READ_AUTH);
      expect(spy.mock.calls[0]![0]).toEqual({ limit: undefined });
    } finally {
      spy.mockRestore();
    }
  });

  // Same line, the `Number.isFinite(v)` half of the && — Infinity is
  // typeof "number" but not finite, so real code must still reject it.
  test("sys_audit_tail L74 (num()) — a non-finite number 'limit' (Infinity) is rejected, not passed through", async () => {
    const spy = spyOn(auditMod, "listAuditLog");
    try {
      await runSystemTool("sys_audit_tail", { limit: Infinity }, READ_AUTH);
      expect(spy.mock.calls[0]![0]).toEqual({ limit: undefined });
    } finally {
      spy.mockRestore();
    }
  });
});

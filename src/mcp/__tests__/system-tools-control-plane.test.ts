/**
 * The /mcp control plane's tenancy gate, across EVERY sys_* tool that names a
 * client or a tool — not just the three that let an agent finish a job
 * (sys_create_bundle, sys_set_guard, sys_diagnose).
 *
 * The property under test is one sentence: a managed key's `scopes` confine it
 * on the control plane exactly as they confine it on the data plane, and a
 * refusal must be indistinguishable from "that target does not exist". A scoped
 * key that could read another client's full detail, disable its tools, reset its
 * breaker or delete it outright would be handed precisely the reach
 * `checkKeyScopeGate` denies it on /mcp/:clientName.
 *
 * Every scope case here carries BOTH halves, because only the pair proves the
 * property: an unrestricted caller succeeding on the same target (so the target
 * demonstrably exists and is reachable) AND a scoped caller getting the same
 * words a nonexistent target gets. Denial alone would also be satisfied by a
 * tool that is simply broken; opacity is what closes the enumeration oracle.
 *
 * Driven through runSystemTool()/listSystemTools() directly with a hand-built
 * SystemAuthResult (no transport, no session), the same harness the ST mutation
 * clusters use; system-tools.test.ts covers the real JSON-RPC path.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { clearRegistry, makeTool, registerTestClient } from "../../__tests__/_utils/registry.js";
import { withConfig } from "../../__tests__/_utils/with-config.js";
import { listSystemTools, runSystemTool, systemToolScopeCensus } from "../system-tools.js";
import { registry } from "../registry.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { listAuditLog } from "../../admin/audit/audit.js";
import { getBundleDetail } from "../../admin/tool-composition/bundles.js";
import { createMcpKey } from "../../security/mcp-key-store.js";
import { recordTraffic } from "../../observability/traffic.js";
import { denyResult, toolResult } from "../../lib/mcp-result.js";
import type { SystemAuthResult } from "../../security/system-role.js";

/** The env admin Bearer: no key row, so no scope narrowing — the unrestricted baseline. */
function envBearer(overrides: Partial<SystemAuthResult> = {}): SystemAuthResult {
  return { role: "admin", elevated: true, keyId: null, isEnvBearer: true, ...overrides };
}

/**
 * A managed key that carries a control-plane role AND a client scope — the only
 * shape of "narrowed caller" this surface can have (mcp_api_keys has no
 * team_id, and only a super-admin may mint an adminRole key at all).
 * `elevated` so the sensitive/__confirm gate never masks a scope result.
 */
function scopedKeyAuth(clients: string[], role: SystemAuthResult["role"] = "admin"): SystemAuthResult {
  const { record } = createMcpKey(`scoped-${clients.join("-")}`, { clients }, null, "tester", null, true, role);
  return { role, elevated: true, keyId: record.id, isEnvBearer: false };
}

/**
 * A key narrowed by `scopes.tools` instead of `scopes.clients` — the shape that
 * distinguishes the two gates: it grants exactly one (client, tool) pair, and
 * therefore no authority over the client that owns it.
 */
function toolScopedKeyAuth(tools: string[], role: SystemAuthResult["role"] = "admin"): SystemAuthResult {
  const { record } = createMcpKey(`tool-scoped-${tools.join("-")}`, { tools }, null, "tester", null, true, role);
  return { role, elevated: true, keyId: record.id, isEnvBearer: false };
}

/**
 * Compares two refusals with the target name factored out: the only thing an
 * out-of-scope answer may differ by is the name the caller itself supplied.
 */
function sameWords(refusal: { content?: { text?: string }[] }, name: string): string {
  return textOf(refusal).replaceAll(name, "<TARGET>");
}

function textOf(result: { content?: { text?: string }[] }): string {
  return result.content?.[0]?.text ?? "";
}

function parse(result: { content?: { text?: string }[] }): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

function guardsOf(clientName: string, toolName: string): Record<string, unknown> | undefined {
  const guards = registry.getClientDetail(clientName)?.tools.find((t) => t.name === toolName)?.guards;
  return guards as Record<string, unknown> | undefined;
}

function toolEnabled(clientName: string, toolName: string): boolean | undefined {
  return registry.getClientDetail(clientName)?.tools.find((t) => t.name === toolName)?.enabled;
}

/** The client names sys_list_clients returned, in the order it returned them. */
function clientNames(result: { content?: { text?: string }[] }): string[] {
  const page = JSON.parse(textOf(result)) as { items: { name: string }[] };
  return page.items.map((i) => i.name);
}

/** sys_list_tools' rows rendered as `client__tool` keys. */
function toolPairs(result: { content?: { text?: string }[] }): string[] {
  const rows = JSON.parse(textOf(result)) as { client: string; tool: string }[];
  return rows.map((r) => `${r.client}__${r.tool}`);
}

/** One captured denial against alpha__get-thing — the fixture sys_diagnose summarises. */
function recordDenial(code: Parameters<typeof denyResult>[0]): void {
  recordTraffic({
    mcpToolName: "alpha__get-thing",
    clientName: "alpha",
    toolName: "get-thing",
    keyId: null,
    args: {},
    result: denyResult(code, "refused"),
    durationMs: 1,
  });
}

beforeEach(async () => {
  await clearRegistry();
  __resetDbForTesting();
});

// ---------------------------------------------------------------------------
// sys_create_bundle
// ---------------------------------------------------------------------------

describe("sys_create_bundle", () => {
  test("curates a bundle from clientName__toolName keys and audits it", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" }), makeTool({ name: "put-thing" })]);

    const result = await runSystemTool(
      "sys_create_bundle",
      { name: "starter-kit", description: "curated", tools: ["alpha__get-thing"], __confirm: true },
      envBearer(),
    );

    expect(result.isError).toBeUndefined();
    expect(parse(result).name).toBe("starter-kit");
    expect(getBundleDetail("starter-kit")?.tools).toEqual([{ client: "alpha", tool: "get-thing" }]);
    expect(listAuditLog({ limit: 1 }).items[0]?.action).toBe("bundle.create");
  });

  test("records the same audit detail POST /admin-api/bundles records, so one row does not depend on the transport", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);

    await runSystemTool(
      "sys_create_bundle",
      { name: "starter-kit", tools: ["alpha__get-thing"], __confirm: true },
      envBearer(),
    );

    // composites_count is 0 rather than absent: this tool refuses composite
    // members, but a reader comparing two bundle.create rows should not have to
    // know which transport wrote which to know a bundle had no macros.
    expect(listAuditLog({ limit: 1 }).items[0]?.detail).toEqual({ tools_count: 1, composites_count: 0 });
  });

  test("is admin tier — an operator-role key can neither see nor call it", async () => {
    expect(listSystemTools("operator").map((t) => t.name)).not.toContain("sys_create_bundle");

    const result = await runSystemTool(
      "sys_create_bundle",
      { name: "kit", tools: [], __confirm: true },
      envBearer({ role: "operator", isEnvBearer: false }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("requires the 'admin' tier or higher");
  });

  test("is sensitive — a non-elevated admin key without __confirm is stopped at the step-up gate", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);
    const { record } = createMcpKey("plain-admin", null, null, "tester", null, false, "admin");

    const result = await runSystemTool(
      "sys_create_bundle",
      { name: "kit", tools: ["alpha__get-thing"] },
      { role: "admin", elevated: false, keyId: record.id, isEnvBearer: false },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("is sensitive");
    expect(getBundleDetail("kit")).toBeUndefined();
  });

  test("a scoped key cannot curate another client's tool, and cannot tell it apart from a tool that does not exist", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);
    await registerTestClient("beta", [makeTool({ name: "get-thing" })]);
    const scoped = scopedKeyAuth(["alpha"]);

    // Exists, but out of scope.
    const foreign = await runSystemTool(
      "sys_create_bundle",
      { name: "kit", tools: ["beta__get-thing"], __confirm: true },
      scoped,
    );
    // Does not exist anywhere.
    const ghost = await runSystemTool(
      "sys_create_bundle",
      { name: "kit", tools: ["beta__nope"], __confirm: true },
      scoped,
    );

    expect(foreign.isError).toBe(true);
    expect(textOf(foreign)).toBe('Unknown tool "beta__get-thing"');
    expect(textOf(ghost)).toBe('Unknown tool "beta__nope"');
    // Same sentence for both: nothing in the answer says which of the two keys
    // named a real tool. Without the scope check the first call would have
    // SUCCEEDED and the second failed — that difference is the oracle.
    expect(textOf(foreign).replace("beta__get-thing", "X")).toBe(textOf(ghost).replace("beta__nope", "X"));
    expect(getBundleDetail("kit")).toBeUndefined();
  });

  test("a scoped key can still curate its own client's tools", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);
    await registerTestClient("beta", [makeTool({ name: "get-thing" })]);

    const result = await runSystemTool(
      "sys_create_bundle",
      { name: "kit", tools: ["alpha__get-thing"], __confirm: true },
      scopedKeyAuth(["alpha"]),
    );
    expect(result.isError).toBeUndefined();
    expect(getBundleDetail("kit")?.tools).toEqual([{ client: "alpha", tool: "get-thing" }]);
  });

  test("a malformed key is refused in the same words as an unknown one", async () => {
    const result = await runSystemTool(
      "sys_create_bundle",
      { name: "kit", tools: ["not-a-composite-key"], __confirm: true },
      envBearer(),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Unknown tool "not-a-composite-key"');
  });
});

// ---------------------------------------------------------------------------
// sys_set_guard
// ---------------------------------------------------------------------------

describe("sys_set_guard", () => {
  test("writes the guard policy through the mutation registry and audits it as a PATCH would", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);

    const result = await runSystemTool(
      "sys_set_guard",
      { client: "alpha", tool: "get-thing", guards: { rateLimitPerMin: 30, timeoutMs: 4000 } },
      envBearer(),
    );

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe("Guards updated for 'alpha__get-thing'");
    expect(guardsOf("alpha", "get-thing")).toEqual({ rateLimitPerMin: 30, timeoutMs: 4000 });
    // The registry entry's own audit event, not one this tool invented.
    expect(listAuditLog({ limit: 1 }).items[0]).toMatchObject({
      action: "tool.guards.update",
      target: "alpha__get-thing",
    });
  });

  test("guards:null clears the policy", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);
    await runSystemTool(
      "sys_set_guard",
      { client: "alpha", tool: "get-thing", guards: { rateLimitPerMin: 30 } },
      envBearer(),
    );

    const cleared = await runSystemTool(
      "sys_set_guard",
      { client: "alpha", tool: "get-thing", guards: null },
      envBearer(),
    );
    expect(cleared.isError).toBeUndefined();
    expect(guardsOf("alpha", "get-thing")).toBeUndefined();
  });

  test("is operate tier — a viewer-role key can neither see nor call it", async () => {
    expect(listSystemTools("viewer").map((t) => t.name)).not.toContain("sys_set_guard");

    const result = await runSystemTool(
      "sys_set_guard",
      { client: "alpha", tool: "get-thing", guards: null },
      envBearer({ role: "viewer", elevated: false, isEnvBearer: false }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("requires the 'operate' tier or higher");
  });

  test("relays the registry's own validation message instead of writing a nonsense guard", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);

    const result = await runSystemTool(
      "sys_set_guard",
      { client: "alpha", tool: "get-thing", guards: { rateLimitPerMin: -1 } },
      envBearer(),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("guards.rateLimitPerMin must be a positive number");
    expect(guardsOf("alpha", "get-thing")).toBeUndefined();
  });

  test("a missing guards argument is rejected rather than read as 'clear it'", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);
    await runSystemTool(
      "sys_set_guard",
      { client: "alpha", tool: "get-thing", guards: { rateLimitPerMin: 30 } },
      envBearer(),
    );

    const result = await runSystemTool("sys_set_guard", { client: "alpha", tool: "get-thing" }, envBearer());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Missing required argument: client, tool, guards");
    expect(guardsOf("alpha", "get-thing")).toEqual({ rateLimitPerMin: 30 });
  });

  test("a scoped key cannot re-guard another client's tool, and its refusal reads as 'not found'", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);
    await registerTestClient("beta", [makeTool({ name: "get-thing" })]);
    const scoped = scopedKeyAuth(["alpha"]);

    const foreign = await runSystemTool(
      "sys_set_guard",
      { client: "beta", tool: "get-thing", guards: { rateLimitPerMin: 1 } },
      scoped,
    );
    const ghost = await runSystemTool(
      "sys_set_guard",
      { client: "beta", tool: "nope", guards: { rateLimitPerMin: 1 } },
      scoped,
    );

    expect(foreign.isError).toBe(true);
    expect(textOf(foreign)).toBe("Tool not found: beta__get-thing");
    expect(textOf(ghost)).toBe("Tool not found: beta__nope");
    // Nothing was written to the other client — without the scope check this
    // call succeeds and rate-limits a tenant the caller can't even call.
    expect(guardsOf("beta", "get-thing")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sys_diagnose
// ---------------------------------------------------------------------------

describe("sys_diagnose", () => {
  test("reports the enable flags, breaker state and guard values in force", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);
    await runSystemTool(
      "sys_set_guard",
      { client: "alpha", tool: "get-thing", guards: { rateLimitPerMin: 5, timeoutMs: 250 } },
      envBearer(),
    );
    await registry.setToolEnabled("alpha", "get-thing", false);

    const result = await runSystemTool("sys_diagnose", { client: "alpha", tool: "get-thing" }, envBearer());
    expect(result.isError).toBeUndefined();
    const report = parse(result);

    expect(report.tool).toBe("alpha__get-thing");
    expect(report.toolEnabled).toBe(false);
    expect(report.client).toMatchObject({ name: "alpha", enabled: true, live: true });
    expect(report.client).toHaveProperty("circuitBreakerState");
    expect(report.guards).toEqual({ rateLimitPerMin: 5, timeoutMs: 250, allowedKeyRestricted: false });
  });

  test("summarises the deny codes recent calls actually hit, and says when capture is off", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);
    const traffic = (result: ReturnType<typeof denyResult> | ReturnType<typeof toolResult>): void =>
      recordTraffic({
        mcpToolName: "alpha__get-thing",
        clientName: "alpha",
        toolName: "get-thing",
        keyId: null,
        args: {},
        result,
        durationMs: 1,
      });
    traffic(denyResult("rate_limit", "too fast"));
    traffic(denyResult("rate_limit", "too fast"));
    traffic(denyResult("disabled", "off"));
    // An upstream failure is not a policy decision and must not be counted.
    traffic(toolResult("upstream 500", { isError: true }));

    const off = await runSystemTool("sys_diagnose", { client: "alpha", tool: "get-thing" }, envBearer());
    expect(parse(off).recentDenials).toMatchObject({ captureEnabled: false, sampled: 0 });

    const on = await withConfig({ trafficCaptureEnabled: true }, () =>
      runSystemTool("sys_diagnose", { client: "alpha", tool: "get-thing" }, envBearer()),
    );
    const denials = parse(on).recentDenials as {
      captureEnabled: boolean;
      sampled: number;
      truncated: boolean;
      byCode: Record<string, number>;
      latest: { denyCode: string }[];
    };
    expect(denials).toMatchObject({
      captureEnabled: true,
      sampled: 3,
      // Four rows written, far below the scan cap — nothing was left unexamined,
      // so the counts really are the window's.
      truncated: false,
      byCode: { rate_limit: 2, disabled: 1 },
    });
    // Most recent first, and only policy decisions — the upstream 500 above is
    // an error without a deny code and must not appear.
    expect(denials.latest.map((d) => d.denyCode)).toEqual(["disabled", "rate_limit", "rate_limit"]);
  });

  test("the window is clamped, so denials older than it drop out of the summary", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);
    recordTraffic({
      mcpToolName: "alpha__get-thing",
      clientName: "alpha",
      toolName: "get-thing",
      keyId: null,
      args: {},
      result: denyResult("quota", "spent"),
      durationMs: 1,
    });

    // A one-millisecond ask is clamped up to the one-second floor, which the
    // row just written still falls inside; a zero-length window would make the
    // whole summary unreadable rather than merely narrow.
    const narrow = await withConfig({ trafficCaptureEnabled: true }, () =>
      runSystemTool("sys_diagnose", { client: "alpha", tool: "get-thing", windowMs: 1 }, envBearer()),
    );
    expect(parse(narrow).recentDenials).toMatchObject({ windowMs: 1_000, sampled: 1 });

    const huge = await withConfig({ trafficCaptureEnabled: true }, () =>
      runSystemTool("sys_diagnose", { client: "alpha", tool: "get-thing", windowMs: 999_999_999_999 }, envBearer()),
    );
    expect(parse(huge).recentDenials).toMatchObject({ windowMs: 24 * 60 * 60_000 });
  });

  test("a scan filled to its cap is flagged truncated, so the count cannot be read as a total", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);
    const day = 24 * 60 * 60_000;
    const diagnose = (): Promise<ReturnType<typeof toolResult>> =>
      withConfig({ trafficCaptureEnabled: true }, () =>
        runSystemTool("sys_diagnose", { client: "alpha", tool: "get-thing", windowMs: day }, envBearer()),
      );

    // Read the cap off the report rather than hardcoding it: the number is an
    // implementation detail, the relationship is what matters.
    const empty = parse(await diagnose()).recentDenials as { scanLimit: number; truncated: boolean };
    expect(empty.truncated).toBe(false);
    const written = empty.scanLimit + 25;
    for (let i = 0; i < written; i++) recordDenial("rate_limit");

    const report = parse(await diagnose()).recentDenials as {
      sampled: number;
      truncated: boolean;
      scanLimit: number;
      byCode: Record<string, number>;
    };
    // Every row above is inside the window and every one is a denial, so an
    // honest "total" would be `written`. It cannot be: the scan stopped at the
    // cap. `sampled` + `truncated` say so; a field called `total` would not.
    expect(written).toBeGreaterThan(report.sampled);
    expect(report.sampled).toBe(report.scanLimit);
    expect(report.truncated).toBe(true);
    // byCode is derived from the same sample and is capped with it.
    expect(report.byCode.rate_limit).toBe(report.scanLimit);
  });

  test("is operate tier — an auditor-role key can neither see nor call it", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);
    expect(listSystemTools("auditor").map((t) => t.name)).not.toContain("sys_diagnose");

    const result = await runSystemTool(
      "sys_diagnose",
      { client: "alpha", tool: "get-thing" },
      envBearer({ role: "auditor", elevated: false, isEnvBearer: false }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("requires the 'operate' tier or higher");
  });

  test("a scoped key cannot diagnose another client's tool, and the refusal does not confirm it exists", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);
    await registerTestClient("beta", [makeTool({ name: "get-thing" })]);
    const scoped = scopedKeyAuth(["alpha"], "operator");

    const foreign = await runSystemTool("sys_diagnose", { client: "beta", tool: "get-thing" }, scoped);
    const ghost = await runSystemTool("sys_diagnose", { client: "beta", tool: "nope" }, scoped);

    expect(foreign.isError).toBe(true);
    expect(textOf(foreign)).toBe("Tool not found: beta__get-thing");
    expect(textOf(ghost)).toBe("Tool not found: beta__nope");

    // The target really does exist and really is readable — by a caller whose
    // key does not exclude it. That asymmetry is what the scoped caller must
    // not be able to observe.
    const unrestricted = await runSystemTool("sys_diagnose", { client: "beta", tool: "get-thing" }, envBearer());
    expect(unrestricted.isError).toBeUndefined();
    expect(parse(unrestricted).tool).toBe("beta__get-thing");
  });

  test("a key whose row has been deleted mid-session fails closed", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);
    // Auth resolved against a key id that no longer has a row: the scope can no
    // longer be read, so it must deny rather than fall back to unrestricted.
    const result = await runSystemTool(
      "sys_diagnose",
      { client: "alpha", tool: "get-thing" },
      { role: "admin", elevated: true, keyId: 4242, isEnvBearer: false },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Tool not found: alpha__get-thing");
  });
});

// ---------------------------------------------------------------------------
// The PRE-EXISTING tools — the same gate, applied uniformly
//
// These shipped with no scope check at all while the three above each had one:
// same arguments, same tiers, strictly larger blast radius. Each case below
// carries the pair described in the file header.
// ---------------------------------------------------------------------------

describe("sys_get_client", () => {
  test("a scoped key cannot read another client's detail, and cannot tell it from a client that does not exist", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);
    await registerTestClient("beta", [makeTool({ name: "get-thing" })]);
    const scoped = scopedKeyAuth(["alpha"], "viewer");

    const foreign = await runSystemTool("sys_get_client", { name: "beta" }, scoped);
    const ghost = await runSystemTool("sys_get_client", { name: "ghost" }, scoped);

    expect(foreign.isError).toBe(true);
    expect(textOf(foreign)).toBe("Client not found: beta");
    expect(sameWords(foreign, "beta")).toBe(sameWords(ghost, "ghost"));

    // The control half: beta exists and its detail really is readable — by a
    // caller whose key does not exclude it. Ungated, the refused call above
    // returned beta's baseUrl, resolvedIp, guards and every tool name.
    const unrestricted = await runSystemTool("sys_get_client", { name: "beta" }, envBearer());
    expect(unrestricted.isError).toBeUndefined();
    expect(parse(unrestricted).name).toBe("beta");
    expect(parse(unrestricted)).toHaveProperty("resolvedIp");
  });

  test("a key scoped to one TOOL of a client still cannot read that client's detail", async () => {
    await registerTestClient("beta", [makeTool({ name: "get-thing" }), makeTool({ name: "put-thing" })]);
    // The detail document is client-level — every other tool on the client, its
    // baseUrl and its resolvedIp — so a single-tool grant is not enough.
    const toolScoped = toolScopedKeyAuth(["beta__get-thing"], "viewer");

    const refused = await runSystemTool("sys_get_client", { name: "beta" }, toolScoped);
    const ghost = await runSystemTool("sys_get_client", { name: "ghost" }, toolScoped);
    expect(refused.isError).toBe(true);
    expect(sameWords(refused, "beta")).toBe(sameWords(ghost, "ghost"));

    const unrestricted = await runSystemTool("sys_get_client", { name: "beta" }, envBearer());
    expect(parse(unrestricted).name).toBe("beta");
  });
});

describe("sys_set_client_enabled", () => {
  test("a scoped key cannot disable another client, and nothing about it changes", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);
    await registerTestClient("beta", [makeTool({ name: "get-thing" })]);
    const scoped = scopedKeyAuth(["alpha"], "operator");

    const foreign = await runSystemTool("sys_set_client_enabled", { name: "beta", enabled: false }, scoped);
    const ghost = await runSystemTool("sys_set_client_enabled", { name: "ghost", enabled: false }, scoped);

    expect(foreign.isError).toBe(true);
    expect(textOf(foreign)).toBe("Client not found: beta");
    expect(sameWords(foreign, "beta")).toBe(sameWords(ghost, "ghost"));
    expect(registry.getClientDetail("beta")?.enabled).toBe(true);
    expect(listAuditLog({ limit: 10 }).items.map((i) => i.action)).not.toContain("client.disable");

    // Control: the very same call from an unrestricted caller disables it, so
    // the refusal above was the gate and not a rejected argument.
    const unrestricted = await runSystemTool("sys_set_client_enabled", { name: "beta", enabled: false }, envBearer());
    expect(unrestricted.isError).toBeUndefined();
    expect(registry.getClientDetail("beta")?.enabled).toBe(false);
  });
});

describe("sys_set_tool_enabled", () => {
  test("a scoped key cannot disable another client's tool, and its refusal reads as 'not found'", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);
    await registerTestClient("beta", [makeTool({ name: "get-thing" })]);
    const scoped = scopedKeyAuth(["alpha"], "operator");

    const foreign = await runSystemTool(
      "sys_set_tool_enabled",
      { client: "beta", tool: "get-thing", enabled: false },
      scoped,
    );
    const ghost = await runSystemTool("sys_set_tool_enabled", { client: "beta", tool: "nope", enabled: false }, scoped);

    expect(foreign.isError).toBe(true);
    expect(textOf(foreign)).toBe("Tool not found: beta__get-thing");
    expect(textOf(ghost)).toBe("Tool not found: beta__nope");
    expect(toolEnabled("beta", "get-thing")).toBe(true);

    // Control — same words for both above, and the operation genuinely works.
    const unrestricted = await runSystemTool(
      "sys_set_tool_enabled",
      { client: "beta", tool: "get-thing", enabled: false },
      envBearer(),
    );
    expect(unrestricted.isError).toBeUndefined();
    expect(toolEnabled("beta", "get-thing")).toBe(false);
  });

  test("a key scoped to that exact TOOL may still toggle it — the grant is per pair here", async () => {
    await registerTestClient("beta", [makeTool({ name: "get-thing" }), makeTool({ name: "put-thing" })]);
    const toolScoped = toolScopedKeyAuth(["beta__get-thing"], "operator");

    const own = await runSystemTool(
      "sys_set_tool_enabled",
      { client: "beta", tool: "get-thing", enabled: false },
      toolScoped,
    );
    expect(own.isError).toBeUndefined();
    expect(toolEnabled("beta", "get-thing")).toBe(false);

    // ...but not its neighbour on the same client, which it was never granted.
    const neighbour = await runSystemTool(
      "sys_set_tool_enabled",
      { client: "beta", tool: "put-thing", enabled: false },
      toolScoped,
    );
    expect(textOf(neighbour)).toBe("Tool not found: beta__put-thing");
    expect(toolEnabled("beta", "put-thing")).toBe(true);
  });
});

describe("sys_reset_circuit_breaker", () => {
  test("a scoped key cannot reset another client's breaker, and the refusal is the not-live one", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);
    await registerTestClient("beta", [makeTool({ name: "get-thing" })]);
    const scoped = scopedKeyAuth(["alpha"], "operator");

    const foreign = await runSystemTool("sys_reset_circuit_breaker", { name: "beta" }, scoped);
    const ghost = await runSystemTool("sys_reset_circuit_breaker", { name: "ghost" }, scoped);

    expect(foreign.isError).toBe(true);
    // Deliberately the same sentence a name that is not live gets, since that is
    // this tool's own not-found answer — see clientNotLive.
    expect(textOf(foreign)).toBe("Client is not currently live: beta");
    expect(sameWords(foreign, "beta")).toBe(sameWords(ghost, "ghost"));
    expect(listAuditLog({ limit: 10 }).items.map((i) => i.action)).not.toContain("client.circuit_breaker.reset");

    // Control: beta IS live, so an unrestricted caller resets it — the refusal
    // above was the gate, not the liveness check.
    const unrestricted = await runSystemTool("sys_reset_circuit_breaker", { name: "beta" }, envBearer());
    expect(unrestricted.isError).toBeUndefined();
    expect(textOf(unrestricted)).toBe("Circuit breaker reset for 'beta'");
  });

  test("a key scoped to one of the client's TOOLS cannot reset the breaker — it is client-wide", async () => {
    await registerTestClient("beta", [makeTool({ name: "get-thing" })]);
    const toolScoped = toolScopedKeyAuth(["beta__get-thing"], "operator");

    const refused = await runSystemTool("sys_reset_circuit_breaker", { name: "beta" }, toolScoped);
    const ghost = await runSystemTool("sys_reset_circuit_breaker", { name: "ghost" }, toolScoped);
    expect(refused.isError).toBe(true);
    expect(sameWords(refused, "beta")).toBe(sameWords(ghost, "ghost"));

    expect((await runSystemTool("sys_reset_circuit_breaker", { name: "beta" }, envBearer())).isError).toBeUndefined();
  });
});

describe("sys_delete_client", () => {
  test("a scoped key cannot delete another client, and the client survives", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);
    await registerTestClient("beta", [makeTool({ name: "get-thing" })]);
    const scoped = scopedKeyAuth(["alpha"], "operator");

    const foreign = await runSystemTool("sys_delete_client", { name: "beta", __confirm: true }, scoped);
    const ghost = await runSystemTool("sys_delete_client", { name: "ghost", __confirm: true }, scoped);

    expect(foreign.isError).toBe(true);
    expect(textOf(foreign)).toBe("Client not found: beta");
    expect(sameWords(foreign, "beta")).toBe(sameWords(ghost, "ghost"));
    expect(registry.getClientDetail("beta")).toBeDefined();
    expect(listAuditLog({ limit: 10 }).items.map((i) => i.action)).not.toContain("client.delete");

    // Control: the same call, unrestricted, really does destroy it — which is
    // exactly what the scoped caller was one confirm away from doing.
    const unrestricted = await runSystemTool("sys_delete_client", { name: "beta", __confirm: true }, envBearer());
    expect(unrestricted.isError).toBeUndefined();
    expect(registry.getClientDetail("beta")).toBeUndefined();
  });
});

describe("sys_register_client", () => {
  test("a scoped key cannot register outside its scope, and the answer does not depend on the name existing", async () => {
    await registerTestClient("beta", [makeTool({ name: "get-thing" })]);
    const scoped = scopedKeyAuth(["alpha"], "operator");

    // A name that does not exist: nothing is created.
    const fresh = await runSystemTool("sys_register_client", { name: "gamma", __confirm: true }, scoped);
    expect(fresh.isError).toBe(true);
    expect(textOf(fresh)).toBe("Client 'gamma' is outside this credential's scope");
    expect(registry.getClientDetail("gamma")).toBeUndefined();

    // A name that DOES exist gets the identical answer — registration has no
    // collision check, so re-registering beta would have replaced it wholesale;
    // the refusal must not reveal which of the two names was real.
    const existing = await runSystemTool("sys_register_client", { name: "beta", __confirm: true }, scoped);
    expect(sameWords(existing, "beta")).toBe(sameWords(fresh, "gamma"));
    expect(registry.getClientDetail("beta")?.tools.map((t) => t.name)).toEqual(["get-thing"]);
  });

  test("the control half: a name INSIDE the key's scope gets past the gate to registration's own validation", async () => {
    const scoped = scopedKeyAuth(["alpha"], "operator");
    // No health_url, so performRestRegistration rejects it before touching the
    // network. A DIFFERENT message from the scope refusal is the whole point: it
    // proves the gate let this one through rather than refusing everything.
    const inScope = await runSystemTool("sys_register_client", { name: "alpha", __confirm: true }, scoped);
    expect(textOf(inScope)).toContain("Missing required fields: name, health_url");
    expect(textOf(inScope)).not.toContain("outside this credential's scope");
  });
});

describe("sys_list_clients / sys_list_tools — an enumeration is filtered, not refused", () => {
  test("sys_list_clients drops the rows the caller's key may not touch", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);
    await registerTestClient("beta", [makeTool({ name: "get-thing" })]);

    const all = await runSystemTool("sys_list_clients", {}, envBearer());
    expect(clientNames(all).sort()).toEqual(["alpha", "beta"]);

    const scoped = await runSystemTool("sys_list_clients", {}, scopedKeyAuth(["alpha"], "viewer"));
    expect(clientNames(scoped)).toEqual(["alpha"]);
  });

  test("sys_list_tools drops the pairs outside the key's scope, and a per-tool grant keeps its own pair", async () => {
    await registerTestClient("alpha", [makeTool({ name: "get-thing" })]);
    await registerTestClient("beta", [makeTool({ name: "get-thing" }), makeTool({ name: "put-thing" })]);

    const all = await runSystemTool("sys_list_tools", {}, envBearer());
    expect(toolPairs(all).sort()).toEqual(["alpha__get-thing", "beta__get-thing", "beta__put-thing"]);

    const clientScoped = await runSystemTool("sys_list_tools", {}, scopedKeyAuth(["alpha"], "viewer"));
    expect(toolPairs(clientScoped)).toEqual(["alpha__get-thing"]);

    // A `scopes.tools` grant is enough here (the row IS the pair) but not in
    // sys_list_clients above (a client row is a client-level fact) — the
    // asymmetry callerMayTouchClient documents, pinned so it stays deliberate.
    const toolScoped = toolScopedKeyAuth(["beta__get-thing"], "viewer");
    expect(toolPairs(await runSystemTool("sys_list_tools", {}, toolScoped))).toEqual(["beta__get-thing"]);
    expect(clientNames(await runSystemTool("sys_list_clients", {}, toolScoped))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The declaration itself
// ---------------------------------------------------------------------------

describe("the scope gate is structural, not per-handler discipline", () => {
  test("every sys_* tool declares a tenancy dimension — a new tool lands in this census first", () => {
    // This list is the point of the test: a tool added without thinking about
    // tenancy fails here, and the fix is to declare `scope` (the compiler
    // already demands the field; this demands that a human chose the value).
    // "none" and "handler" each carry a `why` string in the source — read it
    // before accepting one here.
    expect(systemToolScopeCensus()).toEqual([
      { name: "sys_list_clients", dimension: "handler" },
      { name: "sys_get_client", dimension: "client" },
      { name: "sys_list_tools", dimension: "handler" },
      { name: "sys_list_bundles", dimension: "none" },
      { name: "sys_list_keys", dimension: "none" },
      { name: "sys_metrics", dimension: "none" },
      { name: "sys_audit_tail", dimension: "none" },
      { name: "sys_diagnose", dimension: "tool" },
      { name: "sys_set_client_enabled", dimension: "client" },
      { name: "sys_set_tool_enabled", dimension: "tool" },
      { name: "sys_set_guard", dimension: "tool" },
      { name: "sys_reset_circuit_breaker", dimension: "client" },
      { name: "sys_register_client", dimension: "client" },
      { name: "sys_delete_client", dimension: "client" },
      { name: "sys_create_bundle", dimension: "handler" },
      { name: "sys_mint_key", dimension: "none" },
      { name: "sys_revoke_key", dimension: "none" },
    ]);
  });

  test("no tool that takes a `client` argument declares itself unscoped", () => {
    // The cheapest form the omission takes: a new tool copies a neighbour's
    // {client, tool} schema and leaves `scope` at the value that needs no
    // thought. The census above only catches an ADDED name; this catches a
    // wrong value on one that is already listed.
    const dimensionOf = new Map(systemToolScopeCensus().map((t) => [t.name, t.dimension]));
    for (const tool of listSystemTools("admin")) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      if ("client" in properties) {
        expect(dimensionOf.get(tool.name), `${tool.name} names a client but declares no scope`).not.toBe("none");
      }
    }
  });
});

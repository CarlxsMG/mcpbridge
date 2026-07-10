/**
 * Stryker mutation backstop for src/admin/config/config-io.ts — domain 9.
 *
 * exportConfig/importConfig are the core config-as-code serialization logic;
 * the HTTP layer (src/routes/config-io.ts) is already fully closed in domain 8
 * with its own mutation test. This file is the first (and only) test file for
 * the underlying business logic itself.
 *
 * Direct import + call against a real (in-memory) DB via __resetDbForTesting —
 * no Express harness; config-io.ts exports plain functions, no route
 * registration of its own. Neither exportConfig/importConfig nor any of their
 * transitive dependencies (bundles.ts, alerts.ts, guardrails.ts, consumers.ts)
 * call recordAudit, so no audit-module spy is needed here.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { __resetDbForTesting, getDb } from "../../../db/connection.js";
import { registry, ToolOverrideError } from "../../../mcp/registry.js";
import { createAlertRule, listAlertRules } from "../../../observability/alerts.js";
import { setGuardrails, getGuardrailsForClient } from "../../../tool-policies/guardrails.js";
import { createBundle, getBundleDetail } from "../../tool-composition/bundles.js";
import * as bundlesMod from "../../tool-composition/bundles.js";
import { createConsumer, getConsumerByName } from "../../entities/consumers.js";
import { CONFIG_EXPORT_VERSION, exportConfig, importConfig } from "../config-io.js";
import type { RestToolDefinition } from "../../../mcp/types.js";

function makeTool(name: string): RestToolDefinition {
  return {
    name,
    method: "GET",
    endpoint: `/${name}`,
    description: name,
    inputSchema: { type: "object", properties: {} },
  };
}

async function reg(name: string, toolNames: string[] = ["tool-a"]): Promise<void> {
  await registry.register(
    name,
    toolNames.map(makeTool),
    "http://1.2.3.4/health",
    "1.2.3.4",
    "http://1.2.3.4",
    "1.2.3.4",
  );
}

function baseDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: CONFIG_EXPORT_VERSION,
    exportedAt: Date.now(),
    bundles: [],
    alertRules: [],
    clients: [],
    guardrails: [],
    consumers: [],
    ...overrides,
  };
}

beforeEach(async () => {
  __resetDbForTesting();
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
});

// ---------------------------------------------------------------------------
// exportConfig
// ---------------------------------------------------------------------------

describe("exportConfig — envelope", () => {
  test("version is the module's CONFIG_EXPORT_VERSION constant and exportedAt is a fresh timestamp", () => {
    const before = Date.now();
    const doc = exportConfig();
    const after = Date.now();
    expect(doc.version).toBe(1);
    expect(doc.version).toBe(CONFIG_EXPORT_VERSION);
    expect(doc.exportedAt).toBeGreaterThanOrEqual(before);
    expect(doc.exportedAt).toBeLessThanOrEqual(after);
  });

  test("an empty database exports all-empty arrays, not undefined/null", () => {
    const doc = exportConfig();
    expect(doc.bundles).toEqual([]);
    expect(doc.alertRules).toEqual([]);
    expect(doc.clients).toEqual([]);
    expect(doc.guardrails).toEqual([]);
    expect(doc.consumers).toEqual([]);
  });
});

describe("exportConfig — bundles", () => {
  test("maps name/description/enabled/tools exactly for two distinct bundles", async () => {
    await reg("svc-a", ["get-a"]);
    await reg("svc-b", ["get-b"]);
    const r1 = await createBundle("bundle-one", "first bundle", [{ client: "svc-a", tool: "get-a" }], "alice");
    const r2 = await createBundle("bundle-two", undefined, [{ client: "svc-b", tool: "get-b" }], "bob");
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const doc = exportConfig();
    expect(doc.bundles).toHaveLength(2);
    const one = doc.bundles.find((b) => b.name === "bundle-one");
    const two = doc.bundles.find((b) => b.name === "bundle-two");
    expect(one).toEqual({
      name: "bundle-one",
      description: "first bundle",
      enabled: true,
      tools: [{ client: "svc-a", tool: "get-a" }],
    });
    expect(two).toEqual({
      name: "bundle-two",
      description: null,
      enabled: true,
      tools: [{ client: "svc-b", tool: "get-b" }],
    });
  });

  test("a bundle for which getBundleDetail returns undefined is dropped by the filter (not crashed on, not left as a hole)", async () => {
    // listBundles() and getBundleDetail() both read the same mcp_bundles
    // table, so in ordinary operation they can never disagree — this branch
    // is unreachable through real DB state alone. Verified empirically via
    // spyOn instead of asserting from reasoning alone: forcing a mismatch for
    // exactly one bundle name proves the `.filter(b => b != null)` step
    // actually runs (a "keep everything" or "drop the filter" mutant would
    // leave `undefined` in the array, which the following `.map` step would
    // then crash on when it reads `b.name`).
    await createBundle("real-bundle", "d", [], "seed");
    await createBundle("ghost-bundle", "d", [], "seed");
    const original = getBundleDetail;
    const spy = spyOn(bundlesMod, "getBundleDetail").mockImplementation((name: string) =>
      name === "ghost-bundle" ? undefined : original(name),
    );
    try {
      const doc = exportConfig();
      expect(doc.bundles.map((b) => b.name)).toEqual(["real-bundle"]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("exportConfig — alertRules", () => {
  test("maps every field exactly, including null threshold/minCalls", async () => {
    createAlertRule({
      name: "rule-1",
      eventType: "circuit_breaker_open",
      webhookUrl: "https://example.com/hook",
      actor: "alice",
    });
    createAlertRule({
      name: "rule-2",
      eventType: "error_rate",
      webhookUrl: "https://example.com/hook2",
      threshold: 0.75,
      minCalls: 25,
      actor: "bob",
    });

    const doc = exportConfig();
    expect(doc.alertRules).toHaveLength(2);
    const r1 = doc.alertRules.find((r) => r.name === "rule-1");
    const r2 = doc.alertRules.find((r) => r.name === "rule-2");
    expect(r1).toEqual({
      name: "rule-1",
      eventType: "circuit_breaker_open",
      enabled: true,
      webhookUrl: "https://example.com/hook",
      threshold: null,
      minCalls: null,
    });
    expect(r2).toEqual({
      name: "rule-2",
      eventType: "error_rate",
      enabled: true,
      webhookUrl: "https://example.com/hook2",
      threshold: 0.75,
      minCalls: 25,
    });
  });
});

describe("exportConfig — clients + guards + tools + guardrails", () => {
  test("exports a client with no guards as guards:null, and its tool guards/override exactly", async () => {
    await reg("plain-client", ["get-x"]);

    const doc = exportConfig();
    const client = doc.clients.find((c) => c.name === "plain-client");
    expect(client).toBeDefined();
    expect(client?.guards).toBeNull();
    expect(client?.enabled).toBe(true);
    expect(client?.tools).toEqual([{ name: "get-x", enabled: true, guards: null, override: null }]);
  });

  test("exports a client's guards/tool guards/tool override when set (not omitted, not defaulted)", async () => {
    await reg("guarded-client", ["get-y"]);
    await registry.setClientGuards("guarded-client", { circuitBreaker: { failureThreshold: 3 } });
    await registry.setToolGuards("guarded-client", "get-y", { rateLimitPerMin: 5 });
    await registry.setToolOverride("guarded-client", "get-y", { description: "custom desc" });

    const doc = exportConfig();
    const client = doc.clients.find((c) => c.name === "guarded-client");
    expect(client?.guards).toEqual({ circuitBreaker: { failureThreshold: 3 } });
    const tool = client?.tools.find((t) => t.name === "get-y");
    expect(tool?.guards).toEqual({ rateLimitPerMin: 5 });
    expect(tool?.override).toEqual({ description: "custom desc" });
  });

  test("guardrails are collected per (client, tool) across two distinct clients, keyed correctly", async () => {
    await reg("gr-client-a", ["tool-a"]);
    await reg("gr-client-b", ["tool-b"]);
    expect(
      setGuardrails("gr-client-a", "tool-a", { denyPatterns: ["secret"], blockSecrets: true, scanResponses: false }),
    ).toBe(true);
    expect(setGuardrails("gr-client-b", "tool-b", { denyPatterns: [], blockSecrets: false, scanResponses: true })).toBe(
      true,
    );

    const doc = exportConfig();
    expect(doc.guardrails).toHaveLength(2);
    const a = doc.guardrails.find((g) => g.client === "gr-client-a");
    const b = doc.guardrails.find((g) => g.client === "gr-client-b");
    expect(a).toEqual({
      client: "gr-client-a",
      tool: "tool-a",
      guardrails: { denyPatterns: ["secret"], blockSecrets: true, scanResponses: false },
    });
    expect(b).toEqual({
      client: "gr-client-b",
      tool: "tool-b",
      guardrails: { denyPatterns: [], blockSecrets: false, scanResponses: true },
    });
  });

  test("a client for which registry.getClientDetail returns undefined is skipped entirely (name, tools, AND its guardrails)", async () => {
    // registry.getClientDetail(name) is queried per name pulled from `SELECT
    // name FROM clients`; in ordinary operation the two can never disagree
    // (same table), so this branch is unreachable through normal DB state.
    // Verified empirically here via spyOn instead of asserting from reasoning
    // alone: real behavior for every OTHER client is unaffected, and the
    // skipped client's own guardrails (which would otherwise still be
    // collected if the `continue` didn't also skip the getGuardrailsForClient
    // call) never appear in the export.
    await reg("kept-client", ["tool-a"]);
    await reg("skipped-client", ["tool-b"]);
    expect(
      setGuardrails("skipped-client", "tool-b", { denyPatterns: ["x"], blockSecrets: false, scanResponses: false }),
    ).toBe(true);

    const original = registry.getClientDetail.bind(registry);
    const spy = spyOn(registry, "getClientDetail").mockImplementation((name: string) => {
      if (name === "skipped-client") return undefined;
      return original(name);
    });
    try {
      const doc = exportConfig();
      expect(doc.clients.map((c) => c.name)).toEqual(["kept-client"]);
      expect(doc.guardrails).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("exportConfig — consumers", () => {
  test("maps name/monthlyQuota/endUserRateLimitPerMin exactly for two distinct consumers", () => {
    createConsumer({ name: "acme", monthlyQuota: 1000, endUserRateLimitPerMin: 5, actor: "alice" });
    createConsumer({ name: "beta", monthlyQuota: null, endUserRateLimitPerMin: null, actor: "bob" });

    const doc = exportConfig();
    expect(doc.consumers).toHaveLength(2);
    expect(doc.consumers.find((c) => c.name === "acme")).toEqual({
      name: "acme",
      monthlyQuota: 1000,
      endUserRateLimitPerMin: 5,
    });
    expect(doc.consumers.find((c) => c.name === "beta")).toEqual({
      name: "beta",
      monthlyQuota: null,
      endUserRateLimitPerMin: null,
    });
  });
});

// ---------------------------------------------------------------------------
// importConfig — envelope validation
// ---------------------------------------------------------------------------

describe("importConfig — envelope validation", () => {
  test("rejects a non-object body (string)", async () => {
    await expect(importConfig("not an object", { dryRun: true }, null)).rejects.toThrow(
      "import body must be an object",
    );
  });

  test("rejects a non-object body (number)", async () => {
    await expect(importConfig(42, { dryRun: true }, null)).rejects.toThrow("import body must be an object");
  });

  test("rejects a null body", async () => {
    await expect(importConfig(null, { dryRun: true }, null)).rejects.toThrow("import body must be an object");
  });

  test("rejects undefined", async () => {
    await expect(importConfig(undefined, { dryRun: true }, null)).rejects.toThrow("import body must be an object");
  });

  test("rejects a mismatched version with the exact message, including the actual and expected numbers", async () => {
    await expect(importConfig(baseDoc({ version: 2 }), { dryRun: true }, null)).rejects.toThrow(
      "unsupported export version: 2 (expected 1)",
    );
  });

  test("rejects a missing version (undefined) with 'undefined' spelled out in the message", async () => {
    const doc = baseDoc();
    delete (doc as { version?: number }).version;
    await expect(importConfig(doc, { dryRun: true }, null)).rejects.toThrow(
      "unsupported export version: undefined (expected 1)",
    );
  });

  test("an array body passes the object/null guard but still fails the version check", async () => {
    await expect(importConfig([], { dryRun: true }, null)).rejects.toThrow("unsupported export version");
  });

  test("a minimal valid doc (only version) applies/skips nothing and doesn't throw", async () => {
    const result = await importConfig(baseDoc(), { dryRun: false }, null);
    expect(result).toEqual({
      dryRun: false,
      applied: { bundles: 0, alertRules: 0, clientsConfigured: 0, toolsConfigured: 0, guardrails: 0, consumers: 0 },
      skipped: [],
    });
  });

  test("non-array values for the entity keys are treated as empty (asArray guard), not a crash", async () => {
    const result = await importConfig(
      baseDoc({
        bundles: null,
        alertRules: "oops",
        clients: 5,
        guardrails: undefined,
        consumers: {},
      }),
      { dryRun: false },
      null,
    );
    expect(result.applied).toEqual({
      bundles: 0,
      alertRules: 0,
      clientsConfigured: 0,
      toolsConfigured: 0,
      guardrails: 0,
      consumers: 0,
    });
    expect(result.skipped).toEqual([]);
  });

  test("echoes the exact dryRun option back on the result, for both true and false", async () => {
    const r1 = await importConfig(baseDoc(), { dryRun: true }, null);
    expect(r1.dryRun).toBe(true);
    const r2 = await importConfig(baseDoc(), { dryRun: false }, null);
    expect(r2.dryRun).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// importConfig — alert rules
// ---------------------------------------------------------------------------

describe("importConfig — alert rules", () => {
  test("skips (does not duplicate) a rule whose name already exists, with reason 'already exists'", async () => {
    createAlertRule({ name: "dup-rule", eventType: "usage_spike", webhookUrl: "https://x", actor: "seed" });

    const result = await importConfig(
      baseDoc({
        alertRules: [
          {
            name: "dup-rule",
            eventType: "usage_spike",
            enabled: true,
            webhookUrl: "https://y",
            threshold: null,
            minCalls: null,
          },
        ],
      }),
      { dryRun: false },
      "actor-1",
    );

    expect(result.applied.alertRules).toBe(0);
    expect(result.skipped).toEqual([{ type: "alert", id: "dup-rule", reason: "already exists" }]);
    // Not overwritten — the original webhook URL is untouched.
    expect(listAlertRules().find((r) => r.name === "dup-rule")?.webhookUrl).toBe("https://x");
  });

  test("dryRun:true counts a new rule as applied but does not persist it", async () => {
    const result = await importConfig(
      baseDoc({
        alertRules: [
          {
            name: "plan-only",
            eventType: "schema_drift",
            enabled: true,
            webhookUrl: "https://plan",
            threshold: null,
            minCalls: null,
          },
        ],
      }),
      { dryRun: true },
      "actor-1",
    );
    expect(result.applied.alertRules).toBe(1);
    expect(listAlertRules().find((r) => r.name === "plan-only")).toBeUndefined();
  });

  test("dryRun:false actually creates the rule with exact fields, defaulting undefined threshold/minCalls to null, and forwards actor", async () => {
    const result = await importConfig(
      baseDoc({
        alertRules: [
          {
            name: "real-rule",
            eventType: "client_unreachable",
            enabled: true,
            webhookUrl: "https://real",
            threshold: null,
            minCalls: null,
          },
        ],
      }),
      { dryRun: false },
      "importer-actor",
    );
    expect(result.applied.alertRules).toBe(1);
    const created = listAlertRules().find((r) => r.name === "real-rule");
    expect(created).toBeDefined();
    expect(created?.eventType).toBe("client_unreachable");
    expect(created?.webhookUrl).toBe("https://real");
    expect(created?.threshold).toBeNull();
    expect(created?.minCalls).toBeNull();
    expect(created?.createdBy).toBe("importer-actor");
  });

  test("threshold/minCalls values (not just null) round-trip through the ?? null fallback unchanged", async () => {
    await importConfig(
      baseDoc({
        alertRules: [
          {
            name: "with-values",
            eventType: "error_rate",
            enabled: true,
            webhookUrl: "https://v",
            threshold: 0.9,
            minCalls: 50,
          },
        ],
      }),
      { dryRun: false },
      null,
    );
    const created = listAlertRules().find((r) => r.name === "with-values");
    expect(created?.threshold).toBe(0.9);
    expect(created?.minCalls).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// importConfig — bundles
// ---------------------------------------------------------------------------

describe("importConfig — bundles", () => {
  test("skips a bundle referencing unknown tools, with an exact count in the reason", async () => {
    await reg("bsvc", ["known-tool"]);
    const result = await importConfig(
      baseDoc({
        bundles: [
          {
            name: "bad-bundle",
            description: null,
            enabled: true,
            tools: [
              { client: "bsvc", tool: "unknown-1" },
              { client: "bsvc", tool: "unknown-2" },
            ],
          },
        ],
      }),
      { dryRun: false },
      null,
    );
    expect(result.applied.bundles).toBe(0);
    expect(result.skipped).toEqual([{ type: "bundle", id: "bad-bundle", reason: "2 unknown tool(s)" }]);
    expect(getBundleDetail("bad-bundle")).toBeUndefined();
  });

  test("a bundle with an explicit empty tools array has zero missing tools and is applied, not skipped", async () => {
    const result = await importConfig(
      baseDoc({
        bundles: [{ name: "empty-bundle", description: "no tools", enabled: true, tools: [] }],
      }),
      { dryRun: false },
      "import",
    );
    expect(result.applied.bundles).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(getBundleDetail("empty-bundle")?.tools).toEqual([]);
  });

  test("a bundle whose 'tools' key is entirely absent (undefined) currently throws — a pre-existing gap, pinned here rather than papered over", async () => {
    // `(b.tools ?? []).filter(...)` (the missing-tools check) correctly
    // treats an absent `tools` key as empty (so it's never skipped for
    // "unknown tools"), but createBundle/updateBundle are then called with
    // the raw `b.tools` — no `?? []` fallback at THAT call site — which
    // crashes inside dedupeToolRefs's `for (const t of tools)` over
    // undefined. Verified empirically (not asserted from reasoning alone):
    // hand-applying the mutant's replacement array
    // (`b.tools ?? ["Stryker was here"]`) to a scratch copy of the source
    // and re-running an equivalent probe showed the mutated code does NOT
    // throw here (the bogus one-element array fails the tool-existence
    // check instead, producing a graceful "1 unknown tool(s)" skip) — so
    // this exact "expect a throw" assertion is what distinguishes real vs.
    // mutated behavior for that array-literal mutant. Out of scope to fix
    // the underlying source gap in a mutation-testing-only pass.
    await expect(
      importConfig(
        baseDoc({ bundles: [{ name: "crash-bundle", description: null, enabled: true, tools: undefined }] }),
        { dryRun: false },
        null,
      ),
    ).rejects.toThrow();
  });

  test("dryRun:true plans a new bundle (applied count) without creating it", async () => {
    await reg("bsvc2", ["t1"]);
    const result = await importConfig(
      baseDoc({
        bundles: [{ name: "plan-bundle", description: null, enabled: true, tools: [{ client: "bsvc2", tool: "t1" }] }],
      }),
      { dryRun: true },
      null,
    );
    expect(result.applied.bundles).toBe(1);
    expect(getBundleDetail("plan-bundle")).toBeUndefined();
  });

  test("creates a brand-new bundle (dryRun:false) with description ?? undefined and actor ?? 'import' when actor is null", async () => {
    await reg("bsvc3", ["t1"]);
    const result = await importConfig(
      baseDoc({
        bundles: [{ name: "new-bundle", description: null, enabled: true, tools: [{ client: "bsvc3", tool: "t1" }] }],
      }),
      { dryRun: false },
      null,
    );
    expect(result.applied.bundles).toBe(1);
    const detail = getBundleDetail("new-bundle");
    expect(detail).toBeDefined();
    expect(detail?.tools).toEqual([{ client: "bsvc3", tool: "t1" }]);
    // created_by is stamped from the "import" fallback, not left null, when actor is null.
    const row = getDb().query(`SELECT created_by FROM mcp_bundles WHERE name = ?`).get("new-bundle") as {
      created_by: string | null;
    };
    expect(row.created_by).toBe("import");
  });

  test("creates a brand-new bundle with a genuinely truthy description forwarded through verbatim (not swallowed to undefined/null)", async () => {
    // A null-description fixture can't distinguish `description ?? undefined`
    // from a broken `description && undefined`: both null and undefined
    // collapse to the same stored `null` once createBundle's own
    // `description ?? null` runs. Only a truthy string tells them apart —
    // `??` passes it through untouched, `&&` would discard it for `undefined`.
    await reg("bsvc3b", ["t1"]);
    const result = await importConfig(
      baseDoc({
        bundles: [
          {
            name: "truthy-desc-bundle",
            description: "a real description",
            enabled: true,
            tools: [{ client: "bsvc3b", tool: "t1" }],
          },
        ],
      }),
      { dryRun: false },
      "actor",
    );
    expect(result.applied.bundles).toBe(1);
    expect(getBundleDetail("truthy-desc-bundle")?.description).toBe("a real description");
  });

  test("updates an already-existing bundle (matched by name) instead of erroring, applying the new description/enabled/tools", async () => {
    await reg("bsvc4", ["t1", "t2"]);
    const created = await createBundle("existing-bundle", "old desc", [{ client: "bsvc4", tool: "t1" }], "seed");
    expect(created.ok).toBe(true);

    const result = await importConfig(
      baseDoc({
        bundles: [
          {
            name: "existing-bundle",
            description: "new desc",
            enabled: false,
            tools: [{ client: "bsvc4", tool: "t2" }],
          },
        ],
      }),
      { dryRun: false },
      "updater",
    );
    expect(result.applied.bundles).toBe(1);
    expect(result.skipped).toEqual([]);
    const detail = getBundleDetail("existing-bundle");
    expect(detail?.description).toBe("new desc");
    expect(detail?.enabled).toBe(false);
    expect(detail?.tools).toEqual([{ client: "bsvc4", tool: "t2" }]);
  });
});

// ---------------------------------------------------------------------------
// importConfig — clients + tools
// ---------------------------------------------------------------------------

describe("importConfig — clients", () => {
  test("skips a client that isn't registered, with reason 'not registered', and never touches its tools", async () => {
    const result = await importConfig(
      baseDoc({
        clients: [
          {
            name: "ghost-client",
            enabled: false,
            guards: null,
            tools: [{ name: "whatever", enabled: false, guards: null, override: null }],
          },
        ],
      }),
      { dryRun: false },
      null,
    );
    expect(result.applied.clientsConfigured).toBe(0);
    expect(result.applied.toolsConfigured).toBe(0);
    expect(result.skipped).toEqual([{ type: "client", id: "ghost-client", reason: "not registered" }]);
  });

  test("dryRun:true still increments clientsConfigured (a plan), but never actually calls setClientEnabled/setClientGuards", async () => {
    await reg("plan-client", ["tool-a"]);
    // Force-disable so we can assert dryRun truly left it unchanged after import.
    const result = await importConfig(
      baseDoc({
        clients: [{ name: "plan-client", enabled: false, guards: { extra: { note: "x" } }, tools: [] }],
      }),
      { dryRun: true },
      null,
    );
    expect(result.applied.clientsConfigured).toBe(1);
    const detail = registry.getClientDetail("plan-client");
    expect(detail?.enabled).toBe(true); // untouched — still the original register() default
    expect(detail?.guards).toBeUndefined();
  });

  test("dryRun:false applies client enabled + guards exactly as given", async () => {
    await reg("apply-client", ["tool-a"]);
    const result = await importConfig(
      baseDoc({
        clients: [
          {
            name: "apply-client",
            enabled: false,
            guards: { circuitBreaker: { failureThreshold: 9 } },
            tools: [],
          },
        ],
      }),
      { dryRun: false },
      null,
    );
    expect(result.applied.clientsConfigured).toBe(1);
    const detail = registry.getClientDetail("apply-client");
    expect(detail?.enabled).toBe(false);
    expect(detail?.guards).toEqual({ circuitBreaker: { failureThreshold: 9 } });
  });

  test("guards:null on the exported doc clears an existing client guard config", async () => {
    await reg("clear-client", ["tool-a"]);
    await registry.setClientGuards("clear-client", { circuitBreaker: { failureThreshold: 2 } });
    expect(registry.getClientDetail("clear-client")?.guards).toBeDefined();

    await importConfig(
      baseDoc({ clients: [{ name: "clear-client", enabled: true, guards: null, tools: [] }] }),
      { dryRun: false },
      null,
    );
    expect(registry.getClientDetail("clear-client")?.guards).toBeUndefined();
  });

  test("a client whose 'tools' key is entirely absent (?? []) is configured without throwing, and iterates zero (not fabricated) tools", async () => {
    await reg("no-tools-key", ["tool-a"]);
    const doc = baseDoc({
      clients: [{ name: "no-tools-key", enabled: true, guards: null, tools: undefined }],
    });
    const result = await importConfig(doc, { dryRun: false }, null);
    expect(result.applied.clientsConfigured).toBe(1);
    expect(result.applied.toolsConfigured).toBe(0);
    // A "keep a placeholder element" mutant on the `?? []` fallback would
    // still leave toolsConfigured at 0 (the bogus element fails the
    // tool-existence check rather than getting applied) but would leak a
    // spurious skip entry — this is the assertion that actually tells them
    // apart.
    expect(result.skipped).toEqual([]);
  });
});

describe("importConfig — per-client tools", () => {
  test("skips a tool that isn't found on the client, with id '<client>__<tool>' and reason 'not found'", async () => {
    await reg("tsvc", ["real-tool"]);
    const result = await importConfig(
      baseDoc({
        clients: [
          {
            name: "tsvc",
            enabled: true,
            guards: null,
            tools: [{ name: "fake-tool", enabled: true, guards: null, override: null }],
          },
        ],
      }),
      { dryRun: false },
      null,
    );
    expect(result.applied.toolsConfigured).toBe(0);
    expect(result.skipped).toEqual([{ type: "tool", id: "tsvc__fake-tool", reason: "not found" }]);
  });

  test("applies enabled + guards for two distinct known tools on the same client", async () => {
    await reg("multi-tool-svc", ["tool-a", "tool-b"]);
    const result = await importConfig(
      baseDoc({
        clients: [
          {
            name: "multi-tool-svc",
            enabled: true,
            guards: null,
            tools: [
              { name: "tool-a", enabled: false, guards: { rateLimitPerMin: 1 }, override: null },
              { name: "tool-b", enabled: true, guards: null, override: null },
            ],
          },
        ],
      }),
      { dryRun: false },
      null,
    );
    expect(result.applied.toolsConfigured).toBe(2);
    const detail = registry.getClientDetail("multi-tool-svc");
    const toolA = detail?.tools.find((t) => t.name === "tool-a");
    const toolB = detail?.tools.find((t) => t.name === "tool-b");
    expect(toolA?.enabled).toBe(false);
    expect(toolA?.guards).toEqual({ rateLimitPerMin: 1 });
    expect(toolB?.enabled).toBe(true);
    expect(toolB?.guards).toBeUndefined();
  });

  test("dryRun:true increments toolsConfigured for a known tool but never calls into the registry (per-tool !dryRun gate is independent of the client-level one)", async () => {
    await reg("dry-tool-svc", ["tool-a"]);
    const result = await importConfig(
      baseDoc({
        clients: [
          {
            name: "dry-tool-svc",
            enabled: true,
            guards: null,
            tools: [
              { name: "tool-a", enabled: false, guards: { rateLimitPerMin: 99 }, override: { description: "x" } },
            ],
          },
        ],
      }),
      { dryRun: true },
      null,
    );
    expect(result.applied.toolsConfigured).toBe(1);
    expect(result.skipped).toEqual([]);
    const tool = registry.getClientDetail("dry-tool-svc")?.tools.find((t) => t.name === "tool-a");
    expect(tool?.enabled).toBe(true); // unchanged — register() default
    expect(tool?.guards).toBeUndefined();
    expect(tool?.override).toBeUndefined();
  });

  test("a ToolOverrideError from setToolOverride is caught, skipped with 'override: <message>', and the tool still counts as configured", async () => {
    await reg("override-err-svc", ["tool-a", "tool-b"]);
    // tool-b's real name becomes unavailable as an alias target for tool-a
    // once tool-b itself keeps its own name — asserting a displayName equal
    // to another real tool's name collides (isAliasAvailable -> false),
    // which setToolOverride turns into a TOOL_ALIAS_CONFLICT ToolOverrideError.
    const result = await importConfig(
      baseDoc({
        clients: [
          {
            name: "override-err-svc",
            enabled: true,
            guards: null,
            tools: [{ name: "tool-a", enabled: true, guards: null, override: { displayName: "tool-b" } }],
          },
        ],
      }),
      { dryRun: false },
      null,
    );
    expect(result.applied.toolsConfigured).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.type).toBe("tool");
    expect(result.skipped[0]?.id).toBe("override-err-svc__tool-a");
    expect(result.skipped[0]?.reason).toContain("override:");
    expect(result.skipped[0]?.reason).toContain("collides with another tool");
  });

  test("a non-ToolOverrideError thrown by setToolOverride propagates (is NOT swallowed)", async () => {
    await reg("rethrow-svc", ["tool-a"]);
    const spy = spyOn(registry, "setToolOverride").mockImplementation(() => {
      throw new Error("boom - not a ToolOverrideError");
    });
    try {
      await expect(
        importConfig(
          baseDoc({
            clients: [
              {
                name: "rethrow-svc",
                enabled: true,
                guards: null,
                tools: [{ name: "tool-a", enabled: true, guards: null, override: { description: "x" } }],
              },
            ],
          }),
          { dryRun: false },
          null,
        ),
      ).rejects.toThrow("boom - not a ToolOverrideError");
    } finally {
      spy.mockRestore();
    }
  });

  test("applies a valid tool override successfully (happy path, no error)", async () => {
    await reg("override-ok-svc", ["tool-a"]);
    const result = await importConfig(
      baseDoc({
        clients: [
          {
            name: "override-ok-svc",
            enabled: true,
            guards: null,
            tools: [{ name: "tool-a", enabled: true, guards: null, override: { description: "shiny new desc" } }],
          },
        ],
      }),
      { dryRun: false },
      null,
    );
    expect(result.applied.toolsConfigured).toBe(1);
    expect(result.skipped).toEqual([]);
    const detail = registry.getClientDetail("override-ok-svc");
    expect(detail?.tools.find((t) => t.name === "tool-a")?.override?.description).toBe("shiny new desc");
  });

  test("sanity: ToolOverrideError is importable and is an actual Error subclass (import wiring check)", () => {
    const err = new ToolOverrideError("TOOL_ALIAS_INVALID", "bad alias");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("TOOL_ALIAS_INVALID");
  });
});

// ---------------------------------------------------------------------------
// importConfig — guardrails
// ---------------------------------------------------------------------------

describe("importConfig — guardrails", () => {
  test("skips a guardrail for an unknown tool, with id '<client>__<tool>' and reason 'tool not found'", async () => {
    await reg("gsvc", ["real-tool"]);
    const result = await importConfig(
      baseDoc({
        guardrails: [
          {
            client: "gsvc",
            tool: "missing-tool",
            guardrails: { denyPatterns: [], blockSecrets: true, scanResponses: false },
          },
        ],
      }),
      { dryRun: false },
      null,
    );
    expect(result.applied.guardrails).toBe(0);
    expect(result.skipped).toEqual([{ type: "guardrail", id: "gsvc__missing-tool", reason: "tool not found" }]);
  });

  test("dryRun:true counts a guardrail as applied without persisting it", async () => {
    await reg("gsvc2", ["real-tool"]);
    const result = await importConfig(
      baseDoc({
        guardrails: [
          {
            client: "gsvc2",
            tool: "real-tool",
            guardrails: { denyPatterns: ["x"], blockSecrets: false, scanResponses: false },
          },
        ],
      }),
      { dryRun: true },
      null,
    );
    expect(result.applied.guardrails).toBe(1);
    expect(getGuardrailsForClient("gsvc2")).toEqual({});
  });

  test("dryRun:false actually persists the guardrail config for a known tool", async () => {
    await reg("gsvc3", ["real-tool"]);
    const result = await importConfig(
      baseDoc({
        guardrails: [
          {
            client: "gsvc3",
            tool: "real-tool",
            guardrails: { denyPatterns: ["nope"], blockSecrets: true, scanResponses: true },
          },
        ],
      }),
      { dryRun: false },
      null,
    );
    expect(result.applied.guardrails).toBe(1);
    expect(getGuardrailsForClient("gsvc3")).toEqual({
      "real-tool": { denyPatterns: ["nope"], blockSecrets: true, scanResponses: true },
    });
  });
});

// ---------------------------------------------------------------------------
// importConfig — consumers
// ---------------------------------------------------------------------------

describe("importConfig — consumers", () => {
  test("valid values: a positive integer and null are both accepted (not skipped)", async () => {
    const result = await importConfig(
      baseDoc({
        consumers: [
          { name: "valid-quota", monthlyQuota: 100, endUserRateLimitPerMin: 10 },
          { name: "valid-null", monthlyQuota: null, endUserRateLimitPerMin: null },
        ],
      }),
      { dryRun: false },
      null,
    );
    expect(result.applied.consumers).toBe(2);
    expect(result.skipped).toEqual([]);
  });

  test("rejects monthlyQuota of 0 (falsy-but-defined boundary) with the exact reason string", async () => {
    const result = await importConfig(
      baseDoc({ consumers: [{ name: "zero-quota", monthlyQuota: 0, endUserRateLimitPerMin: null }] }),
      { dryRun: false },
      null,
    );
    expect(result.applied.consumers).toBe(0);
    expect(result.skipped).toEqual([
      {
        type: "consumer",
        id: "zero-quota",
        reason: "monthlyQuota/endUserRateLimitPerMin must be a positive integer or null",
      },
    ]);
  });

  test("rejects a negative monthlyQuota", async () => {
    const result = await importConfig(
      baseDoc({ consumers: [{ name: "neg-quota", monthlyQuota: -1, endUserRateLimitPerMin: null }] }),
      { dryRun: false },
      null,
    );
    expect(result.skipped[0]?.id).toBe("neg-quota");
  });

  test("rejects a non-integer monthlyQuota", async () => {
    const result = await importConfig(
      baseDoc({ consumers: [{ name: "frac-quota", monthlyQuota: 1.5, endUserRateLimitPerMin: null }] }),
      { dryRun: false },
      null,
    );
    expect(result.skipped[0]?.id).toBe("frac-quota");
  });

  test("rejects a wrong-typed-but-truthy endUserRateLimitPerMin (string, not number)", async () => {
    const result = await importConfig(
      baseDoc({
        consumers: [{ name: "string-rate", monthlyQuota: null, endUserRateLimitPerMin: "10" }],
      }),
      { dryRun: false },
      null,
    );
    expect(result.skipped[0]?.id).toBe("string-rate");
    expect(getConsumerByName("string-rate")).toBeNull();
  });

  test("dryRun:true counts a valid new consumer as applied without creating it", async () => {
    const result = await importConfig(
      baseDoc({ consumers: [{ name: "plan-consumer", monthlyQuota: 50, endUserRateLimitPerMin: null }] }),
      { dryRun: true },
      null,
    );
    expect(result.applied.consumers).toBe(1);
    expect(getConsumerByName("plan-consumer")).toBeNull();
  });

  test("creates a brand-new consumer (dryRun:false) with the exact fields and forwarded actor", async () => {
    const result = await importConfig(
      baseDoc({ consumers: [{ name: "new-consumer", monthlyQuota: 250, endUserRateLimitPerMin: 3 }] }),
      { dryRun: false },
      "consumer-actor",
    );
    expect(result.applied.consumers).toBe(1);
    const created = getConsumerByName("new-consumer");
    expect(created).not.toBeNull();
    expect(created?.monthlyQuota).toBe(250);
    expect(created?.endUserRateLimitPerMin).toBe(3);
    expect(created?.createdBy).toBe("consumer-actor");
  });

  test("updates an already-existing consumer (matched by name) instead of creating a duplicate", async () => {
    const seeded = createConsumer({
      name: "existing-consumer",
      monthlyQuota: 10,
      endUserRateLimitPerMin: 1,
      actor: "seed",
    });
    const result = await importConfig(
      baseDoc({ consumers: [{ name: "existing-consumer", monthlyQuota: 999, endUserRateLimitPerMin: 42 }] }),
      { dryRun: false },
      "updater",
    );
    expect(result.applied.consumers).toBe(1);
    const updated = getConsumerByName("existing-consumer");
    expect(updated?.id).toBe(seeded.id);
    expect(updated?.monthlyQuota).toBe(999);
    expect(updated?.endUserRateLimitPerMin).toBe(42);
    // updateConsumer never touches created_by — still the original seeder.
    expect(updated?.createdBy).toBe("seed");
  });

  test("updating an existing consumer with monthlyQuota/endUserRateLimitPerMin omitted (undefined) falls back to null via ?? null", async () => {
    createConsumer({ name: "reset-consumer", monthlyQuota: 10, endUserRateLimitPerMin: 1, actor: "seed" });
    await importConfig(
      baseDoc({
        consumers: [{ name: "reset-consumer", monthlyQuota: undefined, endUserRateLimitPerMin: undefined }],
      }),
      { dryRun: false },
      null,
    );
    const updated = getConsumerByName("reset-consumer");
    expect(updated?.monthlyQuota).toBeNull();
    expect(updated?.endUserRateLimitPerMin).toBeNull();
  });

  test("creating a brand-new consumer with monthlyQuota/endUserRateLimitPerMin entirely omitted (undefined, valid) defaults both to null", async () => {
    const result = await importConfig(
      baseDoc({
        consumers: [{ name: "omitted-new-consumer", monthlyQuota: undefined, endUserRateLimitPerMin: undefined }],
      }),
      { dryRun: false },
      null,
    );
    expect(result.applied.consumers).toBe(1);
    expect(result.skipped).toEqual([]);
    const created = getConsumerByName("omitted-new-consumer");
    expect(created?.monthlyQuota).toBeNull();
    expect(created?.endUserRateLimitPerMin).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe("exportConfig -> importConfig round trip", () => {
  test("re-importing an unmodified export against the same live state applies everything with zero skips", async () => {
    await reg("rt-client", ["rt-tool"]);
    await registry.setToolGuards("rt-client", "rt-tool", { rateLimitPerMin: 7 });
    createAlertRule({ name: "rt-rule", eventType: "usage_spike", webhookUrl: "https://rt", actor: "seed" });
    await createBundle("rt-bundle", "rt", [{ client: "rt-client", tool: "rt-tool" }], "seed");
    setGuardrails("rt-client", "rt-tool", { denyPatterns: ["x"], blockSecrets: false, scanResponses: false });
    createConsumer({ name: "rt-consumer", monthlyQuota: 5, endUserRateLimitPerMin: null, actor: "seed" });

    const exported = exportConfig();
    const result = await importConfig(exported, { dryRun: false }, "reimport-actor");

    // Everything either "already exists" (alert/bundle) or gets re-applied
    // (client/tool/guardrail/consumer) — none of it should be reported as a
    // hard failure/crash, and nothing here should hit an "unknown" skip path.
    expect(result.skipped.every((s) => s.reason === "already exists")).toBe(true);
    expect(result.applied.clientsConfigured).toBe(1);
    expect(result.applied.toolsConfigured).toBe(1);
    expect(result.applied.guardrails).toBe(1);
    expect(result.applied.consumers).toBe(1);
  });
});

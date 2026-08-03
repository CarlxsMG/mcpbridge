/**
 * Config export/import: snapshot fidelity, dry-run safety, promotion round-trip.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { clearRegistry } from "./_utils/registry.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { createBundle, getBundleDetail } from "../admin/tool-composition/bundles.js";
import { createAlertRule, listAlertRules } from "../observability/alerts.js";
import { exportConfig, importConfig } from "../admin/config/config-io.js";
import { getGuardrails, setGuardrails } from "../tool-policies/guardrails.js";
import { listConsumers, createConsumer } from "../admin/entities/consumers.js";
import type { RestToolDefinition } from "../mcp/types.js";

function makeTool(name = "get-users"): RestToolDefinition {
  return {
    name,
    method: "GET",
    endpoint: "/users",
    description: "list",
    inputSchema: { type: "object", properties: {} },
  };
}
async function reg(name = "svc", tools: RestToolDefinition[] = [makeTool()]): Promise<void> {
  await registry.register(name, tools, "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

beforeEach(async () => {
  __resetDbForTesting();
  await clearRegistry();
});
afterEach(async () => {
  await clearRegistry();
});

describe("config export/import", () => {
  test("export captures bundles, alerts, and per-client config", async () => {
    await reg("svc");
    await registry.setToolGuards("svc", "get-users", { rateLimitPerMin: 5 });
    await registry.setToolOverride("svc", "get-users", { description: "Override" });
    await registry.setClientEnabled("svc", false);
    await createBundle("b1", "desc", [{ client: "svc", tool: "get-users" }], "t");
    createAlertRule({
      name: "a1",
      eventType: "client_unreachable",
      webhookUrl: "http://127.0.0.1:9/x",
      threshold: null,
      minCalls: null,
      actor: null,
    });

    const doc = exportConfig();
    expect(doc.version).toBe(1);
    expect(doc.bundles.map((b) => b.name)).toContain("b1");
    expect(doc.alertRules.map((a) => a.name)).toContain("a1");
    const svc = doc.clients.find((c) => c.name === "svc")!;
    expect(svc.enabled).toBe(false);
    // A tool now exports as a PATCH body: policy keys are the registry's keys
    // (`overrides`, plural), and only configured policies appear.
    const tool = svc.tools[0] as Record<string, unknown>;
    expect((tool.guards as { rateLimitPerMin: number }).rateLimitPerMin).toBe(5);
    expect((tool.overrides as { description: string }).description).toBe("Override");
  });

  test("dry-run import reports a plan but mutates nothing", async () => {
    await reg("svc");
    const doc = exportConfig();
    doc.alertRules.push({
      name: "new",
      eventType: "client_unreachable",
      enabled: true,
      webhookUrl: "http://127.0.0.1:9/x",
      threshold: null,
      minCalls: null,
    });
    const result = await importConfig(doc, { dryRun: true }, "t");
    expect(result.dryRun).toBe(true);
    expect(result.applied.alertRules).toBe(1);
    expect(listAlertRules()).toHaveLength(0);
  });

  test("round-trip reapplies config to a re-registered client (promotion)", async () => {
    await reg("svc");
    await registry.setToolGuards("svc", "get-users", { rateLimitPerMin: 7 });
    await createBundle("b1", undefined, [{ client: "svc", tool: "get-users" }], "t");
    const doc = exportConfig();

    // Fresh environment: reset DB, re-register the client with no admin config.
    __resetDbForTesting();
    await clearRegistry();
    await reg("svc");
    expect(registry.resolveTool("svc__get-users")?.tool.guards?.rateLimitPerMin).toBeUndefined();

    const result = await importConfig(doc, { dryRun: false }, "t");
    expect(result.applied.bundles).toBe(1);
    expect(getBundleDetail("b1")).not.toBeNull();
    expect(registry.resolveTool("svc__get-users")?.tool.guards?.rateLimitPerMin).toBe(7);
  });

  test("skips config for clients/tools that don't exist", async () => {
    const doc = {
      version: 1,
      exportedAt: Date.now(),
      bundles: [],
      alertRules: [],
      clients: [
        {
          name: "ghost",
          enabled: true,
          guards: null,
          tools: [{ name: "t", enabled: true, guards: null, override: null }],
        },
      ],
    };
    const result = await importConfig(doc, { dryRun: false }, "t");
    expect(result.skipped.some((s) => s.type === "client" && s.id === "ghost")).toBe(true);
    expect(result.applied.clientsConfigured).toBe(0);
  });

  test("rejects an unsupported version", async () => {
    await expect(importConfig({ version: 999 }, { dryRun: false }, "t")).rejects.toThrow();
  });

  test("round-trips guardrails and consumer quotas", async () => {
    await reg("svc");
    setGuardrails("svc", "get-users", { denyPatterns: ["DROP TABLE"], blockSecrets: true, scanResponses: false });
    createConsumer({ name: "acme", monthlyQuota: 1000, actor: "t" });

    const doc = exportConfig();
    // Guardrails now travel inside their tool, like every other policy in the
    // mutation registry, rather than in a separate top-level array.
    const tool = doc.clients.find((c) => c.name === "svc")!.tools.find((t) => t.name === "get-users") as Record<
      string,
      unknown
    >;
    expect(tool.guardrails).toEqual({ denyPatterns: ["DROP TABLE"], blockSecrets: true, scanResponses: false });
    expect(doc.consumers).toEqual([{ name: "acme", monthlyQuota: 1000, endUserRateLimitPerMin: null }]);

    // Fresh environment: guardrails/consumers must be recreated by import.
    __resetDbForTesting();
    await clearRegistry();
    await reg("svc");

    const result = await importConfig(doc, { dryRun: false }, "t");
    // Guardrails are applied through the tool loop now, so they count toward
    // toolsConfigured; `applied.guardrails` only moves for a legacy document
    // that still carries the separate top-level array.
    expect(result.applied.guardrails).toBe(0);
    expect(result.applied.toolsConfigured).toBeGreaterThan(0);
    expect(result.applied.consumers).toBe(1);
    expect(getGuardrails("svc", "get-users")).toEqual({
      denyPatterns: ["DROP TABLE"],
      blockSecrets: true,
      scanResponses: false,
    });
    expect(listConsumers().map((c) => ({ name: c.name, monthlyQuota: c.monthlyQuota }))).toEqual([
      { name: "acme", monthlyQuota: 1000 },
    ]);

    // Re-importing updates the existing consumer's quota by name instead of duplicating it.
    doc.consumers[0].monthlyQuota = 2000;
    await importConfig(doc, { dryRun: false }, "t");
    expect(listConsumers()).toHaveLength(1);
    expect(listConsumers()[0].monthlyQuota).toBe(2000);
  });

  test("rejects an invalid consumer quota/end-user-limit instead of silently persisting it", async () => {
    await reg("svc");
    const doc = {
      version: 1,
      exportedAt: Date.now(),
      bundles: [],
      alertRules: [],
      clients: [],
      guardrails: [],
      consumers: [
        { name: "zero-quota", monthlyQuota: 0, endUserRateLimitPerMin: null },
        { name: "negative-limit", monthlyQuota: null, endUserRateLimitPerMin: -1 },
        { name: "valid", monthlyQuota: 100, endUserRateLimitPerMin: 10 },
      ],
    };
    const result = await importConfig(doc, { dryRun: false }, "t");
    expect(result.applied.consumers).toBe(1);
    expect(result.skipped.filter((s) => s.type === "consumer")).toHaveLength(2);
    expect(listConsumers().map((c) => c.name)).toEqual(["valid"]);
  });

  test("a v1 document without guardrails/consumers still imports cleanly (back-compat)", async () => {
    await reg("svc");
    const doc = {
      version: 1,
      exportedAt: Date.now(),
      bundles: [],
      alertRules: [],
      clients: [],
    };
    const result = await importConfig(doc, { dryRun: false }, "t");
    expect(result.applied.guardrails).toBe(0);
    expect(result.applied.consumers).toBe(0);
    expect(result.skipped).toHaveLength(0);
  });

  test("skips a bundle whose tools field isn't an array instead of throwing (P2 regression)", async () => {
    const doc = {
      version: 1,
      exportedAt: Date.now(),
      bundles: [
        { name: "malformed", description: null, enabled: true, tools: "not-an-array" },
        { name: "also-malformed", description: null, enabled: true, tools: { client: "svc", tool: "get-users" } },
      ],
      alertRules: [],
      clients: [],
      guardrails: [],
      consumers: [],
    };
    const result = await importConfig(doc, { dryRun: false }, "t");
    expect(result.applied.bundles).toBe(0);
    expect(result.skipped.filter((s) => s.type === "bundle")).toHaveLength(2);
    expect(result.skipped.find((s) => s.id === "malformed")?.reason).toBe("tools field is not an array");
    expect(getBundleDetail("malformed")).toBeUndefined();
  });

  test("skips guardrails for a tool that doesn't exist", async () => {
    const doc = {
      version: 1,
      exportedAt: Date.now(),
      bundles: [],
      alertRules: [],
      clients: [],
      guardrails: [
        { client: "ghost", tool: "t", guardrails: { denyPatterns: [], blockSecrets: true, scanResponses: false } },
      ],
      consumers: [],
    };
    const result = await importConfig(doc, { dryRun: false }, "t");
    expect(result.skipped.some((s) => s.type === "guardrail" && s.id === "ghost__t")).toBe(true);
    expect(result.applied.guardrails).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The gap the per-tool policy manifest closed.
//
// Export used to carry a hand-picked trio (enabled / guards / override) plus a
// top-level guardrails array. Every other per-tool policy — cache, coalesce,
// pagination, streaming, transform, mock, redaction, sensitivity, quarantine,
// context budget, approval thresholds — was silently absent, so a snapshot
// looked complete and a rollback quietly left all of them untouched.
// ---------------------------------------------------------------------------
describe("per-tool policies round-trip through the mutation registry", () => {
  test("policies that used to be dropped now survive export -> fresh instance -> import", async () => {
    await reg("svc");
    const { applyToolMutations } = await import("../admin/tool-policies/mutations/index.js");
    const configured = {
      cache: { enabled: true, ttlSeconds: 300 },
      coalesce: { enabled: true },
      redactPaths: ["data.ssn"],
      sensitive: true,
      pagination: {
        enabled: true,
        strategy: "cursor",
        itemsPath: "items",
        cursorResponsePath: "next",
        cursorParam: "cursor",
        maxPages: 5,
      },
      streaming: { enabled: true, format: "sse", maxEvents: 25 },
      mock: { enabled: true, mode: "fallback", response: '{"stub":true}' },
      requiresApproval: true,
      approvalLevels: 2,
    };
    const { failures } = await applyToolMutations(configured, { actor: "t", clientName: "svc", toolName: "get-users" });
    expect(failures).toEqual([]);

    const doc = exportConfig();

    __resetDbForTesting();
    await clearRegistry();
    await reg("svc");

    const result = await importConfig(doc, { dryRun: false }, "t");
    expect(result.skipped).toEqual([]);

    const { readToolPolicies } = await import("../admin/tool-policies/mutations/index.js");
    const restored = readToolPolicies("svc", "get-users");
    expect(restored.cache).toEqual({ enabled: true, ttlSeconds: 300 });
    expect(restored.coalesce).toEqual({ enabled: true });
    expect(restored.redactPaths).toEqual(["data.ssn"]);
    expect(restored.sensitive).toBe(true);
    expect(restored.streaming).toEqual({ enabled: true, format: "sse", maxEvents: 25 });
    expect(restored.mock).toEqual({ enabled: true, mode: "fallback", response: '{"stub":true}' });
    expect(restored.requiresApproval).toBe(true);
    expect(restored.approvalLevels).toBe(2);
  });

  test("a legacy document — `override` singular and a top-level guardrails array — still applies", async () => {
    await reg("svc");
    const legacy = {
      version: 1,
      exportedAt: Date.now(),
      bundles: [],
      alertRules: [],
      clients: [
        {
          name: "svc",
          enabled: true,
          guards: null,
          tools: [{ name: "get-users", enabled: true, guards: null, override: { description: "from an old export" } }],
        },
      ],
      guardrails: [
        {
          client: "svc",
          tool: "get-users",
          guardrails: { denyPatterns: ["legacy"], blockSecrets: true, scanResponses: false },
        },
      ],
      consumers: [],
    };

    const result = await importConfig(legacy, { dryRun: false }, "t");
    expect(result.skipped).toEqual([]);
    expect(result.applied.guardrails).toBe(1);

    const { readToolPolicies } = await import("../admin/tool-policies/mutations/index.js");
    const restored = readToolPolicies("svc", "get-users");
    expect((restored.overrides as { description: string }).description).toBe("from an old export");
    expect(restored.guardrails).toEqual({ denyPatterns: ["legacy"], blockSecrets: true, scanResponses: false });
  });
});

// ---------------------------------------------------------------------------
// The entities the document used to omit entirely. Before this, the UI told an
// operator plainly that schedules, guard policies, teams, catalog entries and
// WebSocket proxy targets were NOT covered — which was honest, but the gap was
// still a gap.
// ---------------------------------------------------------------------------
describe("config export covers the remaining admin-authored entities", () => {
  test("teams, guard policies and catalog entries round-trip onto a fresh instance", async () => {
    const { createTeam, listTeams } = await import("../admin/entities/teams.js");
    const { createGuardPolicy, listGuardPolicies } = await import("../admin/entities/policies.js");
    const { createCustomEntry, listCatalog } = await import("../catalog/index.js");

    createTeam("platform", "t");
    createGuardPolicy({ name: "tight", rateLimitPerMin: 30, timeoutMs: 5000, actor: "t" });
    const entry = createCustomEntry(
      { slug: "internal-crm", name: "Internal CRM", kind: "graphql", graphqlUrl: "https://crm.example.com/graphql" },
      "t",
    );
    expect(entry.ok).toBe(true);

    const doc = exportConfig();
    expect(doc.teams).toEqual([{ name: "platform" }]);
    expect(doc.guardPolicies).toEqual([{ name: "tight", rateLimitPerMin: 30, timeoutMs: 5000 }]);
    expect(doc.catalogEntries?.map((e) => e.slug)).toEqual(["internal-crm"]);

    __resetDbForTesting();
    await clearRegistry();

    const result = await importConfig(doc, { dryRun: false }, "t");
    expect(result.skipped).toEqual([]);
    expect(result.applied.teams).toBe(1);
    expect(result.applied.guardPolicies).toBe(1);
    expect(result.applied.catalogEntries).toBe(1);

    expect(listTeams().map((t) => t.name)).toEqual(["platform"]);
    expect(listGuardPolicies().map((p) => ({ name: p.name, rate: p.rateLimitPerMin }))).toEqual([
      { name: "tight", rate: 30 },
    ]);
    const restored = listCatalog().find((e) => e.slug === "internal-crm")!;
    expect(restored.kind).toBe("graphql");
    expect(restored.graphqlUrl).toBe("https://crm.example.com/graphql");
  });

  test("the builtin catalog gallery is not exported — it is code, not rows", async () => {
    const { listCatalog } = await import("../catalog/index.js");
    expect(listCatalog().some((e) => e.source === "builtin")).toBe(true);
    expect(exportConfig().catalogEntries).toEqual([]);
  });

  test("schedules round-trip, and are skipped when their target no longer exists", async () => {
    await reg("svc");
    const { createSchedule, listSchedules } = await import("../admin/entities/schedules.js");
    const made = createSchedule({
      targetType: "tool",
      clientName: "svc",
      toolName: "get-users",
      action: "disable",
      cron: "0 3 * * *",
      actor: "t",
    });
    expect(typeof made).not.toBe("string");

    const doc = exportConfig();
    expect(doc.schedules).toHaveLength(1);

    // Restored onto an instance where the client exists: applies.
    __resetDbForTesting();
    await clearRegistry();
    await reg("svc");
    const ok = await importConfig(doc, { dryRun: false }, "t");
    expect(ok.applied.schedules).toBe(1);
    expect(listSchedules()).toHaveLength(1);

    // Re-importing the same document must not stack a duplicate — the key is
    // the target/action/cron tuple, not a row id.
    await importConfig(doc, { dryRun: false }, "t");
    expect(listSchedules()).toHaveLength(1);

    // Restored where the client was never registered: reported, not fabricated.
    __resetDbForTesting();
    await clearRegistry();
    const missing = await importConfig(doc, { dryRun: false }, "t");
    expect(missing.applied.schedules).toBe(0);
    expect(missing.skipped.some((s) => s.type === "schedule" && s.reason === "client not registered")).toBe(true);
  });

  test("a ws-proxy target import is refused when the URL fails the same SSRF check the admin route applies", async () => {
    // Import must never be a weaker path than the admin route: a document
    // could otherwise plant a target the API itself would refuse.
    const doc = {
      version: 1,
      exportedAt: Date.now(),
      bundles: [],
      alertRules: [],
      clients: [],
      consumers: [],
      wsProxyTargets: [
        {
          name: "bad-scheme",
          backendWsUrl: "http://example.com/socket",
          maxConnections: 1,
          maxMessageBytes: 1024,
          idleTimeoutMs: 1000,
          enabled: true,
        },
      ],
    };
    const result = await importConfig(doc, { dryRun: false }, "t");
    expect(result.applied.wsProxyTargets).toBe(0);
    expect(result.skipped.some((s) => s.type === "wsProxyTarget" && s.id === "bad-scheme")).toBe(true);
  });

  test("a document from an older gateway, with none of these sections, still imports", async () => {
    const legacy = {
      version: 1,
      exportedAt: Date.now(),
      bundles: [],
      alertRules: [],
      clients: [],
      consumers: [],
    };
    const result = await importConfig(legacy, { dryRun: false }, "t");
    expect(result.skipped).toEqual([]);
    expect(result.applied.teams).toBe(0);
    expect(result.applied.schedules).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The malformed-input branches of the five new sections. A config document can
// be hand-edited or come from a foreign tool, so every one of these must
// degrade to a reported skip — the import loop is not transactional, and a
// throw halfway through would leave the instance half-configured with no
// record of where it stopped.
// ---------------------------------------------------------------------------
describe("config import — malformed entries in the new sections are skipped, never thrown on", () => {
  function docWith(sections: Record<string, unknown>) {
    return {
      version: 1,
      exportedAt: Date.now(),
      bundles: [],
      alertRules: [],
      clients: [],
      consumers: [],
      ...sections,
    };
  }

  test("a nameless team, guard policy or catalog entry is reported, and the valid siblings still apply", async () => {
    const result = await importConfig(
      docWith({
        teams: [{ name: "" }, { notName: 1 }, { name: "good-team" }],
        guardPolicies: [{ name: "" }, { name: "good-policy", rateLimitPerMin: 5, timeoutMs: null }],
        catalogEntries: [{ slug: "" }, { slug: "good-entry", name: "Good", kind: "rest" }],
      }),
      { dryRun: false },
      "t",
    );

    expect(result.applied.teams).toBe(1);
    expect(result.applied.guardPolicies).toBe(1);
    expect(result.applied.catalogEntries).toBe(1);
    expect(result.skipped.filter((s) => s.type === "team")).toHaveLength(2);
    expect(result.skipped.filter((s) => s.type === "guardPolicy")).toHaveLength(1);
    expect(result.skipped.filter((s) => s.type === "catalogEntry")).toHaveLength(1);
  });

  test("a catalog entry the mutation layer refuses is reported with its own message", async () => {
    // An invalid slug is rejected by createCustomEntry, not by the guard above
    // — this is the branch that surfaces a downstream refusal rather than a
    // missing field.
    const result = await importConfig(
      docWith({ catalogEntries: [{ slug: "Not A Valid Slug", name: "X", kind: "rest" }] }),
      { dryRun: false },
      "t",
    );
    expect(result.applied.catalogEntries).toBe(0);
    const skip = result.skipped.find((s) => s.type === "catalogEntry");
    expect(skip?.reason).toContain("slug");
  });

  test("a schedule with an unparseable cron is reported, not persisted", async () => {
    await reg("svc");
    const result = await importConfig(
      docWith({
        schedules: [
          {
            targetType: "client",
            clientName: "svc",
            toolName: null,
            action: "disable",
            cron: "not a cron",
            enabled: true,
          },
        ],
      }),
      { dryRun: false },
      "t",
    );
    expect(result.applied.schedules).toBe(0);
    expect(result.skipped.some((s) => s.type === "schedule" && s.reason === "INVALID_CRON")).toBe(true);
  });

  test("a nameless ws-proxy target is reported before any DNS work happens", async () => {
    const result = await importConfig(
      docWith({ wsProxyTargets: [{ backendWsUrl: "wss://x/y" }] }),
      {
        dryRun: false,
      },
      "t",
    );
    expect(result.applied.wsProxyTargets).toBe(0);
    expect(result.skipped.some((s) => s.type === "wsProxyTarget")).toBe(true);
  });

  test("dry-run touches nothing in any of the new sections", async () => {
    const { listTeams } = await import("../admin/entities/teams.js");
    const { listGuardPolicies } = await import("../admin/entities/policies.js");
    const result = await importConfig(
      docWith({
        teams: [{ name: "planned" }],
        guardPolicies: [{ name: "planned", rateLimitPerMin: 1, timeoutMs: 1 }],
      }),
      { dryRun: true },
      "t",
    );
    expect(result.applied.teams).toBe(1);
    expect(result.applied.guardPolicies).toBe(1);
    expect(listTeams()).toHaveLength(0);
    expect(listGuardPolicies()).toHaveLength(0);
  });

  test("a disabled schedule is restored disabled, not silently re-enabled", async () => {
    await reg("svc");
    const { listSchedules } = await import("../admin/entities/schedules.js");
    const result = await importConfig(
      docWith({
        schedules: [
          {
            targetType: "client",
            clientName: "svc",
            toolName: null,
            action: "disable",
            cron: "0 4 * * *",
            enabled: false,
          },
        ],
      }),
      { dryRun: false },
      "t",
    );
    expect(result.applied.schedules).toBe(1);
    expect(listSchedules()[0]?.enabled).toBe(false);
  });
});

describe("config export/import — WebSocket proxy targets round-trip", () => {
  test("an existing target is exported without its pin, and re-created through the SSRF-validated path", async () => {
    const { config } = await import("../config.js");
    const { upsertWsProxyTarget, getWsProxyTargetDetail, __resetWsProxyForTesting } = await import("../ws-proxy.js");
    const originalAllowPrivate = config.allowPrivateIps;
    (config as Record<string, unknown>).allowPrivateIps = true;
    try {
      const made = await upsertWsProxyTarget("relay", { backendWsUrl: "ws://127.0.0.1:9", maxConnections: 3 });
      expect(made.ok).toBe(true);

      const doc = exportConfig();
      expect(doc.wsProxyTargets).toHaveLength(1);
      const exported = doc.wsProxyTargets![0]!;
      expect(exported.name).toBe("relay");
      expect(exported.maxConnections).toBe(3);
      // The SSRF pin must NOT travel inside the document: it is resolved state,
      // wrong wherever DNS differs, and trusting a carried value would make
      // import a weaker path than the admin route.
      expect(exported).not.toHaveProperty("resolvedIp");

      __resetDbForTesting();
      await clearRegistry();
      __resetWsProxyForTesting();

      const result = await importConfig(doc, { dryRun: false }, "t");
      expect(result.skipped).toEqual([]);
      expect(result.applied.wsProxyTargets).toBe(1);
      const restored = getWsProxyTargetDetail("relay");
      expect(restored?.backendWsUrl).toBe("ws://127.0.0.1:9");
      expect(restored?.maxConnections).toBe(3);
      // Re-resolved locally rather than copied from the document.
      expect(restored?.resolvedIp).toBe("127.0.0.1");
    } finally {
      (config as Record<string, unknown>).allowPrivateIps = originalAllowPrivate;
    }
  });
});

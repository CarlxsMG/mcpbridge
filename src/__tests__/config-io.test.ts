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

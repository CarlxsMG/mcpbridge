/**
 * The structural gate behind the per-tool policy manifest.
 *
 * `TOOL_MUTATIONS` is the single list of every policy `PATCH
 * /admin-api/clients/:name/tools/:tool` accepts. Adding an entry there is now
 * also what makes a policy exportable, importable and roll-back-able — but only
 * if its `read` genuinely produces something `validate`/`apply` accept back.
 * These tests assert that property GENERICALLY, by iterating the registry, so a
 * policy added next year is covered the day it is added rather than the day
 * someone remembers to extend a hand-written list.
 *
 * Why this matters: config export used to hand-pick which policies it carried,
 * and fifteen per-tool policies were quietly absent. A snapshot looked
 * complete, and a rollback left cache, redaction, pagination, quarantine,
 * transform, mock, monitor and budget exactly as they were.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { __resetDbForTesting } from "../../../../db/connection.js";
import { registry } from "../../../../mcp/registry.js";
import { TOOL_MUTATIONS, applyToolMutations, readToolPolicies } from "../index.js";
import type { MutationContext } from "../types.js";

const CTX: MutationContext = { actor: "test", clientName: "svc", toolName: "t" };
const CTX_COPY: MutationContext = { actor: "test", clientName: "svc-copy", toolName: "t" };

async function register(name: string): Promise<void> {
  await registry.register(
    name,
    [{ name: "t", method: "POST", endpoint: "/t", description: "d", inputSchema: { type: "object", properties: {} } }],
    "http://example.com/health",
    "1.2.3.4",
    "http://example.com",
    "1.2.3.4",
  );
}

/**
 * A representative non-default value for every policy, keyed by body key.
 *
 * Deliberately a total map rather than a partial one: the "every policy has a
 * fixture" test below fails when a new policy is added without one, which is
 * what stops this suite from quietly shrinking to cover only the old policies.
 *
 * `monitor` is the one policy with no fixture, and its exclusion is explained
 * at EXPECT_NO_FIXTURE.
 */
const FIXTURES: Record<string, unknown> = {
  enabled: false,
  guards: { rateLimitPerMin: 30, timeoutMs: 5_000 },
  overrides: { description: "overridden", displayName: "alias_t" },
  sensitive: true,
  redactPaths: ["data.secret", "token"],
  guardrails: { denyPatterns: ["ssn"], blockSecrets: true, scanResponses: true },
  cache: { enabled: true, ttlSeconds: 120 },
  coalesce: { enabled: true },
  quarantinePolicy: { consecutiveThreshold: 3, action: "block", recoveryMode: "manual", cooldownMs: 60_000 },
  pagination: {
    enabled: true,
    strategy: "cursor",
    itemsPath: "items",
    cursorResponsePath: "next",
    cursorParam: "cursor",
    maxPages: 3,
  },
  streaming: { enabled: true, format: "sse", maxEvents: 50 },
  transform: { enabled: true, request: [{ op: "remove", path: "debug" }], response: [] },
  mock: { enabled: true, mode: "always", response: '{"ok":true}' },
  requiresApproval: true,
  graphql: { enabled: true, query: "query { viewer { id } }" },
  contextBudget: { enabled: true, mode: "truncate", maxResponseBytes: 10_000 },
};

/**
 * `monitor` cannot be exercised by this generic harness: setMonitor requires a
 * live tool AND an existing tool_examples row to replay, so a fixture here
 * would be testing the example fixture, not the round trip. Its `read` is
 * covered by its own case at the bottom of this file instead.
 *
 * `ws` needs a reachable WebSocket backend (setToolWs dials and IP-pins it), so
 * it is likewise excluded from the generic pass rather than given a fake URL
 * that would make the assertion about DNS rather than about round-tripping.
 */
const EXPECT_NO_FIXTURE = new Set(["monitor", "ws"]);

beforeEach(async () => {
  __resetDbForTesting();
  await register("svc");
  await register("svc-copy");
});

describe("every policy in the mutation registry participates in the manifest", () => {
  test("every entry declares a read", () => {
    const missing = TOOL_MUTATIONS.filter((m) => typeof m.read !== "function").map((m) => m.key);
    expect(missing).toEqual([]);
  });

  test("every entry has a round-trip fixture, or is explicitly exempt with a reason", () => {
    const uncovered = TOOL_MUTATIONS.filter((m) => !(m.key in FIXTURES) && !EXPECT_NO_FIXTURE.has(m.key)).map(
      (m) => m.key,
    );
    expect(uncovered).toEqual([]);
  });

  test("the exempt list names only policies that actually exist", () => {
    const keys = new Set(TOOL_MUTATIONS.map((m) => m.key));
    expect([...EXPECT_NO_FIXTURE].filter((k) => !keys.has(k))).toEqual([]);
  });
});

describe("read produces exactly what apply accepts, per policy", () => {
  for (const mutation of TOOL_MUTATIONS) {
    if (EXPECT_NO_FIXTURE.has(mutation.key)) continue;

    test(`${mutation.key} survives write -> read -> write -> read unchanged`, async () => {
      const write = await applyToolMutations({ [mutation.key]: FIXTURES[mutation.key] }, CTX);
      expect(write).toEqual({ applied: 1, failures: [] });

      // What an export would carry for this policy.
      const exported = readToolPolicies(CTX.clientName, CTX.toolName);
      expect(exported[mutation.key]).toBeDefined();

      // Replaying it onto a pristine tool must be accepted — this is the step
      // that fails when `read` returns an internal shape rather than the wire
      // shape `validate` expects.
      const replay = await applyToolMutations(exported, CTX_COPY);
      expect(replay.failures).toEqual([]);

      // ...and must land on the same value, not merely be tolerated.
      const reExported = readToolPolicies(CTX_COPY.clientName, CTX_COPY.toolName);
      expect(reExported[mutation.key]).toEqual(exported[mutation.key]);
    });
  }
});

describe("readToolPolicies", () => {
  test("an untouched tool exports only its enabled flag, not eighteen nulls", async () => {
    expect(readToolPolicies("svc", "t")).toEqual({ enabled: true });
  });

  test("returns nothing for a tool that does not exist", () => {
    expect(readToolPolicies("svc", "nope")).toEqual({});
  });

  test("carries a disabled tool's flag — omitting it would silently re-enable on import", async () => {
    await applyToolMutations({ enabled: false }, CTX);
    expect(readToolPolicies("svc", "t").enabled).toBe(false);
  });

  test("requiresApproval brings its approvalLevels threshold along", async () => {
    await applyToolMutations({ requiresApproval: true, approvalLevels: 3 }, CTX);

    const exported = readToolPolicies("svc", "t");
    expect(exported.requiresApproval).toBe(true);
    expect(exported.approvalLevels).toBe(3);

    await applyToolMutations(exported, CTX_COPY);
    expect(readToolPolicies("svc-copy", "t").approvalLevels).toBe(3);
  });

  test("an empty redaction list is omitted rather than exported as []", async () => {
    await applyToolMutations({ redactPaths: [] }, CTX);
    expect(readToolPolicies("svc", "t")).not.toHaveProperty("redactPaths");
  });

  test("a full document round-trips every configured policy at once", async () => {
    const everything: Record<string, unknown> = {};
    for (const m of TOOL_MUTATIONS) {
      if (EXPECT_NO_FIXTURE.has(m.key)) continue;
      everything[m.key] = FIXTURES[m.key];
    }
    expect((await applyToolMutations(everything, CTX)).failures).toEqual([]);

    const exported = readToolPolicies("svc", "t");
    expect((await applyToolMutations(exported, CTX_COPY)).failures).toEqual([]);
    expect(readToolPolicies("svc-copy", "t")).toEqual(exported);
  });
});

describe("monitor's read (excluded from the generic pass — needs a live example row)", () => {
  test("reports nothing when the tool has no monitor", () => {
    const monitor = TOOL_MUTATIONS.find((m) => m.key === "monitor")!;
    expect(monitor.read("svc", "t")).toBeUndefined();
  });

  test("exports only the three configurable fields, never the observed drift state", async () => {
    const { setMonitor } = await import("../../../../observability/monitor.js");
    const { createExample } = await import("../../../../tool-meta/tool-examples.js");
    const example = createExample("svc", "t", "e", {}, "test");
    if (typeof example === "string") throw new Error(`example fixture failed: ${example}`);
    const set = await setMonitor("svc", "t", { exampleId: example.id, intervalMinutes: 30, enabled: true });
    expect(set.ok).toBe(true);

    const monitor = TOOL_MUTATIONS.find((m) => m.key === "monitor")!;
    expect(monitor.read("svc", "t")).toEqual({ exampleId: example.id, intervalMinutes: 30, enabled: true });
  });
});

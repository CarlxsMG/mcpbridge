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
import type { Response } from "express";
import { TOOL_MUTATIONS, applyToolMutations, readToolPolicies, dispatchToolMutations } from "../index.js";
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

/**
 * The stop-vs-continue contract, which is the one behavioural difference
 * between the registry's two callers and the part a reader is most likely to
 * get wrong later.
 *
 * PATCH stops at the first rejected key: a caller sent one request and gets one
 * error, so applying later keys it never learns about would be a silent partial
 * write. Config import continues: a document covers many keys across many
 * tools, and one bad key must not discard the rest.
 *
 * Every case here pins a behaviour rather than an implementation detail — which
 * key stops, which keys still land — so a refactor that keeps the contract
 * still passes.
 */
describe("applyToolMutations — stop-on-first-failure vs continue", () => {
  /** `guards` (index 1) is invalid; `cache` (index 6) is valid and comes later. */
  const EARLY_BAD_LATE_GOOD = {
    guards: { rateLimitPerMin: "not a number" },
    cache: { enabled: true, ttlSeconds: 60 },
  };

  test("stopping is the DEFAULT — no opts means a later valid key is NOT applied", async () => {
    const { failures } = await applyToolMutations(EARLY_BAD_LATE_GOOD, CTX);

    expect(failures.map((f) => f.key)).toEqual(["guards"]);
    // The observable half: `cache` never landed, so the default really is stop.
    expect(readToolPolicies("svc", "t")).not.toHaveProperty("cache");
  });

  test("stopOnFirstFailure: true reports exactly one failure and applies nothing after it", async () => {
    const { applied, failures } = await applyToolMutations(EARLY_BAD_LATE_GOOD, CTX, { stopOnFirstFailure: true });

    expect(applied).toBe(0);
    expect(failures).toHaveLength(1);
    expect(readToolPolicies("svc", "t")).not.toHaveProperty("cache");
  });

  test("stopOnFirstFailure: false applies the later key and still reports the bad one", async () => {
    const { applied, failures } = await applyToolMutations(EARLY_BAD_LATE_GOOD, CTX, { stopOnFirstFailure: false });

    expect(applied).toBe(1);
    expect(failures.map((f) => f.key)).toEqual(["guards"]);
    expect(readToolPolicies("svc", "t").cache).toEqual({ enabled: true, ttlSeconds: 60 });
  });

  test("continuing collects EVERY bad key, not just the first", async () => {
    const { applied, failures } = await applyToolMutations(
      {
        guards: { rateLimitPerMin: "nope" },
        cache: { enabled: true, ttlSeconds: 60 },
        streaming: { format: "not-a-format" },
      },
      CTX,
      { stopOnFirstFailure: false },
    );

    expect(applied).toBe(1);
    expect(failures.map((f) => f.key).sort()).toEqual(["guards", "streaming"]);
  });

  test("a tool that does not exist fails with the 404 message the PATCH route sends", async () => {
    const { applied, failures } = await applyToolMutations(
      { cache: { enabled: true, ttlSeconds: 60 } },
      { actor: "test", clientName: "svc", toolName: "no-such-tool" },
    );

    expect(applied).toBe(0);
    expect(failures).toEqual([{ kind: "tool_not_found", key: "cache", message: "Client or tool not found" }]);
  });

  test("a tool_not_found stops the run too, not just a validation error", async () => {
    const { failures } = await applyToolMutations(
      { cache: { enabled: true, ttlSeconds: 60 }, coalesce: { enabled: true } },
      { actor: "test", clientName: "svc", toolName: "no-such-tool" },
      { stopOnFirstFailure: true },
    );
    expect(failures.map((f) => f.key)).toEqual(["cache"]);
  });

  test("...and continuing past it reports both", async () => {
    const { failures } = await applyToolMutations(
      { cache: { enabled: true, ttlSeconds: 60 }, coalesce: { enabled: true } },
      { actor: "test", clientName: "svc", toolName: "no-such-tool" },
      { stopOnFirstFailure: false },
    );
    expect(failures.map((f) => f.key)).toEqual(["cache", "coalesce"]);
  });
});

describe("dispatchToolMutations — the PATCH route stops at the first rejection", () => {
  function mockRes(): { res: Response; status: () => number | undefined } {
    let statusCode: number | undefined;
    const res = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json() {
        return res;
      },
    } as unknown as Response;
    return { res, status: () => statusCode };
  }

  test("a later valid key is not applied once an earlier one is rejected", async () => {
    // The HTTP contract: one request, one error, and nothing the caller was
    // not told about. Without it a 400 could still have written half the body.
    const { res, status } = mockRes();
    const outcome = await dispatchToolMutations(
      { guards: { rateLimitPerMin: "not a number" }, cache: { enabled: true, ttlSeconds: 60 } },
      CTX,
      res,
    );

    expect(outcome).toBe("validation_error");
    expect(status()).toBe(400);
    expect(readToolPolicies("svc", "t")).not.toHaveProperty("cache");
  });

  test("an all-valid body applies every key and reports success", async () => {
    const { res, status } = mockRes();
    const outcome = await dispatchToolMutations(
      { cache: { enabled: true, ttlSeconds: 60 }, coalesce: { enabled: true } },
      CTX,
      res,
    );

    expect(outcome).toBeNull();
    expect(status()).toBeUndefined();
    expect(readToolPolicies("svc", "t").cache).toEqual({ enabled: true, ttlSeconds: 60 });
    expect(readToolPolicies("svc", "t").coalesce).toEqual({ enabled: true });
  });
});

/**
 * The third failure kind — a mutation whose `apply` refuses for its own reason,
 * rather than failing validation or hitting a missing tool.
 *
 * `overrides` is the reachable case: setting a `displayName` that collides with
 * another tool of the same client makes the registry throw a
 * `ToolOverrideError`, which the mutation turns into `{kind: "error", status:
 * 409}`. Nothing exercised this branch, so neither its shape nor its
 * stop/continue behaviour was pinned.
 */
describe("applyToolMutations — a downstream refusal from apply()", () => {
  async function registerTwoTools(name: string): Promise<void> {
    await registry.register(
      name,
      [
        { name: "t", method: "POST", endpoint: "/t", description: "d", inputSchema: { type: "object" } },
        { name: "other", method: "POST", endpoint: "/o", description: "d", inputSchema: { type: "object" } },
      ],
      "http://example.com/health",
      "1.2.3.4",
      "http://example.com",
      "1.2.3.4",
    );
  }

  test("surfaces the refusal as downstream_error, carrying the status and code", async () => {
    await registerTwoTools("collide");
    const { applied, failures } = await applyToolMutations(
      { overrides: { displayName: "other" } },
      { actor: "test", clientName: "collide", toolName: "t" },
    );

    expect(applied).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: "downstream_error", key: "overrides", status: 409 });
    expect(failures[0]!.message).toContain("collides");
  });

  test("it stops the run by default, leaving a later key unapplied", async () => {
    await registerTwoTools("collide-stop");
    const { failures } = await applyToolMutations(
      { overrides: { displayName: "other" }, cache: { enabled: true, ttlSeconds: 60 } },
      { actor: "test", clientName: "collide-stop", toolName: "t" },
    );

    expect(failures.map((f) => f.key)).toEqual(["overrides"]);
    expect(readToolPolicies("collide-stop", "t")).not.toHaveProperty("cache");
  });

  test("...and continuing past it still applies the later key", async () => {
    await registerTwoTools("collide-continue");
    const { applied, failures } = await applyToolMutations(
      { overrides: { displayName: "other" }, cache: { enabled: true, ttlSeconds: 60 } },
      { actor: "test", clientName: "collide-continue", toolName: "t" },
      { stopOnFirstFailure: false },
    );

    expect(applied).toBe(1);
    expect(failures.map((f) => f.kind)).toEqual(["downstream_error"]);
    expect(readToolPolicies("collide-continue", "t").cache).toEqual({ enabled: true, ttlSeconds: 60 });
  });

  test("the PATCH route answers with the refusal's own status, not a blanket 400", async () => {
    await registerTwoTools("collide-http");
    let statusCode: number | undefined;
    const res = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json() {
        return res;
      },
    } as unknown as Response;

    const outcome = await dispatchToolMutations(
      { overrides: { displayName: "other" } },
      { actor: "test", clientName: "collide-http", toolName: "t" },
      res,
    );

    expect(outcome).toBe("downstream_error");
    expect(statusCode).toBe(409);
  });
});

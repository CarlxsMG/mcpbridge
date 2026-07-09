/**
 * Stryker mutation-testing backstop for src/tool-policies/quarantine.ts.
 * The existing quarantine.test.ts covers policy CRUD, escalation, the
 * three actions, and basic manual/auto recovery well, but never exercises
 * the cooldown-computation boundary combinations, checkQuarantine's
 * no-policy-with-orphaned-state edge case, or getQuarantineForClient at all
 * (zero prior coverage).
 *
 * Documented equivalent (not chased further): 65:27-65:43 ArrowFunction
 * (`nowFn`'s module-level initial value, `() => Date.now()`, emptied to
 * `() => undefined`). Same equivalence class as load-balancer.ts's
 * `nowFn`/`randFn`: this file's own dedicated test unconditionally calls
 * `__setClockForTesting(null)` in every `beforeEach`/`afterEach`, which
 * reassigns `nowFn` to a DIFFERENT, textually-identical arrow function
 * defined inside `__setClockForTesting` itself — so the module-load-time
 * initial declaration is overwritten before any test's assertions ever run.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../../config.js";
import { getDb, __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import {
  setQuarantinePolicy,
  getQuarantineState,
  recordGuardrailHit,
  checkQuarantine,
  getQuarantineForClient,
  __setClockForTesting,
  type QuarantinePolicy,
} from "../../tool-policies/quarantine.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "quarantine-mutation-client";
function makeTool(name = "do-x"): RestToolDefinition {
  return {
    name,
    method: "POST",
    endpoint: `/${name}`,
    description: "x",
    inputSchema: { type: "object", properties: { a: { type: "string" } } },
  };
}
async function reg(...names: string[]): Promise<void> {
  await registry.register(
    CLIENT,
    (names.length ? names : ["do-x"]).map((n) => makeTool(n)),
    "http://1.2.3.4/health",
    "1.2.3.4",
    "http://1.2.3.4",
    "1.2.3.4",
  );
}

function policy(overrides: Partial<QuarantinePolicy> = {}): QuarantinePolicy {
  return { consecutiveThreshold: 2, action: "block", recoveryMode: "manual", cooldownMs: null, ...overrides };
}

beforeEach(async () => {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  __setClockForTesting(null);
  removeCircuitBreaker(CLIENT);
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  __setClockForTesting(null);
  removeCircuitBreaker(CLIENT);
});

// 171:27-171:78 LogicalOperator/ConditionalExpression [Survived]
// (`policy.recoveryMode === "auto" && policy.cooldownMs` — various
// sub-mutants). Existing tests only exercise the "both true" combination
// (implicitly, via the auto-recovery test's eventual behavior) — never
// assert the exact cooldownUntil value, nor the other 3 combinations.
describe("recordGuardrailHit — cooldownUntil computation boundary", () => {
  test("auto + a real cooldownMs sets cooldownUntil to exactly now + cooldownMs", async () => {
    await reg();
    const now = 1_000_000;
    __setClockForTesting(() => now);
    setQuarantinePolicy(CLIENT, "do-x", policy({ consecutiveThreshold: 1, recoveryMode: "auto", cooldownMs: 5000 }));
    recordGuardrailHit(CLIENT, "do-x", true);
    expect(getQuarantineState(CLIENT, "do-x").cooldownUntil).toBe(now + 5000);
  });

  test("auto + null cooldownMs leaves cooldownUntil null", async () => {
    await reg();
    setQuarantinePolicy(CLIENT, "do-x", policy({ consecutiveThreshold: 1, recoveryMode: "auto", cooldownMs: null }));
    recordGuardrailHit(CLIENT, "do-x", true);
    expect(getQuarantineState(CLIENT, "do-x").cooldownUntil).toBeNull();
  });

  test("manual + a real cooldownMs still leaves cooldownUntil null (manual never auto-expires)", async () => {
    await reg();
    setQuarantinePolicy(CLIENT, "do-x", policy({ consecutiveThreshold: 1, recoveryMode: "manual", cooldownMs: 5000 }));
    recordGuardrailHit(CLIENT, "do-x", true);
    expect(getQuarantineState(CLIENT, "do-x").cooldownUntil).toBeNull();
  });
});

// 204:7-204:14 ConditionalExpression [Survived] (`if (!policy)` forced
// always-false). The "no policy configured" case can't distinguish this
// via checkQuarantine's return value ALONE when state is genuinely empty
// too (downstream `if (!state.quarantined)` reaches the same {active:
// false} result either way) — needs an ORPHANED state row (quarantined=1
// with NO policy, a DB shape the public API can never itself produce,
// since setQuarantinePolicy(null) deletes both rows together) to prove
// the no-policy check short-circuits BEFORE ever consulting state.
describe("checkQuarantine — no-policy short-circuit", () => {
  test("an orphaned quarantined state row with no policy is still reported inactive", async () => {
    await reg();
    getDb()
      .query(
        `INSERT INTO tool_quarantine_state (client_name, tool_name, quarantined, consecutive_hits, reason)
         VALUES (?, ?, 1, 5, 'orphaned')`,
      )
      .run(CLIENT, "do-x");
    expect(checkQuarantine(CLIENT, "do-x")).toEqual({ active: false });
  });
});

// 208:*/213:* — checkQuarantine's auto-recovery condition cluster and the
// exact `reason` field.
describe("checkQuarantine — auto-recovery boundary and exact reason", () => {
  test("cooldown expiring at EXACTLY now already clears (>=, not >)", async () => {
    await reg();
    let now = 1_000_000;
    __setClockForTesting(() => now);
    setQuarantinePolicy(CLIENT, "do-x", policy({ consecutiveThreshold: 1, recoveryMode: "auto", cooldownMs: 60_000 }));
    recordGuardrailHit(CLIENT, "do-x", true);
    const cooldownUntil = getQuarantineState(CLIENT, "do-x").cooldownUntil!;

    now = cooldownUntil; // exact boundary tick
    expect(checkQuarantine(CLIENT, "do-x")).toEqual({ active: false });
  });

  test("manual mode never auto-clears, even after a very long simulated time", async () => {
    await reg();
    let now = 1_000_000;
    __setClockForTesting(() => now);
    setQuarantinePolicy(CLIENT, "do-x", policy({ consecutiveThreshold: 1, recoveryMode: "manual", cooldownMs: null }));
    recordGuardrailHit(CLIENT, "do-x", true);
    expect(checkQuarantine(CLIENT, "do-x").active).toBe(true);

    now += 10_000_000_000; // a huge amount of simulated elapsed time
    expect(checkQuarantine(CLIENT, "do-x").active).toBe(true);
  });

  test("the active response carries the exact escalation reason, not undefined", async () => {
    await reg();
    setQuarantinePolicy(CLIENT, "do-x", policy({ consecutiveThreshold: 1, recoveryMode: "manual" }));
    recordGuardrailHit(CLIENT, "do-x", true);
    const result = checkQuarantine(CLIENT, "do-x");
    expect(result.active).toBe(true);
    expect(result.reason).toBe("1 consecutive guardrail violations");
  });

  // 208:7-208:37 ConditionalExpression [Survived] (`policy.recoveryMode ===
  // "auto"` forced always-true) / 208:7-208:69 LogicalOperator [Survived]
  // (`&&` flipped to `||`). Manual mode never itself produces a non-null
  // cooldownUntil, so this needs a DB-mismatched state row (cooldown_until
  // set directly, bypassing recordGuardrailHit) to prove the recoveryMode
  // check is genuinely load-bearing: even with an ALREADY-past
  // cooldown_until present, manual mode must stay active.
  test("manual mode ignores an already-past cooldown_until (DB-mismatched state)", async () => {
    await reg();
    const now = 1_000_000;
    __setClockForTesting(() => now);
    setQuarantinePolicy(CLIENT, "do-x", policy({ consecutiveThreshold: 1, recoveryMode: "manual", cooldownMs: null }));
    recordGuardrailHit(CLIENT, "do-x", true);
    expect(checkQuarantine(CLIENT, "do-x").active).toBe(true);

    getDb()
      .query(`UPDATE tool_quarantine_state SET cooldown_until = ? WHERE client_name = ? AND tool_name = ?`)
      .run(now - 1, CLIENT, "do-x"); // already in the past

    expect(checkQuarantine(CLIENT, "do-x").active).toBe(true);
  });

  // 208:41-208:69 ConditionalExpression [Survived] (`state.cooldownUntil
  // !== null` forced always-true). Auto mode with a genuinely null
  // cooldownUntil (cooldownMs was never configured) must never auto-clear
  // — `nowFn() >= null` coerces to `nowFn() >= 0`, which is always true,
  // so a forced-true here would wrongly auto-clear immediately.
  test("auto mode with a genuinely null cooldownUntil never auto-clears", async () => {
    await reg();
    setQuarantinePolicy(CLIENT, "do-x", policy({ consecutiveThreshold: 1, recoveryMode: "auto", cooldownMs: null }));
    recordGuardrailHit(CLIENT, "do-x", true);
    expect(getQuarantineState(CLIENT, "do-x").cooldownUntil).toBeNull();
    expect(checkQuarantine(CLIENT, "do-x").active).toBe(true);
  });
});

// 241:*/244:*/245:* — getQuarantineForClient had ZERO prior test coverage.
describe("getQuarantineForClient", () => {
  test("returns the policy+state for every tool of a client, keyed by tool name", async () => {
    await reg("tool-a", "tool-b");
    setQuarantinePolicy(CLIENT, "tool-a", policy({ consecutiveThreshold: 2, action: "block" }));
    setQuarantinePolicy(CLIENT, "tool-b", policy({ consecutiveThreshold: 5, action: "observe" }));
    recordGuardrailHit(CLIENT, "tool-a", true);
    recordGuardrailHit(CLIENT, "tool-a", true); // escalates tool-a to quarantined

    const result = getQuarantineForClient(CLIENT);

    expect(result["tool-a"]).toEqual({
      policy: { consecutiveThreshold: 2, action: "block", recoveryMode: "manual", cooldownMs: null },
      state: {
        quarantined: true,
        consecutiveHits: 2,
        quarantinedAt: expect.any(Number),
        reason: "2 consecutive guardrail violations",
        cooldownUntil: null,
      },
    });
    // tool-b has a policy but no accumulated state yet — falls back to EMPTY_STATE.
    expect(result["tool-b"]).toEqual({
      policy: { consecutiveThreshold: 5, action: "observe", recoveryMode: "manual", cooldownMs: null },
      state: { quarantined: false, consecutiveHits: 0, quarantinedAt: null, reason: null, cooldownUntil: null },
    });
  });

  test("a client with no quarantine policies at all returns an empty object", async () => {
    await reg();
    expect(getQuarantineForClient(CLIENT)).toEqual({});
  });
});

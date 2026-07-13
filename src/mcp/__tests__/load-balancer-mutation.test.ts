/**
 * Stryker mutation-testing backstop for src/tool-policies/load-balancer.ts.
 * The existing load-balancer.test.ts covers the happy paths well but never
 * exercises the validation boundaries, the "least-conn"/weighted algorithms'
 * edge cases, or the test-only dependency-injection helpers' own correctness.
 *
 * Documented equivalents (verified empirically, `bun -e`, before accepting):
 *   - 253:21-253:34 MethodExpression (`pool.slice(1)` -> `pool` in the
 *     least-conn loop). Re-including `pool[0]` in the loop is a no-op:
 *     `best`/`bestN` are already seeded from `pool[0]`, and the strict `<`
 *     comparison against itself (`n < bestN` with `n === bestN`) is always
 *     false, so the outcome is identical regardless of whether `pool[0]` is
 *     revisited.
 *   - 265:9-265:19 ConditionalExpression/EqualityOperator (`total <= 0`
 *     boundary on the weighted fallback). Unreachable with more than one
 *     pool member: target weights always go through `Math.max(1, t.weight)`
 *     (floored at 1), so `total <= 0` can only be true when there are ZERO
 *     enabled targets — leaving a single-member pool where
 *     `pool[0] === pool[pool.length - 1]` trivially, making the early
 *     return and the loop's eventual fallback identical.
 *   - 296:7-13 EqualityOperator (`n <= 0` -> `n < 0`). The only value this
 *     changes is `n === 0` exactly, where real code deletes the map entry
 *     and the mutant explicitly sets it to `0` instead — both read back as
 *     `0` via the `?? 0` fallback everywhere `inflight.get(key)` is
 *     consulted, and nothing in this module exposes map size/presence
 *     directly, so the two states are unobservable from any exported
 *     function.
 *   - 209:27-209:43 / 210:28-210:47 ArrowFunction (`nowFn`/`randFn`'s
 *     module-level initial values, `() => Date.now()`/`() => Math.random()`,
 *     each emptied to `() => undefined`). Unreachable within this test
 *     PROCESS specifically: every test file that imports this module (this
 *     one and the original load-balancer.test.ts) resets both via
 *     `__resetLbForTesting()` in its own `beforeEach`, which reassigns them
 *     to DIFFERENT, textually-identical arrow functions defined inside
 *     `__resetLbForTesting` itself (lines 305/306 — separately tested
 *     below). Since `bun test` runs every file in one shared process and
 *     at least one resetting `beforeEach` always fires before any test's
 *     assertions, both are guaranteed to already be the reset-function's
 *     own closures by the time anything observes them — these module-
 *     load-time-only initial values are never read again.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import {
  getLb,
  setLb,
  addUpstream,
  updateUpstream,
  selectTarget,
  markTargetDown,
  incInflight,
  decInflight,
  __resetLbForTesting,
  __setLbDepsForTesting,
  type LbConfig,
  type LbTarget,
} from "../../tool-policies/load-balancer.js";
import type { RestToolDefinition } from "../../mcp/types.js";

const CLIENT = "lbmsvc";
const getTool: RestToolDefinition = {
  name: "get-x",
  method: "GET",
  endpoint: "/x",
  description: "x",
  inputSchema: { type: "object", properties: {} },
};
async function reg(): Promise<void> {
  await registry.register(CLIENT, [getTool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}
async function regMcp(): Promise<void> {
  await registry.registerMcp(CLIENT, [], "http://1.2.3.4/mcp", "streamable-http", "1.2.3.4", "1.2.3.4");
}

const clientLike = { name: CLIENT, base_url: "http://1.2.3.4", resolved_ip: "1.2.3.4" };
function target(id: number, host: string, weight = 1, enabled = true): LbTarget {
  return { id, baseUrl: `http://${host}`, resolvedIp: host, weight, enabled };
}
function lbCfg(strategy: LbConfig["strategy"], targets: LbTarget[], primaryWeight = 1, enabled = true): LbConfig {
  return { strategy, primaryWeight, enabled, targets };
}

function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  __resetDbForTesting();
  __resetLbForTesting();
  removeCircuitBreaker(CLIENT);
}

beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});

// 109:7-109:29 ConditionalExpression [Survived] (`client.kind !== "rest"`
// forced always-false) / 109:58-109:68 StringLiteral [Survived] ("NOT_REST"
// emptied). No existing test ever registers a non-REST (MCP-kind) client.
describe("isRestClient — NOT_REST for a non-REST client", () => {
  test("an MCP-kind client is rejected with the exact NOT_REST error", async () => {
    await regMcp();
    expect(setLb(CLIENT, { strategy: "round-robin", primaryWeight: 1, enabled: true })).toEqual({
      ok: false,
      error: "NOT_REST",
    });
  });
});

// 104:71-104:83 StringLiteral [Survived] ("least-conn" emptied in the
// STRATEGIES allowlist).
describe("setLb — strategy allowlist", () => {
  test("'least-conn' is a valid strategy", async () => {
    await reg();
    expect(setLb(CLIENT, { strategy: "least-conn", primaryWeight: 1, enabled: true })).toEqual({ ok: true });
  });
});

// 127:*/128:* — setLb's primaryWeight validation triple-boundary
// (!Number.isInteger || <0 || >1000) and the exact INVALID_WEIGHT object.
describe("setLb — primaryWeight boundaries", () => {
  test("0 and 1000 are valid (inclusive boundaries)", async () => {
    await reg();
    expect(setLb(CLIENT, { strategy: "round-robin", primaryWeight: 0, enabled: true })).toEqual({ ok: true });
    expect(setLb(CLIENT, { strategy: "round-robin", primaryWeight: 1000, enabled: true })).toEqual({ ok: true });
  });

  test("-1 and 1001 are rejected with the exact INVALID_WEIGHT object", async () => {
    await reg();
    expect(setLb(CLIENT, { strategy: "round-robin", primaryWeight: -1, enabled: true })).toEqual({
      ok: false,
      error: "INVALID_WEIGHT",
    });
    expect(setLb(CLIENT, { strategy: "round-robin", primaryWeight: 1001, enabled: true })).toEqual({
      ok: false,
      error: "INVALID_WEIGHT",
    });
  });
});

// 147:50-147:63 EqualityOperator [Survived] (`weight > 1000` -> `>= 1000`
// in addUpstream).
describe("addUpstream — weight upper boundary", () => {
  test("1000 is valid, 1001 is rejected", async () => {
    await reg();
    const ok = await addUpstream(CLIENT, "http://5.6.7.8", 1000);
    expect(ok.ok).toBe(true);
    const rejected = await addUpstream(CLIENT, "http://9.9.9.9", 1001);
    expect(rejected).toMatchObject({ ok: false, error: "INVALID_WEIGHT" });
  });
});

// 173:*/174:* — updateUpstream's weight patch validation, structurally
// identical to setLb's primaryWeight cluster above.
describe("updateUpstream — weight boundaries", () => {
  test("1 and 1000 are valid (inclusive boundaries)", async () => {
    await reg();
    const added = await addUpstream(CLIENT, "http://5.6.7.8", 5);
    const id = (added as { ok: true; id: number }).id;
    expect(updateUpstream(CLIENT, id, { weight: 1 })).toEqual({ ok: true });
    expect(updateUpstream(CLIENT, id, { weight: 1000 })).toEqual({ ok: true });
  });

  test("0 and 1001 are rejected with the exact INVALID_WEIGHT object", async () => {
    await reg();
    const added = await addUpstream(CLIENT, "http://5.6.7.8", 5);
    const id = (added as { ok: true; id: number }).id;
    expect(updateUpstream(CLIENT, id, { weight: 0 })).toEqual({ ok: false, error: "INVALID_WEIGHT" });
    expect(updateUpstream(CLIENT, id, { weight: 1001 })).toEqual({ ok: false, error: "INVALID_WEIGHT" });
  });

  // 173:7-173:33 EqualityOperator [Survived] (`patch.weight !== undefined`).
  // Omitting weight entirely must skip weight validation/writes altogether.
  test("omitting weight entirely skips weight validation and leaves it unchanged", async () => {
    await reg();
    setLb(CLIENT, { strategy: "round-robin", primaryWeight: 1, enabled: true });
    const added = await addUpstream(CLIENT, "http://5.6.7.8", 7);
    const id = (added as { ok: true; id: number }).id;
    expect(updateUpstream(CLIENT, id, { enabled: false })).toEqual({ ok: true });
    expect(getLb(CLIENT)?.targets[0]).toMatchObject({ weight: 7, enabled: false });
  });

  // 184:7-184:33 ConditionalExpression [Survived] (`if (patch.enabled !==
  // undefined)` forced always-true). Omitting `enabled` entirely must leave
  // the target's current enabled state untouched.
  test("omitting enabled entirely leaves the current enabled state untouched", async () => {
    await reg();
    setLb(CLIENT, { strategy: "round-robin", primaryWeight: 1, enabled: true });
    const added = await addUpstream(CLIENT, "http://5.6.7.8", 3); // enabled defaults true
    const id = (added as { ok: true; id: number }).id;
    expect(updateUpstream(CLIENT, id, { weight: 9 })).toEqual({ ok: true });
    expect(getLb(CLIENT)?.targets[0]).toMatchObject({ weight: 9, enabled: true });
  });
});

describe("selectTarget — disabled targets are never selected", () => {
  // 233:8-234:32 MethodExpression [Survived] (`lb.targets.filter((t) =>
  // t.enabled).map(...)` collapsed to raw `lb.targets` — a disabled target
  // would then be selectable).
  test("a disabled target is never returned, even cycling many times", () => {
    const lb = lbCfg("round-robin", [target(1, "5.6.7.8", 1, false)]);
    for (let i = 0; i < 5; i++) {
      expect(selectTarget(clientLike, lb).isPrimary).toBe(true);
    }
  });
});

describe("selectTarget — weighted strategy", () => {
  // 242:17-242:38 MethodExpression [Survived] (`Math.max(1, t.weight)` ->
  // `Math.min(1, t.weight)`). Two targets with DIFFERENT weights (5 and 1)
  // plus a zero-weight primary make the real vs. floored-to-1 total diverge
  // sharply for the same fixed rand — real picks targetA, the mutant
  // (treating targetA's weight as min(1,5)=1 instead of 5) picks targetB.
  test("uses the real (not floored-to-1) target weight in the proportional total", () => {
    const lb = lbCfg("weighted", [target(1, "5.6.7.8", 5), target(2, "9.9.9.9", 1)], 0);
    __setLbDepsForTesting({ rand: () => 0.5 });
    const result = selectTarget(clientLike, lb);
    expect(result.baseUrl).toBe("http://5.6.7.8");
  });

  // 269:11-269:16 EqualityOperator [Survived] (`r < 0` -> `r <= 0`). The
  // boundary must be hit at a NON-last member to distinguish `<` from
  // `<=`: primaryWeight=1, one target weight=1, rand=0.5 -> r=1.0. Real:
  // subtracting the primary's weight lands r at EXACTLY 0 (`0 < 0` is
  // false) so the loop continues to the target, which it correctly picks.
  // The `<=` mutant would wrongly stop at the primary right there.
  test("an exact-zero remainder after subtracting a NON-last member's weight does not stop early", () => {
    const lb = lbCfg("weighted", [target(1, "5.6.7.8", 1)], 1);
    __setLbDepsForTesting({ rand: () => 0.5 });
    const result = selectTarget(clientLike, lb);
    expect(result.isPrimary).toBe(false);
  });

  // 248:16-248:34 EqualityOperator [Survived] (`healthy.length > 0` ->
  // `>= 0`). When EVERY member is cooling (healthy.length === 0 exactly),
  // must fall back to the full member set, not select from an empty array.
  test("every member cooling down at once still returns a valid choice from the full set", () => {
    __setLbDepsForTesting({ now: () => 1000 });
    const lb = lbCfg("round-robin", [target(1, "5.6.7.8")]);
    markTargetDown(`${CLIENT}#http://1.2.3.4`);
    markTargetDown(`${CLIENT}#http://5.6.7.8`);
    let result: ReturnType<typeof selectTarget> | undefined;
    expect(() => {
      result = selectTarget(clientLike, lb);
    }).not.toThrow();
    expect(["http://1.2.3.4", "http://5.6.7.8"]).toContain(result!.baseUrl);
  });

  // 263:*/271:* — the whole `if (lb.strategy === "weighted")` block must
  // actually run (not silently fall through to round-robin), and the
  // bottom fallback `pool[pool.length - 1]` (not `pool.length + 1`, which
  // would index out of bounds and throw).
  test("a heavily-skewed weight keeps picking the SAME member across repeated calls (round-robin would alternate)", () => {
    const lb = lbCfg("weighted", [target(1, "5.6.7.8", 1)], 100);
    __setLbDepsForTesting({ rand: () => 0.99 });
    const picks = [1, 2, 3].map(() => selectTarget(clientLike, lb).isPrimary);
    expect(picks).toEqual([true, true, true]);
  });

  test("randFn returning exactly 1.0 (loop never matches) falls back to the LAST pool member without throwing", () => {
    const lb = lbCfg("weighted", [target(1, "5.6.7.8", 1)], 1);
    __setLbDepsForTesting({ rand: () => 1 });
    let result: ReturnType<typeof selectTarget> | undefined;
    expect(() => {
      result = selectTarget(clientLike, lb);
    }).not.toThrow();
    expect(result?.isPrimary).toBe(false);
  });
});

describe("selectTarget — least-conn tie-breaking and correctness", () => {
  // 255:11-255:20 ConditionalExpression/EqualityOperator [Survived] (`n <
  // bestN` forced true, or flipped to `<=`). A tie must keep the EARLIER
  // member (primary), not switch to a later one with an EQUAL count.
  test("an exact tie in in-flight count keeps the earlier member (primary), not the later one", () => {
    const lb = lbCfg("least-conn", [target(1, "5.6.7.8")]);
    incInflight(`${CLIENT}#http://1.2.3.4`);
    incInflight(`${CLIENT}#http://5.6.7.8`);
    expect(selectTarget(clientLike, lb).isPrimary).toBe(true);
  });

  test("a target with MORE in-flight calls than the primary does not wrongly win", () => {
    const lb = lbCfg("least-conn", [target(1, "5.6.7.8")]);
    incInflight(`${CLIENT}#http://5.6.7.8`);
    incInflight(`${CLIENT}#http://5.6.7.8`);
    expect(selectTarget(clientLike, lb).isPrimary).toBe(true);
  });
});

// 247:41-247:86 EqualityOperator [Survived] (cooldown `<= now` -> `< now`).
describe("health cooldown — exact boundary", () => {
  test("a target's cooldown expiring at EXACTLY `now` is already healthy again", () => {
    __setLbDepsForTesting({ now: () => 1000 });
    const lb = lbCfg("round-robin", [target(1, "5.6.7.8")]);
    markTargetDown(`${CLIENT}#http://1.2.3.4`); // cools the primary, until 1000 + cooldownMs
    const cooledUntil = 1000 + config.lbTargetCooldownMs;
    __setLbDepsForTesting({ now: () => cooledUntil }); // exactly the boundary tick
    expect(selectTarget(clientLike, lb).isPrimary).toBe(true);
  });
});

describe("decInflight", () => {
  // 296:7-13 ConditionalExpression [Survived] (`n <= 0` forced always-true)
  // / EqualityOperator (`n > 0`). A count that's still POSITIVE after
  // decrementing must stay tracked, not be wiped back to untracked (0).
  test("a still-positive count after decrementing stays tracked, not reset", () => {
    const key = `${CLIENT}#http://5.6.7.8`;
    for (let i = 0; i < 5; i++) incInflight(key);
    decInflight(key); // 5 -> 4, must remain tracked at 4

    const lb = lbCfg("least-conn", [target(1, "5.6.7.8")]);
    incInflight(`${CLIENT}#http://1.2.3.4`);
    incInflight(`${CLIENT}#http://1.2.3.4`);
    incInflight(`${CLIENT}#http://1.2.3.4`); // primary=3, target should be 4 (kept) not 0 (wiped)
    expect(selectTarget(clientLike, lb).isPrimary).toBe(true);
  });

  // 295:14-295:36 LogicalOperator [Survived] (`?? 0` flipped to `&& 0`).
  test("decrementing an untracked key computes -1, not NaN (?? not &&)", () => {
    const key = `${CLIENT}#http://5.6.7.8`;
    expect(() => decInflight(key)).not.toThrow();
    // A key that was never incremented decrements to -1 (real: (undefined??0)-1)
    // and since -1 <= 0, gets deleted — observable via a least-conn tie against
    // an untouched primary (both read back as 0, a tie favors primary).
    const lb = lbCfg("least-conn", [target(1, "5.6.7.8")]);
    expect(selectTarget(clientLike, lb).isPrimary).toBe(true);
  });

  test("ConditionalExpression forced-false (never delete) would leak a negative count past zero", () => {
    const key = `${CLIENT}#http://5.6.7.8`;
    incInflight(key); // 1
    decInflight(key); // 1 -> 0, deleted
    decInflight(key); // (undefined??0)-1 = -1, deleted again (no-op)

    // Real: key ends up absent, reading as 0 via `?? 0` — a tie against an
    // untouched primary (also 0) favors the earlier member (primary).
    const lb = lbCfg("least-conn", [target(1, "5.6.7.8")]);
    expect(selectTarget(clientLike, lb).isPrimary).toBe(true);
  });

  // 295:13-295:41 ArithmeticOperator [Survived] (`(inflight.get(key) ?? 0)
  // - 1` flipped to `+ 1`). A count of 3, decremented once, must land at 2
  // (not 4) — comparing against a primary fixed at 3 distinguishes them.
  test("decrementing actually subtracts, not adds", () => {
    const key = `${CLIENT}#http://5.6.7.8`;
    for (let i = 0; i < 3; i++) incInflight(key);
    decInflight(key); // real: 3 -> 2; mutant: 3 -> 4

    const lb = lbCfg("least-conn", [target(1, "5.6.7.8")]);
    incInflight(`${CLIENT}#http://1.2.3.4`);
    incInflight(`${CLIENT}#http://1.2.3.4`);
    incInflight(`${CLIENT}#http://1.2.3.4`); // primary=3
    // Real: target(2) < primary(3) -> target wins. Mutant: target(4) >
    // primary(3) -> primary wins instead.
    expect(selectTarget(clientLike, lb).isPrimary).toBe(false);
  });
});

describe("__resetLbForTesting / __setLbDepsForTesting", () => {
  // 305:11-305:27 ArrowFunction [Survived] (`nowFn = () => Date.now()` ->
  // `() => undefined`). After resetting, nowFn must genuinely delegate to
  // the real (here, spied) `Date.now`.
  test("__resetLbForTesting restores nowFn to actually call Date.now", () => {
    __setLbDepsForTesting({ now: () => 999 });
    __resetLbForTesting();
    const dateSpy = spyOn(Date, "now").mockReturnValue(123_456_789);
    try {
      lbCfg("round-robin", [target(1, "5.6.7.8")]);
      markTargetDown(`${CLIENT}#http://1.2.3.4`);
      expect(dateSpy).toHaveBeenCalled();
    } finally {
      dateSpy.mockRestore();
    }
  });

  // 306:12-306:31 ArrowFunction [Survived] (`randFn = () => Math.random()`
  // -> `() => undefined`). After resetting, randFn must genuinely delegate
  // to the real (here, spied) `Math.random`.
  test("__resetLbForTesting restores randFn to actually call Math.random", () => {
    __setLbDepsForTesting({ rand: () => 0.1 });
    __resetLbForTesting();
    const randomSpy = spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const lb = lbCfg("weighted", [target(1, "5.6.7.8", 1)], 1);
      selectTarget(clientLike, lb);
      expect(randomSpy).toHaveBeenCalled();
    } finally {
      randomSpy.mockRestore();
    }
  });

  // 312:7-312:16 ConditionalExpression [Survived] (`if (deps.rand)` forced
  // always-true). Calling with only `now` must NOT null out randFn.
  test("passing only `now` does not clobber randFn to undefined", () => {
    __setLbDepsForTesting({ now: () => 12345 });
    const lb = lbCfg("weighted", [target(1, "5.6.7.8", 1)], 1);
    expect(() => selectTarget(clientLike, lb)).not.toThrow();
  });
});

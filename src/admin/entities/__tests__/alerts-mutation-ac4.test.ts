/**
 * Stryker mutation-testing backstop for src/observability/alerts.ts — cluster ac4:
 * evaluateCondition's "usage_spike", "schema_drift", and "default" switch cases
 * (lines 168-196), plus dispatchAlertWebhook (lines 199-210). Test dir is
 * CROSS-DIRECTORY (same convention as this file's sibling anomaly-mutation.test.ts /
 * monitor-mutation.test.ts, the existing dedicated alerts.test.ts, and sibling
 * clusters alerts-mutation-ac1/ac2/ac3/ac5.test.ts): the source lives at
 * src/observability/alerts.ts but its tests live under src/admin/entities/__tests__/.
 *
 * Baseline: reports/mutation/result.json, 161 total mutants for this file, 91 survived.
 * Of those, 17 fall in this cluster's line range (168-210) and are targeted below. Every
 * id/line:col/mutatorName/replacement citation was read directly from that report
 * (mutants array filtered to location.start.line in [168,210] and status !== "Killed"),
 * not transcribed from prose:
 *
 *   92  171:22-171:41 LogicalOperator        `rule.threshold ?? 3` -> `rule.threshold && 3`
 *   93  172:24-172:43 LogicalOperator        `rule.minCalls ?? 20` -> `rule.minCalls && 20`
 *   94  173:34-173:54 ObjectLiteral          `{ factor, minCalls }` (arg to detectUsageSpike) -> `{}`
 *   96  176:17-182:10 ObjectLiteral          usage_spike's whole `detail: {...}` value -> `{}`
 *   97  178:29-178:65 ArithmeticOperator     `Math.round(...) / 100` -> `Math.round(...) * 100` (recentRatePerMin)
 *   98  178:40-178:58 ArithmeticOperator     `r.recentRate * 100` -> `r.recentRate / 100` (recentRatePerMin)
 *   99  179:31-179:69 ArithmeticOperator     `Math.round(...) / 100` -> `Math.round(...) * 100` (baselineRatePerMin)
 *   100 179:42-179:62 ArithmeticOperator     `r.baselineRate * 100` -> `r.baselineRate / 100` (baselineRatePerMin)
 *   104 191:30-191:71 ArrowFunction          `.map((r) => \`...\`)` -> `() => undefined` (schema_drift tools)
 *   105 191:37-191:71 StringLiteral          the template literal -> `` `` `` (schema_drift tools)
 *   111 192:50-192:59 ObjectLiteral          `{ tools }` (schema_drift detail) -> `{}`
 *   112 194:5-195:44  ConditionalExpression  whole `default:` case (label+body) -> bare `default:` (no return)
 *   113 195:14-195:43 ObjectLiteral          `{ active: false, detail: {} }` -> `{}`
 *   114 195:24-195:29 BooleanLiteral         `false` (default's active) -> `true`
 *   118 205:27-205:55 StringLiteral          "Alert webhook URL rejected" -> ""
 *   119 206:25-206:56 StringLiteral          "Alert webhook delivery failed" -> ""
 *   120 207:19-207:38 ObjectLiteral          `{ rule: rule.name }` (logContext) -> `{}`
 *
 * Documented equivalent (verified empirically, not assumed) — id=113:
 *   Replacing the default case's return value `{ active: false, detail: {} }` with
 *   `{}` makes `evaluateCondition` return an object where `active` is `undefined`
 *   instead of `false`, and `detail` is `undefined` instead of `{}`. `evaluateAlerts`
 *   (the only caller) does `const { active, detail } = evaluateCondition(rule); ...
 *   if (active && !was) { ...; await dispatchAlertWebhook(rule, detail); ... } else if
 *   (!active && was) { lastState.set(rule.id, false); }`. Both `undefined` and `false`
 *   are falsy, so every branch that inspects `active` in a boolean context (`active &&
 *   !was`, `!active && was`) evaluates IDENTICALLY for the real `false` and the
 *   mutant's `undefined` — for every possible prior `was` state (`lastState` only ever
 *   holds `true`/`false`, seeded by `__resetAlertStateForTesting`/eviction, never
 *   settable to `true` by a default-case rule in the first place, since that would
 *   require `active` to already be truthy). `detail` is only ever read inside the
 *   `active && !was` branch, which never executes for either variant (both `active`
 *   values are falsy) — so `detail`'s divergence (`undefined` vs `{}`) is also never
 *   observed. Verified with a standalone .mjs scratch script (not checked into the
 *   repo) that reproduces evaluateAlerts' exact destructure-and-branch logic and
 *   runs it against both `{ active: false, detail: {} }` and `{}` for every
 *   reachable `was` value (`true`, `false`, `undefined`) — outputs (dispatched:
 *   bool, nextState) were identical in all 3 cases. No test can distinguish this
 *   mutant from real code.
 *
 * evaluateCondition itself is not exported, so every usage_spike/schema_drift/default
 * test drives it indirectly via evaluateAlerts() + a spy on the (named-import,
 * live-binding) dispatchWebhook export — the same technique already proven for this
 * exact pattern in monitor-mutation.test.ts and this file's own ac2/ac3/ac5 siblings.
 * usage_spike calls are seeded as raw tool_call_log rows (mirroring
 * anomaly-mutation.test.ts's own seed() helper and ac3's identical technique for
 * error_rate), timed relative to the real default windows (recentWindow 5 min,
 * baselineWindow 60 min, per config.ts's anomalyRecentWindowMs/anomalyBaselineWindowMs
 * defaults) since detectUsageSpike is invoked here with no explicit `now` override.
 * schema_drift rows are seeded directly into tool_monitor (FK'd to tools(client_name,
 * name), hence the `reg()` registration first), mirroring alerts.test.ts's own
 * "fires a webhook on schema drift" test.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { config } from "../../../config.js";
import { __resetDbForTesting, getDb } from "../../../db/connection.js";
import { registry } from "../../../mcp/registry.js";
import * as webhookMod from "../../../lib/webhook.js";
import {
  createAlertRule,
  evaluateAlerts,
  __resetAlertStateForTesting,
  type AlertEventType,
} from "../../../observability/alerts.js";
import type { RestToolDefinition } from "../../../mcp/types.js";

const MIN = 60_000;

function makeTool(): RestToolDefinition {
  return {
    name: "get-users",
    method: "GET",
    endpoint: "/users",
    description: "list",
    inputSchema: { type: "object", properties: {} },
  };
}
async function reg(name: string): Promise<void> {
  await registry.register(name, [makeTool()], "http://example.com/health", "1.2.3.4", "http://example.com", "1.2.3.4");
}

/** Seeds `count` tool_call_log rows for client "svc" at a fixed timestamp. */
function seedCalls(count: number, createdAt: number): void {
  const db = getDb();
  const stmt = db.query(
    `INSERT INTO tool_call_log (client_name, tool_name, key_id, status_class, is_error, duration_ms, created_at) VALUES ('svc','t',NULL,'2xx',0,5,?)`,
  );
  for (let i = 0; i < count; i++) stmt.run(createdAt);
}

function makeUsageSpikeRule(threshold: number | null, minCalls: number | null) {
  return createAlertRule({
    name: "spike",
    eventType: "usage_spike",
    webhookUrl: "http://127.0.0.1:9/hook",
    threshold,
    minCalls,
    actor: null,
  });
}

const originalAllowPrivate = config.allowPrivateIps;

beforeEach(async () => {
  __resetDbForTesting();
  __resetAlertStateForTesting();
  (config as Record<string, unknown>).allowPrivateIps = true;
  for (const c of registry.listClients()) await registry.unregister(c.name);
});
afterEach(async () => {
  (config as Record<string, unknown>).allowPrivateIps = originalAllowPrivate;
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

describe("evaluateCondition — usage_spike: threshold/minCalls defaults use ?? (not &&)", () => {
  // Kills 92 (171:22 LogicalOperator -> `rule.threshold && 3`). A truthy explicit
  // threshold (2) is used as-is by `??`; `&&` would instead collapse it to the
  // literal default (3), which here flips `active` from true to false.
  test("an explicit truthy threshold(factor) is honored as-is, not collapsed to the literal default", async () => {
    const now = Date.now();
    seedCalls(60, now - 30 * MIN); // baseline: 60 calls over the 60-min window -> baselineRate 1/min
    seedCalls(10, now - 30_000); // recent: 10 calls over the 5-min window -> recentRate 2/min
    makeUsageSpikeRule(2, 1); // real: 2 >= 1*2 -> true. mutant (factor forced to 3): 2 >= 1*3 -> false.
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      await evaluateAlerts();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  // Kills 93 (172:24 LogicalOperator -> `rule.minCalls && 20`). A truthy explicit
  // minCalls (15) is used as-is by `??`; `&&` would instead collapse it to the
  // literal default (20), which here flips `active` from true to false.
  test("an explicit truthy minCalls is honored as-is, not collapsed to the literal default", async () => {
    const now = Date.now();
    seedCalls(15, now - 30_000); // recent: exactly minCalls(15), silent baseline (0 calls)
    makeUsageSpikeRule(null, 15); // real: 15 >= 15 -> true, baselineRate 0 -> spike true.
    // mutant (minCalls forced to 20): 15 >= 20 -> false -> spike stays false.
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      await evaluateAlerts();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("evaluateCondition — usage_spike: detectUsageSpike is called with the rule's own options (kills 94)", () => {
  // If the `{ factor, minCalls }` argument object were erased to `{}` (94),
  // detectUsageSpike would silently fall back to its OWN internal defaults
  // (factor 3, minCalls 20) instead of the rule's configured values. Using a
  // rule minCalls (5) well below anomaly.ts's own default (20) isolates this:
  // real code honors 5, the mutant would ignore it and use 20.
  test("a low explicit minCalls actually gates firing through to detectUsageSpike, not silently ignored", async () => {
    const now = Date.now();
    seedCalls(5, now - 30_000); // recent: exactly rule.minCalls(5), silent baseline
    makeUsageSpikeRule(null, 5); // real: 5 >= 5 -> true, baselineRate 0 -> spike true.
    // mutant (args erased -> detectUsageSpike({})): internal minCalls default 20 -> 5 >= 20 false -> no fire.
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      await evaluateAlerts();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("evaluateCondition — usage_spike: detail payload exact shape and rounding", () => {
  // Kills:
  //   96  176:17-182:10 ObjectLiteral      whole `detail: {...}` -> `{}` (every key dropped)
  //   97  178:29-178:65 ArithmeticOperator recentRatePerMin's outer `/100` -> `*100`
  //   98  178:40-178:58 ArithmeticOperator recentRatePerMin's inner `*100` -> `/100`
  //   99  179:31-179:69 ArithmeticOperator baselineRatePerMin's outer `/100` -> `*100`
  //   100 179:42-179:62 ArithmeticOperator baselineRatePerMin's inner `*100` -> `/100`
  // Non-round rates (1.4, 1.5) make every one of these mutants produce a
  // wildly different (or zeroed) number from the real rounded value, so a
  // single exact toEqual on the dispatched detail catches all five.
  test("dispatches recentCalls/recentRatePerMin/baselineRatePerMin/factor/minCalls with exact values", async () => {
    const now = Date.now();
    seedCalls(90, now - 30 * MIN); // baseline: 90 calls / 60 min -> baselineRate 1.5/min
    seedCalls(7, now - 30_000); // recent: 7 calls / 5 min -> recentRate 1.4/min
    makeUsageSpikeRule(0.5, 1); // real: 7 >= 1 true; baselineRate 1.5 != 0; 1.4 >= 1.5*0.5(=0.75) -> true
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      await evaluateAlerts();
      expect(spy).toHaveBeenCalledTimes(1);
      const [, payload] = spy.mock.calls[0] as [string, { detail: Record<string, unknown> }, unknown];
      expect(payload.detail).toEqual({
        recentCalls: 7,
        recentRatePerMin: 1.4,
        baselineRatePerMin: 1.5,
        factor: 0.5,
        minCalls: 1,
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("evaluateCondition — schema_drift: detail.tools exact formatted names", () => {
  // Kills:
  //   104 191:30-191:71 ArrowFunction  `.map((r) => \`...\`)` -> `() => undefined`
  //       (every tools[] entry becomes undefined instead of "client__tool")
  //   105 191:37-191:71 StringLiteral  the template literal -> `` (every tools[]
  //       entry becomes "" instead of "client__tool")
  //   111 192:50-192:59 ObjectLiteral  `{ tools }` -> `{}` (detail drops the
  //       tools key entirely)
  // A single exact toEqual against the fully-formatted detail.tools array
  // distinguishes all three: none of them can still produce
  // `{ tools: ["svc__get-users"] }`.
  test("dispatches detail.tools as exact client__tool strings for drifted rows", async () => {
    await reg("svc");
    getDb()
      .query(
        `INSERT INTO tool_monitor (client_name, tool_name, example_id, baseline_schema_hash, drift_detected, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("svc", "get-users", 1, "deadbeef", 1, Date.now());
    createAlertRule({
      name: "drift",
      eventType: "schema_drift",
      webhookUrl: "http://127.0.0.1:9/hook",
      threshold: null,
      minCalls: null,
      actor: null,
    });
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      await evaluateAlerts();
      expect(spy).toHaveBeenCalledTimes(1);
      const [, payload] = spy.mock.calls[0] as [string, { detail: Record<string, unknown> }, unknown];
      expect(payload.detail).toEqual({ tools: ["svc__get-users"] });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("evaluateCondition — default case for an unrecognized eventType", () => {
  // Kills 112 (194:5-195:44 ConditionalExpression -> bare `default:`, body
  // erased): with no matching case and an emptied default, evaluateCondition
  // falls off the end of the function and returns `undefined`; evaluateAlerts'
  // `const { active, detail } = evaluateCondition(rule)` then throws a
  // TypeError destructuring `undefined`, rejecting evaluateAlerts()'s promise
  // — real code must return a plain object and never throw here.
  // Kills 114 (195:24-195:29 BooleanLiteral -> `true`): real code's default
  // case is always inactive (`active: false`), so an unrecognized eventType
  // must never fire a webhook; the mutant would fire on every evaluation.
  //
  // (113 — `{ active: false, detail: {} }` -> `{}` — is a documented equivalent
  // for this exact call path; see the file header for the empirical proof. Both
  // this test's assertions hold identically whether the mutant returns `{}` or
  // the real object, since `active` is falsy either way and `detail` is never
  // read when `active` is falsy.)
  test("does not throw and does not fire a webhook for an unrecognized eventType", async () => {
    createAlertRule({
      name: "unknown-type",
      eventType: "totally_bogus_event_type" as unknown as AlertEventType,
      webhookUrl: "http://127.0.0.1:9/hook",
      threshold: null,
      minCalls: null,
      actor: null,
    });
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      await evaluateAlerts(); // must resolve cleanly, not throw/reject
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("dispatchAlertWebhook — exact log-message/logContext options payload", () => {
  // Kills:
  //   118 205:27-205:55 StringLiteral  "Alert webhook URL rejected" -> ""
  //   119 206:25-206:56 StringLiteral  "Alert webhook delivery failed" -> ""
  //   120 207:19-207:38 ObjectLiteral  `{ rule: rule.name }` (logContext) -> `{}`
  test("passes the exact rejectedLogMessage/failedLogMessage/logContext to dispatchWebhook", async () => {
    await reg("svc-opts");
    registry.markClientStatus("svc-opts", "unreachable");
    createAlertRule({
      name: "opts-rule",
      eventType: "client_unreachable",
      webhookUrl: "http://127.0.0.1:9/hook",
      threshold: null,
      minCalls: null,
      actor: null,
    });
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      await evaluateAlerts();
      expect(spy).toHaveBeenCalledTimes(1);
      const [, , options] = spy.mock.calls[0] as [
        string,
        Record<string, unknown>,
        { rejectedLogMessage: string; failedLogMessage: string; logContext: Record<string, unknown> },
      ];
      expect(options.rejectedLogMessage).toBe("Alert webhook URL rejected");
      expect(options.failedLogMessage).toBe("Alert webhook delivery failed");
      expect(options.logContext).toEqual({ rule: "opts-rule" });
    } finally {
      spy.mockRestore();
    }
  });
});

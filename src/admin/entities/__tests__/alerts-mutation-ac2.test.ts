/**
 * Stryker mutation-testing backstop for src/observability/alerts.ts — cluster ac2:
 * evaluateCondition's "client_unreachable" and "circuit_breaker_open" switch cases
 * (lines 146-160 — the two cases right after the switch opens). Test dir is
 * CROSS-DIRECTORY (same convention as this file's sibling anomaly-mutation.test.ts /
 * monitor-mutation.test.ts, and the existing dedicated alerts.test.ts and sibling
 * clusters alerts-mutation-ac1.test.ts/ac3.test.ts): the source lives at
 * src/observability/alerts.ts but its tests live under src/admin/entities/__tests__/.
 *
 * Baseline: reports/mutation/result.json, 161 total mutants for this file, 91 survived.
 * Of those, 18 fall in this cluster's line range (146-160) and are targeted below. Every
 * id/line:col/mutatorName/replacement citation was read directly from that report
 * (mutants array filtered to location.start.line in [146,160] and status !== "Killed"),
 * not transcribed from prose:
 *
 *   48  152:14-152:27 ArrowFunction         `.map((c) => c.name)` -> `() => undefined`
 *   54  153:52-153:63 ObjectLiteral         `{ clients }` -> `{}` (client_unreachable detail)
 *   55  155:5-160:6   ConditionalExpression whole circuit_breaker_open case (label+body) -> bare
 *                                           `case "circuit_breaker_open":` (fallthrough)
 *   56  155:10-155:32 StringLiteral         case test `"circuit_breaker_open"` -> `""`
 *   57  155:34-160:6  BlockStatement        case body -> `{}` (fallthrough, same effect as 55)
 *   58  156:20-157:41 MethodExpression      `.filter(([, s]) => s === "open")` chain dropped entirely
 *   59  157:17-157:40 ArrowFunction         filter predicate -> `() => undefined` (always falsy)
 *   60  157:28-157:40 ConditionalExpression `s === "open"` -> `true`
 *   61  157:28-157:40 ConditionalExpression `s === "open"` -> `false`
 *   62  157:28-157:40 EqualityOperator      `s === "open"` -> `s !== "open"`
 *   63  157:34-157:40 StringLiteral         `"open"` -> `""`
 *   64  158:14-158:24 ArrowFunction         `.map(([n]) => n)` -> `() => undefined`
 *   65  159:14-159:68 ObjectLiteral         whole return object -> `{}`
 *   66  159:24-159:39 ConditionalExpression `open.length > 0` -> `true`
 *   67  159:24-159:39 ConditionalExpression `open.length > 0` -> `false`
 *   68  159:24-159:39 EqualityOperator      `open.length > 0` -> `open.length >= 0`
 *   69  159:24-159:39 EqualityOperator      `open.length > 0` -> `open.length <= 0`
 *   70  159:49-159:66 ObjectLiteral         `{ clients: open }` -> `{}` (circuit_breaker_open detail)
 *
 * No equivalents in this cluster — every survivor above is genuinely observable through
 * evaluateAlerts()'s dispatched webhook payload (event/detail) and the fire/no-fire
 * edge-trigger, given the right client-registry/circuit-breaker setup.
 *
 * evaluateCondition itself is not exported, so every test drives it indirectly via
 * evaluateAlerts() + a spy on the (named-import, live-binding) dispatchWebhook export —
 * the same technique already proven for this exact case in monitor-mutation.test.ts and
 * this file's own alerts-mutation-ac3.test.ts.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { config } from "../../../config.js";
import { __resetDbForTesting } from "../../../db/connection.js";
import { registry } from "../../../mcp/registry.js";
import { getCircuitBreaker, removeCircuitBreaker, getAllCircuitStates } from "../../../middleware/circuit-breaker.js";
import * as webhookMod from "../../../lib/webhook.js";
import { createAlertRule, evaluateAlerts, __resetAlertStateForTesting } from "../../../observability/alerts.js";
import type { RestToolDefinition } from "../../../mcp/types.js";

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

/** The breakers map is a module-level singleton shared across every test file in this
 * process, so every test that touches circuit state must clear it before AND after. */
function clearAllBreakers(): void {
  for (const name of Object.keys(getAllCircuitStates())) removeCircuitBreaker(name);
}

const originalAllowPrivate = config.allowPrivateIps;

beforeEach(async () => {
  __resetDbForTesting();
  __resetAlertStateForTesting();
  (config as Record<string, unknown>).allowPrivateIps = true;
  for (const c of registry.listClients()) await registry.unregister(c.name);
  clearAllBreakers();
});
afterEach(async () => {
  (config as Record<string, unknown>).allowPrivateIps = originalAllowPrivate;
  for (const c of registry.listClients()) await registry.unregister(c.name);
  clearAllBreakers();
});

describe("evaluateCondition — client_unreachable detail payload", () => {
  // Kills 48 (152:14 ArrowFunction -> `() => undefined`, which would turn every
  // entry of `clients` into `undefined` while leaving its length — and thus
  // `active` — unchanged) and 54 (153:52 ObjectLiteral `{ clients }` -> `{}`,
  // which would drop the `clients` key from `detail` entirely).
  test("dispatches the exact unreachable client name in detail.clients", async () => {
    await reg("svc-down");
    registry.markClientStatus("svc-down", "unreachable");
    createAlertRule({
      name: "down",
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
      const [url, payload] = spy.mock.calls[0] as [string, { event: string; detail: Record<string, unknown> }, unknown];
      expect(url).toBe("http://127.0.0.1:9/hook");
      expect(payload.event).toBe("client_unreachable");
      expect(payload.detail).toEqual({ clients: ["svc-down"] });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("evaluateCondition — circuit_breaker_open detail payload and edge cases", () => {
  // A genuinely-open breaker coexists with a genuinely-closed one, and no
  // tool_call_log rows exist, so:
  //  - any mutant that makes the case fall through to "error_rate" (55/56/57)
  //    resolves that case's `summary.calls (0) >= minCalls (10)` to false, so
  //    it never dispatches — divergence from the real, firing result;
  //  - any mutant that stops filtering by state (58/60) or filters wrongly
  //    (62) folds the closed breaker into `open` too, changing detail.clients
  //    from `["broken-client"]` to something else;
  //  - any mutant that empties/falsifies the predicate (59/61/63) or erases
  //    the whole result (65/70) makes `open` (or the return value) empty,
  //    so it never dispatches either.
  // Kills: 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 70.
  test("fires with detail.clients containing only the genuinely open breaker, excluding a closed one", async () => {
    getCircuitBreaker("broken-client", { failureThreshold: 1 }).recordFailure();
    getCircuitBreaker("healthy-client");
    expect(getAllCircuitStates()).toEqual({ "broken-client": "open", "healthy-client": "closed" });

    createAlertRule({
      name: "cb",
      eventType: "circuit_breaker_open",
      webhookUrl: "http://127.0.0.1:9/hook",
      threshold: null,
      minCalls: null,
      actor: null,
    });
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      await evaluateAlerts();
      expect(spy).toHaveBeenCalledTimes(1);
      const [url, payload] = spy.mock.calls[0] as [string, { event: string; detail: Record<string, unknown> }, unknown];
      expect(url).toBe("http://127.0.0.1:9/hook");
      expect(payload.event).toBe("circuit_breaker_open");
      expect(payload.detail).toEqual({ clients: ["broken-client"] });
    } finally {
      spy.mockRestore();
    }
  });

  // Kills 66 (159:24 ConditionalExpression `open.length > 0` -> `true`) and 68
  // (159:24 EqualityOperator -> `open.length >= 0`, always true since a length
  // can never be negative) — both would fire even with zero open breakers.
  // (67/69, the always-false variants, are already killed by the positive test
  // above: they'd wrongly suppress that genuine positive case.)
  test("does not fire when no breaker is open (a closed breaker exists but nothing is)", async () => {
    getCircuitBreaker("healthy-client");
    expect(getAllCircuitStates()).toEqual({ "healthy-client": "closed" });

    createAlertRule({
      name: "cb",
      eventType: "circuit_breaker_open",
      webhookUrl: "http://127.0.0.1:9/hook",
      threshold: null,
      minCalls: null,
      actor: null,
    });
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      await evaluateAlerts();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

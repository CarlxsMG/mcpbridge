/**
 * Stryker mutation-testing backstop for src/observability/alerts.ts — cluster ac5
 * (markFired lines 212-218, evaluateAlerts lines 221-237, sendTestAlert lines
 * 240-245, startAlertLoop lines 248-256). Test dir is CROSS-DIRECTORY (same
 * convention as this file's sibling anomaly-mutation.test.ts / monitor-mutation.test.ts,
 * the existing dedicated alerts.test.ts, and alerts-mutation-ac1.test.ts): the source
 * lives at src/observability/alerts.ts but its tests live under
 * src/admin/entities/__tests__/.
 *
 * Baseline: reports/mutation/result.json, 161 total mutants for this file. Of those,
 * 22 fall in this cluster's line range (212-256) and are targeted below. Every
 * id/line:col/mutatorName/replacement citation was read directly from that report
 * (mutants array filtered to location.start.line in [212,256] and status !== "Killed"),
 * not transcribed from prose:
 *
 *   121 BlockStatement          212:38-218:2   markFired body -> {}
 *   122 BlockStatement          213:7-215:4    markFired's try body -> {}
 *   123 StringLiteral           214:19-74      UPDATE ... SQL -> ``
 *   138 ConditionalExpression   233:16-30      `!active && was` -> true
 *   140 LogicalOperator         233:16-30      `!active && was` -> `!active || was`
 *   141 BooleanLiteral          233:16-23      `!active` -> `active`
 *   144 BlockStatement          240:92-245:2   sendTestAlert body -> {}
 *   145 BooleanLiteral          242:7-12       `!rule` -> `rule`
 *   146 ConditionalExpression   242:7-12       `!rule` -> true
 *   147 ConditionalExpression   242:7-12       `!rule` -> false
 *   148 ObjectLiteral           242:21-55      `{ ok: false, reason: "not found" }` -> {}
 *   149 BooleanLiteral          242:27-32      `false` (ok) -> true
 *   150 StringLiteral           242:42-53      `"not found"` -> ""
 *   151 ObjectLiteral           243:47-61      `{ test: true }` -> {}
 *   152 BooleanLiteral          243:55-59      `true` (test) -> false
 *   153 ObjectLiteral           244:10-16      `{ ok }` -> {}
 *   154 BlockStatement          248:46-256:2   startAlertLoop body -> {}
 *   155 ArrowFunction           250:5-253:8    outer tick fn -> () => undefined
 *   156 ArrowFunction           251:30-252:108 .catch(err => ...) handler -> () => undefined
 *   157 StringLiteral           252:13-19      "warn" -> ""
 *   158 StringLiteral           252:21-46      "Alert evaluation failed" -> ""
 *   159 ObjectLiteral           252:48-107     `{ error: ... }` -> {}
 *
 * No equivalents found in this cluster — all 22 are killed below by observable tests.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { config } from "../../../config.js";
import { __resetDbForTesting } from "../../../db/connection.js";
import { refreshLeaderStatus } from "../../../db/leader-lease.js";
import { registry } from "../../../mcp/registry.js";
import * as webhookMod from "../../../lib/webhook.js";
import * as loggerMod from "../../../logger.js";
import {
  createAlertRule,
  getAlertRule,
  evaluateAlerts,
  sendTestAlert,
  startAlertLoop,
  __resetAlertStateForTesting,
} from "../../../observability/alerts.js";
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

const originalFetch = globalThis.fetch;
const originalAllowPrivate = config.allowPrivateIps;

beforeEach(async () => {
  __resetDbForTesting();
  __resetAlertStateForTesting();
  (config as Record<string, unknown>).allowPrivateIps = true;
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  (config as Record<string, unknown>).allowPrivateIps = originalAllowPrivate;
  for (const c of registry.listClients()) await registry.unregister(c.name);
});

describe("markFired — persists last_fired_at (kills 121, 122, 123)", () => {
  test("updates the rule's last_fired_at column in the DB immediately after it fires", async () => {
    await reg("svc-markfired");
    registry.markClientStatus("svc-markfired", "unreachable");
    const rule = createAlertRule({
      name: "down",
      eventType: "client_unreachable",
      webhookUrl: "http://127.0.0.1:9/hook",
      threshold: null,
      minCalls: null,
      actor: null,
    });
    const webhookSpy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      expect(getAlertRule(rule.id)?.lastFiredAt).toBeNull();

      await evaluateAlerts();

      const after = getAlertRule(rule.id);
      // If the whole function body were gutted (121) or just its try block (122),
      // or the UPDATE's SQL string were blanked and silently swallowed by the
      // catch (123), last_fired_at would stay null instead of being stamped.
      expect(after?.lastFiredAt).not.toBeNull();
      expect(after?.lastFiredAt).toBeGreaterThan(0);
    } finally {
      webhookSpy.mockRestore();
    }
  });
});

describe("evaluateAlerts — edge-trigger state integrity (kills 138, 140, 141)", () => {
  test("does not re-dispatch while a condition stays continuously active across repeated evaluations", async () => {
    await reg("svc-persist");
    registry.markClientStatus("svc-persist", "unreachable");
    createAlertRule({
      name: "down-persist",
      eventType: "client_unreachable",
      webhookUrl: "http://127.0.0.1:9/hook",
      threshold: null,
      minCalls: null,
      actor: null,
    });
    const webhookSpy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      // Call 1: active=true, was=false -> fires (enters the `if`, not the `else if`).
      await evaluateAlerts();
      // Call 2: active=true, was=true -> real code takes neither branch (condition
      // `!active && was` is false). All three mutants at 233 make this branch's
      // guard evaluate truthy in this exact (active=true, was=true) state instead
      // (`true` outright; `!active || was` = `false || true`; `active && was` =
      // `true && true`), so a mutant spuriously resets lastState to false here even
      // though the condition never went inactive.
      await evaluateAlerts();
      // Call 3: with real code, was=true still -> no re-fire. With any of the three
      // mutants, the spurious reset at call 2 makes was=false here, so the `if`
      // re-fires a second, illegitimate dispatch.
      await evaluateAlerts();

      expect(webhookSpy).toHaveBeenCalledTimes(1);
    } finally {
      webhookSpy.mockRestore();
    }
  });
});

describe("sendTestAlert — missing rule (kills 144, 145, 147, 148, 149, 150)", () => {
  test("returns { ok: false, reason: 'not found' } for a non-existent id, without dispatching", async () => {
    const webhookSpy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      const result = await sendTestAlert(999_999);
      // Kills 148 (object -> {}), 149 (false -> true), 150 ("not found" -> "") by
      // pinning the exact shape/values, and 144 (whole body -> {}, would resolve
      // undefined instead). Kills 145 (`!rule` -> `rule`) and 147 (`!rule` -> `false`)
      // because with a null rule those mutants skip the early return and fall
      // through to `dispatchAlertWebhook(rule, ...)`, dereferencing `rule.webhookUrl`
      // on null and rejecting the awaited promise instead of resolving cleanly.
      expect(result).toEqual({ ok: false, reason: "not found" });
      expect(webhookSpy).not.toHaveBeenCalled();
    } finally {
      webhookSpy.mockRestore();
    }
  });
});

describe("sendTestAlert — existing rule (kills 144, 146, 151, 152, 153)", () => {
  test("dispatches the test payload and returns { ok: true } for an existing rule", async () => {
    const rule = createAlertRule({
      name: "test-alert",
      eventType: "circuit_breaker_open",
      webhookUrl: "http://127.0.0.1:9/hook",
      threshold: null,
      minCalls: null,
      actor: null,
    });
    const webhookSpy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      const result = await sendTestAlert(rule.id);
      // Kills 153 (`{ ok }` -> {}, would resolve {} so .ok is undefined) and 144
      // (whole body -> {}, would resolve undefined).
      expect(result).toEqual({ ok: true });
      // Kills 146 (`!rule` -> true): with an existing rule this would incorrectly
      // take the "not found" branch and never reach dispatchAlertWebhook at all.
      expect(webhookSpy).toHaveBeenCalledTimes(1);
      const payload = webhookSpy.mock.calls[0]?.[1] as { detail?: unknown } | undefined;
      // Kills 151 (`{ test: true }` -> {}) and 152 (`true` -> `false`).
      expect(payload?.detail).toEqual({ test: true });
    } finally {
      webhookSpy.mockRestore();
    }
  });
});

describe("startAlertLoop — return value (kills 154)", () => {
  test("returns a callable stop function", () => {
    const stop = startAlertLoop();
    try {
      expect(typeof stop).toBe("function");
    } finally {
      stop();
    }
  });
});

describe("startAlertLoop — immediate run + failure logging (kills 155, 156, 157, 158, 159)", () => {
  test("invokes evaluateAlerts immediately on start and logs a warning if it rejects", async () => {
    refreshLeaderStatus(); // startLeaderGatedInterval only runs `fn` when isLeader() is true
    await reg("svc-loop");
    registry.markClientStatus("svc-loop", "unreachable");
    createAlertRule({
      name: "down-loop",
      eventType: "client_unreachable",
      webhookUrl: "http://127.0.0.1:9/hook",
      threshold: null,
      minCalls: null,
      actor: null,
    });
    // Force evaluateAlerts() itself to reject, so we can observe the loop's
    // `.catch(err => log(...))` failure path.
    const webhookSpy = spyOn(webhookMod, "dispatchWebhook").mockRejectedValue(new Error("boom"));
    const logSpy = spyOn(loggerMod, "log");
    let stop: (() => void) | undefined;
    try {
      stop = startAlertLoop();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Kills 155 (outer tick arrow -> () => undefined): if the loop's callback
      // never calls evaluateAlerts, dispatchWebhook is never reached at all.
      expect(webhookSpy).toHaveBeenCalled();
      // Kills 156 (.catch handler -> () => undefined, would swallow the
      // rejection silently instead of logging), 157 ("warn" -> ""),
      // 158 ("Alert evaluation failed" -> ""), and 159 (`{ error }` -> {}).
      expect(logSpy).toHaveBeenCalledWith("warn", "Alert evaluation failed", { error: "boom" });
    } finally {
      stop?.();
      webhookSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

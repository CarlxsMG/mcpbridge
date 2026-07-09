/**
 * Stryker mutation-testing backstop for src/observability/monitor.ts — domain 7.
 * Test dir is CROSS-DIRECTORY (same gotcha class as anomaly.ts, domain 5's
 * backend-auth, and domain 3's load-balancer.ts): the dedicated test
 * (monitor.test.ts) lives at src/admin/entities/__tests__/, not
 * src/observability/__tests__/. Scope: STRYKER_TEST_SCOPE="src/observability/__tests__
 * src/admin/entities/__tests__".
 *
 * Baseline: 121 mutants, 73 killed / 48 survived. All line:col citations below
 * were read directly from reports/mutation/result.json.
 *
 * Documented equivalent (verified, not assumed):
 *   163:42-163:65 OptionalChaining (`result.content[0]?.text` -> `result.content[0].text`,
 *   dropping the `?.`) and 163:69-163:76 StringLiteral "" (the `?? "error"`
 *   fallback text emptied). Both trace to the SAME root cause: every `isError:
 *   true` result proxyToolCall can return is built through `toolResult()`
 *   (src/lib/mcp-result.ts), which unconditionally returns exactly
 *   `{ content: [{ type: "text", text }], isError: true }` — a single-element
 *   array whose one element always has a real `.text` string. `result.content[0]`
 *   is therefore NEVER undefined/null on any reachable proxyToolCall output, so
 *   the `?.` can never actually short-circuit and the `?? "error"` fallback can
 *   never actually fire — both mutants are unobservable via any call path
 *   through the real dispatch pipeline. Same "helper's own guarantee is
 *   stronger than the optional type suggests" pattern documented for
 *   mcp-upstream.ts's `ListResourcesResultSchema` case and
 *   openapi-discovery.ts's `dereference()` case.
 *
 *   201:7-201:11 ConditionalExpression false (`if (!row) return null;` forced
 *   off, in exampleArgs). Looks like it should throw on a null row's
 *   `row.args_json` access instead of returning early — but that property
 *   access is syntactically INSIDE the very next `try { return
 *   JSON.parse(row.args_json) ... } catch { return null; }` block, so the
 *   TypeError it throws is caught by the SAME catch clause that handles a
 *   malformed-JSON body, converging on the identical `return null`. Verified
 *   empirically (a hand-simulated copy with the condition hard-coded to
 *   `false`) that a null row produces `null` either way.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { config } from "../../../config.js";
import { __resetDbForTesting, getDb } from "../../../db/connection.js";
import { registry } from "../../../mcp/registry.js";
import { removeCircuitBreaker } from "../../../middleware/circuit-breaker.js";
import * as loggerMod from "../../../logger.js";
import * as webhookMod from "../../../lib/webhook.js";
import { setMonitor, deleteMonitor, listMonitors, runSyntheticChecks } from "../../../observability/monitor.js";
import type { RestToolDefinition } from "../../../mcp/types.js";

const CLIENT = "svc";
const getTool: RestToolDefinition = {
  name: "get-x",
  method: "GET",
  endpoint: "/x",
  description: "x",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
};
async function reg(): Promise<void> {
  await registry.register(CLIENT, [getTool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}
function addExample(args: Record<string, unknown>): number {
  return (
    getDb()
      .query(
        `INSERT INTO tool_examples (client_name, tool_name, label, args_json, created_at) VALUES (?, ?, 'ex', ?, ?) RETURNING id`,
      )
      .get(CLIENT, "get-x", JSON.stringify(args), Date.now()) as { id: number }
  ).id;
}
function respond(status: number, body: string): void {
  globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
}
function ok200(): void {
  respond(200, "{}");
}
function row(): { last_run_minute: number | null; last_error: string | null } {
  return getDb()
    .query(`SELECT last_run_minute, last_error FROM tool_monitor WHERE client_name = ? AND tool_name = ?`)
    .get(CLIENT, "get-x") as { last_run_minute: number | null; last_error: string | null };
}

const originalFetch = globalThis.fetch;
function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  (config as Record<string, unknown>).monitorWebhookUrl = undefined;
  __resetDbForTesting();
  removeCircuitBreaker(CLIENT);
  globalThis.fetch = originalFetch;
}
beforeEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  resetAll();
});

const min = (n: number) => new Date(60_000 * n);

describe("rowTo — enabled flag mapping", () => {
  // Kills 57:14-57:29 (ConditionalExpression true/false, EqualityOperator !== 1).
  test("enabled reflects the stored value in both directions, not a hard-coded boolean", async () => {
    await reg();
    const ex = addExample({ q: "1" });
    await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: false });
    expect(listMonitors()[0].enabled).toBe(false);

    await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: true });
    expect(listMonitors()[0].enabled).toBe(true);
  });
});

describe("setMonitor — interval boundary is [1, 1440], not a wider or narrower range", () => {
  // Kills 90:51-90:76 EqualityOperator ('<=1') and 90:80-90:108
  // (ConditionalExpression false, EqualityOperator '>=1440').
  test("1 and 1440 are both accepted; 1441 is rejected", async () => {
    await reg();
    const ex = addExample({ q: "1" });
    expect(await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 1, enabled: true })).toEqual({
      ok: true,
    });
    expect(await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 1440, enabled: true })).toEqual({
      ok: true,
    });
    expect(await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 1441, enabled: true })).toMatchObject({
      ok: false,
      error: "INVALID_INTERVAL",
    });
  });
});

describe("deleteMonitor — a no-op delete is distinguishable from a real one", () => {
  // Kills 120:5-121:19 (ConditionalExpression true, EqualityOperator '>=0') and
  // 122:7-122:14 ConditionalExpression true.
  test("deleting a monitor that doesn't exist returns false", async () => {
    await reg();
    expect(await deleteMonitor(CLIENT, "get-x")).toBe(false);
  });

  // Kills 122:7-122:14 ConditionalExpression true from the OTHER direction: a
  // no-op delete must not have the `if (deleted)` side effect either.
  // Bypasses deleteMonitor via a raw DELETE so a drift note is left dangling
  // (something deleteMonitor itself would never produce, since its own
  // `if (deleted)` branch always clears the note together with the row) --
  // proves the guard is actually load-bearing, not just that the two halves
  // happen to look the same on an already-clean tool.
  test("a no-op delete on a tool with a dangling drift note leaves the note untouched", async () => {
    await reg();
    const ex = addExample({ q: "1" });
    await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: true });
    getDb()
      .query(`UPDATE tool_monitor SET baseline_schema_hash = 'stale' WHERE client_name = ? AND tool_name = ?`)
      .run(CLIENT, "get-x");
    ok200();
    await runSyntheticChecks(min(2_900_000));
    const advertised = () => registry.getMcpToolsForClient(CLIENT).find((t) => t.name === `${CLIENT}__get-x`);
    expect(advertised()?.description).toMatch(/^\[schema drift/);

    // Bypass deleteMonitor's own row-removal entirely -- nothing left to delete.
    getDb().query(`DELETE FROM tool_monitor WHERE client_name = ? AND tool_name = ?`).run(CLIENT, "get-x");
    expect(await deleteMonitor(CLIENT, "get-x")).toBe(false);
    expect(advertised()?.description).toMatch(/^\[schema drift/);
  });
});

describe("runSyntheticChecks — minute bucketing uses floor(ms / 60_000)", () => {
  // Kills 136:29-136:51 ArithmeticOperator ('* 60_000' instead of '/ 60_000').
  test("the persisted last_run_minute is the exact floor-division bucket, not some other magnitude", async () => {
    await reg();
    const ex = addExample({ q: "1" });
    await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: true });
    ok200();
    const now = min(1_500_000);
    await runSyntheticChecks(now);
    expect(row().last_run_minute).toBe(Math.floor(now.getTime() / 60_000));
  });
});

describe("runSyntheticChecks — a monitor whose tool has left the live registry", () => {
  // Kills 153:9-153:17 ConditionalExpression true (`if (resolved) drift = ...`
  // forced unconditional — with `resolved` undefined this would throw on
  // `resolved.tool.inputSchema` instead of leaving drift untouched).
  test("does not throw, and leaves driftDetected exactly as it was before", async () => {
    await reg();
    const ex = addExample({ q: "1" });
    await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: true });
    // unregister() tears down ONLY the in-memory registry state (no SQLite
    // writes, per its own doc comment) -- the tool_monitor row (and its
    // tools/tool_examples FK dependencies) survive untouched, but
    // registry.resolveTool() now returns undefined for this tool.
    await registry.unregister(CLIENT);
    expect(registry.resolveTool(`${CLIENT}__get-x`)).toBeUndefined();

    await expect(runSyntheticChecks(min(1_600_000))).resolves.toBe(1);
    expect(listMonitors()[0].driftDetected).toBe(false);
  });
});

describe("runSyntheticChecks — exampleArgs failure paths", () => {
  // Kills 157:9-157:22 ConditionalExpression false, 158:16-158:22 StringLiteral,
  // 159:15-159:51 StringLiteral, 201:7-201:11 ConditionalExpression false, and
  // 197:73-207:2 BlockStatement (the whole exampleArgs body emptied).
  test("a monitor whose example row no longer exists fails with the exact 'not found' message, not a thrown error or a silent success", async () => {
    await reg();
    // setMonitor never validates that exampleId actually references a row in
    // tool_examples -- a nonexistent id is accepted, mirroring how a real
    // example could be deleted out from under an existing monitor.
    const ghostId = 999_999;
    await setMonitor(CLIENT, "get-x", { exampleId: ghostId, intervalMinutes: 15, enabled: true });
    ok200();
    await expect(runSyntheticChecks(min(1_700_000))).resolves.toBe(1);
    expect(listMonitors()[0].lastStatus).toBe("fail");
    expect(row().last_error).toBe(`example #${ghostId} not found`);
  });

  // Kills 204:11-206:4 BlockStatement (the JSON.parse catch block emptied,
  // which would otherwise let a thrown error propagate out of exampleArgs
  // instead of falling back to null).
  test("a malformed args_json row is treated the same as a missing example, not a thrown error", async () => {
    await reg();
    const malformedId = (
      getDb()
        .query(
          `INSERT INTO tool_examples (client_name, tool_name, label, args_json, created_at) VALUES (?, 'get-x', 'bad', 'not valid json{', ?) RETURNING id`,
        )
        .get(CLIENT, Date.now()) as { id: number }
    ).id;
    await setMonitor(CLIENT, "get-x", { exampleId: malformedId, intervalMinutes: 15, enabled: true });
    ok200();
    await expect(runSyntheticChecks(min(1_800_000))).resolves.toBe(1);
    expect(row().last_error).toBe(`example #${malformedId} not found`);
  });
});

describe("runSyntheticChecks — lastError tracks the exact upstream failure text", () => {
  // Kills 163:15-163:38 (ConditionalExpression true/false, EqualityOperator
  // '!==', BooleanLiteral 'false') and 163:42-163:76 LogicalOperator
  // ('&&' instead of '??').
  test("a failing upstream call's error text is the exact 'REST API returned <status>: <body>' string", async () => {
    await reg();
    const ex = addExample({ q: "1" });
    await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: true });
    respond(500, "boom");
    await runSyntheticChecks(min(1_900_000));
    expect(listMonitors()[0].lastStatus).toBe("fail");
    expect(row().last_error).toBe("REST API returned 500: boom");
  });

  // Kills 163:41-163:91 MethodExpression (the `.slice(0, 500)` call dropped) --
  // a short body can't distinguish a dropped slice from a real one, since both
  // produce an identical (unclipped) string.
  test("a long upstream error body is clipped to exactly 500 characters", async () => {
    await reg();
    const ex = addExample({ q: "1" });
    await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: true });
    respond(500, "x".repeat(600));
    await runSyntheticChecks(min(2_000_000));
    const expected = `REST API returned 500: ${"x".repeat(600)}`.slice(0, 500);
    expect(row().last_error).toBe(expected);
    expect(row().last_error).toHaveLength(500);
  });

  // Kills 163:15-163:38 ConditionalExpression true (would set a non-null error
  // even on a successful check, since real code's `: null` branch is only
  // reachable when the forced-true condition doesn't apply).
  test("a successful check clears lastError to null, not a leftover/garbage value", async () => {
    await reg();
    const ex = addExample({ q: "1" });
    await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: true });
    ok200();
    await runSyntheticChecks(min(2_100_000));
    expect(listMonitors()[0].lastStatus).toBe("ok");
    expect(row().last_error).toBeNull();
  });
});

describe("runSyntheticChecks — edge-triggered drift annotation guard", () => {
  // Kills 176:9-176:29 LogicalOperator ('||' instead of '&&' on
  // `drift && !wasDrifted`). A steady never-drifted tool must NEVER have its
  // advertised description touched -- with `||`, `!wasDrifted` alone (true
  // for every never-drifted tool) would wrongly fire the drift-note branch
  // even though `drift` itself is false.
  test("a tool that has never drifted keeps its plain description across repeated ok checks", async () => {
    await reg();
    const ex = addExample({ q: "1" });
    await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: true });
    ok200();
    await runSyntheticChecks(min(2_200_000));
    await runSyntheticChecks(min(2_200_020));
    const advertised = registry.getMcpToolsForClient(CLIENT).find((t) => t.name === `${CLIENT}__get-x`);
    expect(advertised?.description).toBe(getTool.description);
  });
});

describe("runSyntheticChecks — the log+webhook trigger is genuinely tri-state", () => {
  test("an ok, non-drifted check logs nothing and never calls the webhook dispatcher", async () => {
    await reg();
    const ex = addExample({ q: "1" });
    await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: true });
    const logSpy = spyOn(loggerMod, "log");
    const webhookSpy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      ok200();
      await runSyntheticChecks(min(2_300_000));
      expect(logSpy).not.toHaveBeenCalledWith("warn", "Synthetic monitor flagged a tool", expect.anything());
      expect(webhookSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      webhookSpy.mockRestore();
    }
  });

  // Kills 182:9-182:35 (ConditionalExpression true/false, LogicalOperator
  // '&&' instead of '||') and 182:9-182:26 (ConditionalExpression false,
  // EqualityOperator '!==') and 183:11-183:53/183:55-183:87 (the log call's
  // own message/meta literals).
  test("a failing (but not drifted) check logs and notifies with the exact status/drift", async () => {
    await reg();
    const ex = addExample({ q: "1" });
    await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: true });
    const logSpy = spyOn(loggerMod, "log");
    const webhookSpy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      respond(500, "boom");
      await runSyntheticChecks(min(2_400_000));
      expect(logSpy).toHaveBeenCalledWith("warn", "Synthetic monitor flagged a tool", {
        tool: `${CLIENT}__get-x`,
        status: "fail",
        drift: false,
      });
    } finally {
      logSpy.mockRestore();
      webhookSpy.mockRestore();
    }
  });

  test("an ok check that newly drifts still logs and notifies, even though status itself is ok", async () => {
    await reg();
    const ex = addExample({ q: "1" });
    await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: true });
    getDb()
      .query(`UPDATE tool_monitor SET baseline_schema_hash = 'stale' WHERE client_name = ? AND tool_name = ?`)
      .run(CLIENT, "get-x");
    const logSpy = spyOn(loggerMod, "log");
    const webhookSpy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      ok200();
      await runSyntheticChecks(min(2_500_000));
      expect(logSpy).toHaveBeenCalledWith("warn", "Synthetic monitor flagged a tool", {
        tool: `${CLIENT}__get-x`,
        status: "ok",
        drift: true,
      });
    } finally {
      logSpy.mockRestore();
      webhookSpy.mockRestore();
    }
  });
});

describe("notifyMonitor — the webhook guard and payload", () => {
  // Kills 216:7-216:11 (BooleanLiteral 'url', ConditionalExpression true/false)
  // — with no monitorWebhookUrl configured, dispatchWebhook must never be
  // called at all.
  test("with no monitorWebhookUrl configured, the webhook dispatcher is never called", async () => {
    await reg();
    const ex = addExample({ q: "1" });
    await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: true });
    const webhookSpy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      respond(500, "boom");
      await runSyntheticChecks(min(2_600_000));
      expect(webhookSpy).not.toHaveBeenCalled();
    } finally {
      webhookSpy.mockRestore();
    }
  });

  // Kills 214:18-227:2 (whole notifyMonitor body emptied), 216:7-216:11 (the
  // guard's opposite direction), 219:5-219:85/219:13-219:32 (payload object +
  // its "synthetic_monitor" literal), 220:5-225:6 (the options object), and
  // 222:27-222:57/223:25-223:58 (the two log-message literals).
  test("with a monitorWebhookUrl configured, a failing check dispatches the exact payload and options", async () => {
    await reg();
    const ex = addExample({ q: "1" });
    await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: true });
    (config as Record<string, unknown>).monitorWebhookUrl = "http://127.0.0.1:1/hook";
    const webhookSpy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      respond(500, "boom");
      await runSyntheticChecks(min(2_700_000));
      expect(webhookSpy).toHaveBeenCalledWith(
        "http://127.0.0.1:1/hook",
        { type: "synthetic_monitor", client: CLIENT, tool: "get-x", status: "fail", drift: false },
        {
          timeoutMs: config.monitorWebhookTimeoutMs,
          rejectedLogMessage: "Monitor webhook URL rejected",
          failedLogMessage: "Monitor webhook delivery failed",
          logContext: { client: CLIENT, tool: "get-x" },
        },
      );
    } finally {
      webhookSpy.mockRestore();
    }
  });
});

/**
 * Synthetic monitoring + schema drift — schemaHash, setMonitor validation, and
 * runSyntheticChecks (ok/fail, interval gating, drift detection).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../config.js";
import { __resetDbForTesting, getDb } from "../db/connection.js";
import { registry } from "../registry.js";
import { removeCircuitBreaker } from "../circuit-breaker.js";
import { setMonitor, deleteMonitor, listMonitors, runSyntheticChecks, schemaHash } from "../monitor.js";
import type { RestToolDefinition } from "../types.js";

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
function ok200(): void {
  globalThis.fetch = (async () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

const originalFetch = globalThis.fetch;
function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
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

describe("schemaHash", () => {
  test("order-insensitive; distinguishes different schemas", () => {
    expect(schemaHash({ a: 1, b: 2 })).toBe(schemaHash({ b: 2, a: 1 }));
    expect(schemaHash({ a: 1 })).not.toBe(schemaHash({ a: 2 }));
  });
});

describe("setMonitor validation", () => {
  test("interval bounds + tool must be live", async () => {
    await reg();
    const ex = addExample({ q: "1" });
    expect(await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 0, enabled: true })).toMatchObject({
      ok: false,
      error: "INVALID_INTERVAL",
    });
    expect(await setMonitor(CLIENT, "ghost", { exampleId: ex, intervalMinutes: 15, enabled: true })).toMatchObject({
      ok: false,
      error: "TOOL_NOT_LIVE",
    });
    expect(await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: true })).toEqual({
      ok: true,
    });
  });
});

describe("runSyntheticChecks", () => {
  test("ok, interval gating, fail, and drift", async () => {
    await reg();
    const ex = addExample({ q: "1" });
    await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: true });

    // ok
    ok200();
    expect(await runSyntheticChecks(min(1_000_000))).toBe(1);
    expect(listMonitors()[0].lastStatus).toBe("ok");

    // same minute -> not due
    expect(await runSyntheticChecks(min(1_000_000))).toBe(0);

    // fail 20 minutes later
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    expect(await runSyntheticChecks(min(1_000_020))).toBe(1);
    expect(listMonitors()[0].lastStatus).toBe("fail");

    // drift: corrupt the baseline so the live schema no longer matches
    getDb()
      .query(`UPDATE tool_monitor SET baseline_schema_hash = 'stale' WHERE client_name = ? AND tool_name = ?`)
      .run(CLIENT, "get-x");
    ok200();
    expect(await runSyntheticChecks(min(1_000_040))).toBe(1);
    const m = listMonitors()[0];
    expect(m.lastStatus).toBe("ok");
    expect(m.driftDetected).toBe(true);
  });
});

describe("schema-drift changelog annotation", () => {
  const advertised = () => registry.getMcpToolsForClient(CLIENT).find((t) => t.name === `${CLIENT}__get-x`);
  const rawOverrideDescription = () =>
    registry.getClientDetail(CLIENT)?.tools.find((t) => t.name === "get-x")?.override?.description;

  test("drift edge adds a note; resolve edge removes it; an admin's own override text is never clobbered", async () => {
    await reg();
    const ex = addExample({ q: "1" });
    await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: true });
    await registry.setToolOverride(CLIENT, "get-x", { description: "Custom admin text" });

    // No drift yet -> only the admin's own text is advertised.
    expect(advertised()?.description).toBe("Custom admin text");

    // Drift edge: corrupt the baseline so the live schema no longer matches.
    getDb()
      .query(`UPDATE tool_monitor SET baseline_schema_hash = 'stale' WHERE client_name = ? AND tool_name = ?`)
      .run(CLIENT, "get-x");
    ok200();
    await runSyntheticChecks(min(2_000_000));

    expect(advertised()?.description).toMatch(/^\[schema drift \d{4}-\d{2}-\d{2}: .*\] Custom admin text$/);
    // The admin's raw override text itself must be untouched by the note.
    expect(rawOverrideDescription()).toBe("Custom admin text");

    // Still drifted (same baseline) on a later check -> note stays, doesn't duplicate.
    ok200();
    await runSyntheticChecks(min(2_000_020));
    expect(advertised()?.description).toMatch(/^\[schema drift \d{4}-\d{2}-\d{2}: .*\] Custom admin text$/);

    // Resolve edge: baseline is fixed back to the live schema's hash.
    const liveHash = schemaHash(registry.resolveTool(`${CLIENT}__get-x`)!.tool.inputSchema);
    getDb()
      .query(`UPDATE tool_monitor SET baseline_schema_hash = ? WHERE client_name = ? AND tool_name = ?`)
      .run(liveHash, CLIENT, "get-x");
    ok200();
    await runSyntheticChecks(min(2_000_040));

    expect(advertised()?.description).toBe("Custom admin text");
    expect(rawOverrideDescription()).toBe("Custom admin text");
  });

  test("drift note on a tool with no admin override falls back to the original description, then clears", async () => {
    await reg();
    const ex = addExample({ q: "1" });
    await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: true });

    getDb()
      .query(`UPDATE tool_monitor SET baseline_schema_hash = 'stale' WHERE client_name = ? AND tool_name = ?`)
      .run(CLIENT, "get-x");
    ok200();
    await runSyntheticChecks(min(3_000_000));
    expect(advertised()?.description).toBe(`[schema drift ${min(3_000_000).toISOString().slice(0, 10)}: input schema changed since last check] ${getTool.description}`);

    const liveHash = schemaHash(registry.resolveTool(`${CLIENT}__get-x`)!.tool.inputSchema);
    getDb()
      .query(`UPDATE tool_monitor SET baseline_schema_hash = ? WHERE client_name = ? AND tool_name = ?`)
      .run(liveHash, CLIENT, "get-x");
    ok200();
    await runSyntheticChecks(min(3_000_020));
    expect(advertised()?.description).toBe(getTool.description);
  });

  test("setMonitor resetting the baseline clears a stale drift note immediately, without waiting for the next check", async () => {
    await reg();
    const ex = addExample({ q: "1" });
    await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: true });

    getDb()
      .query(`UPDATE tool_monitor SET baseline_schema_hash = 'stale' WHERE client_name = ? AND tool_name = ?`)
      .run(CLIENT, "get-x");
    ok200();
    await runSyntheticChecks(min(4_000_000));
    expect(advertised()?.description).toMatch(/^\[schema drift/);

    // Admin re-baselines via setMonitor — this resets drift_detected to 0 directly
    // in the DB, bypassing runSyntheticChecks' edge detection entirely, so the note
    // must be cleared here rather than left to linger until a check that will never
    // observe a drift->no-drift transition.
    await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: true });
    expect(advertised()?.description).toBe(getTool.description);
    expect(listMonitors()[0].driftDetected).toBe(false);
  });

  test("deleteMonitor clears a stale drift note (nothing would ever detect it resolving otherwise)", async () => {
    await reg();
    const ex = addExample({ q: "1" });
    await setMonitor(CLIENT, "get-x", { exampleId: ex, intervalMinutes: 15, enabled: true });

    getDb()
      .query(`UPDATE tool_monitor SET baseline_schema_hash = 'stale' WHERE client_name = ? AND tool_name = ?`)
      .run(CLIENT, "get-x");
    ok200();
    await runSyntheticChecks(min(5_000_000));
    expect(advertised()?.description).toMatch(/^\[schema drift/);

    await deleteMonitor(CLIENT, "get-x");
    expect(advertised()?.description).toBe(getTool.description);
  });
});

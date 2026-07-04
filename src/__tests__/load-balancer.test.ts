/**
 * N-way load balancing — pure strategy selection (round-robin / weighted /
 * least-conn) with an injectable clock+RNG, per-target health cooldown, config
 * persistence/validation, and proxy integration (rotation + skip-on-failure).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { removeCircuitBreaker } from "../circuit-breaker.js";
import { proxyToolCall } from "../proxy/proxy.js";
import {
  getLb,
  setLb,
  addUpstream,
  updateUpstream,
  removeUpstream,
  selectTarget,
  markTargetDown,
  markTargetUp,
  incInflight,
  __resetLbForTesting,
  __setLbDepsForTesting,
  type LbConfig,
  type LbTarget,
} from "../load-balancer.js";
import type { RestToolDefinition } from "../mcp/types.js";

const CLIENT = "svc";
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

const clientLike = { name: CLIENT, base_url: "http://1.2.3.4", resolved_ip: "1.2.3.4" };
function target(id: number, host: string, weight = 1, enabled = true): LbTarget {
  return { id, baseUrl: `http://${host}`, resolvedIp: host, weight, enabled };
}
function lbCfg(strategy: LbConfig["strategy"], targets: LbTarget[], primaryWeight = 1, enabled = true): LbConfig {
  return { strategy, primaryWeight, enabled, targets };
}

const originalFetch = globalThis.fetch;

function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  __resetDbForTesting();
  __resetLbForTesting();
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

describe("selectTarget strategies", () => {
  test("round-robin cycles through primary + enabled targets", () => {
    const lb = lbCfg("round-robin", [target(1, "5.6.7.8")]);
    const seq = [0, 1, 2, 3].map(() => selectTarget(clientLike, lb).baseUrl);
    expect(seq).toEqual(["http://1.2.3.4", "http://5.6.7.8", "http://1.2.3.4", "http://5.6.7.8"]);
  });

  test("weighted picks proportionally (injected RNG)", () => {
    const lb = lbCfg("weighted", [target(1, "5.6.7.8", 3)], 1); // total weight 4: primary 1, target 3
    __setLbDepsForTesting({ rand: () => 0.1 }); // r=0.4 -> primary
    expect(selectTarget(clientLike, lb).isPrimary).toBe(true);
    __setLbDepsForTesting({ rand: () => 0.5 }); // r=2.0 -> target
    expect(selectTarget(clientLike, lb).isPrimary).toBe(false);
  });

  test("least-conn picks the member with the fewest in-flight calls", () => {
    const lb = lbCfg("least-conn", [target(1, "5.6.7.8")]);
    incInflight(`${CLIENT}#http://1.2.3.4`); // primary has 1 in flight, target 0
    expect(selectTarget(clientLike, lb).isPrimary).toBe(false);
  });
});

describe("health cooldown", () => {
  test("a downed target is skipped until its cooldown lapses", () => {
    __setLbDepsForTesting({ now: () => 1000 });
    const lb = lbCfg("round-robin", [target(1, "5.6.7.8")]);
    markTargetDown(`${CLIENT}#http://1.2.3.4`); // cool the PRIMARY at t=1000
    // Only the target is healthy now, so every pick is the target regardless of RR cursor.
    expect(selectTarget(clientLike, lb).isPrimary).toBe(false);
    expect(selectTarget(clientLike, lb).isPrimary).toBe(false);
    // After the cooldown window, the primary is eligible again.
    __setLbDepsForTesting({ now: () => 1000 + config.lbTargetCooldownMs + 1 });
    const picks = new Set([selectTarget(clientLike, lb).isPrimary, selectTarget(clientLike, lb).isPrimary]);
    expect(picks.has(true)).toBe(true);
  });

  test("markTargetUp clears a cooldown immediately", () => {
    __setLbDepsForTesting({ now: () => 1000 });
    const lb = lbCfg("round-robin", [target(1, "5.6.7.8")]);
    markTargetDown(`${CLIENT}#http://5.6.7.8`);
    markTargetUp(`${CLIENT}#http://5.6.7.8`);
    // Both healthy again -> RR alternates.
    const seq = [selectTarget(clientLike, lb).baseUrl, selectTarget(clientLike, lb).baseUrl];
    expect(new Set(seq).size).toBe(2);
  });
});

describe("config persistence + validation", () => {
  test("setLb validates client / strategy / weight; getLb round-trips; clear removes", async () => {
    await reg();
    expect(setLb("ghost", { strategy: "round-robin", primaryWeight: 1, enabled: true })).toMatchObject({
      ok: false,
      error: "CLIENT_NOT_FOUND",
    });
    expect(setLb(CLIENT, { strategy: "bogus" as LbConfig["strategy"], primaryWeight: 1, enabled: true })).toMatchObject(
      { ok: false, error: "INVALID_STRATEGY" },
    );
    expect(setLb(CLIENT, { strategy: "weighted", primaryWeight: 2, enabled: true })).toEqual({ ok: true });
    expect(getLb(CLIENT)).toMatchObject({ strategy: "weighted", primaryWeight: 2, enabled: true, targets: [] });
    expect(setLb(CLIENT, null)).toEqual({ ok: true });
    expect(getLb(CLIENT)).toBeNull();
  });

  test("addUpstream validates client / weight / url and pins the IP; update + remove", async () => {
    await reg();
    setLb(CLIENT, { strategy: "round-robin", primaryWeight: 1, enabled: true });
    expect(await addUpstream("ghost", "http://5.6.7.8", 1)).toMatchObject({ ok: false, error: "CLIENT_NOT_FOUND" });
    expect(await addUpstream(CLIENT, "http://5.6.7.8", 0)).toMatchObject({ ok: false, error: "INVALID_WEIGHT" });
    expect(await addUpstream(CLIENT, "not a url", 1)).toMatchObject({ ok: false, error: "INVALID_URL" });
    const added = await addUpstream(CLIENT, "http://5.6.7.8", 2);
    expect(added.ok).toBe(true);
    const id = (added as { ok: true; id: number }).id;
    expect(getLb(CLIENT)?.targets).toMatchObject([
      { baseUrl: "http://5.6.7.8", resolvedIp: "5.6.7.8", weight: 2, enabled: true },
    ]);

    expect(updateUpstream(CLIENT, 9999, { enabled: false })).toMatchObject({ ok: false, error: "TARGET_NOT_FOUND" });
    expect(updateUpstream(CLIENT, id, { enabled: false, weight: 5 })).toEqual({ ok: true });
    expect(getLb(CLIENT)?.targets[0]).toMatchObject({ enabled: false, weight: 5 });

    expect(removeUpstream(CLIENT, 9999)).toMatchObject({ ok: false, error: "TARGET_NOT_FOUND" });
    expect(removeUpstream(CLIENT, id)).toEqual({ ok: true });
    expect(getLb(CLIENT)?.targets).toEqual([]);
  });
});

describe("proxy integration", () => {
  test("round-robin spreads calls across primary and pool", async () => {
    await reg();
    await addUpstream(CLIENT, "http://5.6.7.8", 1);
    setLb(CLIENT, { strategy: "round-robin", primaryWeight: 1, enabled: true });
    const hosts: string[] = [];
    globalThis.fetch = (async (url: string) => {
      hosts.push(new URL(String(url)).hostname);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await proxyToolCall(`${CLIENT}__get-x`, {});
    await proxyToolCall(`${CLIENT}__get-x`, {});
    expect(new Set(hosts)).toEqual(new Set(["1.2.3.4", "5.6.7.8"]));
  });

  test("a target that fails is cooled down and skipped on the next call", async () => {
    await reg();
    await addUpstream(CLIENT, "http://5.6.7.8", 1);
    setLb(CLIENT, { strategy: "round-robin", primaryWeight: 1, enabled: true });
    const hosts: string[] = [];
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      hosts.push(new URL(u).hostname);
      return u.includes("5.6.7.8")
        ? new Response("down", { status: 500 })
        : new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await proxyToolCall(`${CLIENT}__get-x`, {}); // primary (RR idx 0) -> ok
    await proxyToolCall(`${CLIENT}__get-x`, {}); // pool (RR idx 1) -> 500 -> cooled
    const r3 = await proxyToolCall(`${CLIENT}__get-x`, {}); // pool cooled -> primary
    expect(r3.isError).toBeUndefined();
    expect(hosts[0]).toBe("1.2.3.4");
    expect(hosts[1]).toBe("5.6.7.8");
    expect(hosts[2]).toBe("1.2.3.4");
  });
});

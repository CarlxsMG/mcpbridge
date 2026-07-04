/**
 * Auto-quarantine — policy/state persistence, escalation after N consecutive
 * guardrail hits, the three actions (block/force_approval/observe), recovery
 * (auto-cooldown vs manual clear), and non-interference with the circuit
 * breaker while a call is blocked.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { removeCircuitBreaker, getAllCircuitStates } from "../circuit-breaker.js";
import { proxyToolCall } from "../proxy/proxy.js";
import { setGuardrails } from "../guardrails.js";
import { listApprovals } from "../approvals.js";
import {
  getQuarantinePolicy,
  setQuarantinePolicy,
  getQuarantineState,
  recordGuardrailHit,
  checkQuarantine,
  clearQuarantine,
  __setClockForTesting,
  type QuarantinePolicy,
} from "../quarantine.js";
import type { RestToolDefinition } from "../mcp/types.js";

// A unique client name — proxy.ts's Ajv validator cache is keyed by
// `${clientName}::${toolName}` and never invalidated within a test run, so a
// generic name shared with another file's differently-shaped tool schema
// risks a stale-validator collision (see coalesce.test.ts for the incident
// that first surfaced this).
const CLIENT = "quarantine-test-client";
function makeTool(name = "do-x"): RestToolDefinition {
  return {
    name,
    method: "POST",
    endpoint: `/${name}`,
    description: "x",
    inputSchema: { type: "object", properties: { a: { type: "string" } } },
  };
}
async function reg(): Promise<void> {
  await registry.register(CLIENT, [makeTool()], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

function policy(overrides: Partial<QuarantinePolicy> = {}): QuarantinePolicy {
  return { consecutiveThreshold: 2, action: "block", recoveryMode: "manual", cooldownMs: null, ...overrides };
}

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  __setClockForTesting(null);
  removeCircuitBreaker(CLIENT);
  globalThis.fetch = originalFetch;
});
afterEach(async () => {
  for (const c of registry.listClients()) await registry.unregister(c.name);
  __resetDbForTesting();
  __setClockForTesting(null);
  removeCircuitBreaker(CLIENT);
  globalThis.fetch = originalFetch;
});

describe("policy CRUD", () => {
  test("get/set round-trips and clearing wipes accumulated state too", async () => {
    await reg();
    expect(getQuarantinePolicy(CLIENT, "do-x")).toBeNull();
    expect(setQuarantinePolicy(CLIENT, "do-x", policy())).toBe(true);
    expect(getQuarantinePolicy(CLIENT, "do-x")).toEqual(policy());

    recordGuardrailHit(CLIENT, "do-x", true);
    expect(getQuarantineState(CLIENT, "do-x").consecutiveHits).toBe(1);

    expect(setQuarantinePolicy(CLIENT, "do-x", null)).toBe(true);
    expect(getQuarantinePolicy(CLIENT, "do-x")).toBeNull();
    expect(getQuarantineState(CLIENT, "do-x").consecutiveHits).toBe(0);
  });

  test("returns false for a tool that doesn't exist", () => {
    expect(setQuarantinePolicy(CLIENT, "ghost", policy())).toBe(false);
  });
});

describe("escalation", () => {
  test("consecutive hits escalate to quarantine at the threshold; a clean pass resets the streak", async () => {
    await reg();
    setQuarantinePolicy(CLIENT, "do-x", policy({ consecutiveThreshold: 3 }));

    recordGuardrailHit(CLIENT, "do-x", true);
    expect(getQuarantineState(CLIENT, "do-x")).toMatchObject({ quarantined: false, consecutiveHits: 1 });

    recordGuardrailHit(CLIENT, "do-x", false); // clean pass resets
    expect(getQuarantineState(CLIENT, "do-x").consecutiveHits).toBe(0);

    recordGuardrailHit(CLIENT, "do-x", true);
    recordGuardrailHit(CLIENT, "do-x", true);
    expect(getQuarantineState(CLIENT, "do-x")).toMatchObject({ quarantined: false, consecutiveHits: 2 });
    recordGuardrailHit(CLIENT, "do-x", true);
    expect(getQuarantineState(CLIENT, "do-x")).toMatchObject({ quarantined: true, consecutiveHits: 3 });
    expect(getQuarantineState(CLIENT, "do-x").reason).toContain("3 consecutive");
  });

  test("no policy configured -> never escalates", async () => {
    await reg();
    recordGuardrailHit(CLIENT, "do-x", true);
    recordGuardrailHit(CLIENT, "do-x", true);
    recordGuardrailHit(CLIENT, "do-x", true);
    expect(getQuarantineState(CLIENT, "do-x").quarantined).toBe(false);
    expect(checkQuarantine(CLIENT, "do-x")).toEqual({ active: false });
  });
});

describe("proxy integration", () => {
  function mockFetch(): void {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  }

  test("action=block: the 3rd guardrail-violating call quarantines the tool and a clean-args call is then blocked; breaker untouched", async () => {
    await reg();
    setGuardrails(CLIENT, "do-x", { denyPatterns: ["\\bsecret\\b"], blockSecrets: false, scanResponses: false });
    setQuarantinePolicy(CLIENT, "do-x", policy({ consecutiveThreshold: 2, action: "block" }));
    mockFetch();

    const r1 = await proxyToolCall(`${CLIENT}__do-x`, { a: "secret" });
    expect(r1.isError).toBe(true);
    expect(r1.content[0].text).toContain("guardrail");
    const r2 = await proxyToolCall(`${CLIENT}__do-x`, { a: "secret" });
    expect(r2.isError).toBe(true);
    expect(getQuarantineState(CLIENT, "do-x").quarantined).toBe(true);

    // The breaker singleton is only created on first `getCircuitBreaker(...)`
    // call, which sits AFTER every guard including quarantine — so it never
    // even got instantiated by these blocked calls, let alone recorded a
    // failure against it.
    expect(getAllCircuitStates()[CLIENT]).toBeUndefined();

    const r3 = await proxyToolCall(`${CLIENT}__do-x`, { a: "clean" });
    expect(r3.isError).toBe(true);
    expect(r3.content[0].text).toContain("quarantined");
    expect(getAllCircuitStates()[CLIENT]).toBeUndefined();
  });

  test("action=force_approval: quarantined calls are routed through the approval ticket flow instead of being blocked outright", async () => {
    await reg();
    setGuardrails(CLIENT, "do-x", { denyPatterns: ["\\bsecret\\b"], blockSecrets: false, scanResponses: false });
    setQuarantinePolicy(CLIENT, "do-x", policy({ consecutiveThreshold: 1, action: "force_approval" }));
    mockFetch();

    await proxyToolCall(`${CLIENT}__do-x`, { a: "secret" }); // 1 hit -> quarantined (threshold 1)
    expect(getQuarantineState(CLIENT, "do-x").quarantined).toBe(true);

    const r = await proxyToolCall(`${CLIENT}__do-x`, { a: "clean" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("requires human approval");
    expect(listApprovals("pending")).toHaveLength(1);
  });

  test("action=observe: quarantined calls still execute, only logged", async () => {
    await reg();
    setGuardrails(CLIENT, "do-x", { denyPatterns: ["\\bsecret\\b"], blockSecrets: false, scanResponses: false });
    setQuarantinePolicy(CLIENT, "do-x", policy({ consecutiveThreshold: 1, action: "observe" }));
    mockFetch();

    await proxyToolCall(`${CLIENT}__do-x`, { a: "secret" }); // 1 hit -> quarantined
    expect(getQuarantineState(CLIENT, "do-x").quarantined).toBe(true);

    const r = await proxyToolCall(`${CLIENT}__do-x`, { a: "clean" });
    expect(r.isError).toBeUndefined();
  });
});

describe("recovery", () => {
  test("manual recovery mode requires an explicit clear", async () => {
    await reg();
    setQuarantinePolicy(CLIENT, "do-x", policy({ consecutiveThreshold: 1, action: "block", recoveryMode: "manual" }));
    recordGuardrailHit(CLIENT, "do-x", true);
    expect(checkQuarantine(CLIENT, "do-x").active).toBe(true);
    expect(checkQuarantine(CLIENT, "do-x").active).toBe(true); // still active — no auto-clear
    expect(clearQuarantine(CLIENT, "do-x")).toBe(true);
    expect(checkQuarantine(CLIENT, "do-x")).toEqual({ active: false });
  });

  test("auto recovery mode lazily clears once the cooldown elapses", async () => {
    await reg();
    let now = 1_000_000;
    __setClockForTesting(() => now);
    setQuarantinePolicy(
      CLIENT,
      "do-x",
      policy({ consecutiveThreshold: 1, action: "block", recoveryMode: "auto", cooldownMs: 60_000 }),
    );
    recordGuardrailHit(CLIENT, "do-x", true);
    expect(checkQuarantine(CLIENT, "do-x").active).toBe(true);

    now += 30_000; // cooldown not elapsed yet
    expect(checkQuarantine(CLIENT, "do-x").active).toBe(true);

    now += 31_000; // now past the 60s cooldown
    expect(checkQuarantine(CLIENT, "do-x")).toEqual({ active: false });
    expect(getQuarantineState(CLIENT, "do-x")).toMatchObject({ quarantined: false, consecutiveHits: 0 });
  });

  test("clearQuarantine returns false for a tool that doesn't exist", () => {
    expect(clearQuarantine(CLIENT, "ghost")).toBe(false);
  });
});

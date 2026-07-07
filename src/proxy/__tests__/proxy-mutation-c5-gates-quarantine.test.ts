/**
 * Stryker mutation-testing backstop — cluster C5 (proxy.ts L547-616):
 * auto-quarantine (block/force_approval/observe actions), the natural
 * per-tool approval gate (and its interaction with quarantine's
 * approvalGateHandled short-circuit), and the content-guardrails input gate
 * (including its recordGuardrailHit(...,hit) bookkeeping observed through
 * quarantine escalation).
 *
 * All calls are driven through the public proxyToolCall entry point per the
 * module's hard privacy boundary — no direct imports of dispatchToolCall /
 * runApprovalGate.
 *
 * NOTE on two remaining equivalent mutants (confirmed by reading
 * src/tool-policies/quarantine.ts's checkQuarantine, not chased with dedicated
 * tests):
 *   - `if (quarantine.active)` ConditionalExpression->'true' (proxy.ts L554):
 *     checkQuarantine() returns `{ active: false }` (no `action` field at all)
 *     whenever there is no policy, or the state isn't quarantined, or an
 *     auto-recovery cooldown just lazily cleared it — `action` is therefore
 *     ALWAYS `undefined` whenever `active` is really `false`. Forcing entry
 *     into the block then checks `quarantine.action` against "block" /
 *     "force_approval" / "observe" — none match `undefined`, so execution
 *     falls straight through with zero observable side effects either way.
 *   - `else if (quarantine.action === "observe")` ConditionalExpression->'true'
 *     (proxy.ts L570): QuarantineAction is an exhaustive 3-value union. The
 *     "block" branch above always `return`s, and "force_approval" is a
 *     separate `if` (not falling through to this `else if` once taken) — so
 *     by elimination, this `else if` is only ever REACHED when action is
 *     already, unavoidably, "observe". Forcing its own condition to always-true
 *     cannot change an outcome that was already guaranteed.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { registry } from "../../mcp/registry.js";
import { removeCircuitBreaker } from "../../middleware/circuit-breaker.js";
import { config } from "../../config.js";
import { getDb, __resetDbForTesting } from "../../db/connection.js";
import { proxyToolCall } from "../../proxy/proxy.js";
import { setGuardrails } from "../../tool-policies/guardrails.js";
import { setApprovalRequired, listApprovals, decideApproval } from "../../admin/entities/approvals.js";
import { setQuarantinePolicy, getQuarantineState, type QuarantinePolicy } from "../../tool-policies/quarantine.js";
import * as logger from "../../logger.js";
import type { RestToolDefinition } from "../../mcp/types.js";

// lower-case only — the registry's TOOL_NAME_RE rejects uppercase client names.
const CLIENT = "mutc5quar";

function makeTool(name: string): RestToolDefinition {
  return {
    name,
    method: "POST",
    endpoint: `/${name}`,
    description: "d",
    inputSchema: { type: "object", properties: { a: { type: "string" } } },
  };
}

async function reg(names: string[]): Promise<void> {
  await registry.register(
    CLIENT,
    names.map((n) => makeTool(n)),
    "http://1.2.3.4/health",
    "1.2.3.4",
    "http://1.2.3.4",
    "1.2.3.4",
  );
}

function quarPolicy(overrides: Partial<QuarantinePolicy> = {}): QuarantinePolicy {
  return { consecutiveThreshold: 1, action: "block", recoveryMode: "manual", cooldownMs: null, ...overrides };
}

const originalFetch = globalThis.fetch;
function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  (config as Record<string, unknown>).retryBaseDelayMs = 1;
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

function okFetch(body: unknown = { ok: true }): typeof fetch {
  let calls = 0;
  const fn = (async () => {
    calls++;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch & { calls: () => number };
  Object.defineProperty(fn, "calls", { value: () => calls });
  return fn;
}

// ---------------------------------------------------------------------------
// Natural per-tool approval gate (no quarantine involved)
// ---------------------------------------------------------------------------
describe("natural approval gate (L583, L585, L552 initial value)", () => {
  test("with no quarantine configured, an approval-required tool is gated on the first call and executes only after approval+ticket (kills L552, L583, L585)", async () => {
    await reg(["do-x"]);
    await setApprovalRequired(CLIENT, "do-x", true);
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response('{"done":true}', { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    // First call: no __approval_id -> must be gated (kills L552's initial-value
    // mutant: if approvalGateHandled started `true` instead of `false`, the
    // `!approvalGateHandled && requiresApproval(...)` check at L583 would be
    // skipped entirely and this call would reach the backend unguarded).
    const r1 = await proxyToolCall(`${CLIENT}__do-x`, { a: "1" });
    expect(r1.isError).toBe(true);
    expect(r1.content[0].text).toContain("requires human approval");
    expect(fetched).toBe(0);
    const id = Number(r1.content[0].text.match(/#(\d+)/)![1]);

    // Second call: ticket still pending -> must return the gated result, not
    // proceed to fetch (kills L585's `if (gated) return gated` conditional).
    const r2 = await proxyToolCall(`${CLIENT}__do-x`, { a: "1", __approval_id: id });
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toContain("still pending");
    expect(fetched).toBe(0);

    // Approve, then the call must proceed (proves the whole L583/L585 gate is
    // load-bearing, not a permanent block).
    expect(decideApproval(id, "approved", "admin", null).ok).toBe(true);
    const r3 = await proxyToolCall(`${CLIENT}__do-x`, { a: "1", __approval_id: id });
    expect(r3.isError).toBeUndefined();
    expect(fetched).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Auto-quarantine — action="block"
// ---------------------------------------------------------------------------
describe("quarantine action=block (L554-556, L562-563)", () => {
  test("active quarantine with action=block short-circuits before dispatch and logs a warn with tool/client/reason (kills L554, L555, L556, L563)", async () => {
    await reg(["do-x"]);
    setGuardrails(CLIENT, "do-x", { denyPatterns: ["\\bsecret\\b"], blockSecrets: false, scanResponses: false });
    setQuarantinePolicy(CLIENT, "do-x", quarPolicy({ consecutiveThreshold: 1, action: "block" }));

    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    // 1st call: guardrail-blocked -> escalates to quarantine (threshold 1).
    const r1 = await proxyToolCall(`${CLIENT}__do-x`, { a: "secret" });
    expect(r1.isError).toBe(true);
    expect(getQuarantineState(CLIENT, "do-x").quarantined).toBe(true);
    expect(fetched).toBe(0);

    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      // 2nd call: even with CLEAN args, quarantine.active + action=block must
      // short-circuit before the guardrail/backend ever runs (proves L554's
      // `if (quarantine.active)` gate and L555's action==="block" branch are
      // both load-bearing, and the BlockStatement inside actually executes).
      const r2 = await proxyToolCall(`${CLIENT}__do-x`, { a: "clean" });
      expect(r2.isError).toBe(true);
      expect(r2.content[0].text).toContain("quarantined");
      expect(fetched).toBe(0); // never reached the backend

      const call = logSpy.mock.calls.find((c) => c[0] === "warn" && String(c[1]).includes("blocked by quarantine"));
      expect(call).toBeDefined();
      expect(call?.[2]).toMatchObject({ tool: `${CLIENT}__do-x`, client: CLIENT });
      expect((call?.[2] as Record<string, unknown>).reason).toBeDefined();
    } finally {
      logSpy.mockRestore();
    }
  });

  test("blocked-message uses the real reason when present, and falls back to the default text when state.reason is absent (kills L562 message template + ?? default)", async () => {
    await reg(["do-x"]);
    setGuardrails(CLIENT, "do-x", { denyPatterns: ["\\bsecret\\b"], blockSecrets: false, scanResponses: false });
    setQuarantinePolicy(CLIENT, "do-x", quarPolicy({ consecutiveThreshold: 1, action: "block" }));
    globalThis.fetch = okFetch();

    await proxyToolCall(`${CLIENT}__do-x`, { a: "secret" }); // escalates, sets a real reason
    expect(getQuarantineState(CLIENT, "do-x").quarantined).toBe(true);
    expect(getQuarantineState(CLIENT, "do-x").reason).toContain("consecutive guardrail violations");

    const rWithReason = await proxyToolCall(`${CLIENT}__do-x`, { a: "clean" });
    expect(rWithReason.content[0].text).toBe(
      `Tool '${CLIENT}__do-x' is quarantined: ${getQuarantineState(CLIENT, "do-x").reason}`,
    );

    // Directly null out the persisted reason (bypassing quarantine.ts's own
    // escalation, which always sets one) to force checkQuarantine's `reason:
    // state.reason ?? undefined` down the undefined path, which in turn forces
    // proxy.ts's own `quarantine.reason ?? "too many guardrail violations"`
    // default text.
    getDb()
      .query(`UPDATE tool_quarantine_state SET reason = NULL WHERE client_name = ? AND tool_name = ?`)
      .run(CLIENT, "do-x");

    const rDefault = await proxyToolCall(`${CLIENT}__do-x`, { a: "clean" });
    expect(rDefault.isError).toBe(true);
    expect(rDefault.content[0].text).toBe(`Tool '${CLIENT}__do-x' is quarantined: too many guardrail violations`);
  });
});

// ---------------------------------------------------------------------------
// Auto-quarantine — action="force_approval"
// ---------------------------------------------------------------------------
describe("quarantine action=force_approval (L566, L568, L569, L583 skip)", () => {
  async function activateForceApproval(): Promise<void> {
    await reg(["do-x"]);
    setGuardrails(CLIENT, "do-x", { denyPatterns: ["\\bsecret\\b"], blockSecrets: false, scanResponses: false });
    setQuarantinePolicy(CLIENT, "do-x", quarPolicy({ consecutiveThreshold: 1, action: "force_approval" }));
    globalThis.fetch = okFetch();
    await proxyToolCall(`${CLIENT}__do-x`, { a: "secret" }); // 1 hit -> quarantined
    expect(getQuarantineState(CLIENT, "do-x").quarantined).toBe(true);
  }

  test("quarantined calls are routed through the ticket flow instead of being blocked outright (kills L566)", async () => {
    await activateForceApproval();
    const r = await proxyToolCall(`${CLIENT}__do-x`, { a: "clean" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("requires human approval");
    expect(listApprovals("pending")).toHaveLength(1);
  });

  test("a still-pending quarantine ticket blocks the call and never reaches fetch (kills L569 'if (gated) return gated')", async () => {
    await activateForceApproval();
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const r1 = await proxyToolCall(`${CLIENT}__do-x`, { a: "clean" });
    const id = Number(r1.content[0].text.match(/#(\d+)/)![1]);

    const r2 = await proxyToolCall(`${CLIENT}__do-x`, { a: "clean", __approval_id: id });
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toContain("still pending");
    expect(fetched).toBe(0);
  });

  test("once quarantine's own force_approval gate has run, the natural per-tool approval check is NOT evaluated a second time — exactly one ticket, no double-gating (kills L568 and the L583 approvalGateHandled short-circuit)", async () => {
    await activateForceApproval();
    // ALSO require natural approval on the same tool — if approvalGateHandled
    // were wrongly left `false` after quarantine's gate ran, L583's
    // `!approvalGateHandled && requiresApproval(...)` would re-trigger
    // runApprovalGate a second time using the SAME (already-consumed)
    // __approval_id, which fails as "already used" instead of proceeding.
    await setApprovalRequired(CLIENT, "do-x", true);

    const r1 = await proxyToolCall(`${CLIENT}__do-x`, { a: "clean" });
    expect(r1.isError).toBe(true);
    expect(r1.content[0].text).toContain("requires human approval");
    expect(listApprovals("pending")).toHaveLength(1); // exactly one ticket, not two
    const id = Number(r1.content[0].text.match(/#(\d+)/)![1]);

    expect(decideApproval(id, "approved", "admin", null).ok).toBe(true);

    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const r2 = await proxyToolCall(`${CLIENT}__do-x`, { a: "clean", __approval_id: id });
    expect(r2.isError).toBeUndefined();
    expect(fetched).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Auto-quarantine — action="observe"
// ---------------------------------------------------------------------------
describe("quarantine action=observe (L570-571)", () => {
  test("quarantined calls still execute (not blocked, not gated) and only a warn log marks it (kills L570, L571)", async () => {
    await reg(["do-x"]);
    setGuardrails(CLIENT, "do-x", { denyPatterns: ["\\bsecret\\b"], blockSecrets: false, scanResponses: false });
    setQuarantinePolicy(CLIENT, "do-x", quarPolicy({ consecutiveThreshold: 1, action: "observe" }));
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    await proxyToolCall(`${CLIENT}__do-x`, { a: "secret" }); // 1 hit -> quarantined
    expect(getQuarantineState(CLIENT, "do-x").quarantined).toBe(true);

    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      const r = await proxyToolCall(`${CLIENT}__do-x`, { a: "clean" });
      expect(r.isError).toBeUndefined();
      expect(fetched).toBe(1); // reached the real backend, unlike action=block

      const call = logSpy.mock.calls.find(
        (c) => c[0] === "warn" && String(c[1]).includes("allowed through (observe mode)"),
      );
      expect(call).toBeDefined();
      expect(call?.[2]).toMatchObject({ tool: `${CLIENT}__do-x`, client: CLIENT });
      expect((call?.[2] as Record<string, unknown>).reason).toBeDefined();
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Content guardrails — input gate
// ---------------------------------------------------------------------------
describe("content guardrails input gate (L593, L595-597, L602, L604, L596)", () => {
  test("no guardrails configured -> the gate is skipped entirely, call proceeds (kills L593 'if (guardrails)')", async () => {
    await reg(["do-x"]);
    globalThis.fetch = okFetch();
    const r = await proxyToolCall(`${CLIENT}__do-x`, { a: "anything" });
    expect(r.isError).toBeUndefined();
  });

  test("blocked input never reaches the backend and returns the exact rejection message + warn log (kills L595, L596 log meta, L597, L602)", async () => {
    await reg(["do-x"]);
    setGuardrails(CLIENT, "do-x", { denyPatterns: ["\\bsecret\\b"], blockSecrets: false, scanResponses: false });
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const logSpy = spyOn(logger, "log").mockImplementation(() => {});
    try {
      const r = await proxyToolCall(`${CLIENT}__do-x`, { a: "my secret value" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe("Input rejected by guardrail: arguments matched a configured deny pattern");
      expect(fetched).toBe(0);

      const call = logSpy.mock.calls.find(
        (c) => c[0] === "warn" && String(c[1]).includes("rejected by input guardrail"),
      );
      expect(call).toBeDefined();
      expect(call?.[2]).toMatchObject({
        tool: `${CLIENT}__do-x`,
        client: CLIENT,
        reason: "arguments matched a configured deny pattern",
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  test("a blocked call records a TRUE guardrail hit (escalates quarantine), not false (kills L596 BooleanLiteral)", async () => {
    await reg(["do-x"]);
    setGuardrails(CLIENT, "do-x", { denyPatterns: ["\\bsecret\\b"], blockSecrets: false, scanResponses: false });
    setQuarantinePolicy(CLIENT, "do-x", quarPolicy({ consecutiveThreshold: 1, action: "block" }));
    globalThis.fetch = okFetch();

    expect(getQuarantineState(CLIENT, "do-x").quarantined).toBe(false);
    await proxyToolCall(`${CLIENT}__do-x`, { a: "secret" });
    // If recordGuardrailHit had been called with `false` instead of `true`
    // here, the counter would stay at 0 and the tool would never quarantine.
    expect(getQuarantineState(CLIENT, "do-x").quarantined).toBe(true);
  });

  test("a clean pass-through call resets the consecutive-hit streak to 0, not increments it (kills L604 BooleanLiteral)", async () => {
    await reg(["do-x"]);
    setGuardrails(CLIENT, "do-x", { denyPatterns: ["\\bsecret\\b"], blockSecrets: false, scanResponses: false });
    // Threshold 2 so a single hit doesn't itself quarantine — isolates the
    // reset behaviour of the pass-through branch from the escalation branch.
    setQuarantinePolicy(CLIENT, "do-x", quarPolicy({ consecutiveThreshold: 2, action: "block" }));
    globalThis.fetch = okFetch();

    await proxyToolCall(`${CLIENT}__do-x`, { a: "secret" }); // 1 hit
    expect(getQuarantineState(CLIENT, "do-x")).toMatchObject({ quarantined: false, consecutiveHits: 1 });

    const r = await proxyToolCall(`${CLIENT}__do-x`, { a: "clean" }); // pass-through
    expect(r.isError).toBeUndefined();
    // If recordGuardrailHit(...,false) had been mutated to recordGuardrailHit(...,true),
    // this clean call would INCREMENT to 2 and cross the threshold instead of resetting.
    expect(getQuarantineState(CLIENT, "do-x")).toMatchObject({ quarantined: false, consecutiveHits: 0 });
  });
});

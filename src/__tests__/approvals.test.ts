/**
 * Human-in-the-loop approval — ticket lifecycle and the full proxy flow:
 * queue -> (still pending) -> approve -> execute (single-use) -> already used;
 * plus reject and args-mismatch rejection.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { registry } from "../mcp/registry.js";
import { removeCircuitBreaker } from "../circuit-breaker.js";
import { proxyToolCall } from "../proxy.js";
import {
  requiresApproval,
  setApprovalRequired,
  createApproval,
  getApproval,
  decideApproval,
  consumeApproval,
  approvalArgsHash,
  listApprovals,
  getRequiredLevels,
} from "../approvals.js";
import type { RestToolDefinition } from "../mcp/types.js";

const CLIENT = "svc";
const doTool: RestToolDefinition = {
  name: "do-x",
  method: "POST",
  endpoint: "/do",
  description: "do",
  inputSchema: { type: "object", properties: { a: { type: "string" } } },
};
async function reg(): Promise<void> {
  await registry.register(CLIENT, [doTool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
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

describe("ticket lifecycle", () => {
  test("requires-flag persistence + consume rules", async () => {
    await reg();
    expect(setApprovalRequired(CLIENT, "nope", true)).toBe(false);
    expect(setApprovalRequired(CLIENT, "do-x", true)).toBe(true);
    expect(requiresApproval(CLIENT, "do-x")).toBe(true);

    const hash = approvalArgsHash({ a: "1" });
    const id = createApproval(CLIENT, "do-x", hash, JSON.stringify({ a: "1" }), null);
    expect(getApproval(id)?.status).toBe("pending");
    expect(listApprovals("pending").map((r) => r.id)).toContain(id);

    expect(consumeApproval(id, CLIENT, "do-x", hash)).toMatchObject({ ok: false }); // pending
    expect(consumeApproval(id, CLIENT, "other", hash)).toMatchObject({ ok: false }); // wrong tool
    expect(decideApproval(id, "approved", "admin", null)).toEqual({
      ok: true,
      finalStatus: "approved",
      approvalsReceived: 1,
      requiredLevels: 1,
    });
    expect(decideApproval(id, "approved", "admin", null)).toMatchObject({ ok: false }); // no longer pending
    expect(consumeApproval(id, CLIENT, "do-x", "deadbeef")).toMatchObject({ ok: false }); // args mismatch
    expect(consumeApproval(id, CLIENT, "do-x", hash)).toEqual({ ok: true }); // first use
    expect(consumeApproval(id, CLIENT, "do-x", hash)).toMatchObject({ ok: false }); // already used
  });
});

describe("proxy flow", () => {
  test("queue -> pending -> approve -> execute once -> already used", async () => {
    await reg();
    setApprovalRequired(CLIENT, "do-x", true);
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response('{"done":true}', { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const r1 = await proxyToolCall(`${CLIENT}__do-x`, { a: "1" });
    expect(r1.isError).toBe(true);
    expect(fetched).toBe(0);
    const id = Number(r1.content[0].text.match(/#(\d+)/)![1]);

    const r2 = await proxyToolCall(`${CLIENT}__do-x`, { a: "1", __approval_id: id });
    expect(r2.content[0].text).toContain("still pending");
    expect(fetched).toBe(0);

    expect(decideApproval(id, "approved", "admin", null)).toEqual({
      ok: true,
      finalStatus: "approved",
      approvalsReceived: 1,
      requiredLevels: 1,
    });

    const r3 = await proxyToolCall(`${CLIENT}__do-x`, { a: "1", __approval_id: id });
    expect(r3.isError).toBeUndefined();
    expect(JSON.parse(r3.content[0].text)).toEqual({ done: true });
    expect(fetched).toBe(1);

    const r4 = await proxyToolCall(`${CLIENT}__do-x`, { a: "1", __approval_id: id });
    expect(r4.content[0].text).toContain("already used");
    expect(fetched).toBe(1);
  });

  test("a rejected ticket blocks the call", async () => {
    await reg();
    setApprovalRequired(CLIENT, "do-x", true);
    globalThis.fetch = (async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const r1 = await proxyToolCall(`${CLIENT}__do-x`, { a: "1" });
    const id = Number(r1.content[0].text.match(/#(\d+)/)![1]);
    decideApproval(id, "rejected", "admin", "not allowed");
    const r = await proxyToolCall(`${CLIENT}__do-x`, { a: "1", __approval_id: id });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("rejected");
  });

  test("an approved ticket cannot be used for different args", async () => {
    await reg();
    setApprovalRequired(CLIENT, "do-x", true);
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const r1 = await proxyToolCall(`${CLIENT}__do-x`, { a: "1" });
    const id = Number(r1.content[0].text.match(/#(\d+)/)![1]);
    decideApproval(id, "approved", "admin", null);
    const r = await proxyToolCall(`${CLIENT}__do-x`, { a: "2", __approval_id: id });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("different arguments");
    expect(fetched).toBe(0);
  });
});

describe("multi-level (N-of-M) approvals", () => {
  test("only flips to approved once 3 distinct approvers have signed off", async () => {
    await reg();
    setApprovalRequired(CLIENT, "do-x", true, 3);
    const hash = approvalArgsHash({ a: "1" });
    const id = createApproval(CLIENT, "do-x", hash, JSON.stringify({ a: "1" }), null, 3);

    let r = decideApproval(id, "approved", "alice", null);
    expect(r).toEqual({ ok: true, finalStatus: "pending", approvalsReceived: 1, requiredLevels: 3 });
    expect(getApproval(id)?.status).toBe("pending");

    r = decideApproval(id, "approved", "bob", null);
    expect(r).toEqual({ ok: true, finalStatus: "pending", approvalsReceived: 2, requiredLevels: 3 });

    r = decideApproval(id, "approved", "carol", null);
    expect(r).toEqual({ ok: true, finalStatus: "approved", approvalsReceived: 3, requiredLevels: 3 });
    expect(getApproval(id)?.status).toBe("approved");
    expect(getApproval(id)?.decisions.map((d) => d.decidedBy)).toEqual(["alice", "bob", "carol"]);
  });

  test("the same actor cannot approve twice", async () => {
    await reg();
    setApprovalRequired(CLIENT, "do-x", true, 2);
    const hash = approvalArgsHash({ a: "1" });
    const id = createApproval(CLIENT, "do-x", hash, JSON.stringify({ a: "1" }), null, 2);

    expect(decideApproval(id, "approved", "alice", null)).toMatchObject({ ok: true, finalStatus: "pending" });
    expect(decideApproval(id, "approved", "alice", null)).toMatchObject({ ok: false });
    expect(getApproval(id)?.status).toBe("pending");
  });

  test("a single reject is an immediate terminal veto even with partial approvals", async () => {
    await reg();
    setApprovalRequired(CLIENT, "do-x", true, 3);
    const hash = approvalArgsHash({ a: "1" });
    const id = createApproval(CLIENT, "do-x", hash, JSON.stringify({ a: "1" }), null, 3);

    expect(decideApproval(id, "approved", "alice", null)).toMatchObject({ ok: true, finalStatus: "pending" });
    expect(decideApproval(id, "rejected", "bob", "no")).toEqual({
      ok: true,
      finalStatus: "rejected",
      approvalsReceived: 0,
      requiredLevels: 3,
    });
    expect(getApproval(id)?.status).toBe("rejected");

    // Terminal — a further decision (even approval) is refused.
    expect(decideApproval(id, "approved", "carol", null)).toMatchObject({ ok: false });
  });

  test("setApprovalRequired persists and clamps the level threshold", async () => {
    await reg();
    expect(setApprovalRequired(CLIENT, "do-x", true, 5)).toBe(true);
    expect(getRequiredLevels(CLIENT, "do-x")).toBe(5);
    const r1 = await proxyToolCall(`${CLIENT}__do-x`, { a: "1" });
    const id = Number(r1.content[0].text.match(/#(\d+)/)![1]);
    expect(getApproval(id)?.requiredLevels).toBe(5);

    // Out-of-range/absent levels are not silently clamped or reset here —
    // setApprovalRequired keeps the tool's existing level unchanged (the admin
    // route layer is what rejects out-of-bounds input up front).
    expect(setApprovalRequired(CLIENT, "do-x", true, 999)).toBe(true);
    expect(getRequiredLevels(CLIENT, "do-x")).toBe(5);
    expect(setApprovalRequired(CLIENT, "do-x", true)).toBe(true);
    expect(getRequiredLevels(CLIENT, "do-x")).toBe(5);
  });
});

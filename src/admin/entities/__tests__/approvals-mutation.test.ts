/**
 * Stryker mutation-testing backstop for src/admin/entities/approvals.ts —
 * domain 9. The existing hand-written test (approvals.test.ts, same
 * directory) already exercises the ticket lifecycle end-to-end (including
 * through the real proxy) and the N-of-M multi-level approval flow in depth.
 * This file is a pure gap-fill — it deliberately does NOT re-test what that
 * file already covers well, and is left completely untouched.
 *
 * Gaps closed here:
 *   - getApprovalConfigForClient (zero prior coverage: keying, per-client
 *     scoping, empty-client shape)
 *   - notifyApproval (zero prior coverage: the URL-configured guard, and the
 *     exact payload/options passed through to dispatchWebhook)
 *   - listApprovals() with NO status filter (only the filtered form was
 *     covered)
 *   - requiresApproval / getRequiredLevels default values when a tool has
 *     never been configured (the `row?.x ?? default` / `row?.x === 1`
 *     fallback paths — unset is the one state the existing file never
 *     exercises)
 *   - setApprovalRequired: the disable path (row deletion), and precise
 *     boundary values around the [1, MAX_APPROVAL_LEVELS] clamp (0,
 *     MAX_APPROVAL_LEVELS itself, MAX_APPROVAL_LEVELS + 1, a non-integer)
 *   - consumeApproval: the clientName-mismatch clause specifically (the
 *     existing file only ever exercised the toolName-mismatch clause), plus
 *     exact message text (not just toContain/toMatchObject) for every
 *     rejection branch including the rejected-with-vs-without-note ternary
 *   - decideApproval: exact not-found / no-longer-pending / duplicate-actor
 *     message text
 *   - approvalArgsHash: order-insensitivity and __approval_id/__confirm
 *     exclusion, asserted directly
 *
 * Run with STRYKER_TEST_SCOPE="src/admin/entities/__tests__".
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { config } from "../../../config.js";
import { __resetDbForTesting, getDb } from "../../../db/connection.js";
import { registry } from "../../../mcp/registry.js";
import { removeCircuitBreaker } from "../../../middleware/circuit-breaker.js";
import * as webhookMod from "../../../lib/webhook.js";
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
  getApprovalConfigForClient,
  notifyApproval,
  MAX_APPROVAL_LEVELS,
} from "../../../admin/entities/approvals.js";
import type { RestToolDefinition } from "../../../mcp/types.js";

const CLIENT = "svc";
const CLIENT2 = "svc2";
const doTool: RestToolDefinition = {
  name: "do-x",
  method: "POST",
  endpoint: "/do",
  description: "do",
  inputSchema: { type: "object", properties: { a: { type: "string" } } },
};
const doYTool: RestToolDefinition = {
  name: "do-y",
  method: "POST",
  endpoint: "/doy",
  description: "doy",
  inputSchema: { type: "object", properties: {} },
};
async function reg(): Promise<void> {
  await registry.register(CLIENT, [doTool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}
async function regBoth(): Promise<void> {
  await registry.register(CLIENT, [doTool, doYTool], "http://1.2.3.4/health", "1.2.3.4", "http://1.2.3.4", "1.2.3.4");
}

const originalFetch = globalThis.fetch;
function resetAll(): void {
  (config as Record<string, unknown>).retryMaxAttempts = 0;
  (config as Record<string, unknown>).approvalWebhookUrl = undefined;
  __resetDbForTesting();
  removeCircuitBreaker(CLIENT);
  removeCircuitBreaker(CLIENT2);
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

describe("requiresApproval / getRequiredLevels — defaults when never configured", () => {
  test("requiresApproval defaults to false for a tool that has never had a tool_approval row", async () => {
    await reg();
    expect(requiresApproval(CLIENT, "do-x")).toBe(false);
  });

  test("getRequiredLevels defaults to 1 for a tool that has never had a tool_approval row", async () => {
    await reg();
    expect(getRequiredLevels(CLIENT, "do-x")).toBe(1);
  });

  test("requiresApproval is false for a client/tool combination that doesn't even exist", () => {
    expect(requiresApproval("no-such-client", "no-such-tool")).toBe(false);
  });
});

describe("setApprovalRequired — disable path", () => {
  test("disabling an enabled tool deletes the tool_approval row and resets both getters to defaults", async () => {
    await reg();
    expect(setApprovalRequired(CLIENT, "do-x", true, 4)).toBe(true);
    expect(requiresApproval(CLIENT, "do-x")).toBe(true);
    expect(getRequiredLevels(CLIENT, "do-x")).toBe(4);
    expect(
      getDb().query(`SELECT 1 FROM tool_approval WHERE client_name = ? AND tool_name = ?`).get(CLIENT, "do-x"),
    ).toBeTruthy();

    expect(setApprovalRequired(CLIENT, "do-x", false)).toBe(true);
    expect(requiresApproval(CLIENT, "do-x")).toBe(false);
    expect(getRequiredLevels(CLIENT, "do-x")).toBe(1);
    expect(
      getDb().query(`SELECT 1 FROM tool_approval WHERE client_name = ? AND tool_name = ?`).get(CLIENT, "do-x"),
    ).toBeNull();
  });

  test("disabling a tool that was never enabled is a no-op that still reports true (tool exists)", async () => {
    await reg();
    expect(setApprovalRequired(CLIENT, "do-x", false)).toBe(true);
    expect(requiresApproval(CLIENT, "do-x")).toBe(false);
  });
});

describe("setApprovalRequired — required-levels clamp boundaries", () => {
  test("exactly the minimum (1) and exactly MAX_APPROVAL_LEVELS are both accepted as-is", async () => {
    await reg();
    expect(MAX_APPROVAL_LEVELS).toBe(10);

    expect(setApprovalRequired(CLIENT, "do-x", true, 1)).toBe(true);
    expect(getRequiredLevels(CLIENT, "do-x")).toBe(1);

    expect(setApprovalRequired(CLIENT, "do-x", true, MAX_APPROVAL_LEVELS)).toBe(true);
    expect(getRequiredLevels(CLIENT, "do-x")).toBe(MAX_APPROVAL_LEVELS);
  });

  test("zero, one above the max, and a non-integer are all rejected and fall back to the existing level", async () => {
    await reg();
    expect(setApprovalRequired(CLIENT, "do-x", true, 6)).toBe(true);
    expect(getRequiredLevels(CLIENT, "do-x")).toBe(6);

    expect(setApprovalRequired(CLIENT, "do-x", true, 0)).toBe(true);
    expect(getRequiredLevels(CLIENT, "do-x")).toBe(6);

    expect(setApprovalRequired(CLIENT, "do-x", true, MAX_APPROVAL_LEVELS + 1)).toBe(true);
    expect(getRequiredLevels(CLIENT, "do-x")).toBe(6);

    expect(setApprovalRequired(CLIENT, "do-x", true, 2.5)).toBe(true);
    expect(getRequiredLevels(CLIENT, "do-x")).toBe(6);

    expect(setApprovalRequired(CLIENT, "do-x", true, -1)).toBe(true);
    expect(getRequiredLevels(CLIENT, "do-x")).toBe(6);
  });

  test("an out-of-range level on a never-before-configured tool falls back to the default of 1", async () => {
    await reg();
    expect(setApprovalRequired(CLIENT, "do-x", true, 0)).toBe(true);
    expect(getRequiredLevels(CLIENT, "do-x")).toBe(1);
  });

  // Kills the >= vs > boundary mutant on `requiredLevels >= 1`: the existing
  // level is deliberately set to something OTHER than 1 first, so that if the
  // lower-bound check were `> 1` instead of `>= 1`, an explicit target of 1
  // would be wrongly rejected and the stale 5 would survive instead of 1.
  test("exactly 1 is accepted as a valid target level even when the existing level differs", async () => {
    await reg();
    expect(setApprovalRequired(CLIENT, "do-x", true, 5)).toBe(true);
    expect(getRequiredLevels(CLIENT, "do-x")).toBe(5);
    expect(setApprovalRequired(CLIENT, "do-x", true, 1)).toBe(true);
    expect(getRequiredLevels(CLIENT, "do-x")).toBe(1);
  });
});

describe("getApprovalConfigForClient", () => {
  test("empty for a client with no configured tools at all", async () => {
    await reg();
    expect(getApprovalConfigForClient(CLIENT)).toEqual({});
  });

  test("keyed by tool name; unconfigured sibling tools of the same client are absent, not defaulted", async () => {
    await regBoth();
    setApprovalRequired(CLIENT, "do-x", true, 3);
    const cfg = getApprovalConfigForClient(CLIENT);
    expect(cfg).toEqual({ "do-x": { required: true, requiredLevels: 3 } });
    expect(cfg["do-y"]).toBeUndefined();
  });

  test("scoped strictly to the given client — a second client's config never leaks in", async () => {
    await regBoth();
    await registry.register(CLIENT2, [doTool], "http://1.2.3.5/health", "1.2.3.5", "http://1.2.3.5", "1.2.3.5");
    setApprovalRequired(CLIENT2, "do-x", true, 7);

    expect(getApprovalConfigForClient(CLIENT)).toEqual({});
    expect(getApprovalConfigForClient(CLIENT2)).toEqual({ "do-x": { required: true, requiredLevels: 7 } });
  });

  test("a disabled (false) config still reports required: false with its own row's level", async () => {
    await reg();
    setApprovalRequired(CLIENT, "do-x", true, 2);
    // Re-enabling with `enabled: false` deletes the row entirely (see the
    // "disable path" tests above), so to observe `required: false` we'd need
    // a row with enabled=0 — which setApprovalRequired never actually
    // writes (it only ever inserts enabled=1 rows or deletes). Assert that
    // behavior directly instead: after disabling, the tool is simply absent.
    setApprovalRequired(CLIENT, "do-x", false);
    expect(getApprovalConfigForClient(CLIENT)).toEqual({});
  });

  // Kills the `r.enabled === 1` -> `true` mutant: setApprovalRequired itself
  // never persists an enabled=0 row (it only ever inserts enabled=1 or
  // deletes), so this is a direct-DB fixture rather than a call through the
  // public setter — it proves the mapping genuinely reads the flag rather
  // than defaulting every present row to required: true.
  test("an enabled=0 row (however it got there) is reported as required: false, not defaulted to true", async () => {
    await reg();
    getDb()
      .query(
        `INSERT INTO tool_approval (client_name, tool_name, enabled, required_levels, updated_at) VALUES (?, ?, 0, ?, ?)`,
      )
      .run(CLIENT, "do-x", 2, Date.now());
    expect(getApprovalConfigForClient(CLIENT)).toEqual({ "do-x": { required: false, requiredLevels: 2 } });
  });
});

describe("listApprovals — no status filter", () => {
  test("returns every status, ordered by id descending, when called with no argument", async () => {
    await reg();
    const hash = approvalArgsHash({ a: "1" });
    const id1 = createApproval(CLIENT, "do-x", hash, JSON.stringify({ a: "1" }), null);
    const id2 = createApproval(CLIENT, "do-x", hash, JSON.stringify({ a: "2" }), null);
    decideApproval(id2, "approved", "admin", null);

    const all = listApprovals();
    expect(all.map((r) => r.id)).toEqual([id2, id1]);
    expect(all.map((r) => r.status)).toEqual(["approved", "pending"]);

    const pendingOnly = listApprovals("pending");
    expect(pendingOnly.map((r) => r.id)).toEqual([id1]);
    const approvedOnly = listApprovals("approved");
    expect(approvedOnly.map((r) => r.id)).toEqual([id2]);
  });
});

describe("approvalArgsHash", () => {
  test("is insensitive to key order", () => {
    const h1 = approvalArgsHash({ a: "1", b: 2 });
    const h2 = approvalArgsHash({ b: 2, a: "1" });
    expect(h1).toBe(h2);
  });

  test("excludes __approval_id and __confirm from the hashed payload", () => {
    const base = approvalArgsHash({ a: "1", b: 2 });
    const withControlKeys = approvalArgsHash({ a: "1", b: 2, __approval_id: 5, __confirm: true });
    expect(withControlKeys).toBe(base);
  });

  test("genuinely different argument content hashes differently", () => {
    const h1 = approvalArgsHash({ a: "1" });
    const h2 = approvalArgsHash({ a: "2" });
    expect(h1).not.toBe(h2);
  });
});

describe("decideApproval — exact message text", () => {
  test("not-found message names the missing id", () => {
    expect(decideApproval(999999, "approved", "admin", null)).toEqual({
      ok: false,
      message: "Approval #999999 not found",
    });
  });

  test("no-longer-pending message fires once the ticket has already been decided", async () => {
    await reg();
    setApprovalRequired(CLIENT, "do-x", true);
    const hash = approvalArgsHash({ a: "1" });
    const id = createApproval(CLIENT, "do-x", hash, JSON.stringify({ a: "1" }), null);
    decideApproval(id, "approved", "admin", null);
    expect(decideApproval(id, "approved", "someone-else", null)).toEqual({
      ok: false,
      message: `Approval #${id} is no longer pending`,
    });
  });

  test("duplicate-actor message names the actor's own approval attempt", async () => {
    await reg();
    setApprovalRequired(CLIENT, "do-x", true, 2);
    const hash = approvalArgsHash({ a: "1" });
    const id = createApproval(CLIENT, "do-x", hash, JSON.stringify({ a: "1" }), null, 2);
    decideApproval(id, "approved", "alice", null);
    expect(decideApproval(id, "approved", "alice", null)).toEqual({
      ok: false,
      message: `You already recorded a decision for approval #${id}`,
    });
  });
});

describe("consumeApproval — clientName mismatch (distinct from toolName mismatch)", () => {
  test("an approved ticket from one client cannot be consumed by another client, even for the same tool name", async () => {
    await reg();
    await registry.register(CLIENT2, [doTool], "http://1.2.3.5/health", "1.2.3.5", "http://1.2.3.5", "1.2.3.5");
    setApprovalRequired(CLIENT, "do-x", true);
    const hash = approvalArgsHash({ a: "1" });
    const id = createApproval(CLIENT, "do-x", hash, JSON.stringify({ a: "1" }), null);
    decideApproval(id, "approved", "admin", null);

    expect(consumeApproval(id, CLIENT2, "do-x", hash)).toEqual({
      ok: false,
      message: `Approval #${id} not found for this tool`,
    });
    // Still fully usable by the client it actually belongs to.
    expect(consumeApproval(id, CLIENT, "do-x", hash)).toEqual({ ok: true });
  });
});

describe("consumeApproval — exact message text for every rejection branch", () => {
  test("unknown id", () => {
    expect(consumeApproval(999999, CLIENT, "do-x", "somehash")).toEqual({
      ok: false,
      message: "Approval #999999 not found for this tool",
    });
  });

  // Kills a convergent-masking mutant on `rec.toolName !== toolName`: while
  // the ticket is still pending, a forced-false toolName check would let
  // execution fall through to the (also {ok:false}) "still pending" branch
  // instead of the intended "not found for this tool" — same `ok` shape,
  // different message. Asserting the exact message (not just {ok:false})
  // is what actually distinguishes the two.
  test("wrong tool name for an otherwise-valid client+hash is rejected with the exact not-found message", async () => {
    await reg();
    setApprovalRequired(CLIENT, "do-x", true);
    const hash = approvalArgsHash({ a: "1" });
    const id = createApproval(CLIENT, "do-x", hash, JSON.stringify({ a: "1" }), null);
    expect(consumeApproval(id, CLIENT, "some-other-tool", hash)).toEqual({
      ok: false,
      message: `Approval #${id} not found for this tool`,
    });
  });

  test("args-hash mismatch", async () => {
    await reg();
    setApprovalRequired(CLIENT, "do-x", true);
    const hash = approvalArgsHash({ a: "1" });
    const id = createApproval(CLIENT, "do-x", hash, JSON.stringify({ a: "1" }), null);
    decideApproval(id, "approved", "admin", null);
    expect(consumeApproval(id, CLIENT, "do-x", "wrong-hash")).toEqual({
      ok: false,
      message: `Approval #${id} was issued for different arguments`,
    });
  });

  test("still pending", async () => {
    await reg();
    setApprovalRequired(CLIENT, "do-x", true);
    const hash = approvalArgsHash({ a: "1" });
    const id = createApproval(CLIENT, "do-x", hash, JSON.stringify({ a: "1" }), null);
    expect(consumeApproval(id, CLIENT, "do-x", hash)).toEqual({
      ok: false,
      message: `Approval #${id} is still pending`,
    });
  });

  test("rejected WITHOUT a note omits the trailing colon entirely", async () => {
    await reg();
    setApprovalRequired(CLIENT, "do-x", true);
    const hash = approvalArgsHash({ a: "1" });
    const id = createApproval(CLIENT, "do-x", hash, JSON.stringify({ a: "1" }), null);
    decideApproval(id, "rejected", "admin", null);
    expect(consumeApproval(id, CLIENT, "do-x", hash)).toEqual({
      ok: false,
      message: `Approval #${id} was rejected`,
    });
  });

  test("rejected WITH a note appends exactly ': <note>'", async () => {
    await reg();
    setApprovalRequired(CLIENT, "do-x", true);
    const hash = approvalArgsHash({ a: "1" });
    const id = createApproval(CLIENT, "do-x", hash, JSON.stringify({ a: "1" }), null);
    decideApproval(id, "rejected", "admin", "no reason given");
    expect(consumeApproval(id, CLIENT, "do-x", hash)).toEqual({
      ok: false,
      message: `Approval #${id} was rejected: no reason given`,
    });
  });

  test("already used", async () => {
    await reg();
    setApprovalRequired(CLIENT, "do-x", true);
    const hash = approvalArgsHash({ a: "1" });
    const id = createApproval(CLIENT, "do-x", hash, JSON.stringify({ a: "1" }), null);
    decideApproval(id, "approved", "admin", null);
    expect(consumeApproval(id, CLIENT, "do-x", hash)).toEqual({ ok: true });
    expect(consumeApproval(id, CLIENT, "do-x", hash)).toEqual({
      ok: false,
      message: `Approval #${id} was already used`,
    });
  });
});

describe("notifyApproval — the webhook guard and payload", () => {
  test("with no approvalWebhookUrl configured, dispatchWebhook is never called", async () => {
    await reg();
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      notifyApproval(1, CLIENT, "do-x");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("with an approvalWebhookUrl configured, dispatches the exact payload and options", async () => {
    await reg();
    (config as Record<string, unknown>).approvalWebhookUrl = "http://127.0.0.1:1/hook";
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      notifyApproval(42, CLIENT, "do-x");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        "http://127.0.0.1:1/hook",
        { type: "approval_requested", id: 42, client: CLIENT, tool: "do-x" },
        {
          timeoutMs: config.approvalWebhookTimeoutMs,
          rejectedLogMessage: "Approval webhook URL rejected",
          failedLogMessage: "Approval webhook delivery failed",
          logContext: { approvalId: 42, client: CLIENT, tool: "do-x" },
        },
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe("getApproval — unknown id", () => {
  test("returns null rather than throwing", () => {
    expect(getApproval(999999)).toBeNull();
  });
});

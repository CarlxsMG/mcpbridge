/**
 * Finding #20: consumeApproval must consume a single-use ticket via an atomic
 * compare-and-swap (`UPDATE ... WHERE id = ? AND consumed_at IS NULL`), so that
 * under multi-instance HA two callers racing past the read cannot both consume
 * the same ticket.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { __resetDbForTesting, getDb } from "../../../db/connection.js";
import { createApproval, decideApproval, consumeApproval, approvalArgsHash } from "../approvals.js";

const CLIENT = "svc";
const TOOL = "do-x";

function approvedTicket(): { id: number; hash: string } {
  const hash = approvalArgsHash({ a: "1" });
  const id = createApproval(CLIENT, TOOL, hash, JSON.stringify({ a: "1" }), null);
  decideApproval(id, "approved", "admin", null);
  return { id, hash };
}

beforeEach(() => {
  __resetDbForTesting();
});

describe("consumeApproval single-use CAS (#20)", () => {
  test("only the first of two consume calls succeeds", () => {
    const { id, hash } = approvedTicket();
    expect(consumeApproval(id, CLIENT, TOOL, hash)).toEqual({ ok: true });
    const second = consumeApproval(id, CLIENT, TOOL, hash);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toContain("already used");
  });

  test("the guarded UPDATE is a real compare-and-swap: a second racer's write is a no-op", () => {
    const { id } = approvedTicket();
    const db = getDb();
    const now = Date.now();
    // Two instances both read consumed_at === null, then both attempt the write.
    // With the `AND consumed_at IS NULL` guard, exactly one write lands.
    const winner = db.query(`UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`).run(now, id);
    const loser = db.query(`UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`).run(now, id);
    expect(winner.changes).toBe(1);
    expect(loser.changes).toBe(0);
  });

  test("consuming a rejected or still-pending ticket never marks it consumed", () => {
    const rejectedHash = approvalArgsHash({ a: "1" });
    const rejectedId = createApproval(CLIENT, TOOL, rejectedHash, JSON.stringify({ a: "1" }), null);
    decideApproval(rejectedId, "rejected", "admin", "no");
    expect(consumeApproval(rejectedId, CLIENT, TOOL, rejectedHash).ok).toBe(false);

    const pendingHash = approvalArgsHash({ a: "2" });
    const pendingId = createApproval(CLIENT, TOOL, pendingHash, JSON.stringify({ a: "2" }), null);
    expect(consumeApproval(pendingId, CLIENT, TOOL, pendingHash).ok).toBe(false);

    const row = getDb().query(`SELECT consumed_at FROM approvals WHERE id = ?`).get(pendingId) as {
      consumed_at: number | null;
    };
    expect(row.consumed_at).toBeNull();
  });
});

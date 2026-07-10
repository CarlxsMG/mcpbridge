/**
 * Stryker mutation-testing backstop for src/admin/audit/audit.ts — domain 9.
 *
 * audit-chain.test.ts (pre-existing, left untouched) already covers the
 * tamper-evidence hash chain (recordAudit/verifyAuditChain) and the SIEM
 * sink's happy path. This file gap-fills what it doesn't: actorFromRequest,
 * listAuditLog's own filter/pagination/limit-clamp logic, listAuditActions,
 * exportAuditLog (including its independent maxRows clamp), recordAudit's
 * error-swallowing catch branch, the streamAuditEvent dispatch guard's
 * "no sink configured" branch (asserted via a dispatchWebhook spy, same
 * pattern as monitor-mutation.test.ts), computeAuditHash's exact join
 * formula (asserted against an independently-computed expected digest, not
 * just "looks like a hex string"), and verifyAuditChain's two independent
 * per-row checks (the prev_hash linkage check vs. the content-hash
 * recomputation check — audit-chain.test.ts's tamper tests only ever
 * corrupt columns that trip both at once, which leaves the prev_hash-only
 * linkage check's own coverage gap-able).
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import type { Request } from "express";
import { config } from "../../../config.js";
import { __resetDbForTesting, getDb } from "../../../db/connection.js";
import { sha256Hex } from "../../../lib/crypto.js";
import {
  actorFromRequest,
  recordAudit,
  verifyAuditChain,
  listAuditLog,
  listAuditActions,
  exportAuditLog,
} from "../../../admin/audit/audit.js";
import * as webhookMod from "../../../lib/webhook.js";

/**
 * Mirrors computeAuditHash's exact (private) formula so tests can assert on
 * the real digest value rather than just its shape — read directly from
 * src/admin/audit/audit.ts's `computeAuditHash`.
 */
function expectedAuditHash(
  prevHash: string,
  actor: string,
  action: string,
  target: string,
  detailJson: string | null,
  createdAt: number,
): string {
  return sha256Hex([prevHash, actor, action, target, detailJson ?? "", String(createdAt)].join("\n"));
}

beforeEach(() => {
  __resetDbForTesting();
  (config as Record<string, unknown>).auditSinkUrl = undefined;
});
afterEach(() => {
  __resetDbForTesting();
  (config as Record<string, unknown>).auditSinkUrl = undefined;
});

/** Directly overwrites a row's created_at for deterministic from/to boundary tests. */
function setCreatedAt(actor: string, createdAt: number): void {
  getDb().query(`UPDATE admin_audit_log SET created_at = ? WHERE actor = ?`).run(createdAt, actor);
}

/** Inserts a pre-hash-chain-migration row (hash/prev_hash both NULL) directly. */
function insertLegacyRow(actor: string, action: string, target: string, createdAt: number): void {
  getDb()
    .query(
      `INSERT INTO admin_audit_log (actor, action, target, detail_json, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(actor, action, target, null, createdAt, null, null);
}

describe("actorFromRequest", () => {
  test("no authContext at all falls back to the bearer label", () => {
    const req = {} as Request;
    expect(actorFromRequest(req)).toBe("bearer:admin-api-key");
  });

  test("bearer method (even carrying a username) uses the bearer label, not the username", () => {
    const req = { authContext: { method: "bearer", username: "someone" } } as unknown as Request;
    expect(actorFromRequest(req)).toBe("bearer:admin-api-key");
  });

  test("session method with a username returns the username", () => {
    const req = { authContext: { method: "session", username: "alice" } } as unknown as Request;
    expect(actorFromRequest(req)).toBe("alice");
  });

  test("session method with an empty-string username falls back to the bearer label", () => {
    const req = { authContext: { method: "session", username: "" } } as unknown as Request;
    expect(actorFromRequest(req)).toBe("bearer:admin-api-key");
  });

  test("session method with no username at all falls back to the bearer label", () => {
    const req = { authContext: { method: "session" } } as unknown as Request;
    expect(actorFromRequest(req)).toBe("bearer:admin-api-key");
  });
});

describe("recordAudit — error swallowing", () => {
  test("a detail object that can't be JSON-serialized is swallowed, no row inserted", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => recordAudit("a", "act", "t", circular)).not.toThrow();
    expect(listAuditLog().items).toEqual([]);
  });
});

describe("recordAudit — the content hash's exact join formula", () => {
  test("with a detail object, the stored hash matches prevHash+actor+action+target+JSON(detail)+createdAt joined with \\n", () => {
    recordAudit("alice", "act.one", "target1", { k: "v" });
    const row = getDb().query(`SELECT hash, created_at FROM admin_audit_log ORDER BY id ASC LIMIT 1`).get() as {
      hash: string;
      created_at: number;
    };
    const expected = expectedAuditHash("", "alice", "act.one", "target1", JSON.stringify({ k: "v" }), row.created_at);
    expect(row.hash).toBe(expected);
  });

  test("with no detail, the hashed detail segment is the ??-fallback empty string, not a placeholder", () => {
    recordAudit("bob", "act.two", "target2");
    const row = getDb().query(`SELECT hash, created_at FROM admin_audit_log ORDER BY id ASC LIMIT 1`).get() as {
      hash: string;
      created_at: number;
    };
    const expected = expectedAuditHash("", "bob", "act.two", "target2", null, row.created_at);
    expect(row.hash).toBe(expected);
  });
});

describe("verifyAuditChain — the two independent per-row checks", () => {
  test("tampering only the prev_hash column (leaving the row's own hash untouched) is still detected", () => {
    // Corrupting prev_hash alone does NOT change the recomputed content hash
    // (computeAuditHash is fed the in-memory tracked prevHash, not the row's
    // own prev_hash column), so only the dedicated linkage check
    // `(r.prev_hash ?? "") !== prevHash` can catch this class of tamper.
    recordAudit("a", "x", "t1");
    recordAudit("b", "y", "t2");
    const second = (
      getDb().query(`SELECT id FROM admin_audit_log ORDER BY id ASC LIMIT 1 OFFSET 1`).get() as { id: number }
    ).id;
    getDb().query(`UPDATE admin_audit_log SET prev_hash = 'tampered' WHERE id = ?`).run(second);
    const v = verifyAuditChain();
    expect(v.ok).toBe(false);
    expect(v.brokenAtId).toBe(second);
  });

  test("a genuinely-genesis row with a NULL (not empty-string) prev_hash still verifies via the defensive ?? fallback", () => {
    const createdAt = Date.now();
    const hash = expectedAuditHash("", "x", "act", "t", null, createdAt);
    getDb()
      .query(
        `INSERT INTO admin_audit_log (actor, action, target, detail_json, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("x", "act", "t", null, createdAt, null, hash);
    expect(verifyAuditChain()).toEqual({ ok: true, checked: 1 });
  });
});

describe("recordAudit — SIEM dispatch guard", () => {
  test("with no sink configured, dispatchWebhook is never called", () => {
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      recordAudit("a", "act", "t");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("with a sink configured, dispatchWebhook is called with the exact event + options", () => {
    const originalTimeout = config.auditSinkTimeoutMs;
    (config as Record<string, unknown>).auditSinkUrl = "http://127.0.0.1:1/sink";
    (config as Record<string, unknown>).auditSinkTimeoutMs = 4321;
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      recordAudit("alice", "client.enable", "svc", { note: 1 });
      expect(spy).toHaveBeenCalledTimes(1);
      const [url, payload, options] = spy.mock.calls[0]!;
      expect(url).toBe("http://127.0.0.1:1/sink");
      expect(payload).toMatchObject({
        actor: "alice",
        action: "client.enable",
        target: "svc",
        detail: { note: 1 },
      });
      expect(typeof (payload as Record<string, unknown>).hash).toBe("string");
      expect(typeof (payload as Record<string, unknown>).createdAt).toBe("number");
      expect(options).toMatchObject({
        timeoutMs: 4321,
        rejectedLogMessage: "Audit sink URL rejected",
        failedLogMessage: "Audit sink delivery failed",
      });
    } finally {
      spy.mockRestore();
      (config as Record<string, unknown>).auditSinkTimeoutMs = originalTimeout;
    }
  });

  test("with a sink configured but no detail passed, the event's detail is null (not undefined)", () => {
    (config as Record<string, unknown>).auditSinkUrl = "http://127.0.0.1:1/sink";
    const spy = spyOn(webhookMod, "dispatchWebhook").mockResolvedValue(true);
    try {
      recordAudit("bob", "tool.disable", "svc__x");
      const [, payload] = spy.mock.calls[0]!;
      expect((payload as Record<string, unknown>).detail).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("listAuditLog — filters", () => {
  test("no filters returns every row, newest first", () => {
    recordAudit("a", "act1", "t1");
    recordAudit("b", "act2", "t2");
    const { items } = listAuditLog();
    expect(items.map((i) => i.actor)).toEqual(["b", "a"]);
  });

  test("actor filter narrows to only matching rows", () => {
    recordAudit("alice", "act1", "t1");
    recordAudit("bob", "act1", "t2");
    recordAudit("alice", "act2", "t3");
    const { items } = listAuditLog({ actor: "alice" });
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.actor === "alice")).toBe(true);
  });

  test("action filter narrows to only matching rows", () => {
    recordAudit("alice", "client.enable", "t1");
    recordAudit("alice", "client.disable", "t2");
    const { items } = listAuditLog({ action: "client.enable" });
    expect(items).toHaveLength(1);
    expect(items[0]!.action).toBe("client.enable");
  });

  test("actor and action filters compose with AND, not OR", () => {
    recordAudit("alice", "x", "t1");
    recordAudit("alice", "y", "t2");
    recordAudit("bob", "x", "t3");
    const { items } = listAuditLog({ actor: "alice", action: "x" });
    expect(items).toHaveLength(1);
    expect(items[0]!.target).toBe("t1");
  });

  test("from boundary is inclusive and distinguishes zero from unset", () => {
    recordAudit("neg", "act", "t");
    recordAudit("zero", "act", "t");
    recordAudit("pos", "act", "t");
    setCreatedAt("neg", -50);
    setCreatedAt("zero", 0);
    setCreatedAt("pos", 50);
    const { items } = listAuditLog({ from: 0 });
    expect(items.map((i) => i.actor).sort()).toEqual(["pos", "zero"]);
  });

  test("to boundary is inclusive and distinguishes zero from unset", () => {
    recordAudit("neg", "act", "t");
    recordAudit("zero", "act", "t");
    recordAudit("pos", "act", "t");
    setCreatedAt("neg", -50);
    setCreatedAt("zero", 0);
    setCreatedAt("pos", 50);
    const { items } = listAuditLog({ to: 0 });
    expect(items.map((i) => i.actor).sort()).toEqual(["neg", "zero"]);
  });

  test("detail round-trips through JSON, and is null when omitted", () => {
    recordAudit("a", "act", "t", { nested: { n: 1 }, arr: [1, 2] });
    recordAudit("b", "act", "t2");
    const { items } = listAuditLog();
    const withDetail = items.find((i) => i.actor === "a")!;
    const withoutDetail = items.find((i) => i.actor === "b")!;
    expect(withDetail.detail).toEqual({ nested: { n: 1 }, arr: [1, 2] });
    expect(withoutDetail.detail).toBeNull();
  });

  test("a legacy pre-hash-chain row (hash column NULL) is exposed with hash: null", () => {
    insertLegacyRow("legacy", "act", "t", Date.now());
    const { items } = listAuditLog();
    expect(items[0]!.hash).toBeNull();
  });
});

describe("listAuditLog — pagination and limit clamping", () => {
  test("limit is clamped up to at least 1 when zero is requested", () => {
    recordAudit("a", "act", "t1");
    recordAudit("b", "act", "t2");
    recordAudit("c", "act", "t3");
    const { items, nextCursor } = listAuditLog({ limit: 0 });
    expect(items).toHaveLength(1);
    expect(nextCursor).toBeDefined();
  });

  test("cursor walks to the next older page, and the last page has no nextCursor", () => {
    recordAudit("a", "act", "t1");
    recordAudit("b", "act", "t2");
    recordAudit("c", "act", "t3");
    const first = listAuditLog({ limit: 2 });
    expect(first.items.map((i) => i.actor)).toEqual(["c", "b"]);
    expect(first.nextCursor).toBeDefined();
    const second = listAuditLog({ limit: 2, cursor: first.nextCursor });
    expect(second.items.map((i) => i.actor)).toEqual(["a"]);
    expect(second.nextCursor).toBeUndefined();
  });
});

describe("listAuditActions", () => {
  test("returns distinct actions sorted alphabetically", () => {
    recordAudit("a", "zeta.action", "t");
    recordAudit("a", "alpha.action", "t");
    recordAudit("a", "alpha.action", "t2");
    expect(listAuditActions()).toEqual(["alpha.action", "zeta.action"]);
  });

  test("empty log returns an empty array", () => {
    expect(listAuditActions()).toEqual([]);
  });
});

describe("exportAuditLog", () => {
  test("applies the same actor/action filters as listAuditLog, composed with AND", () => {
    recordAudit("alice", "x", "t1");
    recordAudit("alice", "y", "t2");
    recordAudit("bob", "x", "t3");
    expect(exportAuditLog({ actor: "alice" })).toHaveLength(2);
    expect(exportAuditLog({ action: "x" })).toHaveLength(2);
    expect(exportAuditLog({ actor: "alice", action: "x" })).toHaveLength(1);
  });

  test("from/to boundary zero distinguishes from unset, same as listAuditLog", () => {
    recordAudit("neg", "act", "t");
    recordAudit("zero", "act", "t");
    recordAudit("pos", "act", "t");
    setCreatedAt("neg", -50);
    setCreatedAt("zero", 0);
    setCreatedAt("pos", 50);
    expect(
      exportAuditLog({ from: 0 })
        .map((i) => i.actor)
        .sort(),
    ).toEqual(["pos", "zero"]);
    expect(
      exportAuditLog({ to: 0 })
        .map((i) => i.actor)
        .sort(),
    ).toEqual(["neg", "zero"]);
  });

  test("maxRows caps the result count (LIMIT actually applied), newest first", () => {
    recordAudit("a", "act", "t1");
    recordAudit("b", "act", "t2");
    recordAudit("c", "act", "t3");
    recordAudit("d", "act", "t4");
    recordAudit("e", "act", "t5");
    const rows = exportAuditLog({}, 2);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.actor)).toEqual(["e", "d"]);
  });

  test("maxRows is clamped up to at least 1 when zero is requested", () => {
    recordAudit("a", "act", "t1");
    recordAudit("b", "act", "t2");
    const rows = exportAuditLog({}, 0);
    expect(rows).toHaveLength(1);
  });

  test("with no explicit maxRows the default comfortably covers the fixture", () => {
    recordAudit("a", "act", "t1");
    recordAudit("b", "act", "t2");
    expect(exportAuditLog()).toHaveLength(2);
  });

  test("detail round-trips through JSON and is null when omitted; hash is null for legacy rows", () => {
    recordAudit("a", "act", "t", { k: "v" });
    recordAudit("b", "act", "t2");
    insertLegacyRow("legacy", "act", "t3", Date.now());
    const rows = exportAuditLog();
    expect(rows.find((r) => r.actor === "a")!.detail).toEqual({ k: "v" });
    expect(rows.find((r) => r.actor === "b")!.detail).toBeNull();
    expect(rows.find((r) => r.actor === "legacy")!.hash).toBeNull();
  });
});

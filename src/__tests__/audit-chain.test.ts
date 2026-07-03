/**
 * Audit log tamper-evidence (hash chain) + SIEM streaming.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { config } from "../config.js";
import { __resetDbForTesting, getDb } from "../db/connection.js";
import { recordAudit, verifyAuditChain, listAuditLog } from "../admin/audit.js";
import { requestIdMiddleware } from "../middleware/request-id.js";

beforeEach(() => {
  __resetDbForTesting();
  (config as Record<string, unknown>).auditSinkUrl = undefined;
});
afterEach(() => {
  __resetDbForTesting();
  (config as Record<string, unknown>).auditSinkUrl = undefined;
});

describe("audit hash chain", () => {
  test("consecutive events form a verifiable chain", () => {
    recordAudit("alice", "client.enable", "svc");
    recordAudit("bob", "tool.disable", "svc__get-x");
    recordAudit("carol", "config.export", "config");

    const v = verifyAuditChain();
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(3);

    // Each row links to the previous row's hash; the first is genesis (prev "").
    const rows = getDb().query(`SELECT prev_hash, hash FROM admin_audit_log ORDER BY id ASC`).all() as {
      prev_hash: string;
      hash: string;
    }[];
    expect(rows[0].prev_hash).toBe("");
    expect(rows[1].prev_hash).toBe(rows[0].hash);
    expect(rows[2].prev_hash).toBe(rows[1].hash);
  });

  test("editing a historical row is detected", () => {
    recordAudit("alice", "client.enable", "svc");
    recordAudit("bob", "client.disable", "svc");
    const first = (getDb().query(`SELECT id FROM admin_audit_log ORDER BY id ASC LIMIT 1`).get() as { id: number }).id;

    // Tamper: change the target of the first row out of band.
    getDb().query(`UPDATE admin_audit_log SET target = 'evil' WHERE id = ?`).run(first);

    const v = verifyAuditChain();
    expect(v.ok).toBe(false);
    expect(v.brokenAtId).toBe(first);
  });

  test("deleting a row breaks the linkage of the next", () => {
    recordAudit("a", "x", "t1");
    recordAudit("b", "y", "t2");
    recordAudit("c", "z", "t3");
    const second = (
      getDb().query(`SELECT id FROM admin_audit_log ORDER BY id ASC LIMIT 1 OFFSET 1`).get() as { id: number }
    ).id;
    getDb().query(`DELETE FROM admin_audit_log WHERE id = ?`).run(second);
    expect(verifyAuditChain().ok).toBe(false);
  });

  test("listAuditLog exposes the per-row hash", () => {
    recordAudit("a", "x", "t");
    expect(listAuditLog().items[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("empty log verifies as ok", () => {
    expect(verifyAuditChain()).toEqual({ ok: true, checked: 0 });
  });
});

describe("audit SIEM streaming", () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server)
        server.close(() => {
          server = null;
          resolve();
        });
      else resolve();
    });
  });

  test("posts each event to the configured sink", async () => {
    let received: Record<string, unknown> | null = null;
    let resolveGot!: () => void;
    const got = new Promise<void>((r) => {
      resolveGot = r;
    });

    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.post("/sink", (req, res) => {
      received = req.body as Record<string, unknown>;
      res.status(200).end();
      resolveGot();
    });
    await new Promise<void>((resolve) => {
      const srv = app.listen(0, "127.0.0.1", () => {
        (config as Record<string, unknown>).auditSinkUrl =
          `http://127.0.0.1:${(srv.address() as AddressInfo).port}/sink`;
        server = srv;
        resolve();
      });
    });

    recordAudit("alice", "client.enable", "svc", { note: 1 });
    await Promise.race([got, new Promise((_r, rej) => setTimeout(() => rej(new Error("sink not called")), 3000))]);

    expect(received).not.toBeNull();
    expect(received!.actor).toBe("alice");
    expect(received!.action).toBe("client.enable");
    expect(typeof received!.hash).toBe("string");
  });
});

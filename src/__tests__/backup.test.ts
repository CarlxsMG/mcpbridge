/**
 * HTTP-level tests for src/routes/backup.ts.
 *
 * Uses a real file-backed (WAL) database rather than ":memory:" so the test
 * exercises the actual VACUUM INTO path against a live on-disk DB — the
 * scenario the endpoint exists to make safe.
 */
import { describe, test, expect, afterEach } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "fs";
import { dirname } from "path";
import { config } from "../config.js";
import { __resetDbForTesting } from "../db/connection.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import { createUser } from "../security/user-store.js";
import { createSession } from "../security/session-store.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../security/cookies.js";
import { recordAudit } from "../admin/audit.js";

let baseUrl = "";
let server: Server | null = null;
const ADMIN_KEY = "test-backup-admin-key";
const scratchDir =
  "C:\\Users\\carlo\\AppData\\Local\\Temp\\claude\\C--Users-carlo-Desktop-test-1\\7ba44e1b-d5fb-449a-a74d-5c6ac6f7c43f\\scratchpad";
const dbPath = `${scratchDir}\\backup-route-test.db`;

function cleanupDbFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const p = `${path}${suffix}`;
    if (!existsSync(p)) continue;
    try {
      rmSync(p);
    } catch {
      // Best-effort — Windows can briefly hold a lock after a Database.close()
      // call returns (e.g. antivirus scan); the scratchpad dir is ephemeral
      // anyway, so a stray leftover here isn't worth failing the test over.
    }
  }
}

async function startApp(): Promise<void> {
  cleanupDbFiles(dbPath);
  (config as Record<string, unknown>).dbPath = dbPath;
  __resetDbForTesting(dbPath);
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { backupRoutes } = await import("../routes/backup.js");
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  backupRoutes(app);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      server = srv;
      resolve();
    });
    srv.on("error", reject);
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}` };
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server)
      server.close(() => {
        server = null;
        resolve();
      });
    else resolve();
  });
  __resetDbForTesting();
  cleanupDbFiles(dbPath);
});

describe("POST /admin-api/backup", () => {
  test("returns a valid, openable SQLite snapshot with the right headers", async () => {
    await startApp();
    // Seed a known, pre-existing row so we can prove the *downloaded bytes*
    // (not just some sqlite file) are a real snapshot of this DB's content.
    // (The route's own "backup.create" audit row is written *after* VACUUM
    // INTO runs, so it deliberately is NOT expected to appear here.)
    recordAudit("test-seed", "seed.marker", "target-x");

    const res = await fetch(`${baseUrl}/admin-api/backup`, { method: "POST", headers: bearer() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="mcp-bridge-backup-.*\.db"$/);

    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);

    const outPath = `${scratchDir}\\backup-route-downloaded.db`;
    cleanupDbFiles(outPath);
    await Bun.write(outPath, buf);
    try {
      // Re-open the downloaded bytes as an independent SQLite handle and run a
      // trivial query against a known table — proves the snapshot isn't
      // truncated/corrupt, not just that some bytes came back.
      const reopened = new Database(outPath, { readonly: true });
      const row = reopened.query("SELECT COUNT(*) as c FROM admin_audit_log WHERE action = 'seed.marker'").get() as {
        c: number;
      };
      expect(row.c).toBe(1);
      reopened.close();
    } finally {
      cleanupDbFiles(outPath);
    }
  });

  test("does not leave the temp snapshot file behind on disk", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/backup`, { method: "POST", headers: bearer() });
    await res.arrayBuffer(); // fully drain the response so the server-side stream 'close' fires

    // Pin down the exact filename this request produced (rather than scanning
    // the whole directory) so a slow-to-clean-up file from another test in
    // this suite can't cause a false positive here.
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = disposition.match(/filename="([^"]+)"/);
    expect(match).not.toBeNull();
    const filePath = `${dirname(dbPath)}\\${match![1]}`;

    // The unlink is fired from the stream's 'close' handler asynchronously —
    // poll (generously, since a busy test-suite run can add I/O latency)
    // rather than assuming a fixed delay is always enough.
    let stillThere = existsSync(filePath);
    for (let i = 0; stillThere && i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      stillThere = existsSync(filePath);
    }
    expect(stillThere).toBe(false);
  });

  test("requires auth (401 with no credentials)", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/admin-api/backup`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("rejects a non-admin session role (403)", async () => {
    await startApp();
    const u = createUser("op-backup", "hash", "operator", null);
    const s = createSession(u.id, "127.0.0.1", "agent");
    const res = await fetch(`${baseUrl}/admin-api/backup`, {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${s.token}; ${CSRF_COOKIE_NAME}=${s.csrfToken}`,
        "X-CSRF-Token": s.csrfToken,
      },
    });
    expect(res.status).toBe(403);
  });

  test("an admin session (not just a bearer key) can back up", async () => {
    await startApp();
    const u = createUser("root-backup", "hash", "admin", null);
    const s = createSession(u.id, "127.0.0.1", "agent");
    const res = await fetch(`${baseUrl}/admin-api/backup`, {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${s.token}; ${CSRF_COOKIE_NAME}=${s.csrfToken}`,
        "X-CSRF-Token": s.csrfToken,
      },
    });
    expect(res.status).toBe(200);
  });
});

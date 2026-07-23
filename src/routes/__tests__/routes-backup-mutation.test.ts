/**
 * Stryker mutation-testing backstop for src/routes/backup.ts — domain 8.
 * Baseline: 42 mutants, 0 killed / 42 survived — zero test coverage of any
 * kind existed before this. All line:col citations below were read directly
 * from reports/mutation/result.json.
 */
import { describe, test, expect, spyOn } from "bun:test";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { Readable } from "stream";
import { existsSync, mkdirSync } from "fs";
import * as fsMod from "fs";
import * as fsPromisesMod from "fs/promises";
import { dirname, join } from "path";
import { unlink } from "fs/promises";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import * as dbConnMod from "../../db/connection.js";
import * as auditMod from "../../admin/audit/audit.js";
import * as loggerMod from "../../logger.js";

const ADMIN_KEY = "test-admin-key-backup-mut";
const FILENAME_RE = /^mcp-bridge-backup-\d+-[0-9a-f]{8}\.db$/;

async function startApp(): Promise<{ baseUrl: string; server: Server }> {
  __resetDbForTesting();
  // backup.ts writes its snapshot to backupDir() === dirname(config.dbPath),
  // and SQLite will not create a missing parent directory. Under test the DB is
  // in-memory (__resetDbForTesting defaults to ":memory:"), so db/connection.ts's
  // own mkdirSync — which is what creates that directory when the real app boots
  // — never runs, and the directory only exists on a machine that has previously
  // run the gateway. A clean checkout (CI, a fresh clone) has no ./data, so every
  // backup here failed with "unable to open database". Create it the same way the
  // app does at boot; it is gitignored, and this mirrors production rather than
  // working around it.
  mkdirSync(dirname(config.dbPath), { recursive: true });
  (config as Record<string, unknown>).adminApiKeys = [ADMIN_KEY];
  (config as Record<string, unknown>).authDisabled = false;
  const { backupRoutes } = await import("../../routes/backup.js");
  const app = express();
  backupRoutes(app);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      resolve({ baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, server: srv });
    });
    srv.on("error", reject);
  });
}

function bearer(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_KEY}` };
}

function filenameFromContentDisposition(header: string | null): string {
  const m = header?.match(/filename="([^"]+)"/);
  if (!m) throw new Error(`no filename in Content-Disposition: ${header}`);
  return m[1];
}

/**
 * The server's stream "close" handler (and the unlink() it fires) can
 * resolve slightly after the client's fetch() sees the response as fully
 * received, so cleanup must be polled rather than checked immediately.
 */
async function waitForFileGone(path: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`file still present after ${timeoutMs}ms: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const { baseUrl, server } = await startApp();
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("POST /admin-api/backup", () => {
  // Kills 5/6/7 (whole function/route-path/handler body emptied), 8/9 (the
  // filename template literal emptied and the `.slice(0, 8)` call dropped
  // from the uuid -- an untruncated 36-char uuid would fail this exact
  // pattern), 10/11 (the VACUUM try body/SQL-string emptied), 13/14
  // (complement -- must NOT hit the VACUUM-failure branch), 15/16/17 (the
  // recordAudit action/target/detail literals), 18 (complement -- a real
  // size must be read), 20/21 (complement -- must NOT hit the
  // stat-failure branch), 22-26 (the three response header
  // key/value literals), 27 (the cleanup function body emptied -- the
  // temp file must actually be removed after a successful stream), and 1
  // (backupDir's `?:` forced-true direction, which would write to
  // `process.cwd()` instead of the real DB directory -- proven by
  // capturing the exact path `createReadStream` was called with).
  test("a fully valid backup is streamed with the exact headers, audited, and cleaned up afterward", async () => {
    await withApp(async (baseUrl) => {
      const realCreateReadStream = fsMod.createReadStream;
      let capturedPath = "";
      const streamSpy = spyOn(fsMod, "createReadStream").mockImplementation((p, opts) => {
        capturedPath = String(p);
        return realCreateReadStream(p as string, opts);
      });
      const auditSpy = spyOn(auditMod, "recordAudit");
      try {
        const res = await fetch(`${baseUrl}/admin-api/backup`, { method: "POST", headers: bearer() });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/octet-stream");
        const disposition = res.headers.get("content-disposition");
        const filename = filenameFromContentDisposition(disposition);
        expect(filename).toMatch(FILENAME_RE);
        expect(disposition).toBe(`attachment; filename="${filename}"`);

        const contentLength = Number(res.headers.get("content-length"));
        const bytes = await res.arrayBuffer();
        expect(bytes.byteLength).toBe(contentLength);
        expect(contentLength).toBeGreaterThan(0);

        expect(auditSpy).toHaveBeenCalledWith(expect.any(String), "backup.create", "database", { filename });

        // config.dbPath is the non-":memory:" default during tests, so
        // backupDir() must resolve to dirname(config.dbPath), not
        // process.cwd() (kills mutant 1's forced-true direction).
        expect(capturedPath).toBe(join(dirname(config.dbPath), filename));

        // The route's own "close" listener must have actually unlinked
        // the temp file after streaming completed (kills 27 and 41).
        await waitForFileGone(capturedPath);
      } finally {
        streamSpy.mockRestore();
        auditSpy.mockRestore();
      }
    });
  });

  // Kills mutant 2 (backupDir's `?:` forced-false direction) and 4 (the
  // ":memory:" literal emptied): with config.dbPath temporarily set to
  // ":memory:", the real branch must resolve to process.cwd(), not
  // dirname(":memory:") (".").
  test('backupDir resolves to process.cwd() when config.dbPath is ":memory:"', async () => {
    await withApp(async (baseUrl) => {
      const originalDbPath = config.dbPath;
      (config as Record<string, unknown>).dbPath = ":memory:";
      const realCreateReadStream = fsMod.createReadStream;
      let capturedPath = "";
      const streamSpy = spyOn(fsMod, "createReadStream").mockImplementation((p, opts) => {
        capturedPath = String(p);
        return realCreateReadStream(p as string, opts);
      });
      try {
        const res = await fetch(`${baseUrl}/admin-api/backup`, { method: "POST", headers: bearer() });
        expect(res.status).toBe(200);
        await res.arrayBuffer();
        const filename = filenameFromContentDisposition(res.headers.get("content-disposition"));
        expect(capturedPath).toBe(join(process.cwd(), filename));
      } finally {
        streamSpy.mockRestore();
        (config as Record<string, unknown>).dbPath = originalDbPath;
      }
    });
  });

  // Kills 12/13/14 (the VACUUM catch body and its exact code/message).
  test("a VACUUM failure returns the exact BACKUP_FAILED 500", async () => {
    await withApp(async (baseUrl) => {
      const spy = spyOn(dbConnMod, "getDb").mockImplementation(() => {
        throw new Error("vacuum boom");
      });
      try {
        const res = await fetch(`${baseUrl}/admin-api/backup`, { method: "POST", headers: bearer() });
        expect(res.status).toBe(500);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("BACKUP_FAILED");
        expect(body.error.message).toBe("Failed to create backup: vacuum boom");
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Kills 19/20/21 (the stat catch body and its exact code/message). The
  // real VACUUM still succeeds (only `stat` is mocked to fail), so the
  // real temp file is left on disk by the route (which does not clean up
  // on this branch) -- captured and removed manually here.
  test("a stat failure after a successful VACUUM returns the exact BACKUP_FAILED 500", async () => {
    await withApp(async (baseUrl) => {
      let capturedPath: string | undefined;
      const spy = spyOn(fsPromisesMod, "stat").mockImplementation(async (p) => {
        capturedPath = String(p);
        throw new Error("stat boom");
      });
      try {
        const res = await fetch(`${baseUrl}/admin-api/backup`, { method: "POST", headers: bearer() });
        expect(res.status).toBe(500);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("BACKUP_FAILED");
        expect(body.error.message).toBe("Backup snapshot missing after creation: stat boom");
      } finally {
        spy.mockRestore();
        if (capturedPath) await unlink(capturedPath).catch(() => {});
      }
    });
  });

  // Kills 28 (the unlink().catch() callback body emptied), 29/30 (the
  // "warn" level and message literals emptied), and 31 (the log meta
  // object `{ path, error }` emptied) -- a successful backup whose
  // cleanup unlink() itself fails must still log a warning with the
  // exact shape.
  test("a cleanup unlink failure logs a warning with the exact message and meta", async () => {
    await withApp(async (baseUrl) => {
      const realCreateReadStream = fsMod.createReadStream;
      let capturedPath = "";
      const streamSpy = spyOn(fsMod, "createReadStream").mockImplementation((p, opts) => {
        capturedPath = String(p);
        return realCreateReadStream(p as string, opts);
      });
      const unlinkSpy = spyOn(fsPromisesMod, "unlink").mockRejectedValue(new Error("unlink boom"));
      const logSpy = spyOn(loggerMod, "log");
      try {
        const res = await fetch(`${baseUrl}/admin-api/backup`, { method: "POST", headers: bearer() });
        expect(res.status).toBe(200);
        await res.arrayBuffer();
        // The stream "close" handler's fire-and-forget unlink().catch()
        // needs a tick to run after the response finishes.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(logSpy).toHaveBeenCalledWith("warn", "Failed to remove temporary backup file", {
          path: capturedPath,
          error: "unlink boom",
        });
      } finally {
        streamSpy.mockRestore();
        unlinkSpy.mockRestore();
        logSpy.mockRestore();
        // unlink() is mocked to always fail above, so the real file is
        // still on disk -- remove it now with the restored real unlink.
        await unlink(capturedPath).catch(() => {});
      }
    });
  });

  // Kills 32 (the "error" event-name string emptied -- the handler would
  // never fire at all), 33 (the error-handler body emptied), 34/35/36 (the
  // `!res.headersSent` cluster's "always take the destroy branch"
  // direction), 37 (the pre-headers branch body emptied), and 38/39 (the
  // exact code/message literals). The route's own `cleanup()` (called
  // directly from the error handler, not just via "close") still removes
  // the real file VACUUM created.
  test("a stream error before any data is sent returns the exact BACKUP_STREAM_FAILED 500", async () => {
    await withApp(async (baseUrl) => {
      const spy = spyOn(fsMod, "createReadStream").mockImplementation(() => {
        const r = new Readable({
          read() {
            queueMicrotask(() => r.emit("error", new Error("stream boom")));
          },
        });
        return r as unknown as ReturnType<typeof fsMod.createReadStream>;
      });
      try {
        const res = await fetch(`${baseUrl}/admin-api/backup`, { method: "POST", headers: bearer() });
        expect(res.status).toBe(500);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("BACKUP_STREAM_FAILED");
        expect(body.error.message).toBe("Failed to stream backup file: stream boom");
      } finally {
        spy.mockRestore();
      }
    });
  });

  // Kills the complementary direction of 34/35/36 and 40 (the post-headers
  // `res.destroy(err)` branch body emptied): once real bytes have already
  // flushed (headers sent, status 200 committed), a later stream error
  // must NOT attempt a second JSON response -- it destroys the connection
  // instead, so the client observes a 200 with a truncated/incomplete body
  // rather than a clean error envelope.
  test("a stream error after headers are already sent destroys the connection instead of double-responding", async () => {
    await withApp(async (baseUrl) => {
      const spy = spyOn(fsMod, "createReadStream").mockImplementation(() => {
        let pushed = false;
        const r = new Readable({
          read() {
            if (!pushed) {
              pushed = true;
              this.push(Buffer.from("partial-data-before-the-crash"));
              queueMicrotask(() => queueMicrotask(() => r.emit("error", new Error("mid-stream boom"))));
            }
          },
        });
        return r as unknown as ReturnType<typeof fsMod.createReadStream>;
      });
      try {
        // The connection is actively destroyed mid-stream (real code), so
        // the client observes a hard failure -- either the initial fetch()
        // itself rejects, or a subsequent body read does. Bun may surface
        // this at either point depending on how much was buffered before
        // the reset, so both are accepted as proof `res.destroy(err)` ran.
        // A mutant that empties this branch instead does nothing, leaving
        // the response to hang rather than terminate -- Stryker's own
        // per-mutant test timeout catches that case as a kill.
        let threw = false;
        try {
          const res = await fetch(`${baseUrl}/admin-api/backup`, { method: "POST", headers: bearer() });
          await res.arrayBuffer();
        } catch {
          threw = true;
        }
        expect(threw).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

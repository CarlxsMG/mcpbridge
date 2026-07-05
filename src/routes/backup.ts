import type { Request, Response, Express } from "express";
import { createReadStream } from "fs";
import { stat, unlink } from "fs/promises";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { adminAuth } from "../middleware/auth.js";
import { requireAdminRole } from "../middleware/authz.js";
import { getDb } from "../db/connection.js";
import { config } from "../config.js";
import { recordAudit, actorFromRequest } from "../admin/audit/audit.js";
import { sendError } from "./http-errors.js";
import { log } from "../logger.js";

/**
 * Directory the temp snapshot is written to before being streamed back and
 * deleted. Same directory as the live DB file (falls back to cwd for the
 * ":memory:" test/ephemeral configuration, which has no directory of its own).
 */
function backupDir(): string {
  return config.dbPath === ":memory:" ? process.cwd() : dirname(config.dbPath);
}

export function backupRoutes(app: Express): void {
  /**
   * Produces a consistent, downloadable snapshot of the admin database.
   *
   * Uses SQLite's `VACUUM INTO` rather than copying the live `.db` file: under
   * WAL mode the on-disk file alone is not a consistent snapshot (committed
   * data can still be sitting in the -wal file, and a raw copy can land
   * mid-write), so a naive `fs.copyFile` can produce a corrupt or stale
   * backup. `VACUUM INTO` is SQLite's own safe online-backup primitive — it
   * reads through the same connection used by the rest of the app (so it
   * sees a transactionally consistent view) and writes a fresh, compacted
   * file to the target path, safely even while other requests are writing.
   */
  app.post("/admin-api/backup", adminAuth, requireAdminRole, async (req: Request, res: Response) => {
    const filename = `mcp-bridge-backup-${Date.now()}-${randomUUID().slice(0, 8)}.db`;
    const backupPath = join(backupDir(), filename);

    try {
      getDb().query("VACUUM INTO ?").run(backupPath);
    } catch (err) {
      sendError(
        res,
        500,
        "BACKUP_FAILED",
        `Failed to create backup: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const actor = actorFromRequest(req);
    recordAudit(actor, "backup.create", "database", { filename });

    let size: number;
    try {
      size = (await stat(backupPath)).size;
    } catch (err) {
      // VACUUM INTO reported success but the file is unreadable — surface as a
      // 500 rather than trying to stream a file that isn't there.
      sendError(
        res,
        500,
        "BACKUP_FAILED",
        `Backup snapshot missing after creation: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(size));

    const cleanup = () => {
      unlink(backupPath).catch((err) => {
        log("warn", "Failed to remove temporary backup file", {
          path: backupPath,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };

    const stream = createReadStream(backupPath);
    stream.on("error", (err) => {
      cleanup();
      if (!res.headersSent) {
        sendError(res, 500, "BACKUP_STREAM_FAILED", `Failed to stream backup file: ${err.message}`);
      } else {
        res.destroy(err);
      }
    });
    // Fires once the stream is fully consumed (success) or destroyed (client
    // aborted) — either way, the temp snapshot must not linger on disk.
    stream.on("close", cleanup);
    stream.pipe(res);
  });
}

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { config } from "../config.js";
import { runMigrations } from "./migrations.js";

let db: Database | null = null;

/**
 * How long a connection waits on a locked database before giving up.
 *
 * 5000ms in production — long enough to ride out a checkpoint or a slow writer
 * without surfacing an error to a caller.
 *
 * Deliberately LOWER under test, because 5000ms is also Bun's default per-test
 * timeout, and that coincidence is actively harmful: a test that contends on
 * the file cannot lose gracefully. It burns its entire budget inside SQLite and
 * is reported as "timed out after 5000ms" — a message that names no lock, no
 * file and no query, and sends the reader hunting for a slow assertion that
 * does not exist. It cost a full investigation on the Windows CI leg once
 * (`backup.test.ts`, 7734ms) and had already cost one before that
 * (`registry-reload-on-boot.test.ts`).
 *
 * At 1000ms the same contention raises SQLITE_BUSY well inside the budget, so
 * the failure names itself and points at the connection that is still holding
 * the file. Tests that legitimately wait are unaffected — a normal open/close
 * cycle here measures ~95ms end to end, so 1000ms is still an order of
 * magnitude of headroom.
 *
 * Read per-open rather than snapshotted at module load: all backend tests share
 * one process, and a value captured at import time reflects whatever happened
 * to be set when this module was first pulled in.
 */
export function busyTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return env.NODE_ENV === "test" ? 1000 : 5000;
}

function openAndPrepare(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const handle = new Database(path, { create: true });
  // PRAGMAs are per-connection, not persisted in the file — must be reissued every open.
  handle.exec("PRAGMA foreign_keys = ON;");
  handle.exec("PRAGMA journal_mode = WAL;");
  handle.exec(`PRAGMA busy_timeout = ${busyTimeoutMs()};`);
  runMigrations(handle);
  return handle;
}

/** Returns the process-wide SQLite handle, opening and migrating it on first access. */
export function getDb(): Database {
  if (!db) {
    db = openAndPrepare(config.dbPath);
  }
  return db;
}

/**
 * Test-only escape hatch — closes the current connection (if any) and opens a
 * fresh one (defaults to an in-memory DB), re-running migrations. Mirrors the
 * `_internalsForTesting` convention already used in `middleware/rate-limiter.ts`.
 */
export function __resetDbForTesting(path: string = ":memory:"): Database {
  if (db) {
    // Drop out of WAL before closing. `close()` alone does NOT remove the
    // `-wal`/`-shm` sidecars once the connection's statement cache has been
    // populated — measured on Windows at 15/15 close cycles leaving both files
    // behind, after which the containing directory cannot even be removed
    // (EBUSY). Switching to DELETE journal mode deletes them (0/15).
    //
    // That matters because tests close and REOPEN the same path, so a reopen
    // can contend with a not-fully-released predecessor — the shape of the
    // Windows-only flakes in registry-reload-on-boot.test.ts and
    // backup.test.ts. Releasing the sidecars here removes the contention;
    // `busyTimeoutMs` above caps what it costs when it happens anyway, and
    // explains why that cap is lower under test than in production.
    //
    // A no-op for `:memory:`, and harmless for a file: openAndPrepare re-issues
    // `journal_mode = WAL` on the next open.
    try {
      db.exec("PRAGMA journal_mode = DELETE;");
    } catch {
      // Best effort — a checkpoint can legitimately fail if another connection
      // holds the file; closing anyway is still better than not.
    }
    try {
      db.close();
    } catch {
      // ignore — already closed
    }
  }
  db = openAndPrepare(path);
  return db;
}

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { config } from "../config.js";
import { runMigrations } from "./migrations.js";

let db: Database | null = null;

function openAndPrepare(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const handle = new Database(path, { create: true });
  // PRAGMAs are per-connection, not persisted in the file — must be reissued every open.
  handle.exec("PRAGMA foreign_keys = ON;");
  handle.exec("PRAGMA journal_mode = WAL;");
  handle.exec("PRAGMA busy_timeout = 5000;");
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
    // That matters because tests close and REOPEN the same path, and every
    // connection sets `busy_timeout = 5000` — the same 5000ms as Bun's default
    // per-test timeout. So a reopen that contends with a not-fully-released
    // predecessor cannot lose gracefully: it burns the test's entire budget and
    // the test times out rather than failing on an assertion. That is the shape
    // of the Windows-only flake in registry-reload-on-boot.test.ts (green on
    // Linux, ~50% on the Windows CI leg, always "timed out after 5000ms").
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

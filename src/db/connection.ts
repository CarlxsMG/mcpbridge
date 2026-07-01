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
    try {
      db.close();
    } catch {
      // ignore — already closed
    }
  }
  db = openAndPrepare(path);
  return db;
}

/**
 * The downgrade direction — the mirror of `migration-upgrade-path.test.ts`.
 *
 * That file proves an existing deployment survives moving FORWARD. This one
 * covers what happens when the binary moves BACKWARD while the database does
 * not, which `runMigrations` cannot notice on its own: it computes the pending
 * set, finds it empty, and proceeds happily against a schema from the future.
 *
 * `docs/guide/deployment.md` already tells a human not to do this. The gap it
 * cannot close is the automated one — a Kubernetes rollback is the standard
 * reaction to a bad deploy and points the previous image at the same volume
 * without anyone deciding to. Before this guard existed, that produced a
 * running gateway serving policy decisions against columns and CHECKs it did
 * not model, with nothing in the logs to say so.
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrations, runMigrations, assertSchemaNotNewerThanBinary } from "../migrations.js";

const HEAD = Math.max(...migrations.map((m) => m.id));

/** A fully-migrated database, then advanced past this build by `n` phantom migrations. */
function dbFromTheFuture(n: number): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  for (let i = 1; i <= n; i++) {
    db.query("INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
      HEAD + i,
      `future_${HEAD + i}`,
      Date.now(),
    );
  }
  return db;
}

describe("schema-newer-than-binary guard", () => {
  test("a database written by a newer build is rejected under STRICT_CONFIG=production", () => {
    const db = dbFromTheFuture(3);
    expect(() => assertSchemaNotNewerThanBinary(db, { STRICT_CONFIG: "production" })).toThrow(
      new RegExp(`migration ${HEAD + 3}.*only knows ${HEAD}`),
    );
    db.close();
  });

  test("the error names both versions, so the operator knows which build to roll forward to", () => {
    const db = dbFromTheFuture(1);
    let message = "";
    try {
      assertSchemaNotNewerThanBinary(db, { STRICT_CONFIG: "production" });
    } catch (e) {
      message = (e as Error).message;
    }
    // Not just "schema mismatch" — a bare complaint leaves the operator guessing
    // which of the two sides moved, and the correct action differs (roll forward
    // vs restore the pre-upgrade file).
    expect(message).toContain(String(HEAD + 1));
    expect(message).toContain(String(HEAD));
    expect(message).toContain("Roll forward");
    db.close();
  });

  test("without STRICT_CONFIG it warns instead of throwing — dev and test stay ergonomic", () => {
    const db = dbFromTheFuture(2);
    expect(() => assertSchemaNotNewerThanBinary(db, {})).not.toThrow();
    db.close();
  });

  test("a database at exactly this build's head is fine — the check is strictly-greater-than", () => {
    // The off-by-one that would make every correct deployment fail to boot.
    const db = new Database(":memory:");
    runMigrations(db);
    expect(() => assertSchemaNotNewerThanBinary(db, { STRICT_CONFIG: "production" })).not.toThrow();
    db.close();
  });

  test("a fresh, empty database is fine — MAX(id) over no rows is NULL, not 0", () => {
    const db = new Database(":memory:");
    db.exec(
      `CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL) STRICT;`,
    );
    expect(() => assertSchemaNotNewerThanBinary(db, { STRICT_CONFIG: "production" })).not.toThrow();
    db.close();
  });

  test("an older database is fine — this is a downgrade guard, not a drift guard", () => {
    // The ordinary upgrade case: the binary is ahead, migrations are pending.
    // Failing here would block every legitimate deployment.
    const db = new Database(":memory:");
    db.exec(
      `CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL) STRICT;`,
    );
    db.query("INSERT INTO _migrations (id, name, applied_at) VALUES (1, 'clients_tools_guards', 0)").run();
    expect(() => assertSchemaNotNewerThanBinary(db, { STRICT_CONFIG: "production" })).not.toThrow();
    db.close();
  });

  test("runMigrations itself enforces it, not just the exported helper", () => {
    // The helper being correct is worth nothing if the boot path never calls it.
    const db = dbFromTheFuture(1);
    const previous = process.env.STRICT_CONFIG;
    try {
      process.env.STRICT_CONFIG = "production";
      expect(() => runMigrations(db)).toThrow(/newer/i);
    } finally {
      if (previous === undefined) delete process.env.STRICT_CONFIG;
      else process.env.STRICT_CONFIG = previous;
    }
    db.close();
  });

  test("a gap below the head does not trip it — only the MAXIMUM matters", () => {
    // A deployment that somehow lacks a middle migration is a different problem
    // (and one runMigrations fixes by applying it). Conflating the two would
    // make this guard fire on a case it has no advice for.
    const db = new Database(":memory:");
    runMigrations(db);
    db.query("DELETE FROM _migrations WHERE id = ?").run(HEAD - 1);
    expect(() => assertSchemaNotNewerThanBinary(db, { STRICT_CONFIG: "production" })).not.toThrow();
    db.close();
  });
});

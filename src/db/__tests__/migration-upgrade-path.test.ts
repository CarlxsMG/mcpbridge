/**
 * The upgrade path — the one class of bug the rest of the suite structurally
 * cannot see.
 *
 * Every other test opens a fresh `:memory:` database, so all 57 migrations are
 * only ever applied to an EMPTY schema. That exercises "does the SQL parse",
 * never "does an existing deployment survive it". The difference matters for
 * the migrations that rebuild a table — SQLite cannot alter a CHECK constraint
 * in place, so widening one means create-new / copy / drop / rename, and a
 * wrong column list in the copy silently drops production data with no error
 * and no failing test.
 *
 * Two such migrations exist today (15 `expand_admin_roles`, 57
 * `catalog_entries_graphql`) and REBUILD_MIGRATIONS below asserts that set is
 * still complete, so a third one added later fails here until it is covered.
 *
 * The shape of every case is the same: build the schema as it was *before* the
 * migration, seed the table it rewrites, apply the rest, then compare row for
 * row and column for column.
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrations, runMigrations } from "../migrations.js";

/** Highest migration id that ships today — the version an upgrade lands on. */
const HEAD = Math.max(...migrations.map((m) => m.id));

/**
 * A database with every migration up to and including `id` applied, and
 * `_migrations` populated to match — so `runMigrations` afterwards behaves
 * exactly as it would against a real deployment sitting at that version.
 */
function schemaAt(id: number): Database {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL) STRICT;`,
  );
  for (const m of migrations.filter((x) => x.id <= id).sort((a, b) => a.id - b.id)) {
    db.transaction(() => {
      db.exec(m.sql);
      db.query(`INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)`).run(m.id, m.name, 0);
    })();
  }
  return db;
}

function rows(db: Database, table: string): Record<string, unknown>[] {
  return db.query(`SELECT * FROM ${table} ORDER BY id`).all() as Record<string, unknown>[];
}

/**
 * Asserts no pre-existing value was lost or altered.
 *
 * Deliberately compares only the columns that existed BEFORE the upgrade,
 * rather than the whole row: migrations after the rebuild legitimately add
 * columns (admin_users gains `team_id` at migration 53), and a whole-row
 * equality check would fail on that without anything being wrong. What must
 * never change is a value that was already there.
 */
function expectDataPreserved(before: Record<string, unknown>[], after: Record<string, unknown>[], table: string): void {
  expect(after, `${table}: row count changed`).toHaveLength(before.length);
  for (const [i, row] of after.entries()) {
    for (const [key, value] of Object.entries(before[i]!)) {
      expect(row[key], `${table}.${key} changed for row ${i}`).toEqual(value);
    }
  }
}

/**
 * Every migration whose SQL replaces a table rather than adding to it. Kept as
 * data so the "no uncovered rebuild" test can compare it against the real SQL
 * and fail when a new one appears.
 */
const REBUILD_MIGRATIONS = [
  { id: 15, table: "admin_users" },
  { id: 57, table: "catalog_entries" },
] as const;

const NOW = 1_700_000_000_000;

describe("migration upgrade path — rebuilt tables keep their data", () => {
  test("the rebuild list is complete — a new table-replacing migration must be covered here", () => {
    // DROP TABLE / RENAME TO is the signature of the create-copy-drop-rename
    // dance; a migration using it and absent from REBUILD_MIGRATIONS is an
    // uncovered data-loss risk.
    const rebuilding = migrations
      .filter((m) => /DROP TABLE|RENAME TO/i.test(m.sql))
      .map((m) => m.id)
      .sort((a, b) => a - b);
    expect(rebuilding).toEqual(REBUILD_MIGRATIONS.map((r) => r.id).sort((a, b) => a - b));
  });

  test("15 expand_admin_roles preserves every admin user", () => {
    const db = schemaAt(14);
    db.query(
      `INSERT INTO admin_users (username, password_hash, role, is_active, created_at, updated_at, last_login_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("root", "hash-root", "admin", 1, NOW, NOW, NOW, null);
    db.query(
      `INSERT INTO admin_users (username, password_hash, role, is_active, created_at, updated_at, last_login_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("deactivated", "hash-2", "admin", 0, NOW, NOW, null, "root");
    const before = rows(db, "admin_users");
    expect(before).toHaveLength(2);

    runMigrations(db);

    expectDataPreserved(before, rows(db, "admin_users"), "admin_users");
  });

  test("57 catalog_entries_graphql preserves every catalog entry, ids included", () => {
    const db = schemaAt(56);
    const insert = db.query(
      `INSERT INTO catalog_entries
         (slug, name, description, kind, category, tags_json, icon, openapi_url, health_url, base_url,
          include_tags_json, exclude_operations_json, mcp_url, mcp_transport, featured, created_at, updated_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    insert.run(
      "legacy-rest",
      "Legacy REST",
      "a REST entry",
      "rest",
      "crm",
      '["a","b"]',
      "icon",
      "https://x/openapi.json",
      "https://x/health",
      "https://x",
      '["tag"]',
      '["opId"]',
      null,
      null,
      1,
      NOW,
      NOW,
      "alice",
    );
    insert.run(
      "deleted-later",
      "Deleted later",
      null,
      "rest",
      null,
      "[]",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      0,
      NOW,
      NOW,
      null,
    );
    insert.run(
      "legacy-mcp",
      "Legacy MCP",
      null,
      "mcp",
      null,
      "[]",
      null,
      null,
      null,
      null,
      null,
      null,
      "https://y/mcp",
      "sse",
      0,
      NOW,
      NOW,
      "bob",
    );
    // A GAP in the ids, which any deployment that has ever deleted an entry
    // has. Without it this case cannot discriminate: rows seeded as 1,2 come
    // back as 1,2 even from a copy that drops the id column and lets
    // AUTOINCREMENT re-assign — verified by deleting `id` from the migration's
    // INSERT and watching an earlier version of this test still pass.
    db.query(`DELETE FROM catalog_entries WHERE slug = 'deleted-later'`).run();

    const before = rows(db, "catalog_entries");
    expect(before.map((r) => r.id)).toEqual([1, 3]);

    runMigrations(db);

    const after = rows(db, "catalog_entries");
    // Ids included — a rebuild that renumbered them would silently repoint the
    // `custom:<id>` references the admin UI holds at a different entry.
    expectDataPreserved(before, after, "catalog_entries");
    expect(after.map((r) => r.id)).toEqual([1, 3]);
    // The column the migration adds defaults to NULL for rows that predate it.
    expect(after.every((r) => r.graphql_url === null)).toBe(true);
  });

  test("57 leaves AUTOINCREMENT continuing past the copied rows, not restarting", () => {
    // A rebuild that recreates the table without carrying sqlite_sequence
    // forward would hand the next INSERT an id that already belongs to a
    // deleted row — and `custom:<id>` catalog references would silently point
    // at the wrong entry.
    const db = schemaAt(56);
    db.query(
      `INSERT INTO catalog_entries (slug, name, kind, tags_json, featured, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run("only-one", "Only one", "rest", "[]", 0, NOW, NOW);

    runMigrations(db);

    db.query(
      `INSERT INTO catalog_entries (slug, name, kind, tags_json, featured, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run("added-after", "Added after", "graphql", "[]", 0, NOW, NOW);
    const added = db.query(`SELECT id FROM catalog_entries WHERE slug = 'added-after'`).get() as { id: number };
    expect(added.id).toBe(2);
  });

  test("57 admits the widened kind that motivated it, and still rejects an unknown one", () => {
    const db = schemaAt(56);
    runMigrations(db);
    const insert = db.query(
      `INSERT INTO catalog_entries (slug, name, kind, tags_json, featured, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
    );
    expect(() => insert.run("g", "G", "graphql", "[]", 0, NOW, NOW)).not.toThrow();
    expect(() => insert.run("s", "S", "soap", "[]", 0, NOW, NOW)).toThrow();
  });
});

describe("migration upgrade path — a populated database upgrades to HEAD", () => {
  /**
   * The end-to-end shape: a deployment that predates every table-rebuilding
   * migration, carrying data in the tables those migrations touch, upgraded all
   * the way to the current head in one boot — which is exactly what
   * `runMigrations` does on startup after a version jump.
   */
  test("from the oldest rebuild point to HEAD, in one pass, with data present", () => {
    const oldest = Math.min(...REBUILD_MIGRATIONS.map((r) => r.id));
    const db = schemaAt(oldest - 1);

    db.query(
      `INSERT INTO admin_users (username, password_hash, role, is_active, created_at, updated_at, last_login_at, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run("survivor", "hash", "admin", 1, NOW, NOW, null, null);

    expect(() => runMigrations(db)).not.toThrow();

    expect(db.query(`SELECT username, role FROM admin_users`).get()).toEqual({ username: "survivor", role: "admin" });
    const applied = db.query(`SELECT COUNT(*) AS n FROM _migrations`).get() as { n: number };
    expect(applied.n).toBe(migrations.length);
  });

  test("re-running migrations against an up-to-date database is a no-op", () => {
    // Every boot calls runMigrations; the second one must do nothing rather
    // than re-run a rebuild against live data.
    const db = schemaAt(HEAD);
    db.query(
      `INSERT INTO catalog_entries (slug, name, kind, tags_json, featured, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
    ).run("kept", "Kept", "rest", "[]", 0, NOW, NOW);

    runMigrations(db);
    runMigrations(db);

    expect(rows(db, "catalog_entries")).toHaveLength(1);
    const applied = db.query(`SELECT COUNT(*) AS n FROM _migrations`).get() as { n: number };
    expect(applied.n).toBe(migrations.length);
  });

  test("migration ids are unique, contiguous from 1, and declared in order", () => {
    // The append-only contract: a renumbered or duplicated id makes an already
    // -applied migration re-run (or a new one silently skip) on every existing
    // deployment, since `_migrations` is keyed on the id alone.
    const ids = migrations.map((m) => m.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => i + 1));
    expect(new Set(migrations.map((m) => m.name)).size).toBe(migrations.length);
  });
});

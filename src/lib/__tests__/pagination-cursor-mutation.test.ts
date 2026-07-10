/**
 * Stryker mutation-testing backstop for src/lib/pagination-cursor.ts — no
 * dedicated test file existed before this one. Both exports are covered:
 *
 * - `clampLimit` is pure arithmetic (`Math.min(Math.max(value ?? defaultValue, 1), max)`)
 *   — tested directly with no I/O.
 * - `keysetPaginate` runs a real query against a real `bun:sqlite` `Database`
 *   (via `__resetDbForTesting()` + `getDb()`, the in-memory-DB pattern used
 *   throughout this repo's test suite) against an ad hoc scratch table, so
 *   the "fetch limit+1 / slice / derive nextCursor" mechanics are exercised
 *   with genuine SQL rather than mocks.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { clampLimit, keysetPaginate } from "../pagination-cursor.js";
import { getDb, __resetDbForTesting } from "../../db/connection.js";

// ---------------------------------------------------------------------------
// clampLimit
// ---------------------------------------------------------------------------

describe("clampLimit", () => {
  test("a value within [1, max] passes through unchanged", () => {
    expect(clampLimit(50, 10, 100)).toBe(50);
  });

  test("undefined value falls back to defaultValue", () => {
    expect(clampLimit(undefined, 25, 100)).toBe(25);
  });

  test("value=0 is NOT treated as absent (?? not || ) but IS floored to 1", () => {
    // 0 ?? defaultValue === 0 (nullish coalescing only triggers on null/undefined),
    // so this also proves the code uses `??`, not `||` (which would have picked
    // defaultValue here since 0 is falsy). The floor then clamps 0 up to 1.
    expect(clampLimit(0, 42, 100)).toBe(1);
  });

  test("a negative value is floored to 1", () => {
    expect(clampLimit(-5, 10, 100)).toBe(1);
  });

  test("a value above max is capped to max", () => {
    expect(clampLimit(500, 10, 100)).toBe(100);
  });

  test("a value exactly equal to max is kept at max (boundary, not clamped down further)", () => {
    expect(clampLimit(100, 10, 100)).toBe(100);
  });

  test("a value exactly equal to 1 is kept at 1 (boundary, not floored away)", () => {
    expect(clampLimit(1, 10, 100)).toBe(1);
  });

  test("defaultValue itself is subject to the same floor when value is absent", () => {
    expect(clampLimit(undefined, 0, 100)).toBe(1);
    expect(clampLimit(undefined, -10, 100)).toBe(1);
  });

  test("defaultValue itself is subject to the same cap when value is absent", () => {
    expect(clampLimit(undefined, 9999, 100)).toBe(100);
  });

  test("changing `max` alone changes the result — proves max is actually consulted", () => {
    expect(clampLimit(500, 10, 100)).toBe(100);
    expect(clampLimit(500, 10, 200)).toBe(200);
  });

  test("changing `defaultValue` alone changes the result when value is absent — proves defaultValue is actually consulted", () => {
    expect(clampLimit(undefined, 10, 1000)).toBe(10);
    expect(clampLimit(undefined, 20, 1000)).toBe(20);
  });

  test("null is treated the same as undefined (?? covers both nullish values)", () => {
    expect(clampLimit(null as unknown as undefined, 33, 100)).toBe(33);
  });
});

// ---------------------------------------------------------------------------
// keysetPaginate
// ---------------------------------------------------------------------------

interface TestRow {
  id: number;
  label: string;
  group_name: string;
}

interface TestItem {
  itemId: number;
  itemLabel: string;
}

function mapRow(row: TestRow): TestItem {
  // Deliberately renames fields (itemId/itemLabel, uppercased label) so a
  // mutant that returns raw rows instead of `page.map(mapRow)` is caught by
  // shape/content mismatch, not just a coincidentally-equal value.
  return { itemId: row.id, itemLabel: row.label.toUpperCase() };
}

function cursorOf(row: TestRow): number {
  return row.id;
}

function seedTable(count: number, groupName = "a"): void {
  const db = getDb();
  db.exec(`CREATE TABLE test_rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL, group_name TEXT NOT NULL)`);
  const insert = db.query(`INSERT INTO test_rows (label, group_name) VALUES (?, ?)`);
  for (let i = 1; i <= count; i++) {
    insert.run(`row-${i}`, groupName);
  }
}

beforeEach(() => {
  __resetDbForTesting();
});

describe("keysetPaginate — basic shape and mapping", () => {
  test("returns items mapped through mapRow, in the query's own order (DESC by id)", () => {
    seedTable(5);
    const page = keysetPaginate<TestRow, TestItem>(
      getDb(),
      `SELECT * FROM test_rows ORDER BY id DESC`,
      [],
      2,
      mapRow,
      cursorOf,
    );
    expect(page.items).toEqual([
      { itemId: 5, itemLabel: "ROW-5" },
      { itemId: 4, itemLabel: "ROW-4" },
    ]);
  });

  test("nextCursor is a genuine string even though cursorOf returns a number", () => {
    seedTable(5);
    const page = keysetPaginate<TestRow, TestItem>(
      getDb(),
      `SELECT * FROM test_rows ORDER BY id DESC`,
      [],
      2,
      mapRow,
      cursorOf,
    );
    expect(page.nextCursor).toBe("4");
    expect(typeof page.nextCursor).toBe("string");
  });
});

describe("keysetPaginate — hasMore boundary (rows.length > limit)", () => {
  test("total rows === limit exactly: no more pages, nextCursor is undefined, all rows returned", () => {
    seedTable(3);
    const page = keysetPaginate<TestRow, TestItem>(
      getDb(),
      `SELECT * FROM test_rows ORDER BY id DESC`,
      [],
      3,
      mapRow,
      cursorOf,
    );
    expect(page.items).toHaveLength(3);
    expect(page.items.map((i) => i.itemId)).toEqual([3, 2, 1]);
    expect(page.nextCursor).toBeUndefined();
  });

  test("total rows === limit + 1 exactly: one more page, nextCursor defined, extra row sliced off", () => {
    seedTable(4);
    const page = keysetPaginate<TestRow, TestItem>(
      getDb(),
      `SELECT * FROM test_rows ORDER BY id DESC`,
      [],
      3,
      mapRow,
      cursorOf,
    );
    // The 4th (oldest / lowest-id) row must NOT appear in items...
    expect(page.items).toHaveLength(3);
    expect(page.items.map((i) => i.itemId)).toEqual([4, 3, 2]);
    // ...but its absence is exactly what produces nextCursor, keyed off the
    // LAST *returned* row (id 2), not the sliced-off extra row (id 1).
    expect(page.nextCursor).toBe("2");
  });

  test("total rows < limit: fewer rows than the page size, no more pages", () => {
    seedTable(2);
    const page = keysetPaginate<TestRow, TestItem>(
      getDb(),
      `SELECT * FROM test_rows ORDER BY id DESC`,
      [],
      5,
      mapRow,
      cursorOf,
    );
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeUndefined();
  });

  test("well beyond the limit+1 boundary (many extra rows) still slices down to exactly `limit` items", () => {
    seedTable(10);
    const page = keysetPaginate<TestRow, TestItem>(
      getDb(),
      `SELECT * FROM test_rows ORDER BY id DESC`,
      [],
      3,
      mapRow,
      cursorOf,
    );
    expect(page.items).toHaveLength(3);
    expect(page.items.map((i) => i.itemId)).toEqual([10, 9, 8]);
    expect(page.nextCursor).toBe("8");
  });
});

describe("keysetPaginate — params are genuinely bound into the query (>= 2 distinct groups)", () => {
  test("filtering by a bound param only returns matching rows, not the full table", () => {
    const db = getDb();
    db.exec(`CREATE TABLE test_rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL, group_name TEXT NOT NULL)`);
    const insert = db.query(`INSERT INTO test_rows (label, group_name) VALUES (?, ?)`);
    insert.run("row-a1", "alpha");
    insert.run("row-a2", "alpha");
    insert.run("row-b1", "beta");
    insert.run("row-b2", "beta");
    insert.run("row-b3", "beta");

    const alphaPage = keysetPaginate<TestRow, TestItem>(
      getDb(),
      `SELECT * FROM test_rows WHERE group_name = ? ORDER BY id DESC`,
      ["alpha"],
      10,
      mapRow,
      cursorOf,
    );
    expect(alphaPage.items).toHaveLength(2);
    expect(alphaPage.items.every((i) => i.itemLabel.startsWith("ROW-A"))).toBe(true);

    const betaPage = keysetPaginate<TestRow, TestItem>(
      getDb(),
      `SELECT * FROM test_rows WHERE group_name = ? ORDER BY id DESC`,
      ["beta"],
      10,
      mapRow,
      cursorOf,
    );
    expect(betaPage.items).toHaveLength(3);
    expect(betaPage.items.every((i) => i.itemLabel.startsWith("ROW-B"))).toBe(true);
  });

  test("a keyset cursor param (`WHERE id < ?`) correctly walks to the next page", () => {
    seedTable(6);
    const firstPage = keysetPaginate<TestRow, TestItem>(
      getDb(),
      `SELECT * FROM test_rows ORDER BY id DESC`,
      [],
      2,
      mapRow,
      cursorOf,
    );
    expect(firstPage.items.map((i) => i.itemId)).toEqual([6, 5]);
    expect(firstPage.nextCursor).toBe("5");

    const secondPage = keysetPaginate<TestRow, TestItem>(
      getDb(),
      `SELECT * FROM test_rows WHERE id < ? ORDER BY id DESC`,
      [Number(firstPage.nextCursor)],
      2,
      mapRow,
      cursorOf,
    );
    expect(secondPage.items.map((i) => i.itemId)).toEqual([4, 3]);
    expect(secondPage.nextCursor).toBe("3");

    const thirdPage = keysetPaginate<TestRow, TestItem>(
      getDb(),
      `SELECT * FROM test_rows WHERE id < ? ORDER BY id DESC`,
      [Number(secondPage.nextCursor)],
      2,
      mapRow,
      cursorOf,
    );
    expect(thirdPage.items.map((i) => i.itemId)).toEqual([2, 1]);
    expect(thirdPage.nextCursor).toBeUndefined();
  });
});

describe("keysetPaginate — empty result set", () => {
  test("no rows at all returns an empty items array and no nextCursor", () => {
    seedTable(0);
    const page = keysetPaginate<TestRow, TestItem>(
      getDb(),
      `SELECT * FROM test_rows ORDER BY id DESC`,
      [],
      10,
      mapRow,
      cursorOf,
    );
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });
});

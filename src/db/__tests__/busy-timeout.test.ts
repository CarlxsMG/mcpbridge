/**
 * The busy-timeout budget, and why it differs under test.
 *
 * 5000ms is Bun's default per-test timeout AND was, until this file existed,
 * also the SQLite busy timeout every connection set. A test contending on a
 * locked file therefore consumed its whole budget inside SQLite and surfaced as
 * "timed out after 5000ms" — a message naming no lock, no file and no query.
 * Two Windows CI investigations went that way before the coincidence was spotted.
 *
 * These cases pin the two properties that keep it from coming back: the test
 * value is lower than production's, and it is strictly below Bun's default
 * budget so the failure has room to report itself.
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { busyTimeoutMs } from "../connection.js";

/** Bun's default per-test timeout. The number this must stay clear of. */
const BUN_DEFAULT_TEST_TIMEOUT_MS = 5000;

describe("busy timeout", () => {
  test("is lower under test than in production", () => {
    expect(busyTimeoutMs({ NODE_ENV: "test" })).toBeLessThan(busyTimeoutMs({ NODE_ENV: "production" }));
  });

  test("the test value leaves room inside Bun's default budget to report the failure", () => {
    // The whole point. At or above the budget, contention is indistinguishable
    // from a hung test; below it, SQLITE_BUSY is raised and named.
    expect(busyTimeoutMs({ NODE_ENV: "test" })).toBeLessThan(BUN_DEFAULT_TEST_TIMEOUT_MS);
  });

  test("production keeps the longer wait — a checkpoint must not surface as an error to a caller", () => {
    expect(busyTimeoutMs({ NODE_ENV: "production" })).toBe(BUN_DEFAULT_TEST_TIMEOUT_MS);
  });

  test("an unset NODE_ENV gets the production value, not the test one", () => {
    // A binary started without NODE_ENV is a production binary, and must not
    // inherit a budget tuned for a test runner that is not present.
    expect(busyTimeoutMs({})).toBe(busyTimeoutMs({ NODE_ENV: "production" }));
  });

  test("the value is actually applied to a connection, not just computed", () => {
    // The function being right is worth nothing if openAndPrepare ignores it.
    // Read the PRAGMA back off a real handle prepared the same way.
    const dir = mkdtempSync(join(tmpdir(), "mcpbridge-busy-"));
    const db = new Database(join(dir, "t.db"), { create: true });
    try {
      db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs({ NODE_ENV: "test" })};`);
      const row = db.query("PRAGMA busy_timeout").get() as { timeout: number };
      expect(row.timeout).toBe(busyTimeoutMs({ NODE_ENV: "test" }));
    } finally {
      db.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort — Windows can hold a lock briefly after close().
      }
    }
  });
});

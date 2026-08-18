/**
 * `openAndPrepare` must set `PRAGMA synchronous = NORMAL`.
 *
 * This is the durability trade documented at the PRAGMA in src/db/connection.ts:
 * under WAL it cannot corrupt the file, but it can lose the last committed
 * transaction(s) on OS crash or power loss — for EVERY table on this connection,
 * audit chain included. It is therefore a decision, and a decision deserves a
 * gate: a future "tidy up the PRAGMAs" edit that drops this line silently gives
 * back a 10x fsync cost on the per-tool-call write path, and a future edit that
 * pushes it to OFF silently gives up the WAL corruption guarantee.
 *
 * PRAGMA values are per-connection and not persisted in the file, so this is
 * asserted after an explicit reopen rather than against whatever handle an
 * earlier test in this shared process happened to leave behind.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { __resetDbForTesting, getDb } from "../connection.js";

/** 0 = OFF, 1 = NORMAL, 2 = FULL, 3 = EXTRA (SQLite's own encoding). */
const SQLITE_SYNCHRONOUS_NORMAL = 1;

afterEach(() => {
  __resetDbForTesting();
});

function readSynchronous(): number {
  return (getDb().query(`PRAGMA synchronous`).get() as { synchronous: number }).synchronous;
}

describe("PRAGMA synchronous", () => {
  test("an in-memory connection reports NORMAL after openAndPrepare", () => {
    __resetDbForTesting();
    expect(readSynchronous()).toBe(SQLITE_SYNCHRONOUS_NORMAL);
  });

  test("a file-backed connection reports NORMAL too, alongside WAL", () => {
    // The file case is the one that actually fsyncs, and WAL is what makes NORMAL
    // safe against corruption — assert both together so neither can be dropped
    // without the other being noticed.
    const path = `${process.env.TMPDIR ?? process.env.TEMP ?? "."}/mcp-bridge-sync-pragma-${process.pid}-${Date.now()}/db.sqlite`;
    __resetDbForTesting(path);
    expect(readSynchronous()).toBe(SQLITE_SYNCHRONOUS_NORMAL);
    const journal = (getDb().query(`PRAGMA journal_mode`).get() as { journal_mode: string }).journal_mode;
    expect(journal.toLowerCase()).toBe("wal");
  });
});

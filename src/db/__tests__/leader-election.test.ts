import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, rmSync, mkdirSync } from "fs";
import { config } from "../../config.js";
import { __resetDbForTesting } from "../../db/connection.js";
import { tryAcquireOrRenewLease, refreshLeaderStatus, isLeader } from "../../db/leader-lease.js";

const realNow = Date.now.bind(Date);
const dbDir =
  "C:\\Users\\carlo\\AppData\\Local\\Temp\\claude\\C--Users-carlo-Desktop-test-1\\389c3acb-7605-40d2-86eb-81b21edd9c9a\\scratchpad";
const dbPath = `${dbDir}\\leader-election-test.db`;

const originalInstanceId = config.instanceId;

/** Mirrors tryAcquireOrRenewLease's SQL, but against an independently-opened
 * Database handle — simulates a second process sharing the same file. */
function tryAcquireAsOtherInstance(db: Database, holderId: string, now: number, leaseDurationMs: number): boolean {
  const result = db
    .query(
      `INSERT INTO _leader_lease (id, holder_id, lease_expires_at) VALUES (1, ?1, ?2)
       ON CONFLICT(id) DO UPDATE SET holder_id = ?1, lease_expires_at = ?2
       WHERE _leader_lease.holder_id = ?1 OR _leader_lease.lease_expires_at < ?3`,
    )
    .run(holderId, now + leaseDurationMs, now);
  return result.changes === 1;
}

function cleanupFile() {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const p = `${dbPath}${suffix}`;
    if (existsSync(p)) rmSync(p);
  }
}

afterEach(() => {
  Date.now = realNow;
  (config as Record<string, unknown>).instanceId = originalInstanceId;
  __resetDbForTesting();
  cleanupFile();
});

describe("tryAcquireOrRenewLease — single instance (trivial case)", () => {
  test("a fresh instance always acquires the lease immediately", () => {
    __resetDbForTesting();
    expect(tryAcquireOrRenewLease()).toBe(true);
  });

  test("the same instance can renew its own lease repeatedly", () => {
    __resetDbForTesting();
    expect(tryAcquireOrRenewLease()).toBe(true);
    expect(tryAcquireOrRenewLease()).toBe(true);
    expect(tryAcquireOrRenewLease()).toBe(true);
  });
});

describe("refreshLeaderStatus / isLeader", () => {
  test("isLeader() reflects the outcome of the last refreshLeaderStatus() call", () => {
    __resetDbForTesting();
    expect(refreshLeaderStatus()).toBe(true);
    expect(isLeader()).toBe(true);
  });
});

describe("tryAcquireOrRenewLease — two instances contending for a real shared file", () => {
  test("a second instance cannot acquire the lease while the first instance's lease is still valid", () => {
    mkdirSync(dbDir, { recursive: true });
    cleanupFile();

    __resetDbForTesting(dbPath);
    (config as Record<string, unknown>).instanceId = "instance-A";
    expect(tryAcquireOrRenewLease()).toBe(true);

    // Simulate a second process opening the SAME file independently.
    const otherDb = new Database(dbPath);
    try {
      const now = realNow();
      const acquired = tryAcquireAsOtherInstance(otherDb, "instance-B", now, config.leaderLeaseDurationMs);
      expect(acquired).toBe(false);
    } finally {
      otherDb.close();
    }
  });

  test("a second instance takes over once the first instance's lease has expired", () => {
    mkdirSync(dbDir, { recursive: true });
    cleanupFile();

    __resetDbForTesting(dbPath);
    (config as Record<string, unknown>).instanceId = "instance-A";
    expect(tryAcquireOrRenewLease()).toBe(true);

    const otherDb = new Database(dbPath);
    try {
      // Time passes well beyond the lease duration — instance A never renewed.
      const future = realNow() + config.leaderLeaseDurationMs + 5000;
      const acquired = tryAcquireAsOtherInstance(otherDb, "instance-B", future, config.leaderLeaseDurationMs);
      expect(acquired).toBe(true);

      // And instance A, if it tried to renew now, would correctly lose leadership
      // (its own tryAcquireOrRenewLease() reads via the *main* getDb() singleton,
      // still pointed at the same file, so it observes instance-B's fresh lease).
      Date.now = () => future;
      expect(tryAcquireOrRenewLease()).toBe(false);
    } finally {
      otherDb.close();
    }
  });
});

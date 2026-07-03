import { getDb } from "./connection.js";
import { config } from "../config.js";
import { log } from "../logger.js";

let currentlyLeader = false;

/**
 * Attempts to acquire or renew the single-row leadership lease. Succeeds
 * (returns true) when this instance already holds it, or when the current
 * holder's lease has expired. A single-instance deployment always wins
 * trivially — this is safe, zero-behavior-change scaffolding until there's
 * ever a second instance sharing the same SQLite file.
 */
export function tryAcquireOrRenewLease(): boolean {
  const db = getDb();
  const now = Date.now();
  const expiresAt = now + config.leaderLeaseDurationMs;

  const result = db
    .query(
      `INSERT INTO _leader_lease (id, holder_id, lease_expires_at) VALUES (1, ?1, ?2)
       ON CONFLICT(id) DO UPDATE SET holder_id = ?1, lease_expires_at = ?2
       WHERE _leader_lease.holder_id = ?1 OR _leader_lease.lease_expires_at < ?3`,
    )
    .run(config.instanceId, expiresAt, now);

  return result.changes === 1;
}

/** Cheap in-memory flag, updated by `refreshLeaderStatus`/the periodic renewal loop — safe to call frequently. */
export function isLeader(): boolean {
  return currentlyLeader;
}

/**
 * One-shot acquire-or-renew that also updates the cached `isLeader()` flag.
 * `startLeaderElection` calls this on a timer; a single-instance deployment
 * (or a test) can call it directly to become leader without needing to
 * manage an interval/stop function.
 */
export function refreshLeaderStatus(): boolean {
  try {
    currentlyLeader = tryAcquireOrRenewLease();
  } catch (err) {
    log("error", "Leader election renewal failed", { error: err instanceof Error ? err.message : String(err) });
    currentlyLeader = false;
  }
  return currentlyLeader;
}

/**
 * Starts the periodic lease acquire/renew loop. Only the current leader
 * should run cross-instance-duplicated work (currently: the health-check
 * loop's actual backend probing — see health.ts). Returns a stop function.
 */
export function startLeaderElection(): () => void {
  refreshLeaderStatus();
  const intervalMs = Math.max(1000, Math.floor(config.leaderLeaseDurationMs / 3));
  const timer = setInterval(refreshLeaderStatus, intervalMs);

  return () => clearInterval(timer);
}

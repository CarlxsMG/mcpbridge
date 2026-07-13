import { getDb } from "./connection.js";

/**
 * SQLite-backed fixed-window rate counters for horizontal scaling: unlike the
 * per-instance in-memory limiter, these counts are shared across every instance
 * pointed at the same database, so a per-tool limit is enforced globally rather
 * than per-replica. Opt-in via config.rateLimitShared — a single-instance
 * deployment keeps the faster in-memory path.
 *
 * The increment + read is a single atomic UPSERT ... RETURNING, so concurrent
 * callers (even across processes, serialized by SQLite's write lock) can't
 * lose an increment.
 */

let opCount = 0;

export interface SharedRateResult {
  allowed: boolean;
  retryAfterSeconds: number;
  count: number;
}

/**
 * Atomically increments the counter for `key` in the current fixed window and
 * decides whether the call is within `limit`. `now` is injectable for tests.
 */
export function checkSharedRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): SharedRateResult {
  const db = getDb();
  const windowStart = Math.floor(now / windowMs) * windowMs;

  const row = db
    .query(
      `INSERT INTO rate_counters (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .get(key, windowStart) as { count: number };

  // Opportunistically prune windows older than the one before the current, to
  // keep the table from growing without bound.
  if (++opCount % 200 === 0) {
    db.query(`DELETE FROM rate_counters WHERE window_start < ?`).run(windowStart - windowMs);
  }

  const allowed = row.count <= limit;
  const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
  return { allowed, retryAfterSeconds, count: row.count };
}

/** Shared-counter equivalent of the per-tool rate-limit guard (per-minute window). */
export function checkSharedToolRateLimit(
  toolKey: string,
  perMinute: number,
  now?: number,
): { allowed: boolean; retryAfterSeconds: number } {
  const r = checkSharedRateLimit(`tool:${toolKey}`, perMinute, 60_000, now);
  return { allowed: r.allowed, retryAfterSeconds: r.retryAfterSeconds };
}

/**
 * Shared-counter equivalent for a caller-asserted end-user identity, namespaced
 * per consumer so the same raw id under two different consumers never shares a
 * bucket. Only ever called when a consumer has opted in (endUserRateLimitPerMin
 * set) and a call actually asserts an identity — see resolveEndUserId in
 * proxy/gates.ts.
 */
export function checkSharedEndUserRateLimit(
  consumerId: number,
  endUserId: string,
  perMinute: number,
  now?: number,
): { allowed: boolean; retryAfterSeconds: number } {
  const r = checkSharedRateLimit(`enduser:${consumerId}:${endUserId}`, perMinute, 60_000, now);
  return { allowed: r.allowed, retryAfterSeconds: r.retryAfterSeconds };
}

/** Test-only: wipe all shared counters. */
export function __clearRateCountersForTesting(): void {
  try {
    getDb().query(`DELETE FROM rate_counters`).run();
  } catch {
    // ignore
  }
}

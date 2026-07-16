import { getDb } from "../../db/connection.js";
import { checkSharedEndUserRateLimit } from "../../db/rate-counters.js";

/** Shared validity check for monthlyQuota/endUserRateLimitPerMin — both must be a positive integer or null (unlimited/disabled). Used by both the admin-api route and config-io's import path so a hand-edited gateway.yaml can't sneak in a value (e.g. 0 or -1) that the normal API would reject. */
export function isValidQuotaValue(v: unknown): v is number | null {
  return v === null || v === undefined || (typeof v === "number" && Number.isInteger(v) && v > 0);
}

export interface Consumer {
  id: number;
  name: string;
  monthlyQuota: number | null;
  endUserRateLimitPerMin: number | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
  /** Owning team id, or null for an unowned (super-admin-only) consumer. */
  teamId: number | null;
}

interface ConsumerRow {
  id: number;
  name: string;
  monthly_quota: number | null;
  end_user_rate_limit_per_min: number | null;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  team_id: number | null;
}

const COLS = "id, name, monthly_quota, end_user_rate_limit_per_min, created_at, updated_at, created_by, team_id";

function rowToConsumer(row: ConsumerRow): Consumer {
  return {
    id: row.id,
    name: row.name,
    monthlyQuota: row.monthly_quota,
    endUserRateLimitPerMin: row.end_user_rate_limit_per_min,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    teamId: row.team_id ?? null,
  };
}

/** Start of the current calendar month, UTC (epoch ms). */
function monthStart(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * Lists consumers, optionally scoped to a team. Pass `teamId` for a
 * team-scoped caller (mirrors listClientsSummary's tenancy filter) — omit it
 * (or pass undefined) for a super-admin/bearer caller, who sees every
 * consumer regardless of ownership.
 */
export function listConsumers(filter: { teamId?: number } = {}): Consumer[] {
  if (typeof filter.teamId === "number") {
    return (
      getDb().query(`SELECT ${COLS} FROM consumers WHERE team_id = ? ORDER BY name`).all(filter.teamId) as ConsumerRow[]
    ).map(rowToConsumer);
  }
  return (getDb().query(`SELECT ${COLS} FROM consumers ORDER BY name`).all() as ConsumerRow[]).map(rowToConsumer);
}

export function getConsumer(id: number): Consumer | null {
  if (!Number.isInteger(id)) return null;
  const row = getDb().query(`SELECT ${COLS} FROM consumers WHERE id = ?`).get(id) as ConsumerRow | null;
  return row ? rowToConsumer(row) : null;
}

export function consumerNameExists(name: string): boolean {
  return getDb().query(`SELECT 1 FROM consumers WHERE name = ?`).get(name) != null;
}

export function getConsumerByName(name: string): Consumer | null {
  const row = getDb().query(`SELECT ${COLS} FROM consumers WHERE name = ?`).get(name) as ConsumerRow | null;
  return row ? rowToConsumer(row) : null;
}

export function createConsumer(input: {
  name: string;
  monthlyQuota: number | null;
  endUserRateLimitPerMin?: number | null;
  actor: string | null;
  /** Owning team id for a team-scoped creator; omit/null for an unowned (super-admin-only) consumer. */
  teamId?: number | null;
}): Consumer {
  const now = Date.now();
  const row = getDb()
    .query(
      `INSERT INTO consumers (name, monthly_quota, end_user_rate_limit_per_min, created_at, updated_at, created_by, team_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${COLS}`,
    )
    .get(
      input.name,
      input.monthlyQuota,
      input.endUserRateLimitPerMin ?? null,
      now,
      now,
      input.actor,
      input.teamId ?? null,
    ) as ConsumerRow;
  return rowToConsumer(row);
}

export function updateConsumer(
  id: number,
  updates: { name?: string; monthlyQuota?: number | null; endUserRateLimitPerMin?: number | null },
): Consumer | null {
  const existing = getConsumer(id);
  if (!existing) return null;
  const name = updates.name ?? existing.name;
  const quota = updates.monthlyQuota !== undefined ? updates.monthlyQuota : existing.monthlyQuota;
  const endUserRateLimitPerMin =
    updates.endUserRateLimitPerMin !== undefined ? updates.endUserRateLimitPerMin : existing.endUserRateLimitPerMin;
  getDb()
    .query(
      `UPDATE consumers SET name = ?, monthly_quota = ?, end_user_rate_limit_per_min = ?, updated_at = ? WHERE id = ?`,
    )
    .run(name, quota, endUserRateLimitPerMin, Date.now(), id);
  return getConsumer(id);
}

export function deleteConsumer(id: number): boolean {
  // Keys' consumer_id is set NULL by the FK ON DELETE SET NULL.
  return getDb().query(`DELETE FROM consumers WHERE id = ?`).run(id).changes > 0;
}

/**
 * Number of proxied calls this calendar month attributed to any of a consumer's
 * keys. Reads the incrementally-maintained consumer_usage_counters row (kept in
 * sync by recordUsage in src/observability/usage.ts) — an O(1) lookup rather
 * than the former COUNT(*) scan over tool_call_log, since this runs on the
 * dispatch hot path via checkConsumerQuota.
 */
export function getConsumerUsageThisMonth(consumerId: number): number {
  const row = getDb()
    .query(`SELECT count FROM consumer_usage_counters WHERE consumer_id = ? AND period_start = ?`)
    .get(consumerId, monthStart()) as { count: number } | null;
  return row?.count ?? 0;
}

export interface QuotaStatus {
  exceeded: boolean;
  used: number;
  quota: number | null;
}

/**
 * Whether a consumer is at/over its monthly quota. Unknown or unlimited
 * consumers never exceed. Accepts an already-fetched `consumer` (e.g. from a
 * caller that also needs it for checkEndUserRateLimit) to avoid a second
 * `getConsumer` round-trip on this hot path — pass nothing to fetch it here.
 */
export function checkConsumerQuota(consumerId: number, consumer?: Consumer | null): QuotaStatus {
  const c = consumer !== undefined ? consumer : getConsumer(consumerId);
  if (!c || c.monthlyQuota === null) return { exceeded: false, used: 0, quota: c?.monthlyQuota ?? null };
  const used = getConsumerUsageThisMonth(consumerId);
  return { exceeded: used >= c.monthlyQuota, used, quota: c.monthlyQuota };
}

export interface EndUserRateLimitStatus {
  limited: boolean;
  retryAfterSeconds: number;
}

/**
 * Whether a caller-asserted end-user identity is over its per-minute rate
 * limit, for consumers that have opted in via endUserRateLimitPerMin. This is
 * a cooperative fairness dimension, not an authorization boundary — the
 * identity is caller-asserted and unauthenticated (see resolveEndUserId in
 * proxy/gates.ts). A consumer that hasn't opted in, or an unknown/deleted consumer,
 * never limits (fail-open, symmetric with checkConsumerQuota above).
 */
export function checkEndUserRateLimit(
  consumerId: number,
  rawEndUserId: string,
  consumer?: Consumer | null,
): EndUserRateLimitStatus {
  const c = consumer !== undefined ? consumer : getConsumer(consumerId);
  if (!c || c.endUserRateLimitPerMin === null) return { limited: false, retryAfterSeconds: 0 };
  const endUserId = rawEndUserId.slice(0, 256);
  const r = checkSharedEndUserRateLimit(consumerId, endUserId, c.endUserRateLimitPerMin);
  return { limited: !r.allowed, retryAfterSeconds: r.retryAfterSeconds };
}

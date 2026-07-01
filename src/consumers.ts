import { getDb } from "./db/connection.js";

export interface Consumer {
  id: number;
  name: string;
  monthlyQuota: number | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
}

interface ConsumerRow {
  id: number;
  name: string;
  monthly_quota: number | null;
  created_at: number;
  updated_at: number;
  created_by: string | null;
}

const COLS = "id, name, monthly_quota, created_at, updated_at, created_by";

function rowToConsumer(row: ConsumerRow): Consumer {
  return {
    id: row.id,
    name: row.name,
    monthlyQuota: row.monthly_quota,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

/** Start of the current calendar month, UTC (epoch ms). */
function monthStart(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function listConsumers(): Consumer[] {
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

export function createConsumer(input: { name: string; monthlyQuota: number | null; actor: string | null }): Consumer {
  const now = Date.now();
  const row = getDb()
    .query(`INSERT INTO consumers (name, monthly_quota, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?) RETURNING ${COLS}`)
    .get(input.name, input.monthlyQuota, now, now, input.actor) as ConsumerRow;
  return rowToConsumer(row);
}

export function updateConsumer(id: number, updates: { name?: string; monthlyQuota?: number | null }): Consumer | null {
  const existing = getConsumer(id);
  if (!existing) return null;
  const name = updates.name ?? existing.name;
  const quota = updates.monthlyQuota !== undefined ? updates.monthlyQuota : existing.monthlyQuota;
  getDb().query(`UPDATE consumers SET name = ?, monthly_quota = ?, updated_at = ? WHERE id = ?`).run(name, quota, Date.now(), id);
  return getConsumer(id);
}

export function deleteConsumer(id: number): boolean {
  // Keys' consumer_id is set NULL by the FK ON DELETE SET NULL.
  return getDb().query(`DELETE FROM consumers WHERE id = ?`).run(id).changes > 0;
}

/** Number of proxied calls this calendar month attributed to any of a consumer's keys. */
export function getConsumerUsageThisMonth(consumerId: number): number {
  const row = getDb()
    .query(
      `SELECT COUNT(*) as c FROM tool_call_log
       WHERE created_at >= ? AND key_id IN (SELECT id FROM mcp_api_keys WHERE consumer_id = ?)`
    )
    .get(monthStart(), consumerId) as { c: number };
  return row.c;
}

export interface QuotaStatus {
  exceeded: boolean;
  used: number;
  quota: number | null;
}

/** Whether a consumer is at/over its monthly quota. Unknown or unlimited consumers never exceed. */
export function checkConsumerQuota(consumerId: number): QuotaStatus {
  const c = getConsumer(consumerId);
  if (!c || c.monthlyQuota === null) return { exceeded: false, used: 0, quota: c?.monthlyQuota ?? null };
  const used = getConsumerUsageThisMonth(consumerId);
  return { exceeded: used >= c.monthlyQuota, used, quota: c.monthlyQuota };
}

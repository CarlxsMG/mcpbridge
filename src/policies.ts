import { getDb } from "./db/connection.js";
import { registry } from "./registry.js";
import { getBundleDetail, type BundleToolRef } from "./bundles.js";

export interface GuardPolicy {
  id: number;
  name: string;
  rateLimitPerMin: number | null;
  timeoutMs: number | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
}

interface PolicyRow {
  id: number;
  name: string;
  rate_limit_per_min: number | null;
  timeout_ms: number | null;
  created_at: number;
  updated_at: number;
  created_by: string | null;
}

const COLS = "id, name, rate_limit_per_min, timeout_ms, created_at, updated_at, created_by";

function rowToPolicy(row: PolicyRow): GuardPolicy {
  return {
    id: row.id,
    name: row.name,
    rateLimitPerMin: row.rate_limit_per_min,
    timeoutMs: row.timeout_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

export function listGuardPolicies(): GuardPolicy[] {
  return (getDb().query(`SELECT ${COLS} FROM guard_policies ORDER BY name`).all() as PolicyRow[]).map(rowToPolicy);
}

export function getGuardPolicy(id: number): GuardPolicy | null {
  if (!Number.isInteger(id)) return null;
  const row = getDb().query(`SELECT ${COLS} FROM guard_policies WHERE id = ?`).get(id) as PolicyRow | null;
  return row ? rowToPolicy(row) : null;
}

export function policyNameExists(name: string): boolean {
  return getDb().query(`SELECT 1 FROM guard_policies WHERE name = ?`).get(name) != null;
}

export function createGuardPolicy(input: {
  name: string;
  rateLimitPerMin: number | null;
  timeoutMs: number | null;
  actor: string | null;
}): GuardPolicy {
  const now = Date.now();
  const row = getDb()
    .query(
      `INSERT INTO guard_policies (name, rate_limit_per_min, timeout_ms, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING ${COLS}`,
    )
    .get(input.name, input.rateLimitPerMin, input.timeoutMs, now, now, input.actor) as PolicyRow;
  return rowToPolicy(row);
}

export function updateGuardPolicy(
  id: number,
  updates: { name?: string; rateLimitPerMin?: number | null; timeoutMs?: number | null },
): GuardPolicy | null {
  const existing = getGuardPolicy(id);
  if (!existing) return null;
  const name = updates.name ?? existing.name;
  const rate = updates.rateLimitPerMin !== undefined ? updates.rateLimitPerMin : existing.rateLimitPerMin;
  const timeout = updates.timeoutMs !== undefined ? updates.timeoutMs : existing.timeoutMs;
  getDb()
    .query(`UPDATE guard_policies SET name = ?, rate_limit_per_min = ?, timeout_ms = ?, updated_at = ? WHERE id = ?`)
    .run(name, rate, timeout, Date.now(), id);
  return getGuardPolicy(id);
}

export function deleteGuardPolicy(id: number): boolean {
  return getDb().query(`DELETE FROM guard_policies WHERE id = ?`).run(id).changes > 0;
}

export interface ApplyResult {
  applied: number;
  skipped: { tool: string; reason: string }[];
}

/** Applies a policy's rate-limit/timeout to each tool, preserving key allow-lists. */
export async function applyPolicyToTools(policy: GuardPolicy, refs: BundleToolRef[]): Promise<ApplyResult> {
  const patch = { rateLimitPerMin: policy.rateLimitPerMin, timeoutMs: policy.timeoutMs };
  let applied = 0;
  const skipped: { tool: string; reason: string }[] = [];
  for (const r of refs) {
    const ok = await registry.applyGuardPolicy(r.client, r.tool, patch);
    if (ok) applied++;
    else skipped.push({ tool: `${r.client}__${r.tool}`, reason: "not found" });
  }
  return { applied, skipped };
}

/** Applies a policy to every tool in a bundle (bundle-level guard semantics). Null if the bundle is unknown. */
export async function applyPolicyToBundle(policy: GuardPolicy, bundleName: string): Promise<ApplyResult | null> {
  const bundle = getBundleDetail(bundleName);
  if (!bundle) return null;
  return applyPolicyToTools(policy, bundle.tools);
}

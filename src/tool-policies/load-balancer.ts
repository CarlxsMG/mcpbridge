/**
 * Per-client N-way upstream load balancing (REST clients only, v1).
 *
 * A client can carry a pool of additional backend targets; when the pool is
 * enabled, a tool call is routed across `[primary] + enabled targets` by one of
 * three strategies:
 *   - "round-robin": rotate through the members in order.
 *   - "weighted":    pick proportionally to each member's integer weight.
 *   - "least-conn":  pick the member with the fewest in-flight calls.
 *
 * Each target's URL is SSRF-validated and its IP pinned at config time (exactly
 * like the canary secondary), so dispatch stays DNS-rebinding-safe. Extends the
 * same per-client secondary-routing idea as canary.ts, but many-to-one.
 *
 * Health awareness is a lightweight per-target cooldown maintained here (a target
 * that fails a call is skipped for `config.lbTargetCooldownMs`), independent of
 * the client-level circuit breaker — which is intentionally left untouched, so
 * breaker/canary/health/admin-reset semantics are unchanged. Per-target breakers
 * and cross-instance sharing are deferred to a later phase.
 *
 * LB takes precedence over canary: when the pool is active, canary routing is
 * skipped (see proxy.ts) — the two are mutually exclusive per call.
 */
import { getDb } from "../db/connection.js";
import { config } from "../config.js";
import { validateBackendUrl } from "../net/ip-validator.js";
import { upsertConfig } from "../lib/tool-config.js";

export type LbStrategy = "round-robin" | "weighted" | "least-conn";

export interface LbTarget {
  id: number;
  baseUrl: string;
  resolvedIp: string;
  weight: number;
  enabled: boolean;
}

export interface LbConfig {
  strategy: LbStrategy;
  primaryWeight: number;
  enabled: boolean;
  targets: LbTarget[];
}

/** A single resolved routing choice for one call. */
export interface LbChoice {
  baseUrl: string;
  resolvedIp: string;
  /** Stable per-target key (`client#baseUrl`) for cooldown + in-flight bookkeeping. */
  key: string;
  isPrimary: boolean;
}

interface LbRow {
  strategy: string;
  primary_weight: number;
  enabled: number;
}

interface UpstreamRow {
  id: number;
  base_url: string;
  resolved_ip: string;
  weight: number;
  enabled: number;
}

// ── Read model ──────────────────────────────────────────────────────────────

/** Full LB config + pool for a client, or null when no LB row exists. */
export function getLb(clientName: string): LbConfig | null {
  const db = getDb();
  const row = db
    .query(`SELECT strategy, primary_weight, enabled FROM client_lb WHERE client_name = ?`)
    .get(clientName) as LbRow | null;
  if (!row) return null;
  const targets = (
    db
      .query(
        `SELECT id, base_url, resolved_ip, weight, enabled FROM client_upstreams WHERE client_name = ? ORDER BY id`,
      )
      .all(clientName) as UpstreamRow[]
  ).map((t) => ({
    id: t.id,
    baseUrl: t.base_url,
    resolvedIp: t.resolved_ip,
    weight: t.weight,
    enabled: t.enabled === 1,
  }));
  return {
    strategy: row.strategy as LbStrategy,
    primaryWeight: row.primary_weight,
    enabled: row.enabled === 1,
    targets,
  };
}

// ── Mutations ─────────────────────────────────────────────────────────────

export type LbError =
  "CLIENT_NOT_FOUND" | "NOT_REST" | "INVALID_STRATEGY" | "INVALID_WEIGHT" | "INVALID_URL" | "TARGET_NOT_FOUND";

const STRATEGIES: readonly LbStrategy[] = ["round-robin", "weighted", "least-conn"];

function isRestClient(clientName: string): { ok: true } | { ok: false; error: LbError } {
  const client = getDb().query(`SELECT kind FROM clients WHERE name = ?`).get(clientName) as { kind: string } | null;
  if (!client) return { ok: false, error: "CLIENT_NOT_FOUND" };
  if (client.kind !== "rest") return { ok: false, error: "NOT_REST" };
  return { ok: true };
}

/** Sets (or clears with null) a client's LB strategy config. */
export function setLb(
  clientName: string,
  input: { strategy: LbStrategy; primaryWeight: number; enabled: boolean } | null,
): { ok: true } | { ok: false; error: LbError } {
  const db = getDb();
  const check = isRestClient(clientName);
  if (!check.ok) return check;

  if (input === null) {
    db.query(`DELETE FROM client_lb WHERE client_name = ?`).run(clientName);
    return { ok: true };
  }
  if (!STRATEGIES.includes(input.strategy)) return { ok: false, error: "INVALID_STRATEGY" };
  if (!Number.isInteger(input.primaryWeight) || input.primaryWeight < 0 || input.primaryWeight > 1000) {
    return { ok: false, error: "INVALID_WEIGHT" };
  }
  upsertConfig(
    "client_lb",
    { client_name: clientName },
    { strategy: input.strategy, primary_weight: input.primaryWeight, enabled: input.enabled ? 1 : 0 },
    Date.now(),
  );
  return { ok: true };
}

/** Adds a pool target (SSRF-validated + IP-pinned). */
export async function addUpstream(
  clientName: string,
  baseUrl: string,
  weight: number,
): Promise<{ ok: true; id: number } | { ok: false; error: LbError; reason?: string }> {
  const check = isRestClient(clientName);
  if (!check.ok) return check;
  if (!Number.isInteger(weight) || weight < 1 || weight > 1000) return { ok: false, error: "INVALID_WEIGHT" };

  const url = await validateBackendUrl(baseUrl, config.allowPrivateIps, config.allowedHosts);
  if (!url.valid || !url.resolvedIp) return { ok: false, error: "INVALID_URL", reason: url.reason };

  const now = Date.now();
  const res = getDb()
    .query(
      `INSERT INTO client_upstreams (client_name, base_url, resolved_ip, weight, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?) RETURNING id`,
    )
    .get(clientName, baseUrl, url.resolvedIp, weight, now, now) as { id: number };
  return { ok: true, id: res.id };
}

/** Enables/disables or reweights a pool target. */
export function updateUpstream(
  clientName: string,
  id: number,
  patch: { enabled?: boolean; weight?: number },
): { ok: true } | { ok: false; error: LbError } {
  const db = getDb();
  const row = db.query(`SELECT id FROM client_upstreams WHERE client_name = ? AND id = ?`).get(clientName, id) as {
    id: number;
  } | null;
  if (!row) return { ok: false, error: "TARGET_NOT_FOUND" };
  if (patch.weight !== undefined && (!Number.isInteger(patch.weight) || patch.weight < 1 || patch.weight > 1000)) {
    return { ok: false, error: "INVALID_WEIGHT" };
  }
  if (patch.enabled !== undefined) {
    db.query(`UPDATE client_upstreams SET enabled = ?, updated_at = ? WHERE client_name = ? AND id = ?`).run(
      patch.enabled ? 1 : 0,
      Date.now(),
      clientName,
      id,
    );
  }
  if (patch.weight !== undefined) {
    db.query(`UPDATE client_upstreams SET weight = ?, updated_at = ? WHERE client_name = ? AND id = ?`).run(
      patch.weight,
      Date.now(),
      clientName,
      id,
    );
  }
  return { ok: true };
}

/** Removes a pool target. */
export function removeUpstream(clientName: string, id: number): { ok: true } | { ok: false; error: LbError } {
  const res = getDb().query(`DELETE FROM client_upstreams WHERE client_name = ? AND id = ?`).run(clientName, id);
  if (res.changes === 0) return { ok: false, error: "TARGET_NOT_FOUND" };
  return { ok: true };
}

// ── Runtime state: round-robin cursors, health cooldown, in-flight counts ────

const rrCursor = new Map<string, number>();
const cooldownUntil = new Map<string, number>();
const inflight = new Map<string, number>();

/** Injectable clock + RNG so selection is deterministically testable. */
let nowFn: () => number = () => Date.now();
let randFn: () => number = () => Math.random();

function targetKey(clientName: string, baseUrl: string): string {
  return `${clientName}#${baseUrl}`;
}

/**
 * Chooses one member of `[primary] + enabled targets` for this call. Members in
 * health cooldown are skipped; if that leaves none, the full member set is used
 * (better to try a cooling target than to not dispatch). Never returns null —
 * the primary is always a member — so callers gate on `lbActive` instead.
 */
export function selectTarget(client: { name: string; base_url: string; resolved_ip: string }, lb: LbConfig): LbChoice {
  const members: Array<{ choice: LbChoice; weight: number }> = [
    {
      choice: {
        baseUrl: client.base_url,
        resolvedIp: client.resolved_ip,
        key: targetKey(client.name, client.base_url),
        isPrimary: true,
      },
      weight: Math.max(0, lb.primaryWeight),
    },
    ...lb.targets
      .filter((t) => t.enabled)
      .map((t) => ({
        choice: {
          baseUrl: t.baseUrl,
          resolvedIp: t.resolvedIp,
          key: targetKey(client.name, t.baseUrl),
          isPrimary: false,
        },
        weight: Math.max(1, t.weight),
      })),
  ];

  const now = nowFn();
  const healthy = members.filter((m) => (cooldownUntil.get(m.choice.key) ?? 0) <= now);
  const pool = healthy.length > 0 ? healthy : members;

  if (lb.strategy === "least-conn") {
    let best = pool[0];
    let bestN = inflight.get(best.choice.key) ?? 0;
    for (const m of pool.slice(1)) {
      const n = inflight.get(m.choice.key) ?? 0;
      if (n < bestN) {
        best = m;
        bestN = n;
      }
    }
    return best.choice;
  }

  if (lb.strategy === "weighted") {
    const total = pool.reduce((s, m) => s + m.weight, 0);
    if (total <= 0) return pool[0].choice;
    let r = randFn() * total;
    for (const m of pool) {
      r -= m.weight;
      if (r < 0) return m.choice;
    }
    return pool[pool.length - 1].choice;
  }

  // round-robin
  const idx = (rrCursor.get(client.name) ?? 0) % pool.length;
  rrCursor.set(client.name, idx + 1);
  return pool[idx].choice;
}

/** Marks a target healthy again (clears any cooldown). */
export function markTargetUp(key: string): void {
  cooldownUntil.delete(key);
}

/** Puts a target into health cooldown after a failed call. */
export function markTargetDown(key: string): void {
  cooldownUntil.set(key, nowFn() + config.lbTargetCooldownMs);
}

export function incInflight(key: string): void {
  inflight.set(key, (inflight.get(key) ?? 0) + 1);
}

export function decInflight(key: string): void {
  const n = (inflight.get(key) ?? 0) - 1;
  if (n <= 0) inflight.delete(key);
  else inflight.set(key, n);
}

/** Test-only: reset all runtime state. */
export function __resetLbForTesting(): void {
  rrCursor.clear();
  cooldownUntil.clear();
  inflight.clear();
  nowFn = () => Date.now();
  randFn = () => Math.random();
}

/** Test-only: override the clock and RNG used by selection/cooldown. */
export function __setLbDepsForTesting(deps: { now?: () => number; rand?: () => number }): void {
  if (deps.now) nowFn = deps.now;
  if (deps.rand) randFn = deps.rand;
}

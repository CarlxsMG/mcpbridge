import { getDb } from "../db/connection.js";
import { config } from "../config.js";
import { validateBackendUrl } from "../security/ip-validator.js";
import { upsertConfig } from "../lib/tool-config.js";

/**
 * Per-client secondary-upstream routing (REST clients only, v1). A client can
 * point at a second backend and either:
 *   - "canary": send `weight`% of calls to the secondary, or
 *   - "failover": send calls to the secondary only while the primary's circuit
 *     breaker is OPEN.
 * The secondary URL is SSRF-validated and its IP pinned at config time (exactly
 * like the primary at registration), so the dispatch stays DNS-rebinding-safe.
 * Applies to all of the client's tools.
 */
export type CanaryMode = "canary" | "failover";

export interface CanaryConfig {
  secondaryBaseUrl: string;
  secondaryResolvedIp: string;
  mode: CanaryMode;
  weight: number;
  enabled: boolean;
}

interface CanaryRow {
  secondary_base_url: string;
  secondary_resolved_ip: string;
  mode: string;
  weight: number;
  enabled: number;
}

function rowTo(row: CanaryRow | null): CanaryConfig | null {
  if (!row) return null;
  return {
    secondaryBaseUrl: row.secondary_base_url,
    secondaryResolvedIp: row.secondary_resolved_ip,
    mode: row.mode as CanaryMode,
    weight: row.weight,
    enabled: row.enabled === 1,
  };
}

/** Full config for a client (enabled or not). Null when none is set. */
export function getCanary(clientName: string): CanaryConfig | null {
  const row = getDb()
    .query(
      `SELECT secondary_base_url, secondary_resolved_ip, mode, weight, enabled FROM client_canary WHERE client_name = ?`,
    )
    .get(clientName) as CanaryRow | null;
  return rowTo(row);
}

export type CanaryError = "CLIENT_NOT_FOUND" | "NOT_REST" | "INVALID_MODE" | "INVALID_WEIGHT" | "INVALID_URL";

/**
 * Sets (or, with null, clears) a client's secondary-upstream routing. Validates
 * that the client exists and is REST-kind, the mode/weight are sane, and the
 * secondary URL passes SSRF validation — pinning its resolved IP.
 */
export async function setCanary(
  clientName: string,
  input: { secondaryBaseUrl: string; mode: CanaryMode; weight: number; enabled: boolean } | null,
): Promise<{ ok: true } | { ok: false; error: CanaryError; reason?: string }> {
  const db = getDb();
  const client = db.query(`SELECT kind FROM clients WHERE name = ?`).get(clientName) as { kind: string } | null;
  if (!client) return { ok: false, error: "CLIENT_NOT_FOUND" };

  if (input === null) {
    db.query(`DELETE FROM client_canary WHERE client_name = ?`).run(clientName);
    return { ok: true };
  }

  if (client.kind !== "rest") return { ok: false, error: "NOT_REST" };
  if (input.mode !== "canary" && input.mode !== "failover") return { ok: false, error: "INVALID_MODE" };
  if (!Number.isInteger(input.weight) || input.weight < 1 || input.weight > 100)
    return { ok: false, error: "INVALID_WEIGHT" };

  const check = await validateBackendUrl(input.secondaryBaseUrl, config.allowPrivateIps, config.allowedHosts);
  if (!check.valid || !check.resolvedIp) return { ok: false, error: "INVALID_URL", reason: check.reason };

  upsertConfig(
    "client_canary",
    { client_name: clientName },
    {
      secondary_base_url: input.secondaryBaseUrl,
      secondary_resolved_ip: check.resolvedIp,
      mode: input.mode,
      weight: input.weight,
      enabled: input.enabled ? 1 : 0,
    },
    Date.now(),
  );
  return { ok: true };
}

/**
 * Decides whether a single call should go to the secondary.
 *   - not enabled            -> primary
 *   - failover + breaker open -> secondary (bypass; primary is presumed down)
 *   - canary                 -> secondary with probability weight/100
 * `rand` is injectable for deterministic tests.
 */
export function decideSecondary(
  cfg: CanaryConfig | null,
  breakerOpen: boolean,
  rand: () => number = Math.random,
): { useSecondary: boolean; bypassBreaker: boolean } {
  if (!cfg || !cfg.enabled) return { useSecondary: false, bypassBreaker: false };
  if (breakerOpen) {
    return cfg.mode === "failover"
      ? { useSecondary: true, bypassBreaker: true }
      : { useSecondary: false, bypassBreaker: false };
  }
  if (cfg.mode === "canary" && rand() * 100 < cfg.weight) return { useSecondary: true, bypassBreaker: false };
  return { useSecondary: false, bypassBreaker: false };
}

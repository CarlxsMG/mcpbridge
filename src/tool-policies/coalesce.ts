/**
 * Request coalescing for concurrent identical REST GET tool calls.
 *
 * Distinct from response-cache.ts's TTL cache: this only dedupes calls that
 * are in flight at the SAME time, sharing a single upstream fetch across all
 * of them instead of issuing N. Reuses response-cache.ts's key shape (the
 * same "REST GET, response doesn't vary by caller" safety invariant) but is
 * independently toggled — a tool can coalesce without caching, or vice versa.
 *
 * Every caller's own auth/scope/quota/guardrail gates in proxy.ts already ran
 * BEFORE a call reaches the coalescing point, so piggybacking never bypasses
 * per-caller authorization — only the actual upstream fetch (and its
 * breaker/LB bookkeeping) is shared.
 */
import { getDb } from "../db/connection.js";
import { toolExists, upsertConfig } from "../lib/tool-config.js";

export interface ToolCoalesceConfig {
  enabled: boolean;
}

interface CoalesceRow {
  enabled: number;
}

/** Reads a tool's coalescing config, or null when the tool has none. */
export function getToolCoalesce(clientName: string, toolName: string): ToolCoalesceConfig | null {
  const row = getDb()
    .query(`SELECT enabled FROM tool_coalesce WHERE client_name = ? AND tool_name = ?`)
    .get(clientName, toolName) as CoalesceRow | null;
  if (!row) return null;
  return { enabled: row.enabled === 1 };
}

/** Coalescing config for every tool of a client, keyed by tool name (batched for detail views). */
export function getCoalesceForClient(clientName: string): Record<string, ToolCoalesceConfig> {
  const rows = getDb()
    .query(`SELECT tool_name, enabled FROM tool_coalesce WHERE client_name = ?`)
    .all(clientName) as (CoalesceRow & { tool_name: string })[];
  const out: Record<string, ToolCoalesceConfig> = {};
  for (const r of rows) out[r.tool_name] = { enabled: r.enabled === 1 };
  return out;
}

/**
 * Persists (or clears, with `null`/`enabled:false`) a tool's coalescing
 * config. Returns false when the tool does not exist (same contract as
 * setToolCacheConfig).
 */
export function setToolCoalesce(clientName: string, toolName: string, input: { enabled: boolean } | null): boolean {
  if (!toolExists(clientName, toolName)) return false;

  if (input === null || !input.enabled) {
    getDb().query(`DELETE FROM tool_coalesce WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
  } else {
    upsertConfig("tool_coalesce", { client_name: clientName, tool_name: toolName }, { enabled: 1 }, Date.now());
  }
  return true;
}

// ── In-flight dedup map ─────────────────────────────────────────────────────

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Runs `factory()` for the first caller with a given key; every caller that
 * arrives while it's still pending shares (piggybacks on) the same promise
 * instead of invoking `factory` again. Returns whether THIS call piggybacked
 * (false for the caller that actually triggered `factory`).
 */
export async function runCoalesced<T>(
  key: string,
  factory: () => Promise<T>,
): Promise<{ result: T; piggybacked: boolean }> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) {
    return { result: await existing, piggybacked: true };
  }
  const p = factory();
  inFlight.set(key, p);
  try {
    return { result: await p, piggybacked: false };
  } finally {
    inFlight.delete(key);
  }
}

/** Number of distinct calls currently in flight and coalescible. */
export function coalesceInFlightSize(): number {
  return inFlight.size;
}

/** Test-only: clear in-flight bookkeeping between tests. */
export function __resetCoalesceForTesting(): void {
  inFlight.clear();
}

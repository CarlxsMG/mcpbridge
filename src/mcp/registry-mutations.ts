/**
 * registry-mutations.ts — guard/override/enabled admin-mutation cluster split
 * out of the live Registry class.
 *
 * Mirrors the registry-read-models.ts split: these functions only need the
 * live `clients` map (read AND write here, unlike the read-only maps the
 * read models take) plus the alias index for the one function that touches
 * it (setToolOverrideMutation). No other Registry state or private methods
 * are needed, so they live here as standalone functions rather than class
 * methods. `Registry.setClientEnabled` / `setToolEnabled` / `setClientGuards`
 * / `setToolGuards` / `setToolOverride` / `annotateToolDrift` /
 * `applyGuardPolicy` (see registry.ts) are thin delegating wrappers that
 * keep taking the per-client-name lock themselves (locking stays a Registry
 * concern, same rationale as the persistence split) and pass `this.clients`
 * / `this.aliasIndex` through, preserving their existing public
 * names/signatures for the ~50+ call sites across src/routes/, src/admin/,
 * and tests.
 *
 * `ToolOverrideError` moved here with `setToolOverrideMutation` (the only
 * thing that throws it) — `registry.ts` re-exports it so every existing
 * `import { ToolOverrideError } from ".../registry.js"` keeps working
 * unchanged.
 */
import { getDb } from "../db/connection.js";
import { sanitizeToolDescription } from "../content-filtering/sanitize.js";
import { updateCircuitBreakerConfig } from "../middleware/circuit-breaker.js";
import { notifyToolsChanged } from "./mcp-server.js";
import { isValidToolName } from "../lib/identifier.js";
import type { RegistryAliasIndex } from "./registry-alias-index.js";
import { rowToToolGuards, rowToToolOverride, type ToolGuardRow, type ToolOverrideRow } from "./registry-persistence.js";
import type { RegisteredClient, ClientGuardConfig, ToolGuardConfig, ToolOverride } from "./types.js";

/** Thrown by setToolOverrideMutation when a displayName alias is malformed or collides with another tool. */
export class ToolOverrideError extends Error {
  constructor(
    public code: "TOOL_ALIAS_INVALID" | "TOOL_ALIAS_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "ToolOverrideError";
  }
}

/**
 * Persists and (if live) applies a client-level enable/disable toggle.
 * Returns false for an unknown client. Caller (Registry.setClientEnabled)
 * holds the per-client-name lock.
 */
export function setClientEnabledMutation(
  clients: Map<string, RegisteredClient>,
  name: string,
  enabled: boolean,
): boolean {
  const db = getDb();
  const result = db
    .query(`UPDATE clients SET enabled = ?, updated_at = ? WHERE name = ?`)
    .run(enabled ? 1 : 0, Date.now(), name);
  if (result.changes === 0) {
    return false;
  }

  const client = clients.get(name);
  if (client) {
    const changed = client.enabled !== enabled;
    client.enabled = enabled;
    if (changed) {
      notifyToolsChanged();
    }
  }
  return true;
}

/**
 * Persists and (if live) applies a tool-level enable/disable toggle. Returns
 * false for an unknown client/tool. Caller (Registry.setToolEnabled) holds
 * the per-client-name lock.
 */
export function setToolEnabledMutation(
  clients: Map<string, RegisteredClient>,
  clientName: string,
  toolName: string,
  enabled: boolean,
): boolean {
  const db = getDb();
  const result = db
    .query(`UPDATE tools SET enabled = ?, updated_at = ? WHERE client_name = ? AND name = ?`)
    .run(enabled ? 1 : 0, Date.now(), clientName, toolName);
  if (result.changes === 0) {
    return false;
  }

  const client = clients.get(clientName);
  const tool = client?.tools.find((t) => t.name === toolName);
  if (client && tool) {
    const changed = tool.enabled !== enabled;
    tool.enabled = enabled;
    if (changed) {
      notifyToolsChanged();
    }
  }
  return true;
}

/**
 * Persists and (if live) applies a client-level guard config. Pass `null` to
 * clear it back to "use global defaults". Returns false for an unknown
 * client. Does not call notifyToolsChanged — guards don't change what
 * tools/list advertises, only how calls to already-advertised tools behave.
 * Caller (Registry.setClientGuards) holds the per-client-name lock.
 */
export function setClientGuardsMutation(
  clients: Map<string, RegisteredClient>,
  clientName: string,
  guards: ClientGuardConfig | null,
): boolean {
  const db = getDb();
  const exists = db.query(`SELECT 1 FROM clients WHERE name = ?`).get(clientName);
  if (!exists) return false;

  if (guards === null) {
    db.query(`DELETE FROM client_guards WHERE client_name = ?`).run(clientName);
  } else {
    const cb = guards.circuitBreaker;
    db.query(
      `INSERT INTO client_guards (client_name, cb_failure_threshold, cb_reset_timeout_ms, cb_half_open_timeout_ms, cb_window_ms, extra_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(client_name) DO UPDATE SET
         cb_failure_threshold = excluded.cb_failure_threshold,
         cb_reset_timeout_ms = excluded.cb_reset_timeout_ms,
         cb_half_open_timeout_ms = excluded.cb_half_open_timeout_ms,
         cb_window_ms = excluded.cb_window_ms,
         extra_json = excluded.extra_json,
         updated_at = excluded.updated_at`,
    ).run(
      clientName,
      cb?.failureThreshold ?? null,
      cb?.resetTimeoutMs ?? null,
      cb?.halfOpenTimeoutMs ?? null,
      cb?.windowMs ?? null,
      guards.extra ? JSON.stringify(guards.extra) : null,
      Date.now(),
    );
  }

  const client = clients.get(clientName);
  if (client) {
    client.guards = guards ?? undefined;
    if (guards?.circuitBreaker) {
      updateCircuitBreakerConfig(clientName, guards.circuitBreaker);
    }
  }
  return true;
}

/**
 * Persists and (if live) applies a tool-level guard config. Pass `null` to
 * clear it. Returns false for an unknown client/tool. Caller
 * (Registry.setToolGuards) holds the per-client-name lock.
 */
export function setToolGuardsMutation(
  clients: Map<string, RegisteredClient>,
  clientName: string,
  toolName: string,
  guards: ToolGuardConfig | null,
): boolean {
  const db = getDb();
  const exists = db.query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`).get(clientName, toolName);
  if (!exists) return false;

  if (guards === null) {
    db.query(`DELETE FROM tool_guards WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
  } else {
    db.query(
      `INSERT INTO tool_guards (client_name, tool_name, rate_limit_per_min, timeout_ms, allowed_key_hashes, extra_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(client_name, tool_name) DO UPDATE SET
         rate_limit_per_min = excluded.rate_limit_per_min,
         timeout_ms = excluded.timeout_ms,
         allowed_key_hashes = excluded.allowed_key_hashes,
         extra_json = excluded.extra_json,
         updated_at = excluded.updated_at`,
    ).run(
      clientName,
      toolName,
      guards.rateLimitPerMin ?? null,
      guards.timeoutMs ?? null,
      guards.allowedKeyHashes ? JSON.stringify(guards.allowedKeyHashes) : null,
      guards.extra ? JSON.stringify(guards.extra) : null,
      Date.now(),
    );
  }

  const client = clients.get(clientName);
  const tool = client?.tools.find((t) => t.name === toolName);
  if (tool) {
    tool.guards = guards ?? undefined;
  }
  return true;
}

/**
 * Persists and (if live) applies a tool presentation override. Pass null to
 * clear. Admin-provided text is sanitized the same way registration
 * descriptions are, then a tools/list change is broadcast (overrides alter
 * what's advertised). Caller (Registry.setToolOverride) holds the
 * per-client-name lock and supplies `isAliasAvailable` (Registry's own
 * method — pure DB lookup, independent of the `clients` map) so this
 * function doesn't need a back-reference to the Registry instance.
 */
export function setToolOverrideMutation(
  clients: Map<string, RegisteredClient>,
  aliasIndex: RegistryAliasIndex,
  isAliasAvailable: (clientName: string, toolName: string, displayName: string) => boolean,
  clientName: string,
  toolName: string,
  override: ToolOverride | null,
): boolean {
  const db = getDb();
  const exists = db.query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`).get(clientName, toolName);
  if (!exists) return false;

  let normalized: ToolOverride | null = null;
  if (override) {
    const description = override.description ? sanitizeToolDescription(override.description) : undefined;
    let params: ToolOverride["params"] | undefined;
    if (override.params) {
      // Null-prototype: keyed by caller-supplied parameter names (see cookies.ts).
      params = Object.create(null) as NonNullable<ToolOverride["params"]>;
      for (const [p, o] of Object.entries(override.params)) {
        if (o?.description) params[p] = { description: sanitizeToolDescription(o.description) };
      }
      if (Object.keys(params).length === 0) params = undefined;
    }
    let displayName: string | undefined;
    if (override.displayName) {
      // A display-name alias becomes part of the composite MCP key, so it
      // must satisfy the same charset as a tool name (keeps the `__`
      // separator unambiguous — see TOOL_KEY_SEPARATOR invariant).
      if (!isValidToolName(override.displayName)) {
        throw new ToolOverrideError("TOOL_ALIAS_INVALID", "displayName must match /^[a-z0-9][a-z0-9_-]{0,62}$/");
      }
      if (!isAliasAvailable(clientName, toolName, override.displayName)) {
        throw new ToolOverrideError(
          "TOOL_ALIAS_CONFLICT",
          `displayName '${override.displayName}' collides with another tool of client '${clientName}'`,
        );
      }
      if (override.displayName !== toolName) displayName = override.displayName;
    }
    if (description || params || displayName) normalized = { description, params, displayName };
  }

  if (!normalized) {
    // A schema-drift note (system-authored, see annotateToolDriftMutation) can
    // live in the same row's `drift_note` column. Clearing the admin's own
    // override must never silently delete that note out from under the
    // monitor — only drop the row entirely when no note is active;
    // otherwise just null out the admin-authored columns and keep it.
    const current = db
      .query(`SELECT drift_note FROM tool_overrides WHERE client_name = ? AND tool_name = ?`)
      .get(clientName, toolName) as { drift_note: string | null } | null;
    if (current?.drift_note) {
      db.query(
        `UPDATE tool_overrides SET description = NULL, param_overrides_json = NULL, display_name = NULL, updated_at = ?
         WHERE client_name = ? AND tool_name = ?`,
      ).run(Date.now(), clientName, toolName);
    } else {
      db.query(`DELETE FROM tool_overrides WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
    }
  } else {
    db.query(
      `INSERT INTO tool_overrides (client_name, tool_name, description, param_overrides_json, display_name, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(client_name, tool_name) DO UPDATE SET
         description = excluded.description,
         param_overrides_json = excluded.param_overrides_json,
         display_name = excluded.display_name,
         updated_at = excluded.updated_at`,
    ).run(
      clientName,
      toolName,
      normalized.description ?? null,
      normalized.params ? JSON.stringify(normalized.params) : null,
      normalized.displayName ?? null,
      Date.now(),
    );
  }

  const client = clients.get(clientName);
  const tool = client?.tools.find((t) => t.name === toolName);
  if (tool) {
    // Re-read rather than assume `normalized` is the full picture — a
    // drift_note may have survived the branch above and must be reflected
    // in the live in-memory override too.
    const row = db
      .query(
        `SELECT description, param_overrides_json, display_name, drift_note FROM tool_overrides WHERE client_name = ? AND tool_name = ?`,
      )
      .get(clientName, toolName) as ToolOverrideRow | null;
    tool.override = rowToToolOverride(row);
  }
  // Keep the alias index in lockstep — resolveAdvertisedName/resolveTool
  // depend on it. Safe for a non-live client too (rebuilt on next register).
  aliasIndex.setAlias(clientName, toolName, normalized?.displayName);
  notifyToolsChanged();
  return true;
}

/**
 * System-authored schema-drift changelog annotation (called from
 * monitor.ts's runSyntheticChecks on the drift-detected/drift-resolved
 * EDGE, and from setMonitor when an admin resets a monitor's baseline).
 * Pass a bracketed, dated note string to add/replace it; pass `null` to
 * clear it (drift resolved, or the baseline was reset — never leave a
 * stale note behind, mirroring quarantine.ts's lazy auto-clear idiom).
 *
 * Stored in tool_overrides.drift_note — a column setToolOverrideMutation
 * never writes to — so this can never clobber an admin-authored
 * description, param overrides, or displayName, and an admin editing those
 * can never clobber this note either. The two are concatenated only at
 * advertise-time, in Registry.effectiveAdvertised(). Uses the same UPSERT +
 * notifyToolsChanged() idiom setToolOverrideMutation uses (this DOES change
 * what tools/list advertises). Idempotent — a no-op call (already in the
 * requested state) skips the write and the tools/list broadcast. Returns
 * false for an unknown client/tool. Caller (Registry.annotateToolDrift)
 * holds the per-client-name lock.
 */
export function annotateToolDriftMutation(
  clients: Map<string, RegisteredClient>,
  clientName: string,
  toolName: string,
  note: string | null,
): boolean {
  const db = getDb();
  const exists = db.query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`).get(clientName, toolName);
  if (!exists) return false;

  const current = db
    .query(
      `SELECT description, param_overrides_json, display_name, drift_note FROM tool_overrides WHERE client_name = ? AND tool_name = ?`,
    )
    .get(clientName, toolName) as ToolOverrideRow | null;

  if ((current?.drift_note ?? null) === note) {
    return true; // already in the desired state — avoid a redundant write + broadcast
  }

  if (note === null) {
    if (current?.description || current?.param_overrides_json || current?.display_name) {
      // Admin-authored fields remain — null out only the note, keep the row.
      db.query(
        `UPDATE tool_overrides SET drift_note = NULL, updated_at = ? WHERE client_name = ? AND tool_name = ?`,
      ).run(Date.now(), clientName, toolName);
    } else {
      db.query(`DELETE FROM tool_overrides WHERE client_name = ? AND tool_name = ?`).run(clientName, toolName);
    }
  } else {
    db.query(
      `INSERT INTO tool_overrides (client_name, tool_name, drift_note, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(client_name, tool_name) DO UPDATE SET
         drift_note = excluded.drift_note,
         updated_at = excluded.updated_at`,
    ).run(clientName, toolName, note, Date.now());
  }

  const client = clients.get(clientName);
  const tool = client?.tools.find((t) => t.name === toolName);
  if (tool) {
    const row = db
      .query(
        `SELECT description, param_overrides_json, display_name, drift_note FROM tool_overrides WHERE client_name = ? AND tool_name = ?`,
      )
      .get(clientName, toolName) as ToolOverrideRow | null;
    tool.override = rowToToolOverride(row);
  }
  notifyToolsChanged();
  return true;
}

/**
 * Reads a tool's existing guards and merges in a rate-limit / timeout patch
 * (preserving its API-key allow-list), without persisting. Returns `null`
 * for an unknown client/tool so the caller (Registry.applyGuardPolicy) can
 * short-circuit before calling `setToolGuardsMutation` (which does the
 * actual persist+apply). This function does not take the per-client-name
 * lock itself — the caller MUST run this read and the follow-up
 * setToolGuardsMutation write inside the SAME withLock(clientName, ...)
 * acquisition (see Registry.applyGuardPolicy), otherwise two concurrent
 * callers can both read the same pre-update state and the second write
 * silently clobbers the first's change with stale data.
 */
export function computeMergedToolGuards(
  clientName: string,
  toolName: string,
  patch: { rateLimitPerMin?: number | null; timeoutMs?: number | null },
): ToolGuardConfig | null {
  const db = getDb();
  if (!db.query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`).get(clientName, toolName)) return null;
  const row = db
    .query(
      `SELECT rate_limit_per_min, timeout_ms, allowed_key_hashes, extra_json FROM tool_guards WHERE client_name = ? AND tool_name = ?`,
    )
    .get(clientName, toolName) as ToolGuardRow | null;
  const merged: ToolGuardConfig = { ...(rowToToolGuards(row) ?? {}) };
  if (patch.rateLimitPerMin !== undefined) merged.rateLimitPerMin = patch.rateLimitPerMin ?? undefined;
  if (patch.timeoutMs !== undefined) merged.timeoutMs = patch.timeoutMs ?? undefined;
  return merged;
}

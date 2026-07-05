import { getDb } from "../db/connection.js";

/**
 * Shared per-(client,tool) — and per-client — config-table primitives.
 *
 * Extracted from what used to be byte-identical copies of two idioms spread
 * across tool-policies/{guardrails,quarantine,coalesce,response-cache,
 * context-budget,pagination,canary,load-balancer}.ts and
 * proxy/{streaming,transform,backends}.ts:
 *
 *   1. Every per-tool config setter gates the write on "does this tool exist
 *      for this client", via the exact same
 *      `SELECT 1 FROM tools WHERE client_name = ? AND name = ?` guard —
 *      {@link toolExists} is that guard. Canary and load-balancer are
 *      per-CLIENT (not per-tool) config, so they check client existence
 *      instead and do not use this helper.
 *   2. Every config write is an `INSERT ... ON CONFLICT(...) DO UPDATE SET`
 *      upsert against a table shaped like
 *      `(<key columns...>, <value columns...>, updated_at)` — {@link
 *      upsertConfig} is that upsert, parameterized by table name, key
 *      columns (the ON CONFLICT target — `[client_name, tool_name]` for
 *      per-tool tables, `[client_name]` for canary/load-balancer's
 *      per-client tables), and value columns.
 *
 * `updatedAt` is always supplied by the caller (most sites use `Date.now()`;
 * quarantine.ts uses its injectable `nowFn()` for deterministic cooldown
 * tests) rather than this helper reaching for a clock itself, so every
 * call site's existing clock-injection behavior is preserved unchanged.
 *
 * Table and column names passed to {@link upsertConfig} are always static
 * identifiers hardcoded by the caller — never derived from request input —
 * so interpolating them into the SQL text carries no injection risk; only
 * the bound `?` parameters ever carry caller-supplied values.
 */

/** A single bindable SQLite column value (excludes bun:sqlite's Buffer/Record binding forms, which no config table needs). */
export type ConfigColumnValue = string | number | bigint | boolean | null;

/**
 * True when `toolName` is a currently-registered tool of `clientName`. The
 * shared existence guard behind every per-tool config write — callers keep
 * their own site-specific response on a miss (`return false`, `return
 * { ok: false, error: "TOOL_NOT_FOUND" }`, etc.), only the check itself is shared.
 */
export function toolExists(clientName: string, toolName: string): boolean {
  return !!getDb().query(`SELECT 1 FROM tools WHERE client_name = ? AND name = ?`).get(clientName, toolName);
}

/**
 * Generic `INSERT ... ON CONFLICT DO UPDATE` upsert for the per-(client,tool)
 * or per-client config tables. `keyColumns` becomes the `ON CONFLICT` target
 * (bound first, in the order given); `valueColumns` is the config payload
 * (bound next, in the order given); `updatedAt` is always the trailing
 * column on both the insert list and the `DO UPDATE SET` clause, matching
 * every existing config table's trailing `updated_at` column.
 */
export function upsertConfig(
  table: string,
  keyColumns: Record<string, ConfigColumnValue>,
  valueColumns: Record<string, ConfigColumnValue>,
  updatedAt: number,
): void {
  const keys = Object.entries(keyColumns);
  const values = Object.entries(valueColumns);
  const updatedAtEntry: [string, ConfigColumnValue] = ["updated_at", updatedAt];
  const allColumns = [...keys, ...values, updatedAtEntry];

  const columnList = allColumns.map(([name]) => name).join(", ");
  const placeholders = allColumns.map(() => "?").join(", ");
  const conflictColumns = keys.map(([name]) => name).join(", ");
  const updateSet = [...values, updatedAtEntry].map(([name]) => `${name} = excluded.${name}`).join(",\n       ");

  getDb()
    .query(
      `INSERT INTO ${table} (${columnList})
       VALUES (${placeholders})
       ON CONFLICT(${conflictColumns}) DO UPDATE SET
       ${updateSet}`,
    )
    .run(...allColumns.map(([, value]) => value));
}

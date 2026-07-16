/**
 * Shared keyset-pagination idiom factored out of three independently-converged
 * implementations:
 *   - observability/trace-store.ts's listTraces (GROUP BY trace_id, keyed on
 *     MAX(id) per group)
 *   - observability/traffic.ts's listTraffic (keyed on id)
 *   - admin/audit/audit.ts's listAuditLog (keyed on id)
 *
 * All three: clamp an operator-supplied `limit` into a safe range, fetch one
 * extra row beyond that limit so "is there a next page" is known without a
 * second (COUNT) query, slice back down to `limit`, and — only when that
 * extra row was present — stringify the last returned row's key as
 * `nextCursor`. Callers pass `cursor` back as `WHERE id < ?` (or, for grouped
 * queries, `HAVING MAX(id) < ?`) to walk further back in a later request.
 *
 * This module only owns the "fetch limit+1 / slice / derive nextCursor"
 * mechanics and the limit-clamp arithmetic — building the SQL (including the
 * cursor's own WHERE/HAVING condition) stays with each call site, since the
 * filterable columns and grouping differ per table.
 */
import type { Database } from "bun:sqlite";

export interface KeysetPage<Item> {
  items: Item[];
  nextCursor?: string;
}

/**
 * `Math.min(Math.max(value ?? defaultValue, 1), max)` — the clamp every caller
 * reimplemented for its own `limit`/`maxRows`. `value` is also guarded with
 * `Number.isFinite`: `??` only falls back on null/undefined, so a NaN (e.g.
 * from `Number("abc")` on a malformed `?limit=` query param) would otherwise
 * pass straight through and later get bound as a `LIMIT ?` param to
 * bun:sqlite, which throws a raw 'datatype mismatch' instead of clamping.
 */
export function clampLimit(value: number | undefined, defaultValue: number, max: number): number {
  const n = Number.isFinite(value) ? (value as number) : defaultValue;
  return Math.min(Math.max(n, 1), max);
}

/**
 * Runs `sql` (a complete query up to but not including `LIMIT`, with its
 * params already bound to `params` in order) fetching `limit + 1` rows, then
 * maps and pages the result: `mapRow` converts each raw row to the public
 * item shape, and `cursorOf` extracts the keyset column (e.g. `id` or
 * `last_id`) from a raw row so it can be stringified into `nextCursor`.
 */
export function keysetPaginate<Row, Item>(
  db: Database,
  sql: string,
  params: (string | number)[],
  limit: number,
  mapRow: (row: Row) => Item,
  cursorOf: (row: Row) => string | number,
): KeysetPage<Item> {
  const rows = db.query(`${sql} LIMIT ?`).all(...params, limit + 1) as Row[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map(mapRow),
    nextCursor: hasMore ? String(cursorOf(page[page.length - 1])) : undefined,
  };
}

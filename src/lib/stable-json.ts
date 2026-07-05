/**
 * Deterministic JSON serialization — object keys sorted lexicographically at
 * every level, arrays left in their original element order. Extracted from
 * three byte-identical/near-identical inline implementations:
 *   - `admin/entities/approvals.ts`'s `stableStringify` (hashed to bind an
 *     approval ticket to its exact call args — `approvalArgsHash`)
 *   - `observability/monitor.ts`'s `stableStringify` (hashed to detect
 *     inputSchema drift — `schemaHash`)
 *   - `admin/config/config-diff.ts`'s `canonicalize` (order-insensitive
 *     structural config diffing — a value-level cousin of the same idea,
 *     with one extra domain rule layered on: arrays whose elements all carry
 *     a `name` are also sorted by it, via `arrayTransform` below)
 *
 * Security note: `approvalArgsHash` hashes `stableStringify`'s output, and
 * that hash is persisted (`approvals.args_hash`) to validate a ticket at
 * consume-time. Do not change this algorithm (key ordering, separators, or
 * how `undefined`/`null` are rendered) without accounting for already-stored
 * hashes silently ceasing to match — verify with a before/after digest of a
 * representative object first.
 */

/** Same algorithm as `stableStringify`, but returns the value itself instead
 * of a JSON string — object keys sorted deeply, arrays recursed into and
 * left in place. An optional `arrayTransform` runs bottom-up on every
 * (already-canonicalized) array node, letting a caller layer in its own
 * ordering rule for arrays without forking the traversal. */
export function canonicalizeValue(value: unknown, arrayTransform?: (arr: unknown[]) => unknown[]): unknown {
  if (Array.isArray(value)) {
    const arr = value.map((x) => canonicalizeValue(x, arrayTransform));
    return arrayTransform ? arrayTransform(arr) : arr;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = canonicalizeValue(obj[k], arrayTransform);
    return out;
  }
  return value;
}

/**
 * Deterministic JSON string for a value: object keys sorted lexicographically
 * at every level, arrays serialized in their original order. `undefined`
 * (bare, or as an object property's value) renders as `null` rather than
 * being dropped, unlike `JSON.stringify` — preserved intentionally so this
 * stays a drop-in replacement for the pre-existing call sites (see file
 * header). Do not reimplement this in terms of `canonicalizeValue` +
 * `JSON.stringify`: that would drop `undefined`-valued keys instead of
 * rendering them, changing the output.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/** Alias for call sites that talk about "canonicalizing" a value rather than "stringifying" it. */
export const canonicalStringify = stableStringify;

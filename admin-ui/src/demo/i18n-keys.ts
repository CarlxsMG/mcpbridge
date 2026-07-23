// ─────────────────────────────────────────────────────────────────────────────
// Centralized i18n key constants for the demo fixture layer.
//
// Why a separate module (not literals scattered across fixtures): keys live in
// en.json/es.json under `demo.fixtures.*` and need to stay in sync between the
// fixture data and the locale files. Lifting them here gives us a single
// compilation unit to grep / lint against and makes the namespace pattern
// auditable in one place.
//
// Conventions:
//   - Namespace: `demo.fixtures.{domain}.{entityId}.{field}` where:
//     - {domain} = the fixture file name (tools, bundles, catalog, ...)
//     - {entityId} = the entity's identifier (tool name, client name, ...)
//     - {field} = description | name | label | detail.{name|label}
//   - When an entity's identifier itself is a localized string (e.g. team name
//     "Platform"), namespace as `demo.fixtures.{domain}.by_id.{value}.name` so
//     the key encodes both the entity type AND the original EN value, keeping
//     a stable lookup table even when two EN values share a translation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the canonical key for a demo fixture translation.
 *
 * The whole project funnels through this single function so the namespace
 * pattern stays uniform — no string literals scattered across the fixture
 * files. Keys are composed at module load from the fixture's stable
 * identifiers (client name, tool name, bundle name, ...) which never
 * change, so the lookup is purely declarative.
 *
 * Important: vue-i18n treats `.` as the nested-object-path separator inside
 * `t()`. The `entityId` for tools is `<client>.<toolName>` (e.g.
 * `github.search_issues`) which would normally confuse the lookup
 * (`t("...github.search_issues.description")` would resolve into a
 * `search_issues` nested key, not a literal entity name). To dodge that
 * without forcing every fixture caller to manually escape dots, the helper
 * internally swaps any `.` in `entityId` for `__` before composing the key.
 * The JSON files therefore live under e.g. `tools.github__search_issues`.
 */
export function demoKey(domain: string, entityId: string | number, field: string): string {
  const safeId = String(entityId).replace(/\./g, "__");
  return `demo.fixtures.${domain}.${safeId}.${field}`;
}

/**
 * Variant for entities whose identifier is itself a localized string (team
 * names, API key labels, ...). The original EN value goes in the path so the
 * lookup is stable across locales even when translations collide.
 *
 * Free-form values often contain spaces, parens, or hyphens — vue-i18n's
 * dot-walking syntax would split these on `.` and walk into a `Claude`
 * sub-key that doesn't exist. The helper therefore emits vue-i18n's
 * bracket notation (`['Claude Desktop']`) for any value with characters
 * outside `[A-Za-z0-9_]`, which vue-i18n v9+ supports as a literal
 * sub-key access regardless of the embedded spaces or punctuation.
 *
 * Syntax note: vue-i18n's bracket notation attaches to the preceding
 * path segment with NO dot — i.e. `by_value['Claude Desktop']`, NOT
 * `by_value.['Claude Desktop']`. The helper therefore emits
 * `${prefix}${bracket}` (no separating dot) for the bracket case.
 */
export function demoKeyByValue(domain: string, value: string, field: string): string {
  const br = bracket(value);
  const sep = br.startsWith("[") ? "" : ".";
  return `demo.fixtures.${domain}.by_value${sep}${br}.${field}`;
}

/**
 * Variant for nested fields (e.g. audit-log `detail.label`). Encodes the
 * outer record's id + the inner field name so audit entries with similar
 * labels don't collide.
 */
export function demoDetailKey(domain: string, recordId: number | string, detailField: string, field: string): string {
  const safeId = String(recordId).replace(/\./g, "__");
  return `demo.fixtures.${domain}.${safeId}.detail.${detailField}.${field}`;
}

/**
 * Wrap a free-form value in vue-i18n bracket notation when it contains any
 * character vue-i18n's dot-walker would misread (spaces, parens, hyphens,
 * anything outside the safe `[A-Za-z0-9_]` set). Always wrapping — even for
 * already-safe values — would also work but bloats every key by 8 chars, so
 * we only pay the bracket cost when we have to.
 */
function bracket(value: string): string {
  if (/^[A-Za-z0-9_]+$/.test(value)) return value;
  // Backslashes must be escaped BEFORE quotes, or the backslash this adds in
  // front of a quote gets re-escaped and the quote escapes itself away. Escaping
  // only quotes (the previous behaviour) also left a literal backslash in the
  // value free to start an escape sequence of its own in the emitted source.
  return `['${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`;
}

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
 */
export function demoKey(domain: string, entityId: string | number, field: string): string {
  return `demo.fixtures.${domain}.${entityId}.${field}`;
}

/**
 * Variant for entities whose identifier is itself a localized string (team
 * names, API key labels, ...). The original EN value goes in the path so the
 * lookup is stable across locales even when translations collide.
 */
export function demoKeyByValue(domain: string, value: string, field: string): string {
  return `demo.fixtures.${domain}.by_value.${value}.${field}`;
}

/**
 * Variant for nested fields (e.g. audit-log `detail.label`). Encodes the
 * outer record's id + the inner field name so audit entries with similar
 * labels don't collide.
 */
export function demoDetailKey(domain: string, recordId: number | string, detailField: string, field: string): string {
  return `demo.fixtures.${domain}.${recordId}.detail.${detailField}.${field}`;
}

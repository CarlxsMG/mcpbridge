// ─────────────────────────────────────────────────────────────────────────────
// Demo response localizer: walks the JSON tree returned by `demoFetch()` and
// resolves any `*Key` field into its corresponding text field using the active
// vue-i18n locale.
//
// Why a middleware walker (instead of letting pages resolve keys themselves):
// the demo's whole point is to be a drop-in replacement for the real backend.
// Pages already read `tool.description`, `bundle.name`, `key.label`, etc. —
// adding per-page resolvers would force every consumer to know about i18n
// keys, which would also leak demo-specific concerns into production code.
// A single walker preserves the "demo is invisible to consumers" contract.
//
// Activation model:
//   - demo.ts calls `localize(value)` once on every response, before returning
//     it to the caller. Localize is reactive: it reads `i18n.global.locale`
//     at call time (NOT at module load), so a user switching the locale via
//     AccountPage and triggering a refetch gets the new locale automatically.
//
// Field map:
//   - `descriptionKey` → `description` (and any other `*Key` siblings that
//     shadow a plain text field by stripping the `Key` suffix).
//   - For audit-log entries, the inner `detail` object also has `label` and
//     `name` fields that the fixture marks with nested keys via the
//     `detail_<field>_Key` convention below.
// ─────────────────────────────────────────────────────────────────────────────
import { i18n } from "@/i18n";

/** Strip the trailing `Key` suffix from a field name to find its text twin. */
function keyToField(keyField: string): string | null {
  if (!keyField.endsWith("Key")) return null;
  return keyField.slice(0, -3);
}

/**
 * Resolve a single i18n key against the active locale. Returns `undefined`
 * when the key doesn't exist in the current locale AND no fallback is
 * available — callers should keep the original text field in that case so
 * the demo degrades gracefully to EN even before translations land.
 */
function resolveKey(key: string): string | undefined {
  const t = (i18n.global as unknown as { t: (k: string) => string }).t;
  const translated = t(key);
  // vue-i18n returns the key itself when missing (with silentTranslationWarn
  // suppressing the console noise). Treat that as "no translation" so we
  // fall through to the EN text the fixture ships as a fallback.
  return translated !== key ? translated : undefined;
}

/**
 * Recursively walks `value`, mutating it in place to swap any `*Key` field
 * with the resolved text when a translation exists in the active locale.
 *
 * Returns the (possibly mutated) value for ergonomic chaining. Safe to call
 * on primitives (returns as-is) and on the empty/null cases the demo router
 * emits (returns as-is, since there's nothing to walk).
 *
 * The walker is intentionally narrow:
 *   - It only touches objects/arrays. Strings/numbers/booleans/null pass
 *     through unchanged.
 *   - It handles `detail_*Key` (audit-log detail) by rewriting the inner
 *     `detail.<field>` instead of the outer object — see `audit-log.ts`
 *     for the exact convention used to encode the keys.
 *   - It does NOT descend into items that already look resolved (no `*Key`
 *     child fields left, no array of items to recurse into). That's an
 *     optimization, not a correctness guarantee — the recursion would be
 *     safe to keep going, but the demo fixtures only need one level deep.
 */
export function localize<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = localize(value[i]);
    return value;
  }
  if (typeof value !== "object") return value;

  const obj = value as Record<string, unknown>;

  // Audit-log detail rewrite: `{ detail_labelKey, detail_nameKey, detail }`
  // pattern. When we see a `<field>Key` and the matching inner detail field
  // exists, replace the detail field. Otherwise leave it for the generic
  // pass below (which will swap the outer sibling when present).
  for (const k of Object.keys(obj)) {
    if (k.startsWith("detail_") && k.endsWith("Key")) {
      const detailField = k.slice("detail_".length, -"Key".length);
      const detail = obj["detail"];
      if (detail && typeof detail === "object" && typeof obj[k] === "string") {
        const translated = resolveKey(obj[k] as string);
        if (translated !== undefined) {
          (detail as Record<string, unknown>)[detailField] = translated;
        }
      }
      // Audit-log keys live on the outer object but only mutate `detail`,
      // so we don't strip them from the response — pages don't read them
      // and the walker never touches them again.
    }
  }

  // Generic pass: for each `*Key` field, swap with `t(<key>)` when present.
  // We iterate a snapshot of the keys because we mutate the object's field
  // names (delete + set) inside the loop.
  for (const k of Object.keys(obj)) {
    if (k.startsWith("detail_") && k.endsWith("Key")) continue; // handled above
    const field = keyToField(k);
    if (!field) continue;
    if (typeof obj[k] !== "string") continue;
    const translated = resolveKey(obj[k] as string);
    if (translated === undefined) continue;
    obj[field] = translated;
    delete obj[k];
  }

  // Recurse into known nested shapes: items arrays (list endpoints), tools
  // arrays (client detail), and nested objects on a case-by-case basis.
  // Cheap and safe — the walker short-circuits on primitives — but bounded
  // to keep the demo hot path tight.
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === "object") localize(v);
  }

  return value;
}

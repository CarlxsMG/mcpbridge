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
// Immutability:
//   - The walker returns a NEW tree — it never mutates the input. The demo
//     fixtures are module-level singletons that pages hold references to via
//     `flatTools`, `clients`, etc.; mutating them in place would corrupt
//     the source data on the first ES fetch and the next EN fetch would
//     return stale ES text. The copy cost is negligible (demo data is
//     small) and keeps the fixtures pristine across locale flips.
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
  // vue-i18n v10's `i18n.global.t` reads the current locale + messages
  // bundle on every call. We deliberately re-read it here (instead of
  // capturing at module load) so test-only `setLocaleMessage` calls and
  // runtime locale flips both pick up the new state without needing to
  // re-import this module.
  const translated = (i18n.global as unknown as { t: (k: string) => string }).t(key);
  // vue-i18n returns the key itself when missing (with silentTranslationWarn
  // suppressing the console noise). Treat that as "no translation" so we
  // fall through to the EN text the fixture ships as a fallback.
  return translated !== key ? translated : undefined;
}

/**
 * Recursively walks `value` and returns a new tree with any `*Key` field
 * swapped into the matching text field when a translation exists in the
 * active locale.
 *
 * The output shares no references with the input: arrays and objects are
 * rebuilt; primitives and untouched objects are returned as-is (so the
 * recursion bottoms out cheaply when there are no keys to resolve).
 *
 * Field-order pitfall: fixtures carry BOTH `description` (EN fallback) AND
 * `descriptionKey` (i18n key) on the same record. A naive walk in
 * insertion order would emit the translated value first, then overwrite
 * it with the plain field. The walker therefore scans the input twice:
 *   1. Collect every successfully-resolved *Key field name.
 *   2. Build the output, dropping both the *Key fields AND the plain
 *      text fields they shadow.
 */
export function localize<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => localize(item)) as unknown as T;
  }

  const input = value as Record<string, unknown>;

  // Pass 1: figure out which *Key fields resolve AND what plain text
  // field each one shadows. The plain-field name lets us skip it in
  // pass 2 so the translation isn't clobbered by the EN fallback.
  const resolvedTextFields = new Set<string>();
  const resolvedDetailFields = new Map<string, string>(); // detailField → translation
  for (const k of Object.keys(input)) {
    const v = input[k];
    if (typeof v !== "string") continue;

    if (k.startsWith("detail_") && k.endsWith("Key")) {
      const detailField = k.slice("detail_".length, -"Key".length);
      const translated = resolveKey(v);
      if (translated !== undefined) resolvedDetailFields.set(detailField, translated);
      continue;
    }

    const field = keyToField(k);
    if (field) {
      const translated = resolveKey(v);
      if (translated !== undefined) resolvedTextFields.add(field);
    }
  }

  // Pass 2: build the output.
  const output: Record<string, unknown> = {};
  for (const k of Object.keys(input)) {
    const v = input[k];

    // Skip *Key fields entirely — their translation already lives in
    // the matching plain field (or was dropped if it didn't resolve).
    if (k.startsWith("detail_") && k.endsWith("Key")) continue;
    const field = keyToField(k);
    if (field && resolvedTextFields.has(field)) {
      // Emit the translation we pre-computed in pass 1. `v` is a string
      // here by construction — the pre-scan only adds a field to
      // `resolvedTextFields` when the *Key sibling's value was a string.
      output[field] = resolveKey(v as string);
      continue;
    }

    // Plain text field that was NOT shadowed by a *Key sibling — keep
    // the literal EN fallback the fixture ships.
    if (resolvedTextFields.has(k)) continue; // belt + suspenders (shouldn't fire)

    // Audit-log detail rewrite: rebuild `detail` with any translated
    // inner fields merged in. Only mutate if at least one detail field
    // resolved; otherwise keep the original detail reference to preserve
    // its identity.
    if (k === "detail" && v && typeof v === "object" && resolvedDetailFields.size > 0) {
      output["detail"] = { ...(v as Record<string, unknown>), ...Object.fromEntries(resolvedDetailFields) };
      continue;
    }

    // Plain copy — recurse into nested objects/arrays so deeply nested
    // *Key fields also get resolved.
    output[k] = v && typeof v === "object" ? localize(v) : v;
  }

  return output as unknown as T;
}

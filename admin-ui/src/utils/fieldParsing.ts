/**
 * Non-reactive form-field parsing helpers (same precedent as
 * utils/connectTemplates.ts — plain functions, no "use" prefix).
 *
 * Consolidates optional-numeric-field parsing that had drifted across pages:
 * PoliciesPage's numOrNull() checked Number.isFinite, ConsumersPage inlined
 * the same check twice, and AlertsPage/WsProxyTargetsPage used to call bare
 * Number(...) with no finite check at all — silently sending NaN to the API
 * on invalid input. Pages should adopt these instead of re-inlining the check.
 */

export interface NumberFieldResult {
  value: number | null;
  error: string | null;
}

export function parseOptionalNumber(
  raw: string,
  errorMessage = "Must be a plain number, or blank.",
): NumberFieldResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null, error: null };
  const n = Number(trimmed);
  return Number.isFinite(n) ? { value: n, error: null } : { value: null, error: errorMessage };
}

export function numberRangeValidator(opts: { integer?: boolean; min?: number; max?: number; message: string }) {
  return (raw: string): string | null => {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    const isValidNumber = opts.integer ? Number.isInteger(n) : Number.isFinite(n);
    if (!isValidNumber) return opts.message;
    if (opts.min !== undefined && n < opts.min) return opts.message;
    if (opts.max !== undefined && n > opts.max) return opts.message;
    return null;
  };
}

/** Splits a delimited free-text field into trimmed, non-empty items (comma by default). */
export function parseList(raw: string, delimiter: string | RegExp = ","): string[] {
  return raw
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

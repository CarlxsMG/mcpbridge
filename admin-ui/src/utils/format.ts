/** Locale-formatted date/time string for a value the backend sent as an ISO string, epoch ms, or Date. */
export function formatDateTime(value: string | number | Date): string {
  return new Date(value).toLocaleString();
}

/** Same as formatDateTime, but tolerant of the "not set yet" null/undefined case (e.g. lastLoginAt). */
export function formatMaybeDate(value: string | number | Date | null | undefined, fallback = "Never"): string {
  if (value === null || value === undefined) return fallback;
  return formatDateTime(value);
}

/** Matches TracesPage.vue's fmtDuration: sub-second as whole ms, otherwise seconds to 2 decimal places. */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

/** Matches UsagePage.vue's pct: fraction (0..1) to a percentage string with 1 decimal place. */
export function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Pretty-printed JSON for read-only display (config previews, playground output, etc). */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

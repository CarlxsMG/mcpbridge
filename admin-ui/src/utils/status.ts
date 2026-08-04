export type StatusTone = "good" | "warn" | "bad" | "neutral";

/**
 * Canonical status -> tone mapping, reconciled across every place that
 * independently encoded a version of this (StatusBadge.vue, MonitorsPage.vue,
 * KeysPage.vue, OverviewPage.vue, ApprovalsPage.vue). StatusBadge.vue is the
 * shared component and wins where sources disagree on a shade (see status.test.ts
 * / commit message for the one case that came up: "disabled", where
 * MonitorsPage used a border color distinct from its "never" neutral and
 * KeysPage used the same neutral as StatusBadge's default — both are treated
 * as "neutral" here since neither is good/warn/bad).
 *
 * Unrecognized or missing status falls back to "neutral", matching
 * StatusBadge's own fallback for unknown status strings.
 */
const TONE_MAP: Record<string, StatusTone> = {
  // StatusBadge.vue (shared component, most authoritative)
  healthy: "good",
  closed: "good",
  degraded: "warn",
  half_open: "warn",
  unreachable: "bad",
  open: "bad",
  // KeysPage.vue
  active: "good",
  revoked: "bad",
  expired: "bad",
  disabled: "neutral",
  // MonitorsPage.vue
  drift: "warn",
  failing: "bad",
  never: "neutral",
  // ApprovalsPage.vue
  pending: "warn",
  approved: "good",
  rejected: "bad",
};

/** Maps a raw backend/UI status string to one of the four canonical tones. */
export function statusTone(status: string | null | undefined): StatusTone {
  if (!status) return "neutral";
  return TONE_MAP[status.toLowerCase()] ?? "neutral";
}

/**
 * Name (not value) of the style.css custom property backing a given tone, for
 * NON-TEXT use: a chart series, a status dot, a swatch. Those only need 3:1.
 *
 * For text, use `toneTextVar` — see the -text token block in style.css.
 */
export function toneColorVar(tone: StatusTone): string {
  switch (tone) {
    case "good":
      return "--ok";
    case "warn":
      return "--canary";
    case "bad":
      return "--breach";
    case "neutral":
      return "--text-secondary";
  }
}

/**
 * Same mapping, but the text-safe half of each pair — for a tone rendered as
 * words rather than as a dot or a chart segment.
 *
 * Kept separate from `toneColorVar` rather than folded into it because the two
 * live callers genuinely differ: ApprovalsPage paints status LABELS, while
 * MonitorsPage feeds the same tone to a chart series and a status dot, which are
 * non-text and would only be needlessly darkened. Reusing the non-text variant for
 * the labels put "Pending" at 3.00:1 against the page.
 */
export function toneTextVar(tone: StatusTone): string {
  switch (tone) {
    case "good":
      return "--ok-text";
    case "warn":
      return "--canary-text";
    case "bad":
      return "--breach-text";
    case "neutral":
      return "--text-secondary";
  }
}

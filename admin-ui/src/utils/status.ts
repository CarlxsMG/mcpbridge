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

/** Name (not value) of the style.css custom property backing a given tone. */
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

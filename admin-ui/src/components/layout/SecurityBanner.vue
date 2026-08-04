<script setup lang="ts">
// Instance-wide security warning, shown at the top of every page inside the
// shell.
//
// The gateway has always known when it is running with a boundary open — the
// startup guards compute it and src/index.ts logs it — but a warning on stdout
// reaches nobody once a container is up. This is that same information, in the
// one place the operator actually looks.
//
// Three deliberate choices:
//   - Critical findings CANNOT be dismissed. "Every backend tool is callable
//     without credentials" is not a notification, and a dismissed one is the
//     failure mode this component exists to prevent.
//   - `info` findings never raise the banner at all. They are capability
//     limits, not exposure, and a permanent grey bar on every page is how
//     people learn to stop reading banners.
//   - Dismissal of a warning is keyed by the finding ids, so a NEW warning
//     re-opens a banner that was dismissed for a different one.
//
// A non-admin gets a 403 here (the endpoint requires the admin role) and the
// banner simply stays hidden — the failure is swallowed on purpose, since
// nothing about it is actionable by that user.
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ShieldAlert, ChevronDown, ChevronUp, X } from "lucide-vue-next";
import { api } from "@/composables/useApi";
import type { PostureFinding, SecurityPosture } from "@/types/api";

const { t, te } = useI18n({ useScope: "global" });

const DISMISSED_KEY = "mcpbridge.security.dismissed";

const posture = ref<SecurityPosture | null>(null);
const expanded = ref(false);
const dismissedFor = ref<string>(localStorage.getItem(DISMISSED_KEY) ?? "");

onMounted(async () => {
  try {
    posture.value = await api.get<SecurityPosture>("/admin-api/security-posture");
  } catch {
    // 403 for a non-admin, or an older server without the endpoint. Either way
    // there is nothing to show and nothing this user could do about it.
  }
});

/** Findings worth a banner: exposure, not capability limits. */
const raised = computed<PostureFinding[]>(() =>
  (posture.value?.findings ?? []).filter((f) => f.severity === "critical" || f.severity === "warning"),
);

const hasCritical = computed(() => raised.value.some((f) => f.severity === "critical"));

/** Identity of the current warning set — dismissing pins this exact list, nothing broader. */
const signature = computed(() =>
  raised.value
    .map((f) => f.id)
    .sort()
    .join(","),
);

const visible = computed(
  () => raised.value.length > 0 && (hasCritical.value || dismissedFor.value !== signature.value),
);

function dismiss(): void {
  dismissedFor.value = signature.value;
  localStorage.setItem(DISMISSED_KEY, signature.value);
}

/**
 * Localized explanation for a finding, falling back to the backend's English
 * `summary` for an id this UI has no copy for yet (a newer server than this
 * bundle). Same contract as the API error codes.
 */
function label(finding: PostureFinding): string {
  // The key is spelled inline (twice) rather than hoisted into a local:
  // scripts/check-i18n.mjs discovers dynamic keys by scanning for a
  // `t(`...`)` template literal, and one it cannot see is reported as an
  // orphan in both bundles.
  return te(`components.security_banner.checks.${finding.id}`)
    ? t(`components.security_banner.checks.${finding.id}`)
    : finding.summary;
}

/** Why a normally-refused condition is running — worth saying, since the answers differ a lot in seriousness. */
function toleratedNote(finding: PostureFinding): string | null {
  if (finding.tolerated === null) return null;
  return t(`components.security_banner.tolerated.${finding.tolerated}`);
}
</script>

<template>
  <div v-if="visible" class="security-banner" :class="hasCritical ? 'is-critical' : 'is-warning'" role="alert">
    <div class="banner-head">
      <ShieldAlert :size="18" stroke-width="2" aria-hidden="true" class="banner-icon" />
      <!-- No count in the headline on purpose: "3 issues" invites triage, and
           the first critical one already means the gateway is open. The number
           is visible in the expanded list, where it is actionable. -->
      <p class="banner-summary">
        {{
          hasCritical ? t("components.security_banner.title_critical") : t("components.security_banner.title_warning")
        }}
      </p>
      <button type="button" class="banner-btn" :aria-expanded="expanded" @click="expanded = !expanded">
        <component :is="expanded ? ChevronUp : ChevronDown" :size="14" stroke-width="2" aria-hidden="true" />
        {{ expanded ? t("components.security_banner.hide") : t("components.security_banner.show") }}
      </button>
      <button
        v-if="!hasCritical"
        type="button"
        class="banner-btn banner-dismiss"
        :aria-label="t('components.security_banner.dismiss')"
        @click="dismiss"
      >
        <X :size="14" stroke-width="2" aria-hidden="true" />
      </button>
    </div>

    <ul v-if="expanded" class="banner-list">
      <li v-for="finding in raised" :key="finding.id">
        <span class="finding-severity" :class="`sev-${finding.severity}`">
          {{ t(`components.security_banner.severity.${finding.severity}`) }}
        </span>
        <!-- The remediation is a SIBLING of the sentence, not nested inside it.
             Vue's template compiler condenses the whitespace-only text node
             between two elements on separate lines, so an inline <code> right
             after the <em> produced "…NODE_ENV=developmentServe over HTTPS…" in
             the DOM — separated only by a CSS margin, and read out as one word
             by a screen reader. Separate elements with their own gap can't
             re-acquire that bug. The tolerated note is parenthesized for the
             same reason: it is an aside, not part of the sentence. -->
        <span class="finding-text">
          {{ label(finding) }}
          <em v-if="toleratedNote(finding)" class="finding-tolerated">({{ toleratedNote(finding) }})</em>
        </span>
        <code class="finding-fix">{{ finding.remediation }}</code>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.security-banner {
  border: 1px solid;
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  margin-bottom: var(--space-5);
}
.is-critical {
  border-color: var(--breach);
  background: var(--breach-soft);
}
.is-warning {
  border-color: var(--canary);
  background: var(--canary-soft);
}
.banner-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.banner-icon {
  flex-shrink: 0;
}
.is-critical .banner-icon {
  color: var(--breach);
}
.is-warning .banner-icon {
  color: var(--canary);
}
.banner-summary {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: var(--text-base);
  color: var(--text-primary);
}
.banner-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
  background: none;
  border: none;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--text-secondary);
}
.banner-btn:hover {
  color: var(--text-primary);
  background: var(--surface-sunken);
}
.banner-dismiss {
  padding: var(--space-1);
}
.banner-list {
  list-style: none;
  margin: var(--space-3) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.banner-list li {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--space-2);
  font-size: var(--text-sm);
}
.finding-severity {
  flex-shrink: 0;
  font-size: var(--text-xs);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.sev-critical {
  color: var(--breach);
}
.sev-warning {
  color: var(--canary);
}
.finding-text {
  color: var(--text-primary);
  min-width: 0;
}
.finding-tolerated {
  color: var(--text-secondary);
  font-style: italic;
}
.finding-fix {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  background: var(--surface-sunken);
  border-radius: var(--radius-sm);
  padding: 0.1rem 0.4rem;
  color: var(--text-secondary);
}

@media (max-width: 768px) {
  .banner-list li {
    flex-direction: column;
    gap: var(--space-1);
  }
}
</style>

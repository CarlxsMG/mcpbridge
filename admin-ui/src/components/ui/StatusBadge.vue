<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { CheckCircle2, AlertTriangle, XCircle, Circle } from "lucide-vue-next";

const props = defineProps<{
  status: string | null;
}>();

const { t } = useI18n({ useScope: "global" });

// Status enum -> display metadata. The `labelKey` strings look up under
// `badges.status_*` so languages with different conventions (e.g. gendered
// past participles in Spanish) can override per-status without rewriting the
// caller that picked the status.
const STATUS_META: Record<string, { labelKey: string; icon: typeof Circle; className: string }> = {
  healthy: { labelKey: "badges.status_healthy", icon: CheckCircle2, className: "badge-good" },
  closed: { labelKey: "badges.status_closed", icon: CheckCircle2, className: "badge-good" },
  degraded: { labelKey: "badges.status_degraded", icon: AlertTriangle, className: "badge-warn" },
  half_open: { labelKey: "badges.status_half_open", icon: AlertTriangle, className: "badge-warn" },
  unreachable: { labelKey: "badges.status_unreachable", icon: XCircle, className: "badge-bad" },
  open: { labelKey: "badges.status_open", icon: XCircle, className: "badge-bad" },
  active: { labelKey: "badges.status_active", icon: CheckCircle2, className: "badge-good" },
  revoked: { labelKey: "badges.status_revoked", icon: XCircle, className: "badge-bad" },
  expired: { labelKey: "badges.status_expired", icon: AlertTriangle, className: "badge-warn" },
  disabled: { labelKey: "badges.status_disabled", icon: Circle, className: "badge-neutral" },
};

const display = computed(() => {
  if (!props.status) return { label: t("badges.not_live"), icon: Circle, className: "badge-neutral" };
  const meta = STATUS_META[props.status];
  if (!meta) return { label: props.status, icon: Circle, className: "badge-neutral" };
  return { label: t(meta.labelKey), icon: meta.icon, className: meta.className };
});
</script>

<template>
  <span class="badge" :class="display.className">
    <component :is="display.icon" :size="13" stroke-width="2.25" aria-hidden="true" />
    {{ display.label }}
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
  padding: 0.2em 0.65em;
  border-radius: var(--radius-pill);
  font-size: var(--text-sm);
  font-weight: 600;
  white-space: nowrap;
}
.badge-good {
  background: var(--ok-soft);
  color: var(--ok);
}
.badge-warn {
  background: var(--canary-soft);
  color: var(--canary);
}
.badge-bad {
  background: var(--breach-soft);
  color: var(--breach);
}
.badge-neutral {
  background: var(--surface-sunken);
  color: var(--text-secondary);
}
</style>

<script setup lang="ts">
import { computed } from "vue";
import { CheckCircle2, AlertTriangle, XCircle, Circle } from "lucide-vue-next";

const props = defineProps<{
  status: string | null;
}>();

const displayMap: Record<string, { label: string; icon: typeof Circle; className: string }> = {
  healthy: { label: "Healthy", icon: CheckCircle2, className: "badge-good" },
  closed: { label: "Closed", icon: CheckCircle2, className: "badge-good" },
  degraded: { label: "Degraded", icon: AlertTriangle, className: "badge-warn" },
  half_open: { label: "Half-open", icon: AlertTriangle, className: "badge-warn" },
  unreachable: { label: "Unreachable", icon: XCircle, className: "badge-bad" },
  open: { label: "Open", icon: XCircle, className: "badge-bad" },
  active: { label: "Active", icon: CheckCircle2, className: "badge-good" },
  revoked: { label: "Revoked", icon: XCircle, className: "badge-bad" },
  expired: { label: "Expired", icon: AlertTriangle, className: "badge-warn" },
  disabled: { label: "Disabled", icon: Circle, className: "badge-neutral" },
};

const display = computed(() => {
  if (!props.status) return { label: "Not live", icon: Circle, className: "badge-neutral" };
  return displayMap[props.status] ?? { label: props.status, icon: Circle, className: "badge-neutral" };
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

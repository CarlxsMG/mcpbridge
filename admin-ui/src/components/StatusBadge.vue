<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  status: string | null;
}>();

const displayMap: Record<string, { label: string; icon: string; className: string }> = {
  healthy: { label: "Healthy", icon: "●", className: "badge-good" },
  closed: { label: "Closed", icon: "●", className: "badge-good" },
  degraded: { label: "Degraded", icon: "▲", className: "badge-warn" },
  half_open: { label: "Half-open", icon: "▲", className: "badge-warn" },
  unreachable: { label: "Unreachable", icon: "✕", className: "badge-bad" },
  open: { label: "Open", icon: "✕", className: "badge-bad" },
};

const display = computed(() => {
  if (!props.status) return { label: "Not live", icon: "○", className: "badge-neutral" };
  return displayMap[props.status] ?? { label: props.status, icon: "?", className: "badge-neutral" };
});
</script>

<template>
  <span class="badge" :class="display.className">
    <span aria-hidden="true">{{ display.icon }}</span>
    {{ display.label }}
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
  padding: 0.15em 0.6em;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 600;
  white-space: nowrap;
}
.badge-good {
  background: #e6f6ec;
  color: #146c2e;
}
.badge-warn {
  background: #fff6e0;
  color: #8a5a00;
}
.badge-bad {
  background: #fde8e8;
  color: #a11212;
}
.badge-neutral {
  background: #eceef1;
  color: #52565c;
}
</style>

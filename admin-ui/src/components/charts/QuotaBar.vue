<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  used: number;
  quota: number | null;
}>();

const pct = computed(() => {
  if (props.quota === null || props.quota <= 0) return 1;
  return Math.min(props.used / props.quota, 1);
});

const tone = computed(() => {
  if (props.quota === null) return "unlimited";
  if (props.quota <= 0) return "breach";
  const ratio = props.used / props.quota;
  if (ratio >= 1) return "breach";
  if (ratio >= 0.8) return "canary";
  return "signal";
});

const ariaLabel = computed(() =>
  props.quota === null ? `${props.used} used, unlimited quota` : `${props.used} of ${props.quota} used`,
);
</script>

<template>
  <svg class="quota-bar" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" :aria-label="ariaLabel">
    <rect x="0" y="0" width="100" height="8" rx="4" class="track" />
    <rect v-if="tone === 'unlimited'" x="0.5" y="0.5" width="99" height="7" rx="3.5" class="fill unlimited" />
    <rect v-else x="0" y="0" :width="pct * 100" height="8" rx="4" class="fill" :class="tone" />
  </svg>
</template>

<style scoped>
.quota-bar {
  width: 100%;
  min-width: 3.75rem;
  height: 0.5rem;
  display: block;
}
.track {
  fill: var(--surface-sunken);
}
.fill {
  transition: width 0.4s ease;
}
.fill.signal {
  fill: var(--signal);
}
.fill.canary {
  fill: var(--canary);
}
.fill.breach {
  fill: var(--breach);
}
.fill.unlimited {
  fill: none;
  stroke: var(--border-strong);
  stroke-width: 1;
  stroke-dasharray: 3 2;
  opacity: 0.7;
}
</style>

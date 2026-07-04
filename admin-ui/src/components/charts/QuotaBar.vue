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

// A percentage width, not a viewBox-scaled number: this bar renders anywhere
// from ~90px (a table cell) to 1500px+ wide (an expanded detail panel), and a
// fixed viewBox with preserveAspectRatio="none" stretches x and y by
// different factors at those two extremes. rx/ry inherit that same stretch,
// so the "rounded" end caps come out visibly egg-shaped the wider the bar
// gets. A percentage width has no such coordinate transform to distort.
const fillWidth = computed(() => `${(pct.value * 100).toFixed(2)}%`);

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
  <svg class="quota-bar" role="img" :aria-label="ariaLabel">
    <rect x="0" y="0" width="100%" height="100%" rx="0.25rem" class="track" />
    <rect
      v-if="tone === 'unlimited'"
      x="1"
      y="1"
      width="calc(100% - 2px)"
      height="calc(100% - 2px)"
      rx="calc(0.25rem - 1px)"
      class="fill unlimited"
    />
    <rect v-else x="0" y="0" :width="fillWidth" height="100%" rx="0.25rem" class="fill" :class="tone" />
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

<script setup lang="ts">
import { computed } from "vue";
import ChartLegend from "./ChartLegend.vue";

const props = defineProps<{
  segments: { label: string; value: number; color: string }[];
}>();

const total = computed(() => props.segments.reduce((sum, s) => sum + s.value, 0) || 1);
const withPct = computed(() => props.segments.map((s) => ({ ...s, pct: (s.value / total.value) * 100 })));
</script>

<template>
  <div class="segmented-bar-wrap">
    <div class="segmented-bar" role="img" :aria-label="segments.map((s) => `${s.label}: ${s.value}`).join(', ')">
      <div
        v-for="s in withPct"
        :key="s.label"
        class="segment"
        :style="{ width: s.pct + '%', background: s.color }"
        :title="`${s.label}: ${s.value}`"
      />
    </div>
    <ChartLegend :segments="segments" />
  </div>
</template>

<style scoped>
.segmented-bar-wrap {
  width: 100%;
}
.segmented-bar {
  display: flex;
  width: 100%;
  height: 0.5rem;
  border-radius: var(--radius-pill);
  overflow: hidden;
  background: var(--surface-sunken);
}
.segment {
  height: 100%;
  min-width: 2px;
  transition: width 0.3s ease;
}
/* ChartLegend's own recipe has no gap/margin; this bar's legend wraps below
   the bar with smaller dots than the donut's column legend. */
:deep(.chart-legend) {
  flex-wrap: wrap;
  gap: 0.15rem var(--space-4);
  margin: var(--space-2) 0 0;
}
:deep(.chart-legend li) {
  gap: 0.35em;
}
:deep(.dot) {
  width: 0.55em;
  height: 0.55em;
}
</style>

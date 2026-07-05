<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  segments: { label: string; value: number; color: string }[];
}>();

const total = computed(() => props.segments.reduce((sum, s) => sum + s.value, 0) || 1);
const withPct = computed(() => props.segments.map((s) => ({ ...s, pct: (s.value / total.value) * 100 })));
</script>

<template>
  <ul class="chart-legend">
    <li v-for="s in withPct" :key="s.label">
      <span class="dot" :style="{ background: s.color }" aria-hidden="true" />
      {{ s.label }} <strong>{{ s.value }}</strong>
    </li>
  </ul>
</template>

<style scoped>
.chart-legend {
  list-style: none;
  display: flex;
  padding: 0;
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}
.chart-legend li {
  display: inline-flex;
  align-items: center;
}
.chart-legend strong {
  color: var(--text-primary);
  font-weight: 600;
}
.dot {
  border-radius: 50%;
  flex-shrink: 0;
}
</style>

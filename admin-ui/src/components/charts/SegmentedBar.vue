<script setup lang="ts">
import { computed } from "vue";

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
    <ul class="segmented-legend">
      <li v-for="s in segments" :key="s.label">
        <span class="dot" :style="{ background: s.color }" aria-hidden="true" />
        {{ s.label }} <strong>{{ s.value }}</strong>
      </li>
    </ul>
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
.segmented-legend {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 0.15rem var(--space-4);
  padding: 0;
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}
.segmented-legend li {
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
}
.segmented-legend strong {
  color: var(--text-primary);
  font-weight: 600;
}
.dot {
  width: 0.55em;
  height: 0.55em;
  border-radius: 50%;
  flex-shrink: 0;
}
</style>

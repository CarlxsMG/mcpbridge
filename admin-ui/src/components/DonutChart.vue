<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    segments: { label: string; value: number; color: string }[];
    size?: number;
    centerLabel?: string | null;
  }>(),
  { size: 120 },
);

const total = computed(() => props.segments.reduce((sum, s) => sum + s.value, 0));
const strokeWidth = computed(() => Math.max(props.size * 0.12, 10));
const radius = computed(() => props.size / 2 - strokeWidth.value / 2);
const circumference = computed(() => 2 * Math.PI * radius.value);

const arcs = computed(() => {
  if (total.value <= 0) return [];
  let offset = 0;
  return props.segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const length = (s.value / total.value) * circumference.value;
      const arc = { label: s.label, color: s.color, length, offset };
      offset += length;
      return arc;
    });
});

const centerText = computed(() => {
  if (props.centerLabel === null) return null;
  return props.centerLabel ?? String(total.value);
});
</script>

<template>
  <div class="donut-wrap">
    <template v-if="total > 0">
      <svg
        :width="size"
        :height="size"
        :viewBox="`0 0 ${size} ${size}`"
        role="img"
        :aria-label="segments.map((s) => `${s.label}: ${s.value}`).join(', ')"
      >
        <circle
          :cx="size / 2"
          :cy="size / 2"
          :r="radius"
          fill="none"
          stroke="var(--surface-sunken)"
          :stroke-width="strokeWidth"
        />
        <circle
          v-for="arc in arcs"
          :key="arc.label"
          :cx="size / 2"
          :cy="size / 2"
          :r="radius"
          fill="none"
          :stroke="arc.color"
          :stroke-width="strokeWidth"
          :stroke-dasharray="`${arc.length} ${circumference - arc.length}`"
          :stroke-dashoffset="-arc.offset"
          :transform="`rotate(-90 ${size / 2} ${size / 2})`"
          class="donut-arc"
        />
        <text
          v-if="centerText !== null"
          :x="size / 2"
          :y="size / 2"
          text-anchor="middle"
          dominant-baseline="central"
          class="donut-total"
        >
          {{ centerText }}
        </text>
      </svg>
      <ul class="donut-legend">
        <li v-for="s in segments" :key="s.label">
          <span class="dot" :style="{ background: s.color }" aria-hidden="true" />
          {{ s.label }} <strong>{{ s.value }}</strong>
        </li>
      </ul>
    </template>
    <p v-else class="donut-empty">No data.</p>
  </div>
</template>

<style scoped>
.donut-wrap {
  display: flex;
  align-items: center;
  gap: var(--space-5);
  flex-wrap: wrap;
}
.donut-arc {
  transition: stroke-dasharray 0.4s ease;
}
.donut-total {
  fill: var(--text-primary);
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 1.3rem;
}
.donut-legend {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  padding: 0;
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}
.donut-legend li {
  display: inline-flex;
  align-items: center;
  gap: 0.5em;
}
.donut-legend strong {
  color: var(--text-primary);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.donut-empty {
  color: var(--text-muted);
  font-size: var(--text-md);
  margin: 0;
}
</style>

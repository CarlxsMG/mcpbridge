<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import ChartLegend from "./ChartLegend.vue";

const { t } = useI18n({ useScope: "global" });

const props = withDefaults(
  defineProps<{
    segments: { label: string; value: number; color: string }[];
    size?: number;
    centerLabel?: string | null;
  }>(),
  { size: 120, centerLabel: undefined },
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
      <!-- CSS size in rem (not width/height attrs in px) so the root font-size
           ramp scales the whole donut on TV-class screens; the viewBox stays in
           authored units, so everything inside scales as pure vector. -->
      <svg
        :style="{ width: `${size / 16}rem`, height: `${size / 16}rem` }"
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
      <ChartLegend :segments="segments" />
    </template>
    <p v-else class="donut-empty">{{ t("components.charts.no_data") }}</p>
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
  /* viewBox px on purpose (was 1.3rem = 20.8px): the svg element is CSS-sized
     in rem, so the viewBox transform already applies the root zoom — a rem
     font-size here would double-scale on large screens. */
  font-size: 20.8px;
}
/* ChartLegend's own recipe is an unspaced row; the donut's legend sits beside
   the ring in a taller column with slightly larger gaps/dots. */
:deep(.chart-legend) {
  flex-direction: column;
  gap: var(--space-1-5);
}
:deep(.chart-legend li) {
  gap: 0.5em;
}
:deep(.chart-legend strong) {
  font-variant-numeric: tabular-nums;
}
:deep(.dot) {
  width: 0.625em;
  height: 0.625em;
}
.donut-empty {
  color: var(--text-muted);
  font-size: var(--text-md);
  margin: 0;
}
</style>

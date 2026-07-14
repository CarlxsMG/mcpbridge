<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from "vue";
import { useI18n } from "vue-i18n";

const { t } = useI18n({ useScope: "global" });

interface Point {
  t: number;
  v: number;
}

const props = withDefaults(
  defineProps<{
    points: Point[];
    secondaryPoints?: Point[];
    color?: string;
    secondaryColor?: string;
    primaryLabel?: string;
    secondaryLabel?: string;
    formatValue?: (n: number) => string;
    formatSecondary?: (n: number) => string;
    formatTime?: (t: number) => string;
    height?: number;
  }>(),
  {
    secondaryPoints: () => [],
    color: "var(--signal)",
    secondaryColor: "var(--breach)",
    primaryLabel: "",
    secondaryLabel: "",
    formatValue: (n: number) => String(n),
    formatSecondary: (n: number) => String(n),
    formatTime: (tt: number) =>
      new Date(tt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    height: 200,
  },
);

const effectivePrimaryLabel = computed(() => props.primaryLabel || t("components.charts.primary"));
const effectiveSecondaryLabel = computed(() => props.secondaryLabel || t("components.charts.secondary"));

const gradientId = `tsc-grad-${useId()}`;
/* Geometry is authored in px at 1x zoom. The plot's CSS height is rem-based
   (see :style in the template) so the root font-size ramp (style.css, TV mode)
   grows it; measured-height / authored-height is then the live zoom factor and
   every px-space measure (paddings, strokes, dot radii, label offsets) scales
   by it. The viewBox always matches the measured px box, keeping 1 SVG unit ==
   1 screen px — so the rem-sized axis/tooltip text renders at its natural size
   instead of being distorted by a stretched viewBox. */
const BASE_PAD = { top: 14, right: 46, bottom: 24, left: 46 };

const containerEl = ref<HTMLDivElement | null>(null);
const width = ref(600);
const heightPx = ref(props.height);
let ro: ResizeObserver | null = null;

onMounted(() => {
  if (!containerEl.value) return;
  width.value = containerEl.value.clientWidth || 600;
  heightPx.value = containerEl.value.clientHeight || props.height;
  ro = new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect;
    if (rect && rect.width > 0) width.value = rect.width;
    if (rect && rect.height > 0) heightPx.value = rect.height;
  });
  ro.observe(containerEl.value);
});
onBeforeUnmount(() => ro?.disconnect());

const zoom = computed(() => heightPx.value / props.height);
const PAD = computed(() => ({
  top: BASE_PAD.top * zoom.value,
  right: BASE_PAD.right * zoom.value,
  bottom: BASE_PAD.bottom * zoom.value,
  left: BASE_PAD.left * zoom.value,
}));

const plotWidth = computed(() => Math.max(width.value - PAD.value.left - PAD.value.right, 1));
const plotHeight = computed(() => heightPx.value - PAD.value.top - PAD.value.bottom);

const hasData = computed(() => props.points.length > 0);
const hasSecondary = computed(() => props.secondaryPoints.length > 0);

function xAt(i: number, n: number): number {
  if (n <= 1) return PAD.value.left + plotWidth.value / 2;
  return PAD.value.left + (i / (n - 1)) * plotWidth.value;
}
function yAt(v: number, max: number): number {
  return PAD.value.top + plotHeight.value - (v / max) * plotHeight.value;
}

const primaryMax = computed(() => Math.max(...props.points.map((p) => p.v), 1));
const secondaryMax = computed(() => Math.max(...props.secondaryPoints.map((p) => p.v), 1));

const primaryPath = computed(() => {
  const n = props.points.length;
  if (n === 0) return "";
  return props.points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i, n).toFixed(1)} ${yAt(p.v, primaryMax.value).toFixed(1)}`)
    .join(" ");
});

const areaPath = computed(() => {
  const n = props.points.length;
  if (n === 0) return "";
  const baseline = (PAD.value.top + plotHeight.value).toFixed(1);
  return `${primaryPath.value} L ${xAt(n - 1, n).toFixed(1)} ${baseline} L ${xAt(0, n).toFixed(1)} ${baseline} Z`;
});

const secondaryPath = computed(() => {
  const n = props.secondaryPoints.length;
  if (n === 0) return "";
  return props.secondaryPoints
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i, n).toFixed(1)} ${yAt(p.v, secondaryMax.value).toFixed(1)}`)
    .join(" ");
});

const yTicks = computed(() => {
  const steps = 3;
  const seenRounded = new Set<number>();
  const ticks: { y: number; value: number }[] = [];
  // Walk top-to-bottom (frac descending) so that when two raw values round to the
  // same integer, the higher-valued (first-seen) tick wins and the lower duplicate
  // is dropped instead of rendering a repeated label.
  for (let i = steps; i >= 0; i--) {
    const frac = i / steps;
    const value = primaryMax.value * frac;
    const rounded = Math.round(value);
    if (seenRounded.has(rounded)) continue;
    seenRounded.add(rounded);
    ticks.push({ y: PAD.value.top + plotHeight.value * (1 - frac), value });
  }
  return ticks;
});

const xTicks = computed(() => {
  const n = props.points.length;
  if (n === 0) return [];
  if (n === 1) return [{ x: xAt(0, n), t: props.points[0].t, anchor: "middle" as const }];
  // Below this width (zoom-relative), "Jul 2, 2:30 PM"-length labels for start/mid/end
  // collide with no separating space — drop the middle tick and keep just start + end.
  const idxs =
    plotWidth.value < 280 * zoom.value ? [...new Set([0, n - 1])] : [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
  return idxs.map((i) => ({
    x: xAt(i, n),
    t: props.points[i].t,
    anchor: (i === 0 ? "start" : i === n - 1 ? "end" : "middle") as "start" | "end" | "middle",
  }));
});

// ---- Hover ----
const hoverIndex = ref<number | null>(null);

function onMove(evt: MouseEvent): void {
  const n = props.points.length;
  if (n === 0 || !containerEl.value) return;
  const rect = containerEl.value.getBoundingClientRect();
  const relX = evt.clientX - rect.left;
  const frac = (relX - PAD.value.left) / plotWidth.value;
  hoverIndex.value = Math.min(Math.max(Math.round(frac * (n - 1)), 0), n - 1);
}
function onLeave(): void {
  hoverIndex.value = null;
}

const hoverPoint = computed(() => (hoverIndex.value === null ? null : (props.points[hoverIndex.value] ?? null)));
const hoverSecondary = computed(() =>
  hoverIndex.value === null || !hasSecondary.value ? null : (props.secondaryPoints[hoverIndex.value] ?? null),
);
const hoverX = computed(() => (hoverIndex.value === null ? 0 : xAt(hoverIndex.value, props.points.length)));
const tooltipStyle = computed(() => {
  if (hoverIndex.value === null || width.value === 0) return {};
  const pct = (hoverX.value / width.value) * 100;
  const shiftX = pct < 15 ? "0%" : pct > 85 ? "-100%" : "-50%";
  return { left: `${pct}%`, transform: `translateX(${shiftX})` };
});
</script>

<template>
  <div class="ts-chart">
    <div class="ts-legend">
      <span class="legend-item"
        ><span class="dot" :style="{ background: color }" aria-hidden="true" />{{ effectivePrimaryLabel }}</span
      >
      <span v-if="hasSecondary" class="legend-item"
        ><span class="dot dash" :style="{ background: secondaryColor }" aria-hidden="true" />{{
          effectiveSecondaryLabel
        }}</span
      >
    </div>

    <p v-if="!hasData" class="ts-empty">{{ t("components.charts.no_data_window") }}</p>

    <div
      v-else
      ref="containerEl"
      class="ts-plot"
      :style="{ height: `${height / 16}rem` }"
      @mousemove="onMove"
      @mouseleave="onLeave"
    >
      <svg
        :viewBox="`0 0 ${width} ${heightPx}`"
        class="ts-svg"
        role="img"
        :aria-label="t('components.charts.series_over_time', { label: effectivePrimaryLabel })"
      >
        <defs>
          <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" :style="{ stopColor: color, stopOpacity: 0.28 }" />
            <stop offset="100%" :style="{ stopColor: color, stopOpacity: 0.02 }" />
          </linearGradient>
        </defs>

        <line
          v-for="tick in yTicks"
          :key="`grid-${tick.y}`"
          :x1="PAD.left"
          :x2="width - PAD.right"
          :y1="tick.y"
          :y2="tick.y"
          class="grid-line"
        />

        <path :d="areaPath" :fill="`url(#${gradientId})`" stroke="none" />
        <path
          :d="primaryPath"
          fill="none"
          :stroke="color"
          :stroke-width="2 * zoom"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
        <path
          v-if="hasSecondary"
          :d="secondaryPath"
          fill="none"
          :stroke="secondaryColor"
          :stroke-width="1.5 * zoom"
          :stroke-dasharray="`${4 * zoom} ${3 * zoom}`"
          stroke-linejoin="round"
          stroke-linecap="round"
        />

        <text
          v-for="tick in yTicks"
          :key="`ly-${tick.y}`"
          :x="PAD.left - 8 * zoom"
          :y="tick.y + 3 * zoom"
          class="axis-label y-label"
          text-anchor="end"
        >
          {{ formatValue(Math.round(tick.value)) }}
        </text>
        <text
          v-for="tick in xTicks"
          :key="`lx-${tick.x}`"
          :x="tick.x"
          :y="heightPx - 6 * zoom"
          class="axis-label x-label"
          :text-anchor="tick.anchor"
        >
          {{ formatTime(tick.t) }}
        </text>

        <template v-if="hoverPoint">
          <line :x1="hoverX" :x2="hoverX" :y1="PAD.top" :y2="PAD.top + plotHeight" class="crosshair" />
          <circle :cx="hoverX" :cy="yAt(hoverPoint.v, primaryMax)" :r="3.5 * zoom" :fill="color" class="hover-dot" />
          <circle
            v-if="hoverSecondary"
            :cx="hoverX"
            :cy="yAt(hoverSecondary.v, secondaryMax)"
            :r="3 * zoom"
            :fill="secondaryColor"
            class="hover-dot"
          />
        </template>
      </svg>

      <div v-if="hoverPoint" class="ts-tooltip" :style="tooltipStyle">
        <div class="tt-time">{{ formatTime(hoverPoint.t) }}</div>
        <div class="tt-row">
          <span class="tt-dot" :style="{ background: color }" aria-hidden="true" />{{ effectivePrimaryLabel }}
          <strong>{{ formatValue(hoverPoint.v) }}</strong>
        </div>
        <div v-if="hoverSecondary" class="tt-row">
          <span class="tt-dot" :style="{ background: secondaryColor }" aria-hidden="true" />{{
            effectiveSecondaryLabel
          }}
          <strong>{{ formatSecondary(hoverSecondary.v) }}</strong>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ts-chart {
  width: 100%;
}
.ts-legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  margin-bottom: var(--space-2);
  font-size: var(--text-sm);
  color: var(--text-secondary);
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 0.4em;
}
.dot {
  width: 0.55em;
  height: 0.55em;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot.dash {
  border-radius: 2px;
}
.ts-empty {
  color: var(--text-muted);
  font-size: var(--text-md);
  margin: var(--space-6) 0;
}
.ts-plot {
  position: relative;
  width: 100%;
}
.ts-svg {
  width: 100%;
  height: 100%;
  display: block;
  overflow: visible;
}
.grid-line {
  stroke: var(--border);
  stroke-width: 1;
}
.axis-label {
  fill: var(--text-muted);
  font-size: var(--text-xs);
  font-family: var(--font-mono);
}
.crosshair {
  stroke: var(--border-strong);
  stroke-width: 1;
  stroke-dasharray: 3 3;
}
.hover-dot {
  stroke: var(--surface);
  stroke-width: 1.5;
}
.ts-tooltip {
  position: absolute;
  top: 2px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-sm);
  white-space: nowrap;
  pointer-events: none;
  z-index: 1;
}
.tt-time {
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  margin-bottom: var(--space-1);
}
.tt-row {
  display: flex;
  align-items: center;
  gap: 0.4em;
  font-variant-numeric: tabular-nums;
}
.tt-row strong {
  margin-left: auto;
  padding-left: var(--space-3);
  color: var(--text-primary);
}
.tt-dot {
  width: 0.5em;
  height: 0.5em;
  border-radius: 50%;
  flex-shrink: 0;
}
</style>

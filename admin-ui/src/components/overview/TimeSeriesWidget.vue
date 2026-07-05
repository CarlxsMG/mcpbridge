<script setup lang="ts">
import { computed } from "vue";
import TimeSeriesChart from "@/components/charts/TimeSeriesChart.vue";
import WidgetCard from "./WidgetCard.vue";
import { SERIES_BY_ID, type DashboardStores, type WidgetInstance } from "./widgetCatalog";

const props = defineProps<{ widget: WidgetInstance; stores: DashboardStores }>();
const def = computed(() => SERIES_BY_ID.get(props.widget.options.series ?? ""));
const result = computed(() => def.value?.get(props.stores) ?? null);

// Plot height grows with the widget's row span; the grid row then grows to fit
// (grid-auto-rows minmax), so the chart is never clipped.
const height = computed(() => Math.max(120, props.widget.h * 100 - 40));

const formatTime = computed(() => {
  const bucketMs = result.value?.bucketMs ?? 0;
  const opts: Intl.DateTimeFormatOptions =
    bucketMs >= 24 * 60 * 60_000 ? { month: "short", day: "numeric" } : { hour: "numeric", minute: "2-digit" };
  return (t: number) => new Date(t).toLocaleString([], opts);
});
</script>

<template>
  <WidgetCard :title="widget.options.title">
    <TimeSeriesChart
      v-if="result"
      :points="result.points"
      :secondary-points="result.secondaryPoints ?? []"
      :primary-label="result.primaryLabel"
      :secondary-label="result.secondaryLabel ?? 'Secondary'"
      :format-value="result.valueFormat"
      :format-secondary="result.valueFormat"
      :format-time="formatTime"
      :height="height"
    />
    <p v-else class="w-muted">No data.</p>
  </WidgetCard>
</template>

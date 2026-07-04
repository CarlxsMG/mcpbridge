<script setup lang="ts">
import { computed } from "vue";
import StatCard from "@/components/ui/StatCard.vue";
import SegmentedBar from "@/components/charts/SegmentedBar.vue";
import { STAT_BY_ID, resolveIcon, type DashboardStores, type WidgetInstance } from "./widgetCatalog";

const props = defineProps<{ widget: WidgetInstance; stores: DashboardStores }>();

type StatTone = "default" | "danger" | "warning" | "ok";

const def = computed(() => STAT_BY_ID.get(props.widget.options.metric ?? ""));
const result = computed(() => def.value?.get(props.stores) ?? null);
const icon = computed(() => resolveIcon(props.widget.options.icon ?? def.value?.icon));

// tone: an explicit choice wins; "auto" derives from thresholds (higher = worse).
const tone = computed<StatTone>(() => {
  const o = props.widget.options;
  const chosen = o.tone ?? "default";
  if (chosen !== "auto") return chosen;
  const v = result.value?.value ?? 0;
  const th = o.thresholds ?? def.value?.thresholds ?? {};
  if (th.danger != null && v >= th.danger) return "danger";
  if (th.warn != null && v >= th.warn) return "warning";
  return "default";
});

const value = computed(() => (result.value ? `${result.value.display}${props.widget.options.unit ?? ""}` : "—"));
</script>

<template>
  <StatCard
    :icon="icon"
    :label="widget.options.title"
    :value="value"
    :detail="result?.detail"
    :tone="tone"
    :pulse="tone === 'danger'"
  >
    <SegmentedBar v-if="result?.segments?.length" :segments="result.segments" />
  </StatCard>
</template>

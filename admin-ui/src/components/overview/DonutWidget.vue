<script setup lang="ts">
import { computed } from "vue";
import DonutChart from "@/components/charts/DonutChart.vue";
import WidgetCard from "./WidgetCard.vue";
import { DONUT_BY_ID, type DashboardStores, type WidgetInstance } from "./widgetCatalog";

const props = defineProps<{ widget: WidgetInstance; stores: DashboardStores }>();
const def = computed(() => DONUT_BY_ID.get(props.widget.options.breakdown ?? ""));
const segments = computed(() => def.value?.get(props.stores) ?? []);
const size = computed(() => (props.widget.h >= 3 ? 120 : 96));
</script>

<template>
  <WidgetCard :title="widget.options.title" center>
    <DonutChart :segments="segments" :size="size" />
  </WidgetCard>
</template>

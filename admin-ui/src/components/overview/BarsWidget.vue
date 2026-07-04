<script setup lang="ts">
import { computed } from "vue";
import MiniBarChart from "@/components/charts/MiniBarChart.vue";
import WidgetCard from "./WidgetCard.vue";
import { BARS_BY_ID, type DashboardStores, type WidgetInstance } from "./widgetCatalog";

const props = defineProps<{ widget: WidgetInstance; stores: DashboardStores }>();
const def = computed(() => BARS_BY_ID.get(props.widget.options.ranking ?? ""));
const rows = computed(() => def.value?.get(props.stores) ?? []);
</script>

<template>
  <WidgetCard :title="widget.options.title">
    <MiniBarChart :rows="rows" />
  </WidgetCard>
</template>

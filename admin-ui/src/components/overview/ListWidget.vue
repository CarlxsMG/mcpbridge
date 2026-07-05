<script setup lang="ts">
import { computed } from "vue";
import WidgetCard from "./WidgetCard.vue";
import { LIST_BY_ID, cellToneColor, type DashboardStores, type WidgetInstance } from "./widgetCatalog";

const props = defineProps<{ widget: WidgetInstance; stores: DashboardStores }>();
const def = computed(() => LIST_BY_ID.get(props.widget.options.feed ?? ""));
const feed = computed(() => def.value?.get(props.stores) ?? null);
</script>

<template>
  <WidgetCard :title="widget.options.title">
    <table v-if="feed && feed.rows.length" class="w-feed">
      <thead>
        <tr>
          <th v-for="h in feed.head" :key="h">{{ h }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in feed.rows" :key="row.key">
          <td
            v-for="(cell, i) in row.cells"
            :key="i"
            :class="{ mono: cell.mono }"
            :style="cell.tone ? { color: cellToneColor(cell.tone) } : undefined"
          >
            {{ cell.text }}
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="w-muted">{{ feed?.empty ?? "No data." }}</p>
  </WidgetCard>
</template>

<style scoped>
.w-feed {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}
.w-feed th {
  text-align: left;
  padding: 0 var(--space-2) var(--space-1-5);
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--border);
}
.w-feed td {
  padding: var(--space-1-5) var(--space-2);
  border-bottom: 1px solid var(--border);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 12rem;
}
.w-feed tbody tr:last-child td {
  border-bottom: none;
}
.w-feed td.mono {
  font-family: var(--font-mono);
  color: var(--text-primary);
}
</style>

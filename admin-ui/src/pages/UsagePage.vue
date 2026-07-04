<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { api } from "@/composables/useApi";
import { useLoadState } from "@/composables/useResource";
import { pct } from "@/utils/format";
import type { UsageSummary, TopToolRow, UsageByKeyRow, UsageTimeseries } from "@/types/api";
import StatCard from "@/components/ui/StatCard.vue";
import MiniBarChart from "@/components/charts/MiniBarChart.vue";
import TimeSeriesChart from "@/components/charts/TimeSeriesChart.vue";
import SignalLoader from "@/components/ui/SignalLoader.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import TableCard from "@/components/ui/TableCard.vue";
import ChartCard from "@/components/charts/ChartCard.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import { Activity, AlertTriangle, Percent, Timer, Gauge, Wrench } from "lucide-vue-next";

const WINDOWS = [
  { label: "24 hours", ms: 24 * 60 * 60_000 },
  { label: "7 days", ms: 7 * 24 * 60 * 60_000 },
  { label: "30 days", ms: 30 * 24 * 60 * 60_000 },
];
const WINDOW_OPTIONS = WINDOWS.map((w) => ({ value: w.ms, label: `Last ${w.label}` }));
const windowMs = ref(WINDOWS[1].ms);

function onWindowChange(ms: number) {
  windowMs.value = ms;
  load();
}

const summary = ref<UsageSummary | null>(null);
const topTools = ref<TopToolRow[]>([]);
const byKey = ref<UsageByKeyRow[]>([]);
const timeseries = ref<UsageTimeseries | null>(null);
const { loading, errorMessage, run } = useLoadState("Failed to load usage.");

async function load() {
  const from = Date.now() - windowMs.value;
  await run(async () => {
    const [s, t, k, ts] = await Promise.all([
      api.get<UsageSummary>(`/admin-api/usage/summary?from=${from}`),
      api.get<{ items: TopToolRow[] }>(`/admin-api/usage/top-tools?from=${from}&limit=20`),
      api.get<{ items: UsageByKeyRow[] }>(`/admin-api/usage/by-key?from=${from}&limit=20`),
      api.get<UsageTimeseries>(`/admin-api/usage/timeseries?from=${from}`),
    ]);
    summary.value = s;
    topTools.value = t.items;
    byKey.value = k.items;
    timeseries.value = ts;
  });
}

const callsSeries = computed(() => timeseries.value?.points.map((p) => ({ t: p.t, v: p.calls })) ?? []);
const errorsSeries = computed(() => timeseries.value?.points.map((p) => ({ t: p.t, v: p.errors })) ?? []);
const tsFormatTime = computed(() => {
  const bucketMs = timeseries.value?.bucketMs ?? 0;
  const opts: Intl.DateTimeFormatOptions =
    bucketMs >= 24 * 60 * 60_000 ? { month: "short", day: "numeric" } : { hour: "numeric", minute: "2-digit" };
  return (t: number) => new Date(t).toLocaleString([], opts);
});

const topToolsChart = computed(() =>
  topTools.value.slice(0, 8).map((t) => ({
    label: `${t.client}/${t.tool}`,
    value: t.calls,
    hint: t.errors ? `${t.errors} err` : undefined,
    danger: t.errorRate > 0.1,
  })),
);

const byKeyChart = computed(() =>
  byKey.value.slice(0, 8).map((k) => ({
    label: k.label,
    value: k.calls,
    danger: false,
  })),
);

onMounted(load);
</script>

<template>
  <section>
    <PageHeader title="Usage">
      <div class="window-control">
        <SelectMenu
          :model-value="windowMs"
          aria-label="Time window"
          :options="WINDOW_OPTIONS"
          @update:model-value="onWindowChange"
        />
        <span v-if="loading" class="loading-note">Loading…</span>
      </div>
    </PageHeader>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

    <template v-if="summary">
      <div class="cards">
        <StatCard :icon="Activity" label="Calls" :value="summary.calls" />
        <StatCard
          :icon="AlertTriangle"
          label="Errors"
          :value="summary.errors"
          :tone="summary.errors > 0 ? 'warning' : 'default'"
        />
        <StatCard
          :icon="Percent"
          label="Error rate"
          :value="pct(summary.errorRate)"
          :tone="summary.errorRate > 0.1 ? 'danger' : 'default'"
        />
        <StatCard :icon="Timer" label="Avg latency" :value="`${summary.avgMs}ms`" />
        <StatCard :icon="Gauge" label="Max latency" :value="`${summary.maxMs}ms`" />
        <StatCard :icon="Wrench" label="Active tools" :value="summary.tools" />
      </div>

      <ChartCard title="Calls &amp; errors over time" dotted>
        <TimeSeriesChart
          :points="callsSeries"
          :secondary-points="errorsSeries"
          primary-label="Calls"
          secondary-label="Errors"
          :format-time="tsFormatTime"
        />
      </ChartCard>

      <div class="charts-row">
        <ChartCard title="Top tools by calls" dotted>
          <MiniBarChart :rows="topToolsChart" />
        </ChartCard>
        <ChartCard title="Calls by API key" dotted>
          <MiniBarChart :rows="byKeyChart" />
        </ChartCard>
      </div>

      <h2>Top tools</h2>
      <TableCard v-if="topTools.length">
        <thead>
          <tr>
            <th>Client</th>
            <th>Tool</th>
            <th>Calls</th>
            <th>Errors</th>
            <th>Error rate</th>
            <th>Avg</th>
            <th>Max</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in topTools" :key="`${t.client}/${t.tool}`">
            <td>{{ t.client }}</td>
            <td>{{ t.tool }}</td>
            <td>{{ t.calls }}</td>
            <td>{{ t.errors }}</td>
            <td :class="{ hot: t.errorRate > 0.1 }">{{ pct(t.errorRate) }}</td>
            <td>{{ t.avgMs }}ms</td>
            <td>{{ t.maxMs }}ms</td>
          </tr>
        </tbody>
      </TableCard>
      <p v-else class="empty">No calls recorded in this window.</p>
      <p v-if="topTools.length === 20" class="hint">
        Showing the top 20 — narrower windows or filtering may reveal others.
      </p>

      <h2>By API key</h2>
      <TableCard v-if="byKey.length">
        <thead>
          <tr>
            <th>Key</th>
            <th>Calls</th>
            <th>Errors</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="k in byKey" :key="k.keyId ?? 'none'">
            <td>{{ k.label }}</td>
            <td>{{ k.calls }}</td>
            <td>{{ k.errors }}</td>
          </tr>
        </tbody>
      </TableCard>
      <p v-else class="empty">No attributed calls in this window.</p>
      <p v-if="byKey.length === 20" class="hint">
        Showing the top 20 — narrower windows or filtering may reveal others.
      </p>
    </template>
    <SignalLoader v-else-if="loading" />
  </section>
</template>

<style scoped>
.window-control {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.loading-note {
  color: var(--text-muted);
  font-size: 0.85rem;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9.375rem, 1fr));
  gap: 0.75rem;
  margin-bottom: 1.5rem;
}
.charts-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
}
/* ChartCard bakes in margin-bottom: var(--space-6), but the two charts-row cards
   sit in a grid whose own margin-bottom already provides that spacing — zero out
   the per-card margin here so we don't double it up. */
.charts-row :deep(.chart-card) {
  margin-bottom: 0;
}
h2 {
  font-size: 1.05rem;
  margin: 0 0 0.75rem;
}
.hint {
  color: var(--text-muted);
  font-size: var(--text-sm);
  margin: var(--space-2) 0 0;
}
.empty {
  color: var(--text-muted);
}
</style>

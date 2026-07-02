<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { UsageSummary, TopToolRow, UsageByKeyRow, UsageTimeseries } from "../types/api";
import StatCard from "../components/StatCard.vue";
import MiniBarChart from "../components/MiniBarChart.vue";
import TimeSeriesChart from "../components/TimeSeriesChart.vue";
import { Activity, AlertTriangle, Percent, Timer, Gauge, Wrench } from "lucide-vue-next";

const WINDOWS = [
  { label: "24 hours", ms: 24 * 60 * 60_000 },
  { label: "7 days", ms: 7 * 24 * 60 * 60_000 },
  { label: "30 days", ms: 30 * 24 * 60 * 60_000 },
];
const windowMs = ref(WINDOWS[1].ms);

const summary = ref<UsageSummary | null>(null);
const topTools = ref<TopToolRow[]>([]);
const byKey = ref<UsageByKeyRow[]>([]);
const timeseries = ref<UsageTimeseries | null>(null);
const loading = ref(false);
const errorMessage = ref("");

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function load() {
  loading.value = true;
  errorMessage.value = "";
  const from = Date.now() - windowMs.value;
  try {
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
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load usage.";
  } finally {
    loading.value = false;
  }
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
  }))
);

const byKeyChart = computed(() =>
  byKey.value.slice(0, 8).map((k) => ({
    label: k.label,
    value: k.calls,
    danger: false,
  }))
);

onMounted(load);
</script>

<template>
  <section>
    <header class="page-header">
      <h1>Usage</h1>
      <div class="window-control">
        <select v-model.number="windowMs" aria-label="Time window" @change="load">
          <option v-for="w in WINDOWS" :key="w.ms" :value="w.ms">Last {{ w.label }}</option>
        </select>
        <span v-if="loading" class="loading-note">Loading…</span>
      </div>
    </header>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

    <template v-if="summary">
      <div class="cards">
        <StatCard :icon="Activity" label="Calls" :value="summary.calls" />
        <StatCard :icon="AlertTriangle" label="Errors" :value="summary.errors" :tone="summary.errors > 0 ? 'warning' : 'default'" />
        <StatCard :icon="Percent" label="Error rate" :value="pct(summary.errorRate)" :tone="summary.errorRate > 0.1 ? 'danger' : 'default'" />
        <StatCard :icon="Timer" label="Avg latency" :value="`${summary.avgMs}ms`" />
        <StatCard :icon="Gauge" label="Max latency" :value="`${summary.maxMs}ms`" />
        <StatCard :icon="Wrench" label="Active tools" :value="summary.tools" />
      </div>

      <div class="chart-card ts-card">
        <h2>Calls &amp; errors over time</h2>
        <TimeSeriesChart
          :points="callsSeries"
          :secondary-points="errorsSeries"
          primary-label="Calls"
          secondary-label="Errors"
          :format-time="tsFormatTime"
        />
      </div>

      <div class="charts-row">
        <div class="chart-card">
          <h2>Top tools by calls</h2>
          <MiniBarChart :rows="topToolsChart" />
        </div>
        <div class="chart-card">
          <h2>Calls by API key</h2>
          <MiniBarChart :rows="byKeyChart" />
        </div>
      </div>

      <h2>Top tools</h2>
      <div v-if="topTools.length" class="table-card table-scroll">
        <table class="usage-table">
          <thead><tr><th>Client</th><th>Tool</th><th>Calls</th><th>Errors</th><th>Error rate</th><th>Avg</th><th>Max</th></tr></thead>
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
        </table>
      </div>
      <p v-else class="empty">No calls recorded in this window.</p>

      <h2>By API key</h2>
      <div v-if="byKey.length" class="table-card table-scroll">
        <table class="usage-table">
          <thead><tr><th>Key</th><th>Calls</th><th>Errors</th></tr></thead>
          <tbody>
            <tr v-for="k in byKey" :key="k.keyId ?? 'none'">
              <td>{{ k.label }}</td>
              <td>{{ k.calls }}</td>
              <td>{{ k.errors }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="empty">No attributed calls in this window.</p>
    </template>
    <div v-else-if="loading" class="loading">Loading…</div>
  </section>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.25rem;
}
.page-header select {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-family: var(--font-body);
}
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
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 0.75rem;
  margin-bottom: 1.5rem;
}
.charts-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
}
.chart-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: 1.1rem 1.25rem;
}
.chart-card h2 {
  font-size: 0.85rem;
  margin: 0 0 0.9rem;
  color: var(--text-secondary);
  font-family: var(--font-body);
  font-weight: 600;
}
.ts-card {
  margin-bottom: var(--space-6);
}
h2 {
  font-size: 1.05rem;
  margin: 0 0 0.75rem;
}
.table-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  margin-bottom: 1.5rem;
}
.usage-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.usage-table th {
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.usage-table td {
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border);
}
.usage-table tbody tr:last-child td {
  border-bottom: none;
}
.usage-table tbody tr:hover {
  background: var(--surface-sunken);
}
.usage-table td.hot {
  color: var(--breach);
  font-weight: 600;
}
.error {
  color: var(--breach);
}
.loading,
.empty {
  color: var(--text-muted);
}
</style>

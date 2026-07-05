<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useLoadState } from "@/composables/useResource";
import { pct } from "@/utils/format";
import { tk } from "@/i18n";
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

const { t } = useI18n({ useScope: "global" });

const WINDOWS = [
  { label: "24 hours", ms: 24 * 60 * 60_000, i18nKey: "last_24h" },
  { label: "7 days", ms: 7 * 24 * 60 * 60_000, i18nKey: "last_7d" },
  { label: "30 days", ms: 30 * 24 * 60 * 60_000, i18nKey: "last_30d" },
] as const;
const WINDOW_OPTIONS = WINDOWS.map((w) => ({ value: w.ms, label: t(`common.time_windows.${w.i18nKey}`, w.label) }));
const windowMs = ref(WINDOWS[1].ms);

function onWindowChange(ms: number) {
  windowMs.value = ms;
  load();
}

const summary = ref<UsageSummary | null>(null);
const topTools = ref<TopToolRow[]>([]);
const byKey = ref<UsageByKeyRow[]>([]);
const timeseries = ref<UsageTimeseries | null>(null);
const { loading, errorMessage, run } = useLoadState(tk("pages.usage.errors.load_failed"));

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
  return (tt: number) => new Date(tt).toLocaleString([], opts);
});

const topToolsChart = computed(() =>
  topTools.value.slice(0, 8).map((tool) => ({
    label: `${tool.client}/${tool.tool}`,
    value: tool.calls,
    hint: tool.errors ? t("pages.usage.errors_hint", { count: tool.errors }) : undefined,
    danger: tool.errorRate > 0.1,
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
    <PageHeader :title="t('pages.usage.title')">
      <div class="window-control">
        <SelectMenu
          :model-value="windowMs"
          :aria-label="t('pages.usage.time_window_aria')"
          :options="WINDOW_OPTIONS"
          @update:model-value="onWindowChange"
        />
        <span v-if="loading" class="loading-note">{{ t('common.loading') }}</span>
      </div>
    </PageHeader>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

    <template v-if="summary">
      <div class="cards">
        <StatCard :icon="Activity" :label="t('pages.usage.stat.calls')" :value="summary.calls" />
        <StatCard
          :icon="AlertTriangle"
          :label="t('pages.usage.stat.errors')"
          :value="summary.errors"
          :tone="summary.errors > 0 ? 'warning' : 'default'"
        />
        <StatCard
          :icon="Percent"
          :label="t('pages.usage.stat.error_rate')"
          :value="pct(summary.errorRate)"
          :tone="summary.errorRate > 0.1 ? 'danger' : 'default'"
        />
        <StatCard :icon="Timer" :label="t('pages.usage.stat.avg_latency')" :value="`${summary.avgMs}ms`" />
        <StatCard :icon="Gauge" :label="t('pages.usage.stat.max_latency')" :value="`${summary.maxMs}ms`" />
        <StatCard :icon="Wrench" :label="t('pages.usage.stat.active_tools')" :value="summary.tools" />
      </div>

      <ChartCard :title="t('pages.usage.chart.calls_errors')" dotted>
        <TimeSeriesChart
          :points="callsSeries"
          :secondary-points="errorsSeries"
          :primary-label="t('pages.usage.chart.primary_label')"
          :secondary-label="t('pages.usage.chart.secondary_label')"
          :format-time="tsFormatTime"
        />
      </ChartCard>

      <div class="charts-row">
        <ChartCard :title="t('pages.usage.chart.top_tools')" dotted>
          <MiniBarChart :rows="topToolsChart" />
        </ChartCard>
        <ChartCard :title="t('pages.usage.chart.calls_by_key')" dotted>
          <MiniBarChart :rows="byKeyChart" />
        </ChartCard>
      </div>

      <h2>{{ t('pages.usage.section.top_tools') }}</h2>
      <TableCard v-if="topTools.length">
        <thead>
          <tr>
            <th>{{ t('pages.usage.table.client') }}</th>
            <th>{{ t('pages.usage.table.tool') }}</th>
            <th>{{ t('pages.usage.table.calls') }}</th>
            <th>{{ t('pages.usage.table.errors') }}</th>
            <th>{{ t('pages.usage.table.error_rate') }}</th>
            <th>{{ t('pages.usage.table.avg') }}</th>
            <th>{{ t('pages.usage.table.max') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="tool in topTools" :key="`${tool.client}/${tool.tool}`">
            <td>{{ tool.client }}</td>
            <td>{{ tool.tool }}</td>
            <td>{{ tool.calls }}</td>
            <td>{{ tool.errors }}</td>
            <td :class="{ hot: tool.errorRate > 0.1 }">{{ pct(tool.errorRate) }}</td>
            <td>{{ tool.avgMs }}ms</td>
            <td>{{ tool.maxMs }}ms</td>
          </tr>
        </tbody>
      </TableCard>
      <p v-else class="empty">{{ t('pages.usage.empty.no_calls') }}</p>
      <p v-if="topTools.length === 20" class="hint">
        {{ t('pages.usage.truncated_hint') }}
      </p>

      <h2>{{ t('pages.usage.section.by_key') }}</h2>
      <TableCard v-if="byKey.length">
        <thead>
          <tr>
            <th>{{ t('pages.usage.table.key') }}</th>
            <th>{{ t('pages.usage.table.calls') }}</th>
            <th>{{ t('pages.usage.table.errors') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in byKey" :key="row.keyId ?? 'none'">
            <td>{{ row.label }}</td>
            <td>{{ row.calls }}</td>
            <td>{{ row.errors }}</td>
          </tr>
        </tbody>
      </TableCard>
      <p v-else class="empty">{{ t('pages.usage.empty.no_attributed') }}</p>
      <p v-if="byKey.length === 20" class="hint">
        {{ t('pages.usage.truncated_hint') }}
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
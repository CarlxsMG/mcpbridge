<script setup lang="ts">
import { onMounted, computed } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { formatMaybeDate } from "@/utils/format";
import { statusTone, toneColorVar } from "@/utils/status";
import { tk } from "@/i18n";
import type { MonitorRecord } from "@/types/api";
import DonutChart from "@/components/charts/DonutChart.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import ChartCard from "@/components/charts/ChartCard.vue";
import HoverPreview from "@/components/ui/HoverPreview.vue";
import { Radar, RefreshCw } from "lucide-vue-next";

const { t } = useI18n({ useScope: "global" });
const loadFallback = tk("pages.monitors.errors.load_failed");

const {
  data: monitors,
  loading,
  errorMessage,
  load,
} = useResource<MonitorRecord[]>(
  async () => (await api.get<{ items: MonitorRecord[] }>("/admin-api/monitors")).items,
  [],
  loadFallback,
);
onMounted(load);

type MonitorState = "healthy" | "drift" | "failing" | "never" | "disabled";

function stateOf(m: MonitorRecord): MonitorState {
  if (!m.enabled) return "disabled";
  if (m.lastStatus === "fail") return "failing";
  if (m.lastStatus === null) return "never";
  return m.driftDetected ? "drift" : "healthy";
}

const STATE_LABEL: Record<MonitorState, string> = {
  healthy: tk("pages.monitors.state.healthy"),
  drift: tk("pages.monitors.state.drift"),
  failing: tk("pages.monitors.state.failing"),
  never: tk("pages.monitors.state.never"),
  disabled: tk("pages.monitors.state.disabled"),
};
const segments = computed(() => {
  const counts: Record<MonitorState, number> = { healthy: 0, drift: 0, failing: 0, never: 0, disabled: 0 };
  for (const m of monitors.value) counts[stateOf(m)]++;
  return (Object.keys(counts) as MonitorState[])
    .map((k) => ({ label: STATE_LABEL[k], value: counts[k], color: `var(${toneColorVar(statusTone(k))})` }))
    .filter((s) => s.value > 0);
});
</script>

<template>
  <section>
    <PageHeader :title="t('pages.monitors.title')" :subtitle="t('pages.monitors.subtitle')">
      <button type="button" class="btn-secondary" :disabled="loading" @click="load">
        <RefreshCw :size="14" stroke-width="2" aria-hidden="true" :class="{ spin: loading }" />
        {{ loading ? t("common.refreshing") : t("common.refresh") }}
      </button>
    </PageHeader>

    <ListLayout :loading="loading && !monitors.length" :error="errorMessage" :empty="monitors.length === 0">
      <template #empty>
        <EmptyState :icon="Radar" muted>
          {{ t("pages.monitors.empty.no_monitors") }}
        </EmptyState>
      </template>

      <ChartCard :title="t('pages.monitors.breakdown_title')" dotted>
        <DonutChart :segments="segments" :size="96" />
      </ChartCard>

      <TableCard>
        <thead>
          <tr>
            <th>{{ t("pages.monitors.table.client_tool") }}</th>
            <th>{{ t("pages.monitors.table.state") }}</th>
            <th>{{ t("pages.monitors.table.interval") }}</th>
            <th>{{ t("pages.monitors.table.last_checked") }}</th>
            <th>{{ t("pages.monitors.table.last_error") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in monitors" :key="`${m.clientName}/${m.toolName}`">
            <td class="mono">{{ m.clientName }}/{{ m.toolName }}</td>
            <td>
              <span
                class="state-dot"
                :style="{ background: `var(${toneColorVar(statusTone(stateOf(m)))})` }"
                aria-hidden="true"
              />{{ STATE_LABEL[stateOf(m)] }}
            </td>
            <td>{{ m.intervalMinutes }}m</td>
            <td>{{ formatMaybeDate(m.lastCheckedAt, tk("common.never")) }}</td>
            <td>
              <HoverPreview class="cell-truncate" :text="m.lastError ?? ''">{{ m.lastError ?? "—" }}</HoverPreview>
            </td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>
  </section>
</template>

<style scoped>
:deep(.subtitle) {
  max-width: 42.5rem;
}
.header-actions .btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  flex-shrink: 0;
}
.state-dot {
  display: inline-block;
  width: 0.4375rem;
  height: 0.4375rem;
  border-radius: 50%;
  margin-right: 0.5em;
}
.cell-truncate {
  max-width: 20rem;
  color: var(--text-secondary);
}
</style>

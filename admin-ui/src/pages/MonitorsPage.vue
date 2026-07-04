<script setup lang="ts">
import { onMounted, computed } from "vue";
import { api } from "../composables/useApi";
import { useResource } from "../composables/useResource";
import type { MonitorRecord } from "../types/api";
import DonutChart from "../components/DonutChart.vue";
import SignalLoader from "@/components/ui/SignalLoader.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import ChartCard from "../components/ChartCard.vue";
import { Radar, RefreshCw } from "lucide-vue-next";

const {
  data: monitors,
  loading,
  errorMessage,
  load,
} = useResource<MonitorRecord[]>(
  async () => (await api.get<{ items: MonitorRecord[] }>("/admin-api/monitors")).items,
  [],
  "Failed to load monitors. Check your connection and try again.",
);
onMounted(load);

type MonitorState = "healthy" | "drift" | "failing" | "never" | "disabled";

// Status and drift are independent axes in the data model (a monitor can be
// "ok" and "drifted" at once) — rank failing > drift > never-checked > healthy
// so each monitor lands in exactly one bucket for the breakdown.
function stateOf(m: MonitorRecord): MonitorState {
  if (!m.enabled) return "disabled";
  if (m.lastStatus === "fail") return "failing";
  if (m.lastStatus === null) return "never";
  return m.driftDetected ? "drift" : "healthy";
}

const STATE_LABEL: Record<MonitorState, string> = {
  healthy: "Healthy",
  drift: "Drift detected",
  failing: "Failing",
  never: "Never checked",
  disabled: "Disabled",
};
const STATE_COLOR: Record<MonitorState, string> = {
  healthy: "var(--ok)",
  drift: "var(--canary)",
  failing: "var(--breach)",
  never: "var(--text-muted)",
  disabled: "var(--border-strong)",
};

const segments = computed(() => {
  const counts: Record<MonitorState, number> = { healthy: 0, drift: 0, failing: 0, never: 0, disabled: 0 };
  for (const m of monitors.value) counts[stateOf(m)]++;
  return (Object.keys(counts) as MonitorState[])
    .map((k) => ({ label: STATE_LABEL[k], value: counts[k], color: STATE_COLOR[k] }))
    .filter((s) => s.value > 0);
});

function formatChecked(t: number | null): string {
  return t === null ? "Never" : new Date(t).toLocaleString();
}
</script>

<template>
  <section>
    <PageHeader
      title="Monitors"
      subtitle="Synthetic uptime + schema-drift checks, replaying saved examples on a schedule. Informational only today — failures and drift are recorded here and optionally pinged to one operator webhook, but they don't participate in the Alerts rule system."
    >
      <button type="button" class="btn-secondary" :disabled="loading" @click="load">
        <RefreshCw :size="14" stroke-width="2" aria-hidden="true" :class="{ spin: loading }" />
        {{ loading ? "Refreshing…" : "Refresh" }}
      </button>
    </PageHeader>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <SignalLoader v-if="loading && !monitors.length" />
    <EmptyState v-else-if="monitors.length === 0" :icon="Radar">
      No tools are monitored yet. Configure a monitor from a tool's settings in Server detail.
    </EmptyState>

    <template v-else>
      <ChartCard title="Status breakdown">
        <DonutChart :segments="segments" :size="96" />
      </ChartCard>

      <TableCard>
        <thead>
          <tr>
            <th>Client / Tool</th>
            <th>State</th>
            <th>Interval</th>
            <th>Last checked</th>
            <th>Last error</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in monitors" :key="`${m.clientName}/${m.toolName}`">
            <td class="mono">{{ m.clientName }}/{{ m.toolName }}</td>
            <td>
              <span class="state-dot" :style="{ background: STATE_COLOR[stateOf(m)] }" aria-hidden="true" />{{
                STATE_LABEL[stateOf(m)]
              }}
            </td>
            <td>{{ m.intervalMinutes }}m</td>
            <td>{{ formatChecked(m.lastCheckedAt) }}</td>
            <td class="preview" :title="m.lastError ?? ''">{{ m.lastError ?? "—" }}</td>
          </tr>
        </tbody>
      </TableCard>
    </template>
  </section>
</template>

<style scoped>
/* PageHeader's own recipe covers color/margin; this page's subtitle keeps a
   line-length cap that the shared component doesn't set. */
:deep(.subtitle) {
  max-width: 42.5rem;
}
.header-actions .btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  flex-shrink: 0;
}
.spin {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
/* Page-specific dotted-grid background for the chart card — not part of the
   shared ChartCard recipe, so it's re-applied here via :deep() since the
   .chart-card element itself now lives inside ChartCard.vue's own template. */
:deep(.chart-card) {
  background-image: radial-gradient(circle, var(--border) 1px, transparent 1px);
  background-size: 16px 16px;
}
.mono {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  white-space: nowrap;
}
.state-dot {
  display: inline-block;
  width: 0.4375rem;
  height: 0.4375rem;
  border-radius: 50%;
  margin-right: 0.5em;
}
.preview {
  max-width: 20rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}
.error {
  color: var(--breach);
}
/* EmptyState's own recipe colors its paragraph via --text-secondary on the
   wrapper; this page's empty copy is intentionally a step lighter. */
:deep(.empty-state p) {
  color: var(--text-muted);
}
</style>

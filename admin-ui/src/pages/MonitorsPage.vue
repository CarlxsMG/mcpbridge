<script setup lang="ts">
import { onMounted, computed } from "vue";
import { api } from "../composables/useApi";
import { useResource } from "../composables/useResource";
import type { MonitorRecord } from "../types/api";
import DonutChart from "../components/DonutChart.vue";
import SignalLoader from "../components/SignalLoader.vue";
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
    <header class="page-header">
      <div>
        <h1>Monitors</h1>
        <p class="subtitle">
          Synthetic uptime + schema-drift checks, replaying saved examples on a schedule. Informational only today —
          failures and drift are recorded here and optionally pinged to one operator webhook, but they don't participate
          in the Alerts rule system.
        </p>
      </div>
      <button type="button" class="btn-secondary" :disabled="loading" @click="load">
        <RefreshCw :size="14" stroke-width="2" aria-hidden="true" :class="{ spin: loading }" />
        {{ loading ? "Refreshing…" : "Refresh" }}
      </button>
    </header>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <SignalLoader v-if="loading && !monitors.length" />
    <div v-else-if="monitors.length === 0" class="empty-state">
      <Radar :size="26" stroke-width="1.5" aria-hidden="true" class="empty-icon" />
      <p>No tools are monitored yet. Configure a monitor from a tool's settings in Server detail.</p>
    </div>

    <template v-else>
      <div class="chart-card">
        <h2>Status breakdown</h2>
        <DonutChart :segments="segments" :size="96" />
      </div>

      <div class="table-card table-scroll">
        <table class="mon-table">
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
        </table>
      </div>
    </template>
  </section>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1.25rem;
}
.page-header h1 {
  margin: 0 0 0.2rem;
}
.subtitle {
  color: var(--text-secondary);
  margin: 0;
  max-width: 42.5rem;
}
.page-header .btn-secondary {
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
.chart-card {
  background: var(--surface);
  background-image: radial-gradient(circle, var(--border) 1px, transparent 1px);
  background-size: 16px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: var(--space-4) var(--space-5);
  margin-bottom: var(--space-6);
}
.chart-card h2 {
  font-size: var(--text-sm);
  margin: 0 0 var(--space-3);
  color: var(--text-secondary);
  font-family: var(--font-body);
  font-weight: 600;
}
.table-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
}
.mon-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.mon-table th {
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.mon-table td {
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.mon-table tbody tr:last-child td {
  border-bottom: none;
}
.mon-table tbody tr:hover {
  background: var(--surface-sunken);
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
.empty-state p {
  color: var(--text-muted);
}
.empty-state {
  padding: 3rem 2rem;
  text-align: center;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.empty-icon {
  color: var(--text-muted);
  margin-bottom: 0.75rem;
}
</style>

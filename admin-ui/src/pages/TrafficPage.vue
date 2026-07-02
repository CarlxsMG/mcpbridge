<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { TrafficRecord } from "../types/api";
import TimeSeriesChart from "../components/TimeSeriesChart.vue";
import { ArrowLeftRight, RotateCcw, Search } from "lucide-vue-next";

const records = ref<TrafficRecord[]>([]);
const loading = ref(false);
const errorMessage = ref("");

const clientFilter = ref("");
const toolFilter = ref("");
const errorsOnly = ref(false);

const replayingId = ref<number | null>(null);
const replayNote = ref<{ id: number; ok: boolean; text: string } | null>(null);

async function load() {
  loading.value = true;
  errorMessage.value = "";
  const params = new URLSearchParams({ limit: "500" });
  if (clientFilter.value.trim()) params.set("client", clientFilter.value.trim());
  if (toolFilter.value.trim()) params.set("tool", toolFilter.value.trim());
  if (errorsOnly.value) params.set("errors", "true");
  try {
    records.value = (await api.get<{ items: TrafficRecord[] }>(`/admin-api/traffic?${params}`)).items;
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load traffic.";
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function formatDuration(ms: number): string {
  return `${ms}ms`;
}

const chart = computed(() => {
  const rows = records.value;
  if (rows.length === 0) return { points: [] as { t: number; v: number }[], errorPoints: [] as { t: number; v: number }[] };
  const times = rows.map((r) => r.createdAt);
  const min = Math.min(...times);
  const max = Math.max(...times);
  // Scale bucket count to the record count so sparse traffic doesn't render as a
  // mostly-empty, spiky chart — average a few records per bucket instead of a fixed 24.
  const bucketCount = Math.min(24, Math.max(6, Math.ceil(rows.length / 3)));
  const bucketMs = Math.max(Math.ceil((max - min) / bucketCount), 60_000);
  const buckets = new Map<number, { calls: number; errors: number }>();
  for (const r of rows) {
    const t = min + Math.floor((r.createdAt - min) / bucketMs) * bucketMs;
    const entry = buckets.get(t) ?? { calls: 0, errors: 0 };
    entry.calls++;
    if (r.isError) entry.errors++;
    buckets.set(t, entry);
  }
  const points: { t: number; v: number }[] = [];
  const errorPoints: { t: number; v: number }[] = [];
  for (let t = min; t <= max; t += bucketMs) {
    const b = buckets.get(t) ?? { calls: 0, errors: 0 };
    points.push({ t, v: b.calls });
    errorPoints.push({ t, v: b.errors });
  }
  return { points, errorPoints };
});

async function replay(r: TrafficRecord) {
  replayingId.value = r.id;
  replayNote.value = null;
  try {
    const res = await api.post<{ content?: { type: string; text: string }[]; isError?: boolean }>(`/admin-api/traffic/${r.id}/replay`);
    const text = res.content?.map((c) => c.text).join(" ") ?? "(no content)";
    replayNote.value = { id: r.id, ok: !res.isError, text: text.length > 300 ? `${text.slice(0, 300)}…` : text };
  } catch (err) {
    replayNote.value = { id: r.id, ok: false, text: err instanceof ApiError ? err.message : "Replay failed." };
  } finally {
    replayingId.value = null;
  }
}
</script>

<template>
  <section>
    <header class="page-header">
      <div>
        <h1>Traffic</h1>
        <p class="subtitle">
          Captured request/response calls. Capture is opt-in (<code>TRAFFIC_CAPTURE=true</code> on the server) — an empty list here can
          mean either capture is off or there's genuinely nothing recent.
        </p>
      </div>
    </header>

    <form class="filter-row" @submit.prevent="load">
      <input v-model="clientFilter" type="text" placeholder="Client name" aria-label="Filter by client" />
      <input v-model="toolFilter" type="text" placeholder="Tool name" aria-label="Filter by tool" />
      <label class="errors-only"><input v-model="errorsOnly" type="checkbox" /> Errors only</label>
      <button type="submit" class="btn-secondary">
        <Search :size="14" stroke-width="2" aria-hidden="true" /> Filter
      </button>
    </form>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <p v-if="replayNote" :class="replayNote.ok ? 'success' : 'error'" role="status">
      Replay #{{ replayNote.id }} {{ replayNote.ok ? "succeeded" : "failed" }} — {{ replayNote.text }}
    </p>

    <div v-if="loading && !records.length" class="loading">Loading…</div>
    <div v-else-if="records.length === 0" class="empty-state">
      <ArrowLeftRight :size="26" stroke-width="1.5" aria-hidden="true" class="empty-icon" />
      <p>No traffic recorded yet.</p>
    </div>

    <template v-else>
      <div class="chart-card">
        <h2>Call volume</h2>
        <TimeSeriesChart :points="chart.points" :secondary-points="chart.errorPoints" primary-label="Calls" secondary-label="Errors" :height="160" />
      </div>

      <div class="table-card table-scroll">
        <table class="traffic-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Client / Tool</th>
              <th>Duration</th>
              <th>Status</th>
              <th>Preview</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in records" :key="r.id">
              <td class="mono">{{ new Date(r.createdAt).toLocaleString() }}</td>
              <td class="mono">{{ r.clientName ?? "—" }}/{{ r.toolName ?? r.mcpToolName }}</td>
              <td>{{ formatDuration(r.durationMs) }}</td>
              <td :class="{ hot: r.isError }">{{ r.isError ? "Error" : "OK" }}</td>
              <td class="preview" :title="r.preview">{{ r.preview }}</td>
              <td class="actions">
                <button type="button" class="link-btn" :disabled="replayingId === r.id" @click="replay(r)">
                  <RotateCcw :size="13" stroke-width="2" aria-hidden="true" /> {{ replayingId === r.id ? "Replaying…" : "Replay" }}
                </button>
              </td>
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
  max-width: 640px;
}
.filter-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-5);
}
.filter-row input[type="text"] {
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-family: var(--font-body);
  font-size: 0.9rem;
  min-width: 160px;
}
.errors-only {
  display: inline-flex;
  align-items: center;
  gap: 0.4em;
  font-size: 0.88rem;
  color: var(--text-secondary);
}
.filter-row .btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.chart-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: 1.1rem 1.25rem;
  margin-bottom: var(--space-6);
}
.chart-card h2 {
  font-size: 0.85rem;
  margin: 0 0 0.9rem;
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
.traffic-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.traffic-table th {
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
}
.traffic-table td {
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.traffic-table tbody tr:last-child td {
  border-bottom: none;
}
.traffic-table tbody tr:hover {
  background: var(--surface-sunken);
}
.mono {
  font-family: var(--font-mono);
  font-size: 0.82rem;
  white-space: nowrap;
}
.preview {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}
.hot {
  color: var(--breach);
  font-weight: 600;
}
.actions {
  white-space: nowrap;
}
.error {
  color: var(--breach);
}
.success {
  color: var(--ok);
}
.loading,
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

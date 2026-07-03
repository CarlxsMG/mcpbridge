<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import { api, ApiError } from "../composables/useApi";
import type { TraceSummary, StoredSpan, PaginatedResult } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { Waypoints, Trash2 } from "lucide-vue-next";

const props = defineProps<{ traceId?: string }>();
const router = useRouter();

const traces = ref<TraceSummary[]>([]);
const nextCursor = ref<string | undefined>(undefined);
const cursorStack = ref<(string | undefined)[]>([]);
const spans = ref<StoredSpan[] | null>(null);
const loading = ref(false);
const errorMessage = ref("");
const toolFilter = ref("");
const pendingPurge = ref(false);
const purging = ref(false);

function buildListQuery(cursor?: string): string {
  const params = new URLSearchParams();
  if (toolFilter.value.trim()) params.set("tool", toolFilter.value.trim());
  if (cursor) params.set("cursor", cursor);
  params.set("limit", "50");
  return params.toString();
}

async function loadList(cursor?: string) {
  loading.value = true;
  errorMessage.value = "";
  try {
    const result = await api.get<PaginatedResult<TraceSummary>>(`/admin-api/traces?${buildListQuery(cursor)}`);
    traces.value = result.items;
    nextCursor.value = result.nextCursor;
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load traces.";
  } finally {
    loading.value = false;
  }
}

function applyFilters() {
  cursorStack.value = [];
  loadList();
}

function nextPage() {
  if (!nextCursor.value) return;
  cursorStack.value.push(undefined); // placeholder for "page before current" bookkeeping
  loadList(nextCursor.value);
}

function prevPage() {
  if (cursorStack.value.length === 0) return;
  cursorStack.value.pop();
  const cursor = cursorStack.value[cursorStack.value.length - 1];
  loadList(cursor);
}

async function loadDetail(traceId: string) {
  loading.value = true;
  errorMessage.value = "";
  spans.value = null;
  try {
    spans.value = (
      await api.get<{ traceId: string; spans: StoredSpan[] }>(`/admin-api/traces/${encodeURIComponent(traceId)}`)
    ).spans;
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load trace.";
  } finally {
    loading.value = false;
  }
}

async function refresh() {
  if (props.traceId) {
    await loadDetail(props.traceId);
  } else {
    // Returning to the list (e.g. from a detail view) always shows page one —
    // keep the pagination stack in sync so Previous doesn't stay wrongly enabled.
    cursorStack.value = [];
    await loadList();
  }
}
onMounted(refresh);
watch(() => props.traceId, refresh);

function openTrace(t: TraceSummary) {
  router.push({ name: "trace-detail", params: { traceId: t.traceId } });
}

function backToList() {
  router.push({ name: "traces" });
}

async function confirmPurge() {
  pendingPurge.value = false;
  purging.value = true;
  try {
    await api.delete("/admin-api/traces");
    cursorStack.value = [];
    await loadList();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to purge traces.";
  } finally {
    purging.value = false;
  }
}

function fmtDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

/** Waterfall bar geometry: left%/width% relative to the earliest span's start. */
const waterfall = computed(() => {
  const rows = spans.value ?? [];
  if (rows.length === 0) return { rows: [], totalMs: 0 };
  const traceStart = Math.min(...rows.map((s) => s.startMs));
  const traceEnd = Math.max(...rows.map((s) => s.endMs));
  const totalMs = Math.max(traceEnd - traceStart, 1);
  return {
    totalMs,
    rows: rows.map((s) => ({
      span: s,
      leftPct: ((s.startMs - traceStart) / totalMs) * 100,
      widthPct: Math.max(((s.endMs - s.startMs) / totalMs) * 100, 0.5),
      durationMs: s.endMs - s.startMs,
    })),
  };
});
</script>

<template>
  <section>
    <header class="page-header">
      <div>
        <h1>Traces</h1>
        <p class="subtitle">
          Per-call span timing for a built-in waterfall view — independent of any external OTLP collector. Opt-in (<code
            >TRACE_STORAGE=true</code
          >
          on the server) — an empty list can mean either storage is off or there's genuinely nothing recent.
        </p>
      </div>
    </header>

    <template v-if="!traceId">
      <form class="filter-row" @submit.prevent="applyFilters">
        <input
          v-model="toolFilter"
          type="text"
          placeholder="Tool name (e.g. github__search_issues)"
          aria-label="Filter by tool"
        />
        <button type="submit" class="btn-secondary">Filter</button>
        <button
          type="button"
          class="btn-secondary danger"
          :disabled="purging || traces.length === 0"
          @click="pendingPurge = true"
        >
          <Trash2 :size="14" stroke-width="2" aria-hidden="true" /> Purge all
        </button>
      </form>

      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
      <div v-if="loading && !traces.length" class="loading">Loading…</div>
      <div v-else-if="traces.length === 0" class="empty-state">
        <Waypoints :size="26" stroke-width="1.5" aria-hidden="true" class="empty-icon" />
        <p>No traces recorded yet.</p>
      </div>

      <div v-else class="table-card table-scroll">
        <table class="trace-table">
          <thead>
            <tr>
              <th>Started</th>
              <th>Tool</th>
              <th>Spans</th>
              <th>Duration</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in traces" :key="t.traceId" class="clickable" @click="openTrace(t)">
              <td class="mono">{{ new Date(t.startMs).toLocaleString() }}</td>
              <td class="mono">{{ t.mcpToolName ?? "—" }}</td>
              <td>{{ t.spanCount }}</td>
              <td>{{ fmtDuration(t.endMs - t.startMs) }}</td>
              <td :class="{ hot: t.hasError }">{{ t.hasError ? "Error" : "OK" }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="pagination">
        <button type="button" class="btn-secondary" :disabled="cursorStack.length === 0" @click="prevPage">
          Previous
        </button>
        <button type="button" class="btn-secondary" :disabled="!nextCursor" @click="nextPage">Next</button>
        <p class="subtitle">{{ traces.length }} trace(s) on this page</p>
      </div>
    </template>

    <template v-else>
      <button type="button" class="link-btn back-link" @click="backToList">&larr; Back to traces</button>
      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
      <div v-if="loading" class="loading">Loading…</div>
      <div v-else-if="waterfall.rows.length === 0" class="empty-state">
        <p>Trace not found.</p>
      </div>
      <div v-else class="waterfall-card">
        <h2>Trace {{ traceId }}</h2>
        <div class="waterfall">
          <div v-for="row in waterfall.rows" :key="row.span.id" class="waterfall-row">
            <div class="waterfall-label" :title="row.span.name">{{ row.span.name }}</div>
            <div class="waterfall-track">
              <div
                class="waterfall-bar"
                :class="{ hot: row.span.statusCode === 2 }"
                :style="{ left: `${row.leftPct}%`, width: `${row.widthPct}%` }"
                :title="`${row.span.name} — ${row.durationMs}ms`"
              ></div>
            </div>
            <div class="waterfall-duration">{{ row.durationMs }}ms</div>
          </div>
        </div>
        <details class="attrs">
          <summary>Attributes (last span)</summary>
          <pre>{{ JSON.stringify(waterfall.rows[waterfall.rows.length - 1]?.span.attributes ?? {}, null, 2) }}</pre>
        </details>
      </div>
    </template>

    <ConfirmDialog
      :open="pendingPurge"
      title="Purge all traces?"
      message="Deletes every persisted span. This cannot be undone."
      confirm-label="Purge all"
      danger
      @confirm="confirmPurge"
      @cancel="pendingPurge = false"
    />
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
  max-width: 680px;
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
  min-width: 220px;
}
.btn-secondary.danger {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--breach);
  margin-left: auto;
}
.table-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
}
.trace-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.trace-table th {
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.trace-table td {
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.trace-table tbody tr:last-child td {
  border-bottom: none;
}
.pagination {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 1.25rem;
}
.pagination .subtitle {
  margin-left: 0.4rem;
}
.clickable {
  cursor: pointer;
}
.clickable:hover {
  background: var(--surface-sunken);
}
.mono {
  font-family: var(--font-mono);
  font-size: 0.82rem;
  white-space: nowrap;
}
.hot {
  color: var(--breach);
  font-weight: 600;
}
.error {
  color: var(--breach);
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
.back-link {
  display: inline-block;
  margin-bottom: 1rem;
}
.waterfall-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: 1.25rem;
}
.waterfall-card h2 {
  margin-top: 0;
  font-size: 0.95rem;
  font-family: var(--font-mono);
  word-break: break-all;
}
.waterfall {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.waterfall-row {
  display: grid;
  grid-template-columns: 200px 1fr 70px;
  align-items: center;
  gap: 0.75rem;
}
.waterfall-label {
  font-size: 0.82rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.waterfall-track {
  position: relative;
  height: 20px;
  background: var(--surface-sunken);
  border-radius: var(--radius-sm);
}
.waterfall-bar {
  position: absolute;
  top: 0;
  height: 100%;
  background: var(--signal);
  border-radius: var(--radius-sm);
  min-width: 2px;
}
.waterfall-bar.hot {
  background: var(--breach);
}
.waterfall-duration {
  font-size: 0.78rem;
  color: var(--text-muted);
  text-align: right;
  font-family: var(--font-mono);
}
.attrs {
  margin-top: 1rem;
  font-size: 0.8rem;
}
.attrs pre {
  background: var(--surface-sunken);
  padding: 0.6rem;
  border-radius: var(--radius-sm);
  overflow-x: auto;
}
.link-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.85rem;
  padding: 0;
  color: var(--signal-strong);
}
</style>

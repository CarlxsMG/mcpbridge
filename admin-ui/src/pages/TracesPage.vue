<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRouter, useRoute } from "vue-router";
import { api, ApiError } from "../composables/useApi";
import type { TraceSummary, StoredSpan, TopSessionRow, PaginatedResult } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import SignalLoader from "../components/SignalLoader.vue";
import MiniBarChart from "../components/MiniBarChart.vue";
import TableCard from "../components/TableCard.vue";
import EmptyState from "../components/EmptyState.vue";
import ChartCard from "../components/ChartCard.vue";
import PaginationBar from "../components/PaginationBar.vue";
import { Waypoints, Trash2 } from "lucide-vue-next";

const props = defineProps<{ traceId?: string }>();
const router = useRouter();
const route = useRoute();

const traces = ref<TraceSummary[]>([]);
const nextCursor = ref<string | undefined>(undefined);
const cursorStack = ref<(string | undefined)[]>([]);
const currentCursor = ref<string | undefined>(undefined);
const spans = ref<StoredSpan[] | null>(null);
const loading = ref(false);
const errorMessage = ref("");
const toolFilter = ref(typeof route.query.tool === "string" ? route.query.tool : "");
const sessionFilter = ref(typeof route.query.session_id === "string" ? route.query.session_id : "");
const initialCursor = typeof route.query.cursor === "string" ? route.query.cursor : undefined;
const pendingPurge = ref(false);
const purging = ref(false);
const topSessions = ref<TopSessionRow[]>([]);

function buildListQuery(cursor?: string): string {
  const params = new URLSearchParams();
  if (toolFilter.value.trim()) params.set("tool", toolFilter.value.trim());
  if (sessionFilter.value.trim()) params.set("session_id", sessionFilter.value.trim());
  if (cursor) params.set("cursor", cursor);
  params.set("limit", "50");
  return params.toString();
}

function currentFilterQuery(cursor?: string): Record<string, string | undefined> {
  return {
    tool: toolFilter.value.trim() || undefined,
    session_id: sessionFilter.value.trim() || undefined,
    cursor,
  };
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

async function loadTopSessions() {
  try {
    const result = await api.get<{ items: TopSessionRow[] }>("/admin-api/traces/top-sessions?limit=8");
    topSessions.value = result.items;
  } catch {
    // Nice-to-have summary — a failure here shouldn't block the trace list.
    topSessions.value = [];
  }
}

function applyFilters() {
  cursorStack.value = [];
  currentCursor.value = undefined;
  router.replace({ query: currentFilterQuery() });
  loadList();
}

function filterBySession(sessionId: string) {
  sessionFilter.value = sessionId;
  applyFilters();
}

function nextPage() {
  if (!nextCursor.value) return;
  cursorStack.value.push(currentCursor.value);
  currentCursor.value = nextCursor.value;
  router.replace({ query: currentFilterQuery(currentCursor.value) });
  loadList(currentCursor.value);
}

function prevPage() {
  if (cursorStack.value.length === 0) return;
  currentCursor.value = cursorStack.value.pop();
  router.replace({ query: currentFilterQuery(currentCursor.value || undefined) });
  loadList(currentCursor.value);
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
    currentCursor.value = undefined;
    await loadList();
  }
}
onMounted(() => {
  if (props.traceId) {
    loadDetail(props.traceId);
  } else {
    currentCursor.value = initialCursor;
    loadList(initialCursor);
    loadTopSessions();
  }
});
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
    currentCursor.value = undefined;
    await loadList();
    await loadTopSessions();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to purge traces.";
  } finally {
    purging.value = false;
  }
}

function fmtDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

/** Short display form of a session id (first 8 hex chars) — full id shown on hover / used for filtering. */
function shortSession(sessionId: string): string {
  return sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId;
}

const topSessionsChart = computed(() =>
  topSessions.value.map((s) => ({
    label: shortSession(s.sessionId),
    value: s.calls,
    danger: s.hasError,
  })),
);

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
        <input
          v-model="sessionFilter"
          type="text"
          placeholder="Session id"
          aria-label="Filter by session id"
          class="session-input"
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

      <ChartCard v-if="topSessionsChart.length" title="Top sessions by call volume" class="top-sessions-card">
        <MiniBarChart :rows="topSessionsChart" />
      </ChartCard>

      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
      <SignalLoader v-if="loading && !traces.length" />
      <EmptyState v-else-if="traces.length === 0" :icon="Waypoints">No traces recorded yet.</EmptyState>

      <TableCard v-else>
        <thead>
          <tr>
            <th>Started</th>
            <th>Tool</th>
            <th>Session</th>
            <th>Spans</th>
            <th>Duration</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in traces" :key="t.traceId" class="clickable" @click="openTrace(t)">
            <td class="mono">{{ new Date(t.startMs).toLocaleString() }}</td>
            <td class="mono">{{ t.mcpToolName ?? "—" }}</td>
            <td class="mono">
              <button
                v-if="t.sessionId"
                type="button"
                class="session-badge"
                :title="`Filter to session ${t.sessionId}`"
                @click.stop="filterBySession(t.sessionId)"
              >
                {{ shortSession(t.sessionId) }}
              </button>
              <span v-else>—</span>
            </td>
            <td>{{ t.spanCount }}</td>
            <td>{{ fmtDuration(t.endMs - t.startMs) }}</td>
            <td :class="{ hot: t.hasError }">{{ t.hasError ? "Error" : "OK" }}</td>
          </tr>
        </tbody>
      </TableCard>

      <div class="pagination">
        <PaginationBar :has-prev="cursorStack.length > 0" :has-next="!!nextCursor" @prev="prevPage" @next="nextPage" />
        <p class="subtitle">{{ traces.length }} trace(s) on this page</p>
      </div>
    </template>

    <template v-else>
      <button type="button" class="link-btn back-link" @click="backToList">&larr; Back to traces</button>
      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
      <SignalLoader v-if="loading" />
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
section {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}
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
  min-width: 13.75rem;
}
.filter-row input.session-input {
  font-family: var(--font-mono);
  min-width: 11.25rem;
}
.btn-secondary.danger {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--breach);
  margin-left: auto;
}
.session-badge {
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.15rem 0.45rem;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  cursor: pointer;
  color: var(--text-secondary);
}
.session-badge:hover {
  background: var(--surface);
  color: var(--signal-strong);
  border-color: var(--signal);
}
/* TableCard's own recipe hardcodes 0.6rem td padding; this page's table needs to
   keep respecting the live density toggle (body.density-compact), which the
   shared component doesn't account for. */
:deep(.data-table td) {
  padding: var(--table-pad-y) 0.85rem;
}
.pagination {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: auto;
  position: sticky;
  bottom: 0;
  z-index: 1;
  background: var(--paper);
  padding: var(--space-3) 0;
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
  grid-template-columns: 12.5rem 1fr 4.375rem;
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
  height: 1.25rem;
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

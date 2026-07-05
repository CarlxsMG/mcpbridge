<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter, useRoute } from "vue-router";
import { api } from "@/composables/useApi";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useQueryFilters } from "@/composables/useQueryFilters";
import { useCursorPagination } from "@/composables/useCursorPagination";
import { toErrorMessage } from "@/utils/errors";
import { formatDateTime, formatDuration } from "@/utils/format";
import type { TraceSummary, TopSessionRow, PaginatedResult } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import MiniBarChart from "@/components/charts/MiniBarChart.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import ChartCard from "@/components/charts/ChartCard.vue";
import PaginationBar from "@/components/ui/PaginationBar.vue";
import HoverPreview from "@/components/ui/HoverPreview.vue";
import SearchInput from "@/components/ui/SearchInput.vue";
import { Waypoints, Trash2 } from "lucide-vue-next";

const router = useRouter();
const route = useRoute();

const { filters, syncUrl } = useQueryFilters(["tool", "session_id"] as const);
const toolFilter = filters.tool;
const sessionFilter = filters.session_id;
const initialCursor = typeof route.query.cursor === "string" ? route.query.cursor : undefined;
const {
  pending: pendingPurge,
  request: requestPurge,
  cancel: cancelPurge,
  confirm: confirmActionPurge,
} = useConfirmAction<true>();
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

const {
  items: traces,
  loading,
  errorMessage,
  load: loadList,
  reset,
  next: nextPage,
  prev: prevPage,
  hasPrev,
  hasNext,
} = useCursorPagination<TraceSummary>(
  (cursor) => api.get<PaginatedResult<TraceSummary>>(`/admin-api/traces?${buildListQuery(cursor)}`),
  {
    initialCursor,
    onCursorChange: (cursor) => syncUrl({ cursor }),
    fallbackMessage: "Failed to load traces.",
  },
);

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
  reset();
  syncUrl();
  loadList();
}

function filterBySession(sessionId: string) {
  sessionFilter.value = sessionId;
  applyFilters();
}

onMounted(() => {
  loadList();
  loadTopSessions();
});

function openTrace(t: TraceSummary) {
  router.push({ name: "trace-detail", params: { traceId: t.traceId } });
}

async function confirmPurge() {
  await confirmActionPurge(async () => {
    purging.value = true;
    try {
      await api.delete("/admin-api/traces");
      reset();
      await loadList();
      await loadTopSessions();
    } catch (err) {
      errorMessage.value = toErrorMessage(err, "Failed to purge traces.");
    } finally {
      purging.value = false;
    }
  });
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
</script>

<template>
  <section class="list-shell">
    <PageHeader title="Traces" />
    <p class="subtitle">
      Per-call span timing for a built-in waterfall view — independent of any external OTLP collector. Opt-in (<code
        >TRACE_STORAGE=true</code
      >
      on the server) — an empty list can mean either storage is off or there's genuinely nothing recent.
    </p>

    <form class="filter-row" @submit.prevent="applyFilters">
      <SearchInput v-model="toolFilter" placeholder="Tool name (e.g. github__search_issues)" />
      <SearchInput v-model="sessionFilter" placeholder="Session id" class="session-input" />
      <button type="submit" class="btn-secondary">Filter</button>
      <button
        type="button"
        class="btn-secondary danger"
        :disabled="purging || traces.length === 0"
        @click="requestPurge(true)"
      >
        <Trash2 :size="14" stroke-width="2" aria-hidden="true" /> Purge all
      </button>
    </form>

    <ChartCard v-if="topSessionsChart.length" title="Top sessions by call volume" class="top-sessions-card">
      <MiniBarChart :rows="topSessionsChart" />
    </ChartCard>

    <ListLayout :loading="loading && !traces.length" :error="errorMessage" :empty="traces.length === 0">
      <template #empty>
        <EmptyState :icon="Waypoints">No traces recorded yet.</EmptyState>
      </template>

      <TableCard>
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
            <td class="mono">{{ formatDateTime(t.startMs) }}</td>
            <td class="mono">{{ t.mcpToolName ?? "—" }}</td>
            <td class="mono">
              <HoverPreview v-if="t.sessionId" always-show no-tabindex mono :text="t.sessionId">
                <template #default="{ panelId, visible }">
                  <button
                    type="button"
                    class="session-badge"
                    :aria-describedby="visible ? panelId : undefined"
                    @click.stop="filterBySession(t.sessionId)"
                  >
                    {{ shortSession(t.sessionId) }}
                  </button>
                </template>
              </HoverPreview>
              <span v-else>—</span>
            </td>
            <td>{{ t.spanCount }}</td>
            <td>{{ formatDuration(t.endMs - t.startMs) }}</td>
            <td :class="{ hot: t.hasError }">{{ t.hasError ? "Error" : "OK" }}</td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <div class="sticky-pagination">
      <PaginationBar
        :has-prev="hasPrev"
        :has-next="hasNext"
        :label="`${traces.length} trace(s) on this page`"
        @prev="prevPage"
        @next="nextPage"
      />
    </div>

    <ConfirmDialog
      :open="pendingPurge !== null"
      title="Purge all traces?"
      message="Deletes every persisted span. This cannot be undone."
      confirm-label="Purge all"
      danger
      @confirm="confirmPurge"
      @cancel="cancelPurge"
    />
  </section>
</template>

<style scoped>
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
.filter-row :deep(.search-input) {
  min-width: 13.75rem;
}
.filter-row .session-input {
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
.clickable {
  cursor: pointer;
}
.clickable:hover {
  background: var(--surface-sunken);
}
</style>

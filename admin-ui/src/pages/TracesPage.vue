<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter, useRoute } from "vue-router";
import { api } from "@/composables/useApi";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useQueryFilters } from "@/composables/useQueryFilters";
import { useCursorPagination } from "@/composables/useCursorPagination";
import { toErrorMessage } from "@/utils/errors";
import { formatDateTime, formatDuration } from "@/utils/format";
import { tk } from "@/i18n";
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

const { t } = useI18n({ useScope: "global" });

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
    fallbackMessage: tk("pages.traces.errors.load_failed"),
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

function openTrace(trace: TraceSummary) {
  router.push({ name: "trace-detail", params: { traceId: trace.traceId } });
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
      errorMessage.value = toErrorMessage(err, tk("pages.traces.errors.purge_failed"));
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
    <PageHeader :title="t('pages.traces.title')" />
    <p class="subtitle">
      {{ t('pages.traces.subtitle_p1') }} (<code>TRACE_STORAGE=true</code>) {{ t('pages.traces.subtitle_p2') }}
    </p>

    <form class="filter-row" @submit.prevent="applyFilters">
      <SearchInput v-model="toolFilter" :placeholder="t('pages.traces.tool_placeholder')" />
      <SearchInput v-model="sessionFilter" :placeholder="t('pages.traces.session_placeholder')" class="session-input" />
      <button type="submit" class="btn-secondary">{{ t('pages.traces.filter_button') }}</button>
      <button
        type="button"
        class="btn-secondary danger"
        :disabled="purging || traces.length === 0"
        @click="requestPurge(true)"
      >
        <Trash2 :size="14" stroke-width="2" aria-hidden="true" /> {{ t('pages.traces.purge_all') }}
      </button>
    </form>

    <ChartCard v-if="topSessionsChart.length" :title="t('pages.traces.top_sessions')" class="top-sessions-card">
      <MiniBarChart :rows="topSessionsChart" />
    </ChartCard>

    <ListLayout :loading="loading && !traces.length" :error="errorMessage" :empty="traces.length === 0">
      <template #empty>
        <EmptyState :icon="Waypoints">{{ t('pages.traces.empty.no_traces') }}</EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th>{{ t('pages.traces.table.started') }}</th>
            <th>{{ t('pages.traces.table.tool') }}</th>
            <th>{{ t('pages.traces.table.session') }}</th>
            <th>{{ t('pages.traces.table.spans') }}</th>
            <th>{{ t('pages.traces.table.duration') }}</th>
            <th>{{ t('pages.traces.table.status') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="trace in traces" :key="trace.traceId" class="clickable" @click="openTrace(trace)">
            <td class="mono">{{ formatDateTime(trace.startMs) }}</td>
            <td class="mono">{{ trace.mcpToolName ?? "—" }}</td>
            <td class="mono">
              <HoverPreview v-if="trace.sessionId" always-show no-tabindex mono :text="trace.sessionId">
                <template #default="{ panelId, visible }">
                  <button
                    type="button"
                    class="session-badge"
                    :aria-describedby="visible ? panelId : undefined"
                    @click.stop="filterBySession(trace.sessionId)"
                  >
                    {{ shortSession(trace.sessionId) }}
                  </button>
                </template>
              </HoverPreview>
              <span v-else>—</span>
            </td>
            <td>{{ trace.spanCount }}</td>
            <td>{{ formatDuration(trace.endMs - trace.startMs) }}</td>
            <td :class="{ hot: trace.hasError }">{{ trace.hasError ? t('pages.traces.table.status_error') : t('pages.traces.table.status_ok') }}</td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <div class="sticky-pagination">
      <PaginationBar
        :has-prev="hasPrev"
        :has-next="hasNext"
        :label="t('pages.traces.pagination_label', { count: traces.length })"
        @prev="prevPage"
        @next="nextPage"
      />
    </div>

    <ConfirmDialog
      :open="pendingPurge !== null"
      :title="t('pages.traces.confirm.purge_title')"
      :message="t('pages.traces.confirm.purge_message')"
      :confirm-label="t('pages.traces.confirm.purge_cta')"
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
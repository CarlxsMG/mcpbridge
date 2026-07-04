<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { useRoute } from "vue-router";
import { api } from "@/composables/useApi";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useQueryFilters } from "@/composables/useQueryFilters";
import { useCursorPagination } from "@/composables/useCursorPagination";
import { toErrorMessage } from "@/utils/errors";
import { formatDateTime } from "@/utils/format";
import type { TrafficRecord, PaginatedResult } from "@/types/api";
import TimeSeriesChart from "@/components/charts/TimeSeriesChart.vue";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import ChartCard from "@/components/charts/ChartCard.vue";
import PaginationBar from "@/components/ui/PaginationBar.vue";
import HoverPreview from "@/components/ui/HoverPreview.vue";
import { ArrowLeftRight, Repeat, Filter } from "lucide-vue-next";

const route = useRoute();

const { filters, syncUrl } = useQueryFilters(["client", "tool"] as const);
const clientFilter = filters.client;
const toolFilter = filters.tool;
const errorsOnly = ref(route.query.errors === "true");
const initialCursor = typeof route.query.cursor === "string" ? route.query.cursor : undefined;

const replayingId = ref<number | null>(null);
const replayNote = ref<{ id: number; ok: boolean; text: string } | null>(null);

function buildQuery(cursor?: string): string {
  const params = new URLSearchParams();
  if (clientFilter.value.trim()) params.set("client", clientFilter.value.trim());
  if (toolFilter.value.trim()) params.set("tool", toolFilter.value.trim());
  if (errorsOnly.value) params.set("errors", "true");
  if (cursor) params.set("cursor", cursor);
  params.set("limit", "50");
  return params.toString();
}

const {
  items: records,
  loading,
  errorMessage,
  load,
  reset,
  next: nextPage,
  prev: prevPage,
  hasPrev,
  hasNext,
} = useCursorPagination<TrafficRecord>(
  (cursor) => api.get<PaginatedResult<TrafficRecord>>(`/admin-api/traffic?${buildQuery(cursor)}`),
  {
    initialCursor,
    fallbackMessage: "Failed to load traffic. Check your connection and try again.",
    onCursorChange: (cursor) => syncUrl({ errors: errorsOnly.value ? "true" : undefined, cursor }),
  },
);

function applyFilters() {
  reset();
  syncUrl({ errors: errorsOnly.value ? "true" : undefined });
  load();
}

onMounted(() => load());

function formatDuration(ms: number): string {
  return `${ms}ms`;
}

const chart = computed(() => {
  const rows = records.value;
  if (rows.length === 0)
    return { points: [] as { t: number; v: number }[], errorPoints: [] as { t: number; v: number }[] };
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

const {
  pending: pendingReplay,
  request: requestReplay,
  cancel: cancelReplay,
  confirm: confirmActionReplay,
} = useConfirmAction<TrafficRecord>();

function replay(r: TrafficRecord) {
  requestReplay(r);
}

function confirmReplay() {
  return confirmActionReplay(async (r) => {
    replayingId.value = r.id;
    replayNote.value = null;
    try {
      const res = await api.post<{ content?: { type: string; text: string }[]; isError?: boolean }>(
        `/admin-api/traffic/${r.id}/replay`,
      );
      const text = res.content?.map((c) => c.text).join(" ") ?? "(no content)";
      replayNote.value = { id: r.id, ok: !res.isError, text: text.length > 300 ? `${text.slice(0, 300)}…` : text };
    } catch (err) {
      replayNote.value = { id: r.id, ok: false, text: toErrorMessage(err, "Replay failed.") };
    } finally {
      replayingId.value = null;
    }
  });
}
</script>

<template>
  <section class="list-shell">
    <PageHeader title="Traffic" />
    <p class="subtitle">
      Captured request/response calls. Capture is opt-in (<code>TRAFFIC_CAPTURE=true</code> on the server) — an empty
      list here can mean either capture is off or there's genuinely nothing recent.
    </p>

    <form class="filter-row" @submit.prevent="applyFilters">
      <div class="filter-field">
        <span class="filter-label">Client name</span>
        <input v-model="clientFilter" type="text" placeholder="Client name" aria-label="Filter by client" />
      </div>
      <div class="filter-field">
        <span class="filter-label">Tool name</span>
        <input v-model="toolFilter" type="text" placeholder="Tool name" aria-label="Filter by tool" />
      </div>
      <label class="errors-only"><input v-model="errorsOnly" type="checkbox" /> Errors only</label>
      <button type="submit" class="btn-secondary" :disabled="loading">
        <Filter :size="14" stroke-width="2" aria-hidden="true" /> {{ loading ? "Filtering…" : "Filter" }}
      </button>
    </form>

    <p v-if="replayNote" :class="replayNote.ok ? 'success' : 'error'" role="status">
      Replayed call #{{ replayNote.id }} against the upstream tool — {{ replayNote.ok ? "succeeded" : "failed" }}:
      {{ replayNote.text }}
    </p>

    <ListLayout :loading="loading && !records.length" :error="errorMessage" :empty="records.length === 0">
      <template #empty>
        <EmptyState :icon="ArrowLeftRight">
          No traffic recorded yet. If <code>TRAFFIC_CAPTURE</code> isn't set on the server, calls aren't being recorded
          — enable it, then check back after your next request.
        </EmptyState>
      </template>

      <ChartCard title="Call volume" dotted>
        <TimeSeriesChart
          :points="chart.points"
          :secondary-points="chart.errorPoints"
          primary-label="Calls"
          secondary-label="Errors"
          :height="160"
        />
      </ChartCard>

      <TableCard>
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
            <td class="mono">{{ formatDateTime(r.createdAt) }}</td>
            <td class="mono">{{ r.clientName ?? "—" }}/{{ r.toolName ?? r.mcpToolName }}</td>
            <td>{{ formatDuration(r.durationMs) }}</td>
            <td :class="{ hot: r.isError }">{{ r.isError ? "Error" : "OK" }}</td>
            <td>
              <HoverPreview class="cell-truncate" :text="r.preview">{{ r.preview }}</HoverPreview>
            </td>
            <td>
              <div class="actions">
                <button
                  type="button"
                  class="link-btn"
                  :disabled="replayingId === r.id"
                  title="Sends this call to the upstream tool again, right now."
                  @click="replay(r)"
                >
                  <Repeat :size="13" stroke-width="2" aria-hidden="true" />
                  {{ replayingId === r.id ? "Replaying…" : "Replay" }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </TableCard>

      <div class="sticky-pagination">
        <PaginationBar :has-prev="hasPrev" :has-next="hasNext" @prev="prevPage" @next="nextPage" />
        <p class="subtitle">{{ records.length }} record(s) on this page</p>
      </div>
    </ListLayout>

    <ConfirmDialog
      :open="pendingReplay !== null"
      title="Replay this call?"
      :message="
        pendingReplay
          ? `This sends '${pendingReplay.mcpToolName}' to the live upstream again, right now, with the same arguments — including any side effects (writes, refunds, deletes) the original call had.`
          : ''
      "
      :confirm-label="pendingReplay ? `Replay ${pendingReplay.mcpToolName}` : 'Replay'"
      danger
      @confirm="confirmReplay"
      @cancel="cancelReplay"
    />
  </section>
</template>

<style scoped>
.subtitle {
  color: var(--text-secondary);
  margin: 0;
  max-width: 40rem;
}
.filter-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.filter-label {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.filter-row input[type="text"] {
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-family: var(--font-body);
  font-size: 0.9rem;
  min-width: 10rem;
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
/* TableCard's global .data-table recipe doesn't set white-space on th;
   this page needs its long "Time" header to stay on one line. */
:deep(.data-table th) {
  white-space: nowrap;
}
.cell-truncate {
  max-width: 20rem;
  color: var(--text-secondary);
}
.actions {
  white-space: nowrap;
}
.success {
  color: var(--ok);
}
/* EmptyState's own recipe colors its paragraph via --text-secondary on the
   wrapper; this page's empty copy is intentionally a step lighter. */
:deep(.empty-state p) {
  color: var(--text-muted);
}
</style>

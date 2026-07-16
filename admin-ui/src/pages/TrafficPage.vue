<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api } from "@/composables/useApi";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useQueryFilters } from "@/composables/useQueryFilters";
import { useCursorPagination } from "@/composables/useCursorPagination";
import { toErrorMessage } from "@/utils/errors";
import { formatDateTime, formatDuration } from "@/utils/format";
import { tk } from "@/i18n";
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
import SearchInput from "@/components/ui/SearchInput.vue";
import { ArrowLeftRight, Repeat, Filter } from "lucide-vue-next";

const { t } = useI18n({ useScope: "global" });

const route = useRoute();
const router = useRouter();

const { filters } = useQueryFilters(["client", "tool"] as const);
const clientFilter = filters.client;
const toolFilter = filters.tool;
const errorsOnly = ref(route.query.errors === "true");
const initialCursor = typeof route.query.cursor === "string" ? route.query.cursor : undefined;

const replayingId = ref<number | null>(null);
const replayNote = ref<{ id: number; ok: boolean; text: string } | null>(null);

// Snapshot of the last *applied* filters, not the live input refs — pagination is
// "apply on submit," so a cursor fetched mid-edit must keep using the query that
// produced it rather than whatever the user has since typed but not submitted.
const appliedFilters = ref({ client: clientFilter.value, tool: toolFilter.value, errors: errorsOnly.value });

function buildQuery(cursor?: string): string {
  const params = new URLSearchParams();
  if (appliedFilters.value.client.trim()) params.set("client", appliedFilters.value.client.trim());
  if (appliedFilters.value.tool.trim()) params.set("tool", appliedFilters.value.tool.trim());
  if (appliedFilters.value.errors) params.set("errors", "true");
  if (cursor) params.set("cursor", cursor);
  params.set("limit", "50");
  return params.toString();
}

// Writes the URL from the applied snapshot (not the live filter refs), so pagination
// never overwrites the query string with an edited-but-unapplied filter value.
function syncUrlFromSnapshot(cursor?: string) {
  void router.replace({
    query: {
      client: appliedFilters.value.client.trim() || undefined,
      tool: appliedFilters.value.tool.trim() || undefined,
      errors: appliedFilters.value.errors ? "true" : undefined,
      cursor,
    },
  });
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
    fallbackMessage: tk("pages.traffic.errors.load_failed"),
    onCursorChange: (cursor) => syncUrlFromSnapshot(cursor),
  },
);

function applyFilters() {
  appliedFilters.value = { client: clientFilter.value, tool: toolFilter.value, errors: errorsOnly.value };
  reset();
  syncUrlFromSnapshot();
  load();
}

onMounted(() => load());

const chart = computed(() => {
  const rows = records.value;
  if (rows.length === 0)
    return { points: [] as { t: number; v: number }[], errorPoints: [] as { t: number; v: number }[] };
  const times = rows.map((r) => r.createdAt);
  const min = Math.min(...times);
  const max = Math.max(...times);
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

function replay(record: TrafficRecord) {
  requestReplay(record);
}

function confirmReplay() {
  return confirmActionReplay(async (record) => {
    replayingId.value = record.id;
    replayNote.value = null;
    try {
      const res = await api.post<{ content?: { type: string; text: string }[]; isError?: boolean }>(
        `/admin-api/traffic/${record.id}/replay`,
      );
      const text = res.content?.map((c) => c.text).join(" ") ?? t("pages.traffic.replay.no_content");
      replayNote.value = {
        id: record.id,
        ok: !res.isError,
        text: text.length > 300 ? `${text.slice(0, 300)}…` : text,
      };
    } catch (err) {
      replayNote.value = {
        id: record.id,
        ok: false,
        text: toErrorMessage(err, tk("pages.traffic.errors.replay_failed")),
      };
    } finally {
      replayingId.value = null;
    }
  });
}
</script>

<template>
  <section class="list-shell">
    <PageHeader :title="t('pages.traffic.title')" />
    <p class="subtitle">
      {{ t("pages.traffic.subtitle_p1") }} (<code>TRAFFIC_CAPTURE=true</code>) {{ t("pages.traffic.subtitle_p2") }}
    </p>

    <form class="filter-row" @submit.prevent="applyFilters">
      <div class="filter-field">
        <span class="filter-label">{{ t("pages.traffic.filters.client_label") }}</span>
        <SearchInput v-model="clientFilter" :placeholder="t('pages.traffic.filters.client_label')" />
      </div>
      <div class="filter-field">
        <span class="filter-label">{{ t("pages.traffic.filters.tool_label") }}</span>
        <SearchInput v-model="toolFilter" :placeholder="t('pages.traffic.filters.tool_label')" />
      </div>
      <label class="errors-only"
        ><input v-model="errorsOnly" type="checkbox" /> {{ t("pages.traffic.errors_only") }}</label
      >
      <button type="submit" class="btn-secondary" :disabled="loading">
        <Filter :size="14" stroke-width="2" aria-hidden="true" />
        {{ loading ? t("pages.traffic.filtering") : t("pages.traffic.filter_button") }}
      </button>
    </form>

    <p v-if="replayNote" :class="replayNote.ok ? 'success' : 'error'" role="status">
      {{ t("pages.traffic.replay.note_p1", { id: replayNote.id }) }}
      {{ replayNote.ok ? t("pages.traffic.replay.succeeded") : t("pages.traffic.replay.failed") }}:
      {{ replayNote.text }}
    </p>

    <ListLayout :loading="loading && !records.length" :error="errorMessage" :empty="records.length === 0">
      <template #empty>
        <EmptyState :icon="ArrowLeftRight" muted>
          {{ t("pages.traffic.empty_p1") }}
          <code>TRAFFIC_CAPTURE</code>
          {{ t("pages.traffic.empty_p2") }}
        </EmptyState>
      </template>

      <ChartCard :title="t('pages.traffic.chart.title')" dotted>
        <TimeSeriesChart
          :points="chart.points"
          :secondary-points="chart.errorPoints"
          :primary-label="t('pages.traffic.chart.primary_label')"
          :secondary-label="t('pages.traffic.chart.secondary_label')"
          :height="160"
        />
      </ChartCard>

      <TableCard>
        <thead>
          <tr>
            <th scope="col">{{ t("pages.traffic.table.time") }}</th>
            <th scope="col">{{ t("pages.traffic.table.client_tool") }}</th>
            <th scope="col">{{ t("pages.traffic.table.duration") }}</th>
            <th scope="col">{{ t("pages.traffic.table.status") }}</th>
            <th scope="col">{{ t("pages.traffic.table.preview") }}</th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in records" :key="record.id">
            <td class="mono">{{ formatDateTime(record.createdAt) }}</td>
            <td class="mono">{{ record.clientName ?? "—" }}/{{ record.toolName ?? record.mcpToolName }}</td>
            <td>{{ formatDuration(record.durationMs) }}</td>
            <td :class="{ hot: record.isError }">
              {{ record.isError ? t("pages.traffic.table.status_error") : t("pages.traffic.table.status_ok") }}
            </td>
            <td>
              <HoverPreview class="cell-truncate" :text="record.preview">{{ record.preview }}</HoverPreview>
            </td>
            <td>
              <div class="actions">
                <button
                  type="button"
                  class="link-btn"
                  :disabled="replayingId === record.id"
                  :title="t('pages.traffic.replay.tooltip')"
                  @click="replay(record)"
                >
                  <Repeat :size="13" stroke-width="2" aria-hidden="true" />
                  {{
                    replayingId === record.id ? t("pages.traffic.replay.replaying") : t("pages.traffic.replay.replay")
                  }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </TableCard>

      <div class="sticky-pagination">
        <PaginationBar
          :has-prev="hasPrev"
          :has-next="hasNext"
          :label="t('pages.traffic.pagination_label', { count: records.length })"
          @prev="prevPage"
          @next="nextPage"
        />
      </div>
    </ListLayout>

    <ConfirmDialog
      :open="pendingReplay !== null"
      :title="t('pages.traffic.confirm.replay_title')"
      :message="pendingReplay ? t('pages.traffic.confirm.replay_message', { name: pendingReplay.mcpToolName }) : ''"
      :confirm-label="
        pendingReplay
          ? t('pages.traffic.confirm.replay_cta', { name: pendingReplay.mcpToolName })
          : t('pages.traffic.replay.replay')
      "
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
</style>

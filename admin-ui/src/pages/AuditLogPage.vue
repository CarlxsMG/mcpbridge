<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useCursorPagination } from "@/composables/useCursorPagination";
import { toErrorMessage } from "@/utils/errors";
import { formatDateTime, prettyJson } from "@/utils/format";
import { downloadTextFile } from "@/utils/download";
import { tk } from "@/i18n";
import type { AuditLogEntry, PaginatedResult } from "@/types/api";
import { ScrollText, CheckCircle2, XCircle } from "lucide-vue-next";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import SearchInput from "@/components/ui/SearchInput.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import HoverPreview from "@/components/ui/HoverPreview.vue";

const { t } = useI18n({ useScope: "global" });

const actorFilter = ref("");
const actionFilter = ref("");
const fromDate = ref("");
const toDate = ref("");

const knownActions = ref<string[]>([]);
const actionOptions = computed(() => [
  { value: "", label: t("pages.audit_log.filter.all_actions") },
  ...knownActions.value.map((a) => ({ value: a, label: a })),
]);
async function loadActions() {
  try {
    const result = await api.get<{ actions: string[] }>("/admin-api/audit-log/actions");
    knownActions.value = result.actions;
  } catch {
    // Non-fatal — the action filter just falls back to free text.
  }
}

const hasActiveFilters = computed(() => !!(actorFilter.value || actionFilter.value || fromDate.value || toDate.value));

function dateStartMs(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00`).getTime();
}
function dateEndMs(dateStr: string): number {
  return new Date(`${dateStr}T23:59:59.999`).getTime();
}

function buildFilterParams(): URLSearchParams {
  const params = new URLSearchParams();
  if (actorFilter.value) params.set("actor", actorFilter.value);
  if (actionFilter.value) params.set("action", actionFilter.value);
  if (fromDate.value) params.set("from", String(dateStartMs(fromDate.value)));
  if (toDate.value) params.set("to", String(dateEndMs(toDate.value)));
  return params;
}

const loadFallback = tk("pages.audit_log.errors.load_failed");
const exportFallback = tk("pages.audit_log.errors.export_failed");
const verifyFallback = tk("pages.audit_log.errors.verify_failed");

const {
  items: entries,
  loading,
  errorMessage,
  load,
  loadMore,
  hasNext,
} = useCursorPagination<AuditLogEntry>(
  (cursor) => {
    const params = buildFilterParams();
    if (cursor) params.set("cursor", cursor);
    return api.get<PaginatedResult<AuditLogEntry>>(`/admin-api/audit-log?${params.toString()}`);
  },
  { fallbackMessage: loadFallback },
);

function applyFilter() {
  load();
}

function clearFilters() {
  actorFilter.value = "";
  actionFilter.value = "";
  fromDate.value = "";
  toDate.value = "";
  applyFilter();
}

const exportFormat = ref<"json" | "csv" | "html">("json");
const EXPORT_FORMAT_OPTIONS = computed(() => [
  { value: "json" as const, label: t("pages.audit_log.export.json") },
  { value: "csv" as const, label: t("pages.audit_log.export.csv") },
  { value: "html" as const, label: t("pages.audit_log.export.html") },
]);
const exporting = ref(false);
const EXPORT_MIME: Record<"json" | "csv" | "html", string> = {
  json: "application/json",
  csv: "text/csv",
  html: "text/html",
};

async function exportLog() {
  errorMessage.value = "";
  exporting.value = true;
  try {
    const params = buildFilterParams();
    params.set("format", exportFormat.value);
    const content =
      exportFormat.value === "json"
        ? prettyJson(
            (await api.get<{ items: AuditLogEntry[] }>(`/admin-api/audit-log/export?${params.toString()}`)).items,
          )
        : await api.getRaw(`/admin-api/audit-log/export?${params.toString()}`);
    downloadTextFile(`audit-log.${exportFormat.value}`, content, EXPORT_MIME[exportFormat.value]);
  } catch (err) {
    errorMessage.value = toErrorMessage(err, exportFallback);
  } finally {
    exporting.value = false;
  }
}

const integrity = ref<{ ok: boolean; checked: number; brokenAtId?: number } | null>(null);
const verifying = ref(false);
async function verifyIntegrity() {
  verifying.value = true;
  integrity.value = null;
  errorMessage.value = "";
  try {
    integrity.value = await api.get<{ ok: boolean; checked: number; brokenAtId?: number }>(
      "/admin-api/audit-log/verify",
    );
  } catch (err) {
    errorMessage.value = toErrorMessage(err, verifyFallback);
  } finally {
    verifying.value = false;
  }
}

onMounted(() => {
  load();
  loadActions();
});
</script>

<template>
  <section>
    <PageHeader :title="t('pages.audit_log.title')" :subtitle="t('pages.audit_log.subtitle')" />

    <form class="filters" @submit.prevent="applyFilter">
      <div class="field">
        <label for="actor-filter">{{ t("pages.audit_log.filter.actor") }}</label>
        <SearchInput v-model="actorFilter" :placeholder="t('pages.audit_log.filter.actor_placeholder')" />
      </div>

      <div class="field">
        <label for="action-filter">{{ t("pages.audit_log.filter.action") }}</label>
        <SelectMenu v-if="knownActions.length" id="action-filter" v-model="actionFilter" :options="actionOptions" />
        <SearchInput v-else v-model="actionFilter" :placeholder="t('pages.audit_log.filter.action_placeholder')" />
      </div>

      <div class="field">
        <label for="from-filter">{{ t("pages.audit_log.filter.from") }}</label>
        <input id="from-filter" v-model="fromDate" type="date" />
      </div>

      <div class="field">
        <label for="to-filter">{{ t("pages.audit_log.filter.to") }}</label>
        <input id="to-filter" v-model="toDate" type="date" />
      </div>

      <button type="submit" class="btn-secondary">{{ t("common.apply") }}</button>
      <button v-if="hasActiveFilters" type="button" class="link-btn" @click="clearFilters">
        {{ t("pages.audit_log.filter.clear") }}
      </button>

      <div class="field export-field">
        <label for="export-format">{{ t("pages.audit_log.filter.export_as") }}</label>
        <SelectMenu id="export-format" v-model="exportFormat" :options="EXPORT_FORMAT_OPTIONS" />
      </div>
      <button type="button" class="btn-secondary" :disabled="exporting" @click="exportLog">
        {{ exporting ? t("pages.audit_log.exporting") : t("pages.audit_log.export.cta") }}
      </button>
    </form>

    <div class="integrity-actions">
      <button type="button" class="btn-secondary" :disabled="verifying" @click="verifyIntegrity">
        {{ verifying ? t("pages.audit_log.verifying") : t("pages.audit_log.verify_cta") }}
      </button>
    </div>

    <p v-if="integrity" class="integrity" :class="integrity.ok ? 'ok' : 'broken'">
      <CheckCircle2 v-if="integrity.ok" :size="16" stroke-width="2" aria-hidden="true" />
      <XCircle v-else :size="16" stroke-width="2" aria-hidden="true" />
      <span v-if="integrity.ok">{{ t("pages.audit_log.integrity_ok", { count: integrity.checked }) }}</span>
      <span v-else>{{
        t("pages.audit_log.integrity_broken", { id: integrity.brokenAtId, count: integrity.checked })
      }}</span>
    </p>

    <ListLayout :loading="loading && !entries.length" :error="errorMessage" :empty="entries.length === 0">
      <template #empty>
        <EmptyState :icon="ScrollText">
          <template v-if="hasActiveFilters">
            {{ t("pages.audit_log.empty.no_match") }}
            <button type="button" class="link-btn" @click="clearFilters">
              {{ t("pages.audit_log.filter.clear") }}
            </button>
          </template>
          <template v-else>{{ t("pages.audit_log.empty.no_entries") }}</template>
        </EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th>{{ t("pages.audit_log.table.when") }}</th>
            <th>{{ t("pages.audit_log.table.actor") }}</th>
            <th>{{ t("pages.audit_log.table.action") }}</th>
            <th>{{ t("pages.audit_log.table.target") }}</th>
            <th>{{ t("pages.audit_log.table.detail") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in entries" :key="entry.id">
            <td>{{ formatDateTime(entry.createdAt) }}</td>
            <td>{{ entry.actor }}</td>
            <td>
              <code>{{ entry.action }}</code>
            </td>
            <td>{{ entry.target }}</td>
            <td>
              <HoverPreview
                v-if="entry.detail"
                always-show
                mono
                :text="prettyJson(entry.detail)"
                class="detail-trigger"
              >
                {{ t("pages.audit_log.table.view") }}
              </HoverPreview>
              <span v-else class="detail-none">—</span>
            </td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <button v-if="hasNext" type="button" class="btn-secondary" :disabled="loading" @click="loadMore">
      {{ loading ? t("common.loading") : t("common.load_more") }}
    </button>
  </section>
</template>

<style scoped>
.filters {
  display: flex;
  align-items: flex-end;
  gap: 0.6rem;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}
.filters .field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
}
.filters input[type="date"] {
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 0.45rem 0.6rem;
  background: var(--surface);
  font-family: var(--font-body);
  font-size: 0.9rem;
  color: inherit;
}
.export-field {
  margin-left: auto;
}
:deep(.search-input) {
  max-width: 16.25rem;
}
.integrity-actions {
  margin-bottom: 1.25rem;
}
:deep(.data-table) {
  font-size: 0.88rem;
}
:deep(.table-card) {
  margin-bottom: 1rem;
}
.detail-trigger {
  color: var(--signal-strong);
  font-size: 0.85rem;
}
.detail-none {
  color: var(--text-muted);
}
.integrity {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 0.9rem;
  border-radius: var(--radius-md);
  font-size: 0.9rem;
  margin-bottom: 1rem;
}
.integrity svg {
  flex-shrink: 0;
}
.integrity.ok {
  background: var(--ok-soft);
  color: var(--ok);
  border: 1px solid var(--ok);
}
.integrity.broken {
  background: var(--breach-soft);
  color: var(--breach);
  border: 1px solid var(--breach);
}
</style>

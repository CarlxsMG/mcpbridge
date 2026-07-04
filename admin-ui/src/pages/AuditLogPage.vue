<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { api } from "@/composables/useApi";
import { useLoadState } from "@/composables/useResource";
import { toErrorMessage } from "@/utils/errors";
import { formatDateTime, prettyJson } from "@/utils/format";
import { downloadTextFile } from "@/utils/download";
import type { AuditLogEntry, PaginatedResult } from "@/types/api";
import { ScrollText, CheckCircle2, XCircle } from "lucide-vue-next";
import PageHeader from "@/components/ui/PageHeader.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import SearchInput from "@/components/ui/SearchInput.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";

const entries = ref<AuditLogEntry[]>([]);
const { loading, errorMessage, run } = useLoadState("Failed to load audit log.");
const nextCursor = ref<string | undefined>(undefined);
const actorFilter = ref("");
const actionFilter = ref("");
const fromDate = ref(""); // yyyy-mm-dd, from <input type="date">
const toDate = ref("");

/** Known action values already present in the log, for the action filter's dropdown. Falls back to a free-text input if this comes back empty. */
const knownActions = ref<string[]>([]);
const actionOptions = computed(() => [
  { value: "", label: "All actions" },
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

/** Local midnight of the given yyyy-mm-dd, inclusive lower bound. */
function dateStartMs(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00`).getTime();
}
/** The last instant of the given yyyy-mm-dd, inclusive upper bound. */
function dateEndMs(dateStr: string): number {
  return new Date(`${dateStr}T23:59:59.999`).getTime();
}

/** Shared by both the list view and the export download — keeps the two filter sets from drifting apart. */
function buildFilterParams(): URLSearchParams {
  const params = new URLSearchParams();
  if (actorFilter.value) params.set("actor", actorFilter.value);
  if (actionFilter.value) params.set("action", actionFilter.value);
  if (fromDate.value) params.set("from", String(dateStartMs(fromDate.value)));
  if (toDate.value) params.set("to", String(dateEndMs(toDate.value)));
  return params;
}

async function load(cursor?: string) {
  await run(async () => {
    const params = buildFilterParams();
    if (cursor) params.set("cursor", cursor);
    const result = await api.get<PaginatedResult<AuditLogEntry>>(`/admin-api/audit-log?${params.toString()}`);
    entries.value = cursor ? [...entries.value, ...result.items] : result.items;
    nextCursor.value = result.nextCursor;
  });
}

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
const EXPORT_FORMAT_OPTIONS: { value: "json" | "csv" | "html"; label: string }[] = [
  { value: "json", label: "JSON" },
  { value: "csv", label: "CSV" },
  { value: "html", label: "HTML report" },
];
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
    // JSON keeps its original pretty-printed-items-array shape for backwards
    // compatibility with anyone already relying on this download; CSV/HTML are
    // opaque text the backend renders — both flow through the same
    // getRaw-then-Blob download, just with a different format= and mime type.
    const content =
      exportFormat.value === "json"
        ? prettyJson(
            (await api.get<{ items: AuditLogEntry[] }>(`/admin-api/audit-log/export?${params.toString()}`)).items,
          )
        : await api.getRaw(`/admin-api/audit-log/export?${params.toString()}`);
    downloadTextFile(`audit-log.${exportFormat.value}`, content, EXPORT_MIME[exportFormat.value]);
  } catch (err) {
    errorMessage.value = toErrorMessage(err, "Export failed.");
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
    errorMessage.value = toErrorMessage(err, "Verification failed.");
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
    <PageHeader title="Audit log" subtitle="Who changed what, and when." />

    <form class="filters" @submit.prevent="applyFilter">
      <div class="field">
        <label for="actor-filter">Actor</label>
        <SearchInput v-model="actorFilter" placeholder="Filter by actor…" />
      </div>

      <div class="field">
        <label for="action-filter">Action</label>
        <SelectMenu v-if="knownActions.length" id="action-filter" v-model="actionFilter" :options="actionOptions" />
        <SearchInput v-else v-model="actionFilter" placeholder="Filter by action…" />
      </div>

      <div class="field">
        <label for="from-filter">From</label>
        <input id="from-filter" v-model="fromDate" type="date" />
      </div>

      <div class="field">
        <label for="to-filter">To</label>
        <input id="to-filter" v-model="toDate" type="date" />
      </div>

      <button type="submit" class="btn-secondary">Apply</button>
      <button v-if="hasActiveFilters" type="button" class="link-btn" @click="clearFilters">Clear</button>

      <div class="field export-field">
        <label for="export-format">Export as</label>
        <SelectMenu id="export-format" v-model="exportFormat" :options="EXPORT_FORMAT_OPTIONS" />
      </div>
      <button type="button" class="btn-secondary" :disabled="exporting" @click="exportLog">
        {{ exporting ? "Exporting…" : "Export" }}
      </button>
    </form>

    <div class="integrity-actions">
      <button type="button" class="btn-secondary" :disabled="verifying" @click="verifyIntegrity">
        {{ verifying ? "Verifying…" : "Verify integrity" }}
      </button>
    </div>

    <p v-if="integrity" class="integrity" :class="integrity.ok ? 'ok' : 'broken'">
      <CheckCircle2 v-if="integrity.ok" :size="16" stroke-width="2" aria-hidden="true" />
      <XCircle v-else :size="16" stroke-width="2" aria-hidden="true" />
      <span v-if="integrity.ok">Chain intact — {{ integrity.checked }} entries verified.</span>
      <span v-else
        >Tampering detected — chain breaks at entry #{{ integrity.brokenAtId }} (after {{ integrity.checked }} valid).
        Escalate to security and do not trust entries after this point.</span
      >
    </p>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

    <TableCard v-if="entries.length">
      <thead>
        <tr>
          <th>When</th>
          <th>Actor</th>
          <th>Action</th>
          <th>Target</th>
          <th>Detail</th>
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
            <details v-if="entry.detail" class="detail-disclosure">
              <summary>View</summary>
              <pre>{{ prettyJson(entry.detail) }}</pre>
            </details>
            <span v-else class="detail-none">—</span>
          </td>
        </tr>
      </tbody>
    </TableCard>
    <EmptyState v-else-if="!loading" :icon="ScrollText">
      <template v-if="hasActiveFilters">
        No entries match these filters.
        <button type="button" class="link-btn" @click="clearFilters">Clear filters</button>
      </template>
      <template v-else>No audit entries yet.</template>
    </EmptyState>

    <button v-if="nextCursor" type="button" class="btn-secondary" :disabled="loading" @click="load(nextCursor)">
      {{ loading ? "Loading…" : "Load more" }}
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
/* SearchInput's own recipe has no max-width; this page constrains it so the
   two search fields don't grow unbounded in the flex filter row. */
:deep(.search-input) {
  max-width: 16.25rem;
}
.integrity-actions {
  margin-bottom: 1.25rem;
}
/* TableCard's global .data-table recipe hardcodes font-size; this page
   needs a slightly smaller type size. */
:deep(.data-table) {
  font-size: 0.88rem;
}
/* TableCard's own recipe has no bottom margin; this page needs a gap before
   the "Load more" button below it. */
:deep(.table-card) {
  margin-bottom: 1rem;
}
.detail-disclosure summary {
  cursor: pointer;
  color: var(--signal-strong);
  font-size: 0.85rem;
}
.detail-disclosure pre {
  margin: 0.5rem 0 0;
  padding: 0.6rem;
  background: var(--surface-sunken);
  border-radius: var(--radius-sm);
  font-size: 0.78rem;
  max-width: 22.5rem;
  overflow-x: auto;
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

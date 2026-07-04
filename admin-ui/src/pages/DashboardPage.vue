<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute } from "vue-router";
import { api } from "@/composables/useApi";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useCursorPagination } from "@/composables/useCursorPagination";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import { useQueryFilters } from "@/composables/useQueryFilters";
import { toErrorMessage } from "@/utils/errors";
import type { ClientSummary, PaginatedResult, TagSummary, TagToolRef } from "@/types/api";
import StatusBadge from "@/components/ui/StatusBadge.vue";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import SignalLoader from "@/components/ui/SignalLoader.vue";
import OnboardingChecklist from "@/components/OnboardingChecklist.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import SearchInput from "@/components/ui/SearchInput.vue";
import PaginationBar from "@/components/ui/PaginationBar.vue";
import TogglePill from "@/components/ui/TogglePill.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import { Server, Tags, ChevronRight } from "lucide-vue-next";

const ENABLED_FILTER_OPTIONS = [
  { value: "", label: "All states" },
  { value: "true", label: "Enabled only" },
  { value: "false", label: "Disabled only" },
];

const route = useRoute();

const { rowError, toggle } = useOptimisticToggle<ClientSummary>((c) => c.name, "Failed to update.");

const { filters, syncUrl } = useQueryFilters(["q", "enabled"] as const);
const q = filters.q;
const enabledFilter = filters.enabled;
const initialCursor = typeof route.query.cursor === "string" ? route.query.cursor : undefined;

function buildQuery(cursor?: string): string {
  const params = new URLSearchParams();
  if (q.value) params.set("q", q.value);
  if (enabledFilter.value) params.set("enabled", enabledFilter.value);
  if (cursor) params.set("cursor", cursor);
  params.set("limit", "50");
  return params.toString();
}

const {
  items,
  loading,
  errorMessage,
  load,
  reset,
  next: nextPage,
  prev: prevPage,
  hasPrev,
  hasNext,
} = useCursorPagination<ClientSummary>(
  (cursor) => api.get<PaginatedResult<ClientSummary>>(`/admin-api/clients?${buildQuery(cursor)}`),
  {
    initialCursor,
    fallbackMessage: "Failed to load servers.",
    onCursorChange: (cursor) => syncUrl({ cursor }),
  },
);

// debounce-free: filters apply on explicit submit here, not on every keystroke
function applyFilters() {
  reset();
  syncUrl();
  load();
}

const {
  pending: pendingDisable,
  request: requestDisableConfirm,
  cancel: cancelDisable,
  confirm: confirmDisableAction,
} = useConfirmAction<ClientSummary>();
const selected = ref<Set<string>>(new Set());
const bulkPending = ref(false);
const bulkError = ref("");
const {
  pending: pendingBulkDisable,
  request: requestBulkDisableConfirm,
  cancel: cancelBulkDisable,
  confirm: confirmBulkDisableAction,
} = useConfirmAction<true>();

function toggleSelected(name: string) {
  if (selected.value.has(name)) selected.value.delete(name);
  else selected.value.add(name);
  // Trigger reactivity — Set mutation alone doesn't notify Vue's ref.
  selected.value = new Set(selected.value);
}

function toggleSelectAll() {
  if (selected.value.size === items.value.length) {
    selected.value = new Set();
  } else {
    selected.value = new Set(items.value.map((c) => c.name));
  }
}

async function runBulk(enabled: boolean) {
  bulkError.value = "";
  bulkPending.value = true;
  try {
    await api.patch("/admin-api/clients", { names: Array.from(selected.value), enabled });
    selected.value = new Set();
    // Original hand-rolled `load()` (no cursor arg) fell back to `cursor === undefined`,
    // i.e. jumped back to page 1 after a bulk action. The composable's `load()` instead
    // defaults to the *current* cursor, so `reset()` first is required to preserve that.
    reset();
    await load();
  } catch (err) {
    bulkError.value = toErrorMessage(err, "Bulk update failed.");
  } finally {
    bulkPending.value = false;
  }
}

function requestBulkDisable() {
  requestBulkDisableConfirm(true);
}

function confirmBulkDisable() {
  return confirmBulkDisableAction(async () => {
    await runBulk(false);
  });
}

async function toggleEnabled(client: ClientSummary) {
  await toggle(client, "enabled", (next) =>
    api.patch(`/admin-api/clients/${encodeURIComponent(client.name)}`, { enabled: next }),
  );
}

function requestDisable(client: ClientSummary) {
  if (client.toolsCount === 0) {
    toggleEnabled(client);
    return;
  }
  requestDisableConfirm(client);
}

function confirmDisable() {
  return confirmDisableAction(async (client) => {
    await toggleEnabled(client);
  });
}

function onToggleClick(client: ClientSummary) {
  if (client.enabled) {
    requestDisable(client);
  } else {
    toggleEnabled(client);
  }
}

// Browse-by-tag — GET /admin-api/tags + GET /admin-api/tags/:tag/tools. Separate from the
// client filters above: tags live on tools, not clients, so this is a lightweight side panel
// rather than a filter over the clients table.
const showTagBrowser = ref(false);
const tags = ref<TagSummary[]>([]);
const tagsLoading = ref(false);
const tagsError = ref("");
const selectedTag = ref<string | null>(null);
const tagTools = ref<TagToolRef[]>([]);
const tagToolsLoading = ref(false);
const tagToolsError = ref("");

async function loadTags() {
  tagsLoading.value = true;
  tagsError.value = "";
  try {
    tags.value = (await api.get<{ items: TagSummary[] }>("/admin-api/tags")).items;
  } catch (err) {
    tagsError.value = toErrorMessage(err, "Failed to load tags.");
  } finally {
    tagsLoading.value = false;
  }
}

async function selectTag(tag: string) {
  if (selectedTag.value === tag) {
    selectedTag.value = null;
    tagTools.value = [];
    return;
  }
  selectedTag.value = tag;
  tagToolsLoading.value = true;
  tagToolsError.value = "";
  try {
    tagTools.value = (await api.get<{ items: TagToolRef[] }>(`/admin-api/tags/${encodeURIComponent(tag)}/tools`)).items;
  } catch (err) {
    tagToolsError.value = toErrorMessage(err, "Failed to load tools for this tag.");
  } finally {
    tagToolsLoading.value = false;
  }
}

function toggleTagBrowser() {
  showTagBrowser.value = !showTagBrowser.value;
  if (showTagBrowser.value && tags.value.length === 0 && !tagsLoading.value) loadTags();
}

onMounted(() => load());
</script>

<template>
  <section class="list-shell">
    <PageHeader title="Servers" subtitle="Registered backend servers and their tools.">
      <button type="button" class="btn-secondary" :aria-expanded="showTagBrowser" @click="toggleTagBrowser">
        <Tags :size="15" stroke-width="2" aria-hidden="true" /> Browse by tag
      </button>
      <RouterLink to="/register-server" class="btn-primary">Add server</RouterLink>
    </PageHeader>

    <OnboardingChecklist :has-servers="items.length > 0" />

    <div v-if="showTagBrowser" class="tag-browser">
      <SignalLoader v-if="tagsLoading" label="Loading tags…" />
      <p v-else-if="tagsError" class="error">{{ tagsError }}</p>
      <p v-else-if="tags.length === 0" class="subtitle">
        No tools have been tagged yet. Tag a tool from its server's Settings tab.
      </p>
      <template v-else>
        <div class="tag-cloud">
          <button
            v-for="t in tags"
            :key="t.tag"
            type="button"
            class="tag-chip"
            :class="{ 'tag-chip-active': selectedTag === t.tag }"
            :aria-pressed="selectedTag === t.tag"
            @click="selectTag(t.tag)"
          >
            {{ t.tag }} <span class="tag-count">{{ t.count }}</span>
          </button>
        </div>
        <div v-if="selectedTag" class="tag-tools">
          <SignalLoader v-if="tagToolsLoading" label="Loading tools…" />
          <p v-else-if="tagToolsError" class="error">{{ tagToolsError }}</p>
          <p v-else-if="tagTools.length === 0" class="subtitle">No tools currently carry '{{ selectedTag }}'.</p>
          <ul v-else class="tag-tools-list">
            <li v-for="toolRef in tagTools" :key="`${toolRef.client}__${toolRef.tool}`">
              <ChevronRight :size="13" stroke-width="2" class="tag-tool-arrow" aria-hidden="true" />
              <RouterLink :to="`/servers/${encodeURIComponent(toolRef.client)}`">{{ toolRef.client }}</RouterLink>
              <span class="tag-tool-sep">/</span>
              <code>{{ toolRef.tool }}</code>
            </li>
          </ul>
        </div>
      </template>
    </div>

    <form class="filters" @submit.prevent="applyFilters">
      <div class="field">
        <label for="d-search">Search</label>
        <SearchInput v-model="q" placeholder="Search by name…" />
      </div>
      <div class="field">
        <label for="d-state">State</label>
        <SelectMenu id="d-state" v-model="enabledFilter" :options="ENABLED_FILTER_OPTIONS" />
      </div>
      <button type="submit" class="btn-secondary">Apply</button>
    </form>

    <div v-if="selected.size > 0" class="bulk-bar">
      <span>{{ selected.size }} selected</span>
      <button type="button" class="btn-secondary" :disabled="bulkPending" @click="runBulk(true)">
        Enable selected
      </button>
      <button type="button" class="btn-danger" :disabled="bulkPending" @click="requestBulkDisable">
        Disable selected
      </button>
      <button type="button" class="link-btn" @click="selected = new Set()">Clear selection</button>
      <span v-if="bulkError" class="error">{{ bulkError }}</span>
    </div>

    <ListLayout :loading="loading" :error="errorMessage" :empty="items.length === 0">
      <template #empty>
        <EmptyState :icon="Server">
          <template v-if="q || enabledFilter">
            No servers match your filters.
            <button
              type="button"
              class="link-btn"
              @click="
                q = '';
                enabledFilter = '';
                applyFilters();
              "
            >
              Clear filters
            </button>
          </template>
          <template v-else>
            No servers registered yet. REST backends register themselves via <code>POST /register</code>; you can also
            <RouterLink to="/register-server">add a REST or MCP server</RouterLink> manually.
          </template>
        </EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th class="checkbox-col">
              <input
                type="checkbox"
                :checked="selected.size > 0 && selected.size === items.length"
                aria-label="Select all servers on this page"
                @change="toggleSelectAll"
              />
            </th>
            <th>Name</th>
            <th>Status</th>
            <th>Tools</th>
            <th>Health URL</th>
            <th>Enabled</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="client in items" :key="client.name">
            <td class="checkbox-col">
              <input
                type="checkbox"
                :checked="selected.has(client.name)"
                :aria-label="`Select ${client.name}`"
                @change="toggleSelected(client.name)"
              />
            </td>
            <td>
              <RouterLink :to="`/servers/${encodeURIComponent(client.name)}`">{{ client.name }}</RouterLink>
              <span v-if="client.kind === 'mcp'" class="kind-chip">MCP</span>
            </td>
            <td><StatusBadge :status="client.status" /></td>
            <td>{{ client.toolsCount }}</td>
            <td class="cell-truncate" :title="client.healthUrl">{{ client.healthUrl }}</td>
            <td>
              <TogglePill
                :on="client.enabled"
                on-label="Enabled"
                off-label="Disabled"
                :aria-pressed="client.enabled"
                @click="onToggleClick(client)"
              />
              <p v-if="rowError[client.name]" class="row-error">{{ rowError[client.name] }}</p>
            </td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <div class="sticky-pagination">
      <PaginationBar :has-prev="hasPrev" :has-next="hasNext" @prev="prevPage" @next="nextPage" />
      <p class="subtitle">{{ items.length }} server(s) on this page</p>
    </div>

    <ConfirmDialog
      :open="pendingDisable !== null"
      title="Disable this server?"
      :message="
        pendingDisable
          ? `Disabling '${pendingDisable.name}' will stop all ${pendingDisable.toolsCount} of its tools for every connected MCP agent.`
          : ''
      "
      :confirm-label="pendingDisable ? `Disable ${pendingDisable.name}` : 'Disable'"
      danger
      @confirm="confirmDisable"
      @cancel="cancelDisable"
    />

    <ConfirmDialog
      :open="pendingBulkDisable !== null"
      title="Disable selected servers?"
      :message="`Disabling ${selected.size} server(s) will stop all of their tools for every connected MCP agent.`"
      :confirm-label="`Disable ${selected.size} server(s)`"
      danger
      @confirm="confirmBulkDisable"
      @cancel="cancelBulkDisable"
    />
  </section>
</template>

<style scoped>
.subtitle {
  color: var(--text-secondary);
  margin: 0;
}
/* PageHeader's own recipe covers the title/subtitle; this page still needs its
   header buttons laid out in a row (PageHeader's .header-actions wrapper is
   rendered by the child component, so reaching it requires :deep()). */
:deep(.header-actions) {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.header-actions .btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
}
.tag-browser {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: var(--space-4) var(--space-5);
  margin-bottom: var(--space-6);
}
.tag-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  padding: 0.3rem 0.75rem;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    color 0.12s ease,
    background-color 0.12s ease;
}
.tag-chip:hover {
  border-color: var(--border-strong);
  color: var(--text-primary);
}
.tag-chip-active {
  background: var(--signal-soft);
  border-color: var(--signal);
  color: var(--signal-strong);
}
.tag-count {
  color: var(--text-muted);
  font-weight: 400;
}
.tag-chip-active .tag-count {
  color: var(--signal-strong);
}
.tag-tools {
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border);
}
.tag-tools-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.tag-tools-list li {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  font-size: var(--text-base);
}
.tag-tool-arrow {
  color: var(--text-muted);
  flex-shrink: 0;
}
.tag-tool-sep {
  color: var(--text-muted);
}
.filters .field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
}
.filters .field:first-of-type {
  flex: 1;
  max-width: 20rem;
}
.bulk-bar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: var(--signal-soft);
  border: 1px solid var(--signal);
  border-radius: var(--radius-md);
  padding: 0.6rem 1rem;
  margin-bottom: 1rem;
  font-size: 0.88rem;
}
.checkbox-col {
  width: 2rem;
}
.cell-truncate {
  max-width: 16.25rem;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.83rem;
}
.kind-chip {
  display: inline-block;
  margin-left: 0.4rem;
  padding: 0.05rem 0.4rem;
  background: var(--kind-mcp-soft);
  color: var(--kind-mcp-text);
  border-radius: var(--radius-pill);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  vertical-align: middle;
}
</style>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter, useRoute } from "vue-router";
import { api, ApiError } from "../composables/useApi";
import type { ClientSummary, PaginatedResult, TagSummary, TagToolRef } from "../types/api";
import StatusBadge from "../components/StatusBadge.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { Search, Server, Tags, ChevronRight } from "lucide-vue-next";

const router = useRouter();
const route = useRoute();

const items = ref<ClientSummary[]>([]);
const nextCursor = ref<string | undefined>(undefined);
const currentCursor = ref<string | undefined>(undefined);
const cursorStack = ref<(string | undefined)[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const rowError = ref<Record<string, string>>({});

const q = ref(typeof route.query.q === "string" ? route.query.q : "");
const enabledFilter = ref(typeof route.query.enabled === "string" ? route.query.enabled : "");
const initialCursor = typeof route.query.cursor === "string" ? route.query.cursor : undefined;

const pendingDisable = ref<ClientSummary | null>(null);
const selected = ref<Set<string>>(new Set());
const bulkPending = ref(false);
const bulkError = ref("");
const pendingBulkDisable = ref(false);

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
    await load();
  } catch (err) {
    bulkError.value = err instanceof ApiError ? err.message : "Bulk update failed.";
  } finally {
    bulkPending.value = false;
  }
}

function requestBulkDisable() {
  pendingBulkDisable.value = true;
}

async function confirmBulkDisable() {
  pendingBulkDisable.value = false;
  await runBulk(false);
}

function buildQuery(cursor?: string): string {
  const params = new URLSearchParams();
  if (q.value) params.set("q", q.value);
  if (enabledFilter.value) params.set("enabled", enabledFilter.value);
  if (cursor) params.set("cursor", cursor);
  params.set("limit", "50");
  return params.toString();
}

async function load(cursor?: string) {
  loading.value = true;
  errorMessage.value = "";
  try {
    const result = await api.get<PaginatedResult<ClientSummary>>(`/admin-api/clients?${buildQuery(cursor)}`);
    items.value = result.items;
    nextCursor.value = result.nextCursor;
    currentCursor.value = cursor;
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load servers.";
  } finally {
    loading.value = false;
  }
}

// debounce-free: filters apply on explicit submit here, not on every keystroke
function applyFilters() {
  cursorStack.value = [];
  router.replace({ query: { q: q.value || undefined, enabled: enabledFilter.value || undefined } });
  load();
}

function nextPage() {
  if (!nextCursor.value) return;
  cursorStack.value.push(currentCursor.value);
  router.replace({
    query: { q: q.value || undefined, enabled: enabledFilter.value || undefined, cursor: nextCursor.value },
  });
  load(nextCursor.value);
}

function prevPage() {
  if (cursorStack.value.length === 0) return;
  const cursor = cursorStack.value.pop();
  router.replace({
    query: { q: q.value || undefined, enabled: enabledFilter.value || undefined, cursor: cursor || undefined },
  });
  load(cursor);
}

async function toggleEnabled(client: ClientSummary) {
  const nextEnabled = !client.enabled;
  const previous = client.enabled;
  client.enabled = nextEnabled; // optimistic
  delete rowError.value[client.name];
  try {
    await api.patch(`/admin-api/clients/${encodeURIComponent(client.name)}`, { enabled: nextEnabled });
  } catch (err) {
    client.enabled = previous; // revert on failure
    rowError.value[client.name] = err instanceof ApiError ? err.message : "Failed to update.";
  }
}

function requestDisable(client: ClientSummary) {
  if (client.toolsCount === 0) {
    toggleEnabled(client);
    return;
  }
  pendingDisable.value = client;
}

async function confirmDisable() {
  if (!pendingDisable.value) return;
  const client = pendingDisable.value;
  pendingDisable.value = null;
  await toggleEnabled(client);
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
    tagsError.value = err instanceof ApiError ? err.message : "Failed to load tags.";
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
    tagToolsError.value = err instanceof ApiError ? err.message : "Failed to load tools for this tag.";
  } finally {
    tagToolsLoading.value = false;
  }
}

function toggleTagBrowser() {
  showTagBrowser.value = !showTagBrowser.value;
  if (showTagBrowser.value && tags.value.length === 0 && !tagsLoading.value) loadTags();
}

onMounted(() => load(initialCursor));
</script>

<template>
  <section>
    <header class="page-header">
      <div>
        <h1>Servers</h1>
        <p class="subtitle">Registered backend servers and their tools.</p>
      </div>
      <div class="header-actions">
        <button type="button" class="btn-secondary" :aria-expanded="showTagBrowser" @click="toggleTagBrowser">
          <Tags :size="15" stroke-width="2" aria-hidden="true" /> Browse by tag
        </button>
        <RouterLink to="/register-server" class="btn-primary">Add server</RouterLink>
      </div>
    </header>

    <div v-if="showTagBrowser" class="tag-browser">
      <p v-if="tagsLoading" class="loading">Loading tags…</p>
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
          <p v-if="tagToolsLoading" class="loading">Loading tools…</p>
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
        <div class="search-input">
          <Search :size="15" stroke-width="2" aria-hidden="true" />
          <input id="d-search" v-model="q" type="search" placeholder="Search by name…" />
        </div>
      </div>
      <div class="field">
        <label for="d-state">State</label>
        <select id="d-state" v-model="enabledFilter">
          <option value="">All states</option>
          <option value="true">Enabled only</option>
          <option value="false">Disabled only</option>
        </select>
      </div>
      <button type="submit" class="btn-secondary">Apply</button>
    </form>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

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

    <div v-if="loading" class="loading">Loading…</div>

    <template v-else-if="items.length === 0">
      <div class="empty-state">
        <Server :size="26" stroke-width="1.5" aria-hidden="true" class="empty-icon" />
        <p v-if="q || enabledFilter">
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
        </p>
        <p v-else>
          No servers registered yet. REST backends register themselves via <code>POST /register</code>; you can also
          <RouterLink to="/register-server">add a REST or MCP server</RouterLink> manually.
        </p>
      </div>
    </template>

    <div v-else class="table-card table-scroll">
      <table class="clients-table">
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
            <td class="url-cell" :title="client.healthUrl">{{ client.healthUrl }}</td>
            <td>
              <button
                type="button"
                class="toggle"
                :class="client.enabled ? 'toggle-on' : 'toggle-off'"
                :aria-pressed="client.enabled"
                @click="onToggleClick(client)"
              >
                {{ client.enabled ? "Enabled" : "Disabled" }}
              </button>
              <p v-if="rowError[client.name]" class="row-error">{{ rowError[client.name] }}</p>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pagination">
      <button type="button" class="btn-secondary" :disabled="cursorStack.length === 0" @click="prevPage">
        Previous
      </button>
      <button type="button" class="btn-secondary" :disabled="!nextCursor" @click="nextPage">Next</button>
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
      @cancel="pendingDisable = null"
    />

    <ConfirmDialog
      :open="pendingBulkDisable"
      title="Disable selected servers?"
      :message="`Disabling ${selected.size} server(s) will stop all of their tools for every connected MCP agent.`"
      :confirm-label="`Disable ${selected.size} server(s)`"
      danger
      @confirm="confirmBulkDisable"
      @cancel="pendingBulkDisable = false"
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
}
.header-actions {
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
.filters {
  display: flex;
  align-items: flex-end;
  gap: 0.6rem;
  margin-bottom: 1.25rem;
}
.filters .field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
}
.filters .field:first-of-type {
  flex: 1;
  max-width: 320px;
}
.search-input {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 0 0.6rem;
  background: var(--surface);
}
.search-input svg {
  color: var(--text-muted);
  flex-shrink: 0;
}
.search-input input[type="search"] {
  flex: 1;
  width: 100%;
  padding: 0.45rem 0;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: 0.9rem;
}
.filters select {
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-family: var(--font-body);
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
.table-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
}
.clients-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.clients-table th {
  text-align: left;
  padding: 0.7rem 0.9rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.clients-table td {
  padding: 0.65rem 0.9rem;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.clients-table tbody tr:last-child td {
  border-bottom: none;
}
.clients-table tbody tr:hover {
  background: var(--surface-sunken);
}
.url-cell {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.83rem;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.45em;
  border-radius: var(--radius-pill);
  padding: 0.28rem 0.8rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  background: var(--surface);
  transition:
    background-color 0.12s ease,
    border-color 0.12s ease;
}
.toggle::before {
  content: "";
  width: 0.55em;
  height: 0.55em;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.toggle-on {
  border: 1px solid var(--ok);
  color: var(--ok);
}
.toggle-off {
  border: 1px solid var(--border-strong);
  color: var(--text-secondary);
}
.toggle-on:hover {
  background: var(--ok-soft);
}
.toggle-off:hover {
  background: var(--surface-sunken);
}
.row-error {
  color: var(--breach);
  font-size: 0.75rem;
  margin: 0.25rem 0 0;
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
.pagination {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 1.25rem;
}
.pagination .subtitle {
  margin-left: 0.4rem;
}
.empty-state {
  padding: 3rem 2rem;
  text-align: center;
  color: var(--text-secondary);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.empty-icon {
  color: var(--text-muted);
  margin-bottom: 0.75rem;
}
.loading {
  color: var(--text-muted);
  padding: 1rem 0;
}
.error {
  color: var(--breach);
}
</style>

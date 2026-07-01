<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { useRouter, useRoute } from "vue-router";
import { api, ApiError } from "../composables/useApi";
import type { ClientSummary, PaginatedResult } from "../types/api";
import StatusBadge from "../components/StatusBadge.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";

const router = useRouter();
const route = useRoute();

const items = ref<ClientSummary[]>([]);
const nextCursor = ref<string | undefined>(undefined);
const cursorStack = ref<(string | undefined)[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const rowError = ref<Record<string, string>>({});

const q = ref(typeof route.query.q === "string" ? route.query.q : "");
const enabledFilter = ref(typeof route.query.enabled === "string" ? route.query.enabled : "");

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
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load clients.";
  } finally {
    loading.value = false;
  }
}

function applyFilters() {
  cursorStack.value = [];
  router.replace({ query: { q: q.value || undefined, enabled: enabledFilter.value || undefined } });
  load();
}

function nextPage() {
  if (!nextCursor.value) return;
  cursorStack.value.push(undefined); // placeholder for "page before current" bookkeeping
  load(nextCursor.value);
}

function prevPage() {
  if (cursorStack.value.length === 0) return;
  cursorStack.value.pop();
  load(cursorStack.value[cursorStack.value.length - 1]);
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

watch([q, enabledFilter], () => {
  // debounce-free: filters apply on explicit submit via applyFilters(), not on every keystroke
});

onMounted(load);
</script>

<template>
  <section>
    <header class="page-header">
      <h1>Servers</h1>
      <p class="subtitle">Registered backend clients and their tools.</p>
    </header>

    <form class="filters" @submit.prevent="applyFilters">
      <input v-model="q" type="search" placeholder="Search by name…" aria-label="Search clients" />
      <select v-model="enabledFilter" aria-label="Filter by enabled state">
        <option value="">All states</option>
        <option value="true">Enabled only</option>
        <option value="false">Disabled only</option>
      </select>
      <button type="submit" class="btn-secondary">Apply</button>
    </form>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

    <div v-if="selected.size > 0" class="bulk-bar">
      <span>{{ selected.size }} selected</span>
      <button type="button" class="btn-secondary" :disabled="bulkPending" @click="runBulk(true)">Enable selected</button>
      <button type="button" class="btn-secondary" :disabled="bulkPending" @click="requestBulkDisable">Disable selected</button>
      <button type="button" class="link-btn" @click="selected = new Set()">Clear selection</button>
      <span v-if="bulkError" class="error">{{ bulkError }}</span>
    </div>

    <div v-if="loading" class="loading">Loading…</div>

    <template v-else-if="items.length === 0">
      <div class="empty-state">
        <p v-if="q || enabledFilter">No clients match your filters. <button type="button" class="link-btn" @click="q = ''; enabledFilter = ''; applyFilters();">Clear filters</button></p>
        <p v-else>
          No clients registered yet. REST backends register themselves via <code>POST /register</code>;
          you can also <RouterLink to="/register-server">add a REST or MCP server</RouterLink> manually.
        </p>
      </div>
    </template>

    <div v-else class="table-scroll">
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
          <td class="url-cell">{{ client.healthUrl }}</td>
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
      <button type="button" class="btn-secondary" :disabled="cursorStack.length === 0" @click="prevPage">Previous</button>
      <button type="button" class="btn-secondary" :disabled="!nextCursor" @click="nextPage">Next</button>
    </div>

    <ConfirmDialog
      :open="pendingDisable !== null"
      title="Disable this server?"
      :message="pendingDisable ? `Disabling '${pendingDisable.name}' will stop all ${pendingDisable.toolsCount} of its tools for every connected MCP agent.` : ''"
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
.page-header h1 {
  margin: 0 0 0.2rem;
}
.subtitle {
  color: #63676e;
  margin: 0 0 1.25rem;
}
.filters {
  display: flex;
  gap: 0.6rem;
  margin-bottom: 1.25rem;
}
.filters input[type="search"] {
  flex: 1;
  max-width: 320px;
  padding: 0.45rem 0.6rem;
  border: 1px solid #cfd4da;
  border-radius: 6px;
}
.filters select {
  padding: 0.45rem 0.6rem;
  border: 1px solid #cfd4da;
  border-radius: 6px;
}
.bulk-bar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: #eef4ff;
  border: 1px solid #c9dcfb;
  border-radius: 8px;
  padding: 0.6rem 1rem;
  margin-bottom: 1rem;
  font-size: 0.88rem;
}
.checkbox-col {
  width: 2rem;
}
.clients-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.clients-table th {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 2px solid #e5e7eb;
  color: #52565c;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.clients-table td {
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid #eef0f2;
  vertical-align: middle;
}
.url-cell {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #63676e;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4em;
  border-radius: 6px;
  padding: 0.25rem 0.75rem;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  background: #fff;
}
.toggle::before {
  content: "";
  width: 0.6em;
  height: 0.6em;
  border-radius: 50%;
  background: currentColor;
}
.toggle-on {
  border: 1px solid #146c2e;
  color: #146c2e;
}
.toggle-off {
  border: 1px solid #9aa0a8;
  color: #52565c;
}
.row-error {
  color: #a11212;
  font-size: 0.75rem;
  margin: 0.25rem 0 0;
}
.kind-chip {
  display: inline-block;
  margin-left: 0.4rem;
  padding: 0.05rem 0.4rem;
  background: #ece9fb;
  color: #5a3aa8;
  border-radius: 999px;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  vertical-align: middle;
}
.pagination {
  display: flex;
  gap: 0.6rem;
  margin-top: 1.25rem;
}
.empty-state {
  padding: 2rem;
  text-align: center;
  color: #63676e;
  background: #fafbfc;
  border-radius: 8px;
}
.loading {
  color: #63676e;
  padding: 1rem 0;
}
.error {
  color: #a11212;
}
</style>

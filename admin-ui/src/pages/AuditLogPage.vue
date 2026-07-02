<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { AuditLogEntry, PaginatedResult } from "../types/api";
import { ScrollText, Search, CheckCircle2, XCircle } from "lucide-vue-next";

const entries = ref<AuditLogEntry[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const nextCursor = ref<string | undefined>(undefined);
const actorFilter = ref("");

async function load(cursor?: string) {
  loading.value = true;
  errorMessage.value = "";
  try {
    const params = new URLSearchParams();
    if (actorFilter.value) params.set("actor", actorFilter.value);
    if (cursor) params.set("cursor", cursor);
    const result = await api.get<PaginatedResult<AuditLogEntry>>(`/admin-api/audit-log?${params.toString()}`);
    entries.value = cursor ? [...entries.value, ...result.items] : result.items;
    nextCursor.value = result.nextCursor;
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load audit log.";
  } finally {
    loading.value = false;
  }
}

function applyFilter() {
  load();
}

async function exportLog() {
  errorMessage.value = "";
  try {
    const params = new URLSearchParams();
    if (actorFilter.value) params.set("actor", actorFilter.value);
    const result = await api.get<{ items: AuditLogEntry[] }>(`/admin-api/audit-log/export?${params.toString()}`);
    const blob = new Blob([JSON.stringify(result.items, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "audit-log.json";
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Export failed.";
  }
}

const integrity = ref<{ ok: boolean; checked: number; brokenAtId?: number } | null>(null);
const verifying = ref(false);
async function verifyIntegrity() {
  verifying.value = true;
  integrity.value = null;
  errorMessage.value = "";
  try {
    integrity.value = await api.get<{ ok: boolean; checked: number; brokenAtId?: number }>("/admin-api/audit-log/verify");
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Verification failed.";
  } finally {
    verifying.value = false;
  }
}

onMounted(() => load());
</script>

<template>
  <section>
    <header class="page-header">
      <h1>Audit log</h1>
      <p class="subtitle">Who changed what, and when.</p>
    </header>

    <form class="filters" @submit.prevent="applyFilter">
      <div class="field">
        <label for="actor-filter">Actor</label>
        <div class="search-input">
          <Search :size="15" stroke-width="2" aria-hidden="true" />
          <input id="actor-filter" v-model="actorFilter" type="search" placeholder="Filter by actor…" />
        </div>
      </div>
      <button type="submit" class="btn-secondary">Apply</button>
      <button type="button" class="btn-secondary" @click="exportLog">Export</button>
    </form>

    <div class="integrity-actions">
      <button type="button" class="btn-secondary" :disabled="verifying" @click="verifyIntegrity">{{ verifying ? "Verifying…" : "Verify integrity" }}</button>
    </div>

    <p v-if="integrity" class="integrity" :class="integrity.ok ? 'ok' : 'broken'">
      <CheckCircle2 v-if="integrity.ok" :size="16" stroke-width="2" aria-hidden="true" />
      <XCircle v-else :size="16" stroke-width="2" aria-hidden="true" />
      <span v-if="integrity.ok">Chain intact — {{ integrity.checked }} entries verified.</span>
      <span v-else>Tampering detected — chain breaks at entry #{{ integrity.brokenAtId }} (after {{ integrity.checked }} valid). Escalate to security and do not trust entries after this point.</span>
    </p>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

    <div v-if="entries.length" class="table-card table-scroll">
    <table class="audit-table">
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
          <td>{{ new Date(entry.createdAt).toLocaleString() }}</td>
          <td>{{ entry.actor }}</td>
          <td><code>{{ entry.action }}</code></td>
          <td>{{ entry.target }}</td>
          <td>
            <details v-if="entry.detail" class="detail-disclosure">
              <summary>View</summary>
              <pre>{{ JSON.stringify(entry.detail, null, 2) }}</pre>
            </details>
            <span v-else class="detail-none">—</span>
          </td>
        </tr>
      </tbody>
    </table>
    </div>
    <div v-else-if="!loading" class="empty-state">
      <ScrollText :size="26" stroke-width="1.5" aria-hidden="true" class="empty-icon" />
      <p>No audit entries yet.</p>
    </div>

    <button v-if="nextCursor" type="button" class="btn-secondary" :disabled="loading" @click="load(nextCursor)">
      {{ loading ? "Loading…" : "Load more" }}
    </button>
  </section>
</template>

<style scoped>
.page-header h1 {
  margin: 0 0 0.2rem;
}
.subtitle {
  color: var(--text-secondary);
  margin: 0 0 1.25rem;
}
.filters {
  display: flex;
  align-items: flex-end;
  gap: 0.6rem;
  margin-bottom: 0.75rem;
}
.filters .field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
}
.search-input {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 0 0.6rem;
  background: var(--surface);
  max-width: 260px;
}
.search-input svg {
  color: var(--text-muted);
  flex-shrink: 0;
}
.search-input input {
  flex: 1;
  width: 100%;
  padding: 0.45rem 0;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: 0.9rem;
}
.integrity-actions {
  margin-bottom: 1.25rem;
}
.table-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  margin-bottom: 1rem;
}
.audit-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}
.audit-table th {
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.audit-table td {
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.audit-table tbody tr:last-child td {
  border-bottom: none;
}
.audit-table tbody tr:hover {
  background: var(--surface-sunken);
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
  max-width: 360px;
  overflow-x: auto;
}
.detail-none {
  color: var(--text-muted);
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
.error {
  color: var(--breach);
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

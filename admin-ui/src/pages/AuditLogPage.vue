<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { AuditLogEntry, PaginatedResult } from "../types/api";

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
      <input v-model="actorFilter" type="text" placeholder="Filter by actor…" />
      <button type="submit" class="btn-secondary">Apply</button>
      <button type="button" class="btn-secondary" @click="exportLog">Export</button>
      <button type="button" class="btn-secondary" :disabled="verifying" @click="verifyIntegrity">{{ verifying ? "Verifying…" : "Verify integrity" }}</button>
    </form>

    <p v-if="integrity" class="integrity" :class="integrity.ok ? 'ok' : 'broken'">
      <template v-if="integrity.ok">✓ Chain intact — {{ integrity.checked }} entries verified.</template>
      <template v-else>✗ Tampering detected — chain breaks at entry #{{ integrity.brokenAtId }} (after {{ integrity.checked }} valid).</template>
    </p>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

    <div v-if="entries.length" class="table-scroll">
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
    <p v-else-if="!loading" class="empty-state">No audit entries yet.</p>

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
  color: #63676e;
  margin: 0 0 1.25rem;
}
.filters {
  display: flex;
  gap: 0.6rem;
  margin-bottom: 1.25rem;
}
.filters input {
  padding: 0.45rem 0.6rem;
  border: 1px solid #cfd4da;
  border-radius: 6px;
  max-width: 260px;
}
.audit-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
  margin-bottom: 1rem;
}
.audit-table th {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 2px solid #e5e7eb;
  color: #52565c;
  font-size: 0.78rem;
  text-transform: uppercase;
}
.audit-table td {
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid #eef0f2;
}
.detail-disclosure summary {
  cursor: pointer;
  color: #1a56db;
  font-size: 0.85rem;
}
.detail-disclosure pre {
  margin: 0.5rem 0 0;
  padding: 0.6rem;
  background: #f4f5f7;
  border-radius: 6px;
  font-size: 0.78rem;
  max-width: 360px;
  overflow-x: auto;
}
.detail-none {
  color: #63676e;
}
.empty-state {
  padding: 1.5rem;
  text-align: center;
  color: #63676e;
  background: #fafbfc;
  border-radius: 8px;
}
.error {
  color: #a11212;
}
.integrity {
  padding: 0.5rem 0.8rem;
  border-radius: 6px;
  font-size: 0.9rem;
}
.integrity.ok {
  background: #eef7ee;
  color: #256029;
  border: 1px solid #b7dcb7;
}
.integrity.broken {
  background: #fbeeee;
  color: #8a1c1c;
  border: 1px solid #e0b4b4;
}
</style>

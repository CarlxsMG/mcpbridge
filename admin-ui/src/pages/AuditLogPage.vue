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
    </form>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

    <table v-if="entries.length" class="audit-table">
      <thead>
        <tr>
          <th>When</th>
          <th>Actor</th>
          <th>Action</th>
          <th>Target</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in entries" :key="entry.id">
          <td>{{ new Date(entry.createdAt).toLocaleString() }}</td>
          <td>{{ entry.actor }}</td>
          <td><code>{{ entry.action }}</code></td>
          <td>{{ entry.target }}</td>
        </tr>
      </tbody>
    </table>
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
</style>

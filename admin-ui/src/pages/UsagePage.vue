<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { UsageSummary, TopToolRow, UsageByKeyRow } from "../types/api";

const WINDOWS = [
  { label: "24 hours", ms: 24 * 60 * 60_000 },
  { label: "7 days", ms: 7 * 24 * 60 * 60_000 },
  { label: "30 days", ms: 30 * 24 * 60 * 60_000 },
];
const windowMs = ref(WINDOWS[1].ms);

const summary = ref<UsageSummary | null>(null);
const topTools = ref<TopToolRow[]>([]);
const byKey = ref<UsageByKeyRow[]>([]);
const loading = ref(false);
const errorMessage = ref("");

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function load() {
  loading.value = true;
  errorMessage.value = "";
  const from = Date.now() - windowMs.value;
  try {
    const [s, t, k] = await Promise.all([
      api.get<UsageSummary>(`/admin-api/usage/summary?from=${from}`),
      api.get<{ items: TopToolRow[] }>(`/admin-api/usage/top-tools?from=${from}&limit=20`),
      api.get<{ items: UsageByKeyRow[] }>(`/admin-api/usage/by-key?from=${from}&limit=20`),
    ]);
    summary.value = s;
    topTools.value = t.items;
    byKey.value = k.items;
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load usage.";
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section>
    <header class="page-header">
      <h1>Usage</h1>
      <select v-model.number="windowMs" @change="load">
        <option v-for="w in WINDOWS" :key="w.ms" :value="w.ms">Last {{ w.label }}</option>
      </select>
    </header>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <div v-if="loading" class="loading">Loading…</div>

    <template v-else-if="summary">
      <div class="cards">
        <div class="card"><div class="card-value">{{ summary.calls }}</div><div class="card-label">Calls</div></div>
        <div class="card"><div class="card-value">{{ summary.errors }}</div><div class="card-label">Errors</div></div>
        <div class="card"><div class="card-value">{{ pct(summary.errorRate) }}</div><div class="card-label">Error rate</div></div>
        <div class="card"><div class="card-value">{{ summary.avgMs }}ms</div><div class="card-label">Avg latency</div></div>
        <div class="card"><div class="card-value">{{ summary.maxMs }}ms</div><div class="card-label">Max latency</div></div>
        <div class="card"><div class="card-value">{{ summary.tools }}</div><div class="card-label">Active tools</div></div>
      </div>

      <h2>Top tools</h2>
      <div v-if="topTools.length" class="table-scroll">
        <table class="usage-table">
          <thead><tr><th>Client</th><th>Tool</th><th>Calls</th><th>Errors</th><th>Error rate</th><th>Avg</th><th>Max</th></tr></thead>
          <tbody>
            <tr v-for="t in topTools" :key="`${t.client}/${t.tool}`">
              <td>{{ t.client }}</td>
              <td>{{ t.tool }}</td>
              <td>{{ t.calls }}</td>
              <td>{{ t.errors }}</td>
              <td :class="{ hot: t.errorRate > 0.1 }">{{ pct(t.errorRate) }}</td>
              <td>{{ t.avgMs }}ms</td>
              <td>{{ t.maxMs }}ms</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="empty">No calls recorded in this window.</p>

      <h2>By API key</h2>
      <div v-if="byKey.length" class="table-scroll">
        <table class="usage-table">
          <thead><tr><th>Key</th><th>Calls</th><th>Errors</th></tr></thead>
          <tbody>
            <tr v-for="k in byKey" :key="k.keyId ?? 'none'">
              <td>{{ k.label }}</td>
              <td>{{ k.calls }}</td>
              <td>{{ k.errors }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="empty">No attributed calls in this window.</p>
    </template>
  </section>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.25rem;
}
.page-header select {
  padding: 0.4rem 0.6rem;
  border: 1px solid #cfd4da;
  border-radius: 6px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.75rem;
  margin-bottom: 1.75rem;
}
.card {
  background: #fafbfc;
  border-radius: 8px;
  padding: 1rem;
}
.card-value {
  font-size: 1.5rem;
  font-weight: 700;
}
.card-label {
  font-size: 0.78rem;
  text-transform: uppercase;
  color: #63676e;
  margin-top: 0.2rem;
}
.usage-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
  margin-bottom: 1.5rem;
}
.usage-table th {
  text-align: left;
  padding: 0.5rem 0.6rem;
  border-bottom: 2px solid #e5e7eb;
  color: #52565c;
  font-size: 0.78rem;
  text-transform: uppercase;
}
.usage-table td {
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid #eef0f2;
}
.usage-table td.hot {
  color: #a11212;
  font-weight: 600;
}
.error {
  color: #a11212;
}
.loading,
.empty {
  color: #63676e;
}
</style>

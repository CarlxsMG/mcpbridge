<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { GuardPolicy, BundleSummary } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";

const policies = ref<GuardPolicy[]>([]);
const bundles = ref<BundleSummary[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const notice = ref("");
const pendingDelete = ref<GuardPolicy | null>(null);

const showCreate = ref(false);
const newName = ref("");
const newRate = ref("");
const newTimeout = ref("");
const createError = ref("");
const creating = ref(false);

// per-policy selected bundle to apply to
const applyBundle = ref<Record<number, string>>({});

async function load() {
  loading.value = true;
  errorMessage.value = "";
  try {
    const [p, b] = await Promise.all([
      api.get<{ items: GuardPolicy[] }>("/admin-api/policies"),
      api.get<{ items: BundleSummary[] }>("/admin-api/bundles"),
    ]);
    policies.value = p.items;
    bundles.value = b.items;
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load policies.";
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function numOrNull(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

async function createPolicy() {
  createError.value = "";
  if (!newName.value.trim()) {
    createError.value = "Name is required.";
    return;
  }
  creating.value = true;
  try {
    await api.post("/admin-api/policies", { name: newName.value.trim(), rateLimitPerMin: numOrNull(newRate.value), timeoutMs: numOrNull(newTimeout.value) });
    newName.value = "";
    newRate.value = "";
    newTimeout.value = "";
    showCreate.value = false;
    await load();
  } catch (err) {
    createError.value = err instanceof ApiError ? err.message : "Failed to create policy.";
  } finally {
    creating.value = false;
  }
}

async function apply(policy: GuardPolicy) {
  const bundle = applyBundle.value[policy.id];
  if (!bundle) return;
  notice.value = "";
  try {
    const res = await api.post<{ applied: number; skipped: unknown[] }>(`/admin-api/policies/${policy.id}/apply`, { bundle });
    notice.value = `Applied "${policy.name}" to ${res.applied} tool(s) in bundle "${bundle}".`;
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Apply failed.";
  }
}

async function confirmDelete() {
  if (!pendingDelete.value) return;
  const p = pendingDelete.value;
  pendingDelete.value = null;
  try {
    await api.delete(`/admin-api/policies/${p.id}`);
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to delete policy.";
  }
}
</script>

<template>
  <section>
    <header class="page-header">
      <h1>Guard policies</h1>
      <button type="button" class="btn-primary" @click="showCreate = !showCreate">{{ showCreate ? "Cancel" : "New policy" }}</button>
    </header>
    <p class="hint">Reusable rate-limit / timeout templates. Apply one to every tool in a bundle for bundle-level guard semantics. Applying preserves each tool's API-key allow-list.</p>

    <form v-if="showCreate" class="create-form" @submit.prevent="createPolicy">
      <div class="field"><label>Name</label><input v-model="newName" type="text" placeholder="strict" /></div>
      <div class="field"><label>Rate limit (calls/min, blank = none)</label><input v-model="newRate" type="text" inputmode="numeric" /></div>
      <div class="field"><label>Timeout (ms, blank = none)</label><input v-model="newTimeout" type="text" inputmode="numeric" /></div>
      <p v-if="createError" class="error">{{ createError }}</p>
      <button type="submit" class="btn-primary" :disabled="creating">{{ creating ? "Creating…" : "Create policy" }}</button>
    </form>

    <p v-if="notice" class="notice">{{ notice }}</p>
    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <div v-if="loading" class="loading">Loading…</div>
    <div v-else-if="policies.length === 0" class="empty">No policies yet.</div>

    <div v-else class="table-scroll">
      <table class="pol-table">
        <thead><tr><th>Name</th><th>Rate/min</th><th>Timeout</th><th>Apply to bundle</th><th></th></tr></thead>
        <tbody>
          <tr v-for="p in policies" :key="p.id">
            <td>{{ p.name }}</td>
            <td>{{ p.rateLimitPerMin ?? "—" }}</td>
            <td>{{ p.timeoutMs ? `${p.timeoutMs}ms` : "—" }}</td>
            <td class="apply-cell">
              <select v-model="applyBundle[p.id]">
                <option value="">Select bundle…</option>
                <option v-for="b in bundles" :key="b.name" :value="b.name">{{ b.name }}</option>
              </select>
              <button type="button" class="btn-secondary" :disabled="!applyBundle[p.id]" @click="apply(p)">Apply</button>
            </td>
            <td><button type="button" class="link-btn danger" @click="pendingDelete = p">Delete</button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this policy?"
      :message="pendingDelete ? `'${pendingDelete.name}' will be removed. Already-applied guards on tools are not reverted.` : ''"
      :confirm-label="pendingDelete ? `Delete ${pendingDelete.name}` : 'Delete'"
      danger
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </section>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}
.hint {
  color: #63676e;
  font-size: 0.85rem;
  margin-bottom: 1.25rem;
  max-width: 640px;
}
.create-form {
  background: #fafbfc;
  padding: 1.25rem;
  border-radius: 8px;
  margin-bottom: 1.5rem;
  max-width: 420px;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
}
.field input {
  width: 100%;
  padding: 0.45rem 0.6rem;
  border: 1px solid #cfd4da;
  border-radius: 6px;
  box-sizing: border-box;
}
.pol-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.pol-table th {
  text-align: left;
  padding: 0.5rem 0.6rem;
  border-bottom: 2px solid #e5e7eb;
  color: #52565c;
  font-size: 0.78rem;
  text-transform: uppercase;
}
.pol-table td {
  padding: 0.55rem 0.6rem;
  border-bottom: 1px solid #eef0f2;
}
.apply-cell {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.apply-cell select {
  padding: 0.35rem 0.5rem;
  border: 1px solid #cfd4da;
  border-radius: 6px;
}
.notice {
  color: #146c2e;
  font-size: 0.9rem;
}
.link-btn.danger {
  color: #a11212;
}
.error {
  color: #a11212;
}
.loading,
.empty {
  color: #63676e;
}
</style>

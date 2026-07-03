<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import { useLoadState } from "../composables/useResource";
import type { GuardPolicy, BundleSummary } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { ShieldCheck } from "lucide-vue-next";

const policies = ref<GuardPolicy[]>([]);
const bundles = ref<BundleSummary[]>([]);
const { loading, errorMessage, run } = useLoadState("Failed to load policies.");
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
const applyingId = ref<number | null>(null);
const applyResult = ref<Record<number, string>>({});

async function load() {
  await run(async () => {
    const [p, b] = await Promise.all([
      api.get<{ items: GuardPolicy[] }>("/admin-api/policies"),
      api.get<{ items: BundleSummary[] }>("/admin-api/bundles"),
    ]);
    policies.value = p.items;
    bundles.value = b.items;
  });
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
  if (newRate.value.trim() && !Number.isFinite(Number(newRate.value.trim()))) {
    createError.value = "Rate limit must be a plain number (no units), or blank.";
    return;
  }
  if (newTimeout.value.trim() && !Number.isFinite(Number(newTimeout.value.trim()))) {
    createError.value = "Timeout must be a plain number (no units), or blank.";
    return;
  }
  creating.value = true;
  try {
    await api.post("/admin-api/policies", {
      name: newName.value.trim(),
      rateLimitPerMin: numOrNull(newRate.value),
      timeoutMs: numOrNull(newTimeout.value),
    });
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
  applyingId.value = policy.id;
  try {
    const res = await api.post<{ applied: number; skipped: unknown[] }>(`/admin-api/policies/${policy.id}/apply`, {
      bundle,
    });
    const message = `Applied "${policy.name}" to ${res.applied} tool(s) in bundle "${bundle}".`;
    notice.value = message;
    applyResult.value[policy.id] = message;
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Apply failed.";
  } finally {
    applyingId.value = null;
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
      <div>
        <h1>Guard policies</h1>
        <p class="subtitle">
          Reusable rate-limit / timeout templates. Apply one to every tool in a bundle at once — each tool's existing
          API-key allow-list is left untouched.
        </p>
      </div>
      <button type="button" :class="showCreate ? 'btn-secondary' : 'btn-primary'" @click="showCreate = !showCreate">
        {{ showCreate ? "Cancel" : "New policy" }}
      </button>
    </header>

    <form v-if="showCreate" class="create-form" @submit.prevent="createPolicy">
      <div class="field">
        <label for="p-name">Name</label><input id="p-name" v-model="newName" type="text" placeholder="strict" />
      </div>
      <div class="field">
        <label for="p-rate">Rate limit (calls/min, blank = none)</label
        ><input id="p-rate" v-model="newRate" type="text" inputmode="numeric" />
      </div>
      <div class="field">
        <label for="p-timeout">Timeout (ms, blank = none)</label
        ><input id="p-timeout" v-model="newTimeout" type="text" inputmode="numeric" />
      </div>
      <p v-if="createError" class="error">{{ createError }}</p>
      <button type="submit" class="btn-primary" :disabled="creating">
        {{ creating ? "Creating…" : "Create policy" }}
      </button>
    </form>

    <p v-if="notice" class="notice">{{ notice }}</p>
    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <div v-if="loading" class="loading">Loading…</div>
    <div v-else-if="policies.length === 0" class="empty-state">
      <ShieldCheck :size="26" stroke-width="1.5" aria-hidden="true" class="empty-icon" />
      <p>No policies yet.</p>
    </div>

    <div v-else class="table-card table-scroll">
      <table class="pol-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Rate/min</th>
            <th>Timeout</th>
            <th>Apply to bundle</th>
            <th></th>
          </tr>
        </thead>
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
              <button
                type="button"
                class="btn-secondary"
                :disabled="!applyBundle[p.id] || applyingId === p.id"
                @click="apply(p)"
              >
                {{ applyingId === p.id ? "Applying…" : "Apply" }}
              </button>
              <span v-if="applyResult[p.id]" class="row-notice">{{ applyResult[p.id] }}</span>
            </td>
            <td><button type="button" class="link-btn danger" @click="pendingDelete = p">Delete</button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this policy?"
      :message="
        pendingDelete
          ? `'${pendingDelete.name}' will be removed. Already-applied guards on tools are not reverted.`
          : ''
      "
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
  align-items: flex-start;
  margin-bottom: 1.25rem;
}
.page-header h1 {
  margin: 0 0 0.2rem;
}
.subtitle {
  color: var(--text-secondary);
  margin: 0;
  max-width: 640px;
}
.create-form {
  background: var(--surface-sunken);
  padding: 1.25rem;
  border-radius: var(--radius-md);
  margin-bottom: 1.5rem;
  max-width: 420px;
}
.field {
  margin-bottom: 1rem;
}
.field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.3rem;
}
.field input,
.field select,
.field textarea {
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
  font-family: var(--font-body);
  box-sizing: border-box;
}
.table-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
}
.pol-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.pol-table th {
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.pol-table td {
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.pol-table tbody tr:last-child td {
  border-bottom: none;
}
.pol-table tbody tr:hover {
  background: var(--surface-sunken);
}
.apply-cell {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}
.apply-cell select {
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-family: var(--font-body);
}
.notice {
  color: var(--ok);
  font-size: 0.9rem;
}
.row-notice {
  color: var(--ok);
  font-size: 0.8rem;
}
.link-btn.danger {
  color: var(--breach);
}
.error {
  color: var(--breach);
}
.loading {
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
</style>

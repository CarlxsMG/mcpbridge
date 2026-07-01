<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { ConsumerWithUsage } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";

const consumers = ref<ConsumerWithUsage[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const pendingDelete = ref<ConsumerWithUsage | null>(null);

const showCreate = ref(false);
const newName = ref("");
const newQuota = ref("");
const createError = ref("");
const creating = ref(false);

async function load() {
  loading.value = true;
  errorMessage.value = "";
  try {
    consumers.value = (await api.get<{ items: ConsumerWithUsage[] }>("/admin-api/consumers")).items;
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load consumers.";
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function createConsumer() {
  createError.value = "";
  if (!newName.value.trim()) {
    createError.value = "Name is required.";
    return;
  }
  creating.value = true;
  try {
    const quota = newQuota.value.trim() ? Number(newQuota.value) : null;
    await api.post("/admin-api/consumers", { name: newName.value.trim(), monthlyQuota: quota });
    newName.value = "";
    newQuota.value = "";
    showCreate.value = false;
    await load();
  } catch (err) {
    createError.value = err instanceof ApiError ? err.message : "Failed to create consumer.";
  } finally {
    creating.value = false;
  }
}

async function confirmDelete() {
  if (!pendingDelete.value) return;
  const c = pendingDelete.value;
  pendingDelete.value = null;
  try {
    await api.delete(`/admin-api/consumers/${c.id}`);
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to delete consumer.";
  }
}
</script>

<template>
  <section>
    <header class="page-header">
      <h1>Consumers</h1>
      <button type="button" class="btn-primary" @click="showCreate = !showCreate">{{ showCreate ? "Cancel" : "New consumer" }}</button>
    </header>
    <p class="hint">Consumers (teams / apps) own API keys and can carry a monthly call quota enforced across all their keys.</p>

    <form v-if="showCreate" class="create-form" @submit.prevent="createConsumer">
      <div class="field"><label>Name</label><input v-model="newName" type="text" placeholder="mobile-app" /></div>
      <div class="field"><label>Monthly quota (blank = unlimited)</label><input v-model="newQuota" type="text" inputmode="numeric" /></div>
      <p v-if="createError" class="error">{{ createError }}</p>
      <button type="submit" class="btn-primary" :disabled="creating">{{ creating ? "Creating…" : "Create consumer" }}</button>
    </form>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <div v-if="loading" class="loading">Loading…</div>
    <div v-else-if="consumers.length === 0" class="empty">No consumers yet.</div>

    <div v-else class="table-scroll">
      <table class="cons-table">
        <thead><tr><th>Name</th><th>Quota</th><th>Used this month</th><th></th></tr></thead>
        <tbody>
          <tr v-for="c in consumers" :key="c.id">
            <td>{{ c.name }}</td>
            <td>{{ c.monthlyQuota ?? "Unlimited" }}</td>
            <td :class="{ hot: c.monthlyQuota !== null && c.usedThisMonth >= c.monthlyQuota }">{{ c.usedThisMonth }}</td>
            <td><button type="button" class="link-btn danger" @click="pendingDelete = c">Delete</button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this consumer?"
      :message="pendingDelete ? `'${pendingDelete.name}' will be removed; its keys keep working but become unattributed.` : ''"
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
  max-width: 380px;
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
.cons-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.cons-table th {
  text-align: left;
  padding: 0.5rem 0.6rem;
  border-bottom: 2px solid #e5e7eb;
  color: #52565c;
  font-size: 0.78rem;
  text-transform: uppercase;
}
.cons-table td {
  padding: 0.55rem 0.6rem;
  border-bottom: 1px solid #eef0f2;
}
.cons-table td.hot {
  color: #a11212;
  font-weight: 600;
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

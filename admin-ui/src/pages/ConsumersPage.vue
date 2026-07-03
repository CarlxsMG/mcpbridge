<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import { useResource } from "../composables/useResource";
import type { ConsumerWithUsage, ConsumerUsage } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import QuotaBar from "../components/QuotaBar.vue";
import { Users2, ChevronDown, ChevronRight } from "lucide-vue-next";

const {
  data: consumers,
  loading,
  errorMessage,
  load,
} = useResource<ConsumerWithUsage[]>(
  async () => (await api.get<{ items: ConsumerWithUsage[] }>("/admin-api/consumers")).items,
  [],
  "Failed to load consumers.",
);
const pendingDelete = ref<ConsumerWithUsage | null>(null);

const showCreate = ref(false);
const newName = ref("");
const newQuota = ref("");
const newEndUserLimit = ref("");
const createError = ref("");
const nameError = ref("");
const quotaError = ref("");
const endUserLimitError = ref("");
const creating = ref(false);
const editingConsumer = ref<ConsumerWithUsage | null>(null);

// Usage drilldown — GET /admin-api/consumers/:id/usage. Fetched lazily per row (rather than
// bundled into the list load above) since the list already carries `usedThisMonth`; expanding
// a row hits the dedicated endpoint fresh and caches the result for the rest of the session.
const expandedId = ref<number | null>(null);
const usageById = ref<Record<number, ConsumerUsage>>({});
const usageLoadingId = ref<number | null>(null);
const usageErrorById = ref<Record<number, string>>({});

function remainingLabel(usage: ConsumerUsage): string {
  if (usage.quota === null) return "Unlimited";
  return String(Math.max(usage.quota - usage.used, 0));
}

async function toggleUsage(consumer: ConsumerWithUsage) {
  if (expandedId.value === consumer.id) {
    expandedId.value = null;
    return;
  }
  expandedId.value = consumer.id;
  if (usageById.value[consumer.id]) return;
  usageLoadingId.value = consumer.id;
  delete usageErrorById.value[consumer.id];
  try {
    usageById.value[consumer.id] = await api.get<ConsumerUsage>(`/admin-api/consumers/${consumer.id}/usage`);
  } catch (err) {
    usageErrorById.value[consumer.id] = err instanceof ApiError ? err.message : "Failed to load usage detail.";
  } finally {
    usageLoadingId.value = null;
  }
}

onMounted(load);

function openCreate() {
  editingConsumer.value = null;
  newName.value = "";
  newQuota.value = "";
  newEndUserLimit.value = "";
  createError.value = "";
  nameError.value = "";
  quotaError.value = "";
  endUserLimitError.value = "";
  showCreate.value = true;
}

function openEdit(consumer: ConsumerWithUsage) {
  editingConsumer.value = consumer;
  newName.value = consumer.name;
  newQuota.value = consumer.monthlyQuota !== null ? String(consumer.monthlyQuota) : "";
  newEndUserLimit.value = consumer.endUserRateLimitPerMin !== null ? String(consumer.endUserRateLimitPerMin) : "";
  createError.value = "";
  nameError.value = "";
  quotaError.value = "";
  endUserLimitError.value = "";
  showCreate.value = true;
}

function closeForm() {
  showCreate.value = false;
  editingConsumer.value = null;
  newName.value = "";
  newQuota.value = "";
  newEndUserLimit.value = "";
  createError.value = "";
  nameError.value = "";
  quotaError.value = "";
  endUserLimitError.value = "";
}

async function submitConsumer() {
  createError.value = "";
  nameError.value = "";
  quotaError.value = "";
  endUserLimitError.value = "";
  if (!newName.value.trim()) {
    nameError.value = "Name is required.";
  }
  let quota: number | null = null;
  if (newQuota.value.trim()) {
    const n = Number(newQuota.value.trim());
    if (!Number.isFinite(n)) {
      quotaError.value = "Monthly quota must be a plain number, or blank.";
    } else {
      quota = n;
    }
  }
  let endUserRateLimitPerMin: number | null = null;
  if (newEndUserLimit.value.trim()) {
    const n = Number(newEndUserLimit.value.trim());
    if (!Number.isFinite(n)) {
      endUserLimitError.value = "Per-end-user rate limit must be a plain number, or blank.";
    } else {
      endUserRateLimitPerMin = n;
    }
  }
  if (nameError.value || quotaError.value || endUserLimitError.value) {
    return;
  }
  creating.value = true;
  try {
    if (editingConsumer.value) {
      await api.patch(`/admin-api/consumers/${editingConsumer.value.id}`, {
        name: newName.value.trim(),
        monthlyQuota: quota,
        endUserRateLimitPerMin,
      });
    } else {
      await api.post("/admin-api/consumers", {
        name: newName.value.trim(),
        monthlyQuota: quota,
        endUserRateLimitPerMin,
      });
    }
    closeForm();
    await load();
  } catch (err) {
    createError.value =
      err instanceof ApiError
        ? err.message
        : editingConsumer.value
          ? "Failed to update consumer."
          : "Failed to create consumer.";
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
      <div>
        <h1>Consumers</h1>
        <p class="subtitle">
          Consumers (teams / apps) own API keys and can carry a monthly call quota and an optional per-end-user rate
          limit enforced across all their keys.
        </p>
      </div>
      <button
        type="button"
        :class="showCreate ? 'btn-secondary' : 'btn-primary'"
        @click="showCreate ? closeForm() : openCreate()"
      >
        {{ showCreate ? "Cancel" : "New consumer" }}
      </button>
    </header>

    <form v-if="showCreate" class="create-form" @submit.prevent="submitConsumer">
      <div class="field">
        <label for="c-name">Name</label>
        <input id="c-name" v-model="newName" type="text" placeholder="mobile-app" />
        <p v-if="nameError" class="error">{{ nameError }}</p>
      </div>
      <div class="field">
        <label for="c-quota">Monthly quota (blank = unlimited)</label>
        <input id="c-quota" v-model="newQuota" type="text" inputmode="numeric" />
        <p v-if="quotaError" class="error">{{ quotaError }}</p>
      </div>
      <div class="field">
        <label for="c-end-user-limit">Per-end-user rate limit (calls/min, blank = disabled)</label>
        <input id="c-end-user-limit" v-model="newEndUserLimit" type="text" inputmode="numeric" />
        <p v-if="endUserLimitError" class="error">{{ endUserLimitError }}</p>
      </div>
      <p v-if="createError" class="error">{{ createError }}</p>
      <button type="submit" class="btn-primary" :disabled="creating">
        {{
          creating ? (editingConsumer ? "Saving…" : "Creating…") : editingConsumer ? "Save changes" : "Create consumer"
        }}
      </button>
    </form>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <div v-if="loading" class="loading">Loading…</div>
    <div v-else-if="consumers.length === 0" class="empty-state">
      <Users2 :size="26" stroke-width="1.5" aria-hidden="true" class="empty-icon" />
      <p>No consumers yet.</p>
    </div>

    <div v-else class="table-card table-scroll">
      <table class="cons-table">
        <thead>
          <tr>
            <th></th>
            <th>Name</th>
            <th>Quota</th>
            <th>Per-end-user limit</th>
            <th>Used this month</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="c in consumers" :key="c.id">
            <tr class="cons-row" @click="toggleUsage(c)">
              <td class="expand-col">
                <button
                  type="button"
                  class="expand-btn"
                  :aria-expanded="expandedId === c.id"
                  :aria-label="`Toggle usage detail for ${c.name}`"
                  @click.stop="toggleUsage(c)"
                >
                  <ChevronDown v-if="expandedId === c.id" :size="15" stroke-width="2" aria-hidden="true" />
                  <ChevronRight v-else :size="15" stroke-width="2" aria-hidden="true" />
                </button>
              </td>
              <td>{{ c.name }}</td>
              <td>{{ c.monthlyQuota ?? "Unlimited" }}</td>
              <td>{{ c.endUserRateLimitPerMin !== null ? `${c.endUserRateLimitPerMin}/min per user` : "—" }}</td>
              <td :class="{ hot: c.monthlyQuota !== null && c.usedThisMonth >= c.monthlyQuota }">
                <div class="usage-cell">
                  <span>{{ c.usedThisMonth }}</span>
                  <div class="usage-bar-wrap"><QuotaBar :used="c.usedThisMonth" :quota="c.monthlyQuota" /></div>
                </div>
              </td>
              <td class="actions" @click.stop>
                <button type="button" class="link-btn" @click="openEdit(c)">Edit</button>
                <button type="button" class="link-btn danger" @click="pendingDelete = c">Delete</button>
              </td>
            </tr>
            <tr v-if="expandedId === c.id" class="usage-detail-row">
              <td colspan="6">
                <div class="usage-detail">
                  <p v-if="usageLoadingId === c.id" class="loading">Loading usage…</p>
                  <p v-else-if="usageErrorById[c.id]" class="error">{{ usageErrorById[c.id] }}</p>
                  <template v-else-if="usageById[c.id]">
                    <div class="usage-detail-stats">
                      <div class="usage-stat">
                        <span class="usage-stat-label">Used this month</span>
                        <span class="usage-stat-value">{{ usageById[c.id].used }}</span>
                      </div>
                      <div class="usage-stat">
                        <span class="usage-stat-label">Monthly quota</span>
                        <span class="usage-stat-value">{{ usageById[c.id].quota ?? "Unlimited" }}</span>
                      </div>
                      <div class="usage-stat">
                        <span class="usage-stat-label">Remaining</span>
                        <span class="usage-stat-value">{{ remainingLabel(usageById[c.id]) }}</span>
                      </div>
                    </div>
                    <QuotaBar :used="usageById[c.id].used" :quota="usageById[c.id].quota" />
                  </template>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this consumer?"
      :message="
        pendingDelete ? `'${pendingDelete.name}' will be removed; its keys keep working but become unattributed.` : ''
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
  max-width: 380px;
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
.cons-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.cons-table th {
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.cons-table td {
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.cons-table tbody tr:last-child td {
  border-bottom: none;
}
.cons-table tbody tr:hover {
  background: var(--surface-sunken);
}
.cons-table td.hot {
  color: var(--breach);
  font-weight: 600;
}
.usage-cell {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.usage-bar-wrap {
  width: 90px;
}
.actions {
  display: flex;
  gap: 0.75rem;
}
.cons-row {
  cursor: pointer;
}
.expand-col {
  width: 2rem;
}
.expand-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  padding: 0.2rem;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.expand-btn:hover {
  color: var(--text-primary);
  background: var(--surface-sunken);
}
.usage-detail-row td {
  padding: 0;
  border-bottom: 1px solid var(--border);
}
.usage-detail {
  background: var(--surface-sunken);
  padding: var(--space-4) var(--space-5);
}
.usage-detail-stats {
  display: flex;
  gap: var(--space-8);
  margin-bottom: var(--space-3);
}
.usage-stat {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.usage-stat-label {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  font-weight: 600;
}
.usage-stat-value {
  font-family: var(--font-display);
  font-size: 1.1rem;
  color: var(--text-primary);
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

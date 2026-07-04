<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import { useResource } from "../composables/useResource";
import { useConfirmAction } from "../composables/useConfirmAction";
import { parseOptionalNumber } from "../composables/fieldParsing";
import type { ConsumerWithUsage, ConsumerUsage } from "../types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import QuotaBar from "@/components/charts/QuotaBar.vue";
import SignalLoader from "@/components/ui/SignalLoader.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import FormField from "@/components/ui/FormField.vue";
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
const {
  pending: pendingDelete,
  request: requestDelete,
  cancel: cancelDelete,
  confirm: confirmActionDelete,
} = useConfirmAction<ConsumerWithUsage>();

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
  const quotaResult = parseOptionalNumber(newQuota.value, "Monthly quota must be a plain number, or blank.");
  quotaError.value = quotaResult.error ?? "";
  const quota = quotaResult.value;
  const endUserLimitResult = parseOptionalNumber(
    newEndUserLimit.value,
    "Per-end-user rate limit must be a plain number, or blank.",
  );
  endUserLimitError.value = endUserLimitResult.error ?? "";
  const endUserRateLimitPerMin = endUserLimitResult.value;
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

function confirmDelete() {
  return confirmActionDelete(async (c) => {
    try {
      await api.delete(`/admin-api/consumers/${c.id}`);
      await load();
    } catch (err) {
      errorMessage.value = err instanceof ApiError ? err.message : "Failed to delete consumer.";
    }
  });
}
</script>

<template>
  <section>
    <PageHeader
      title="Consumers"
      subtitle="Consumers (teams / apps) own API keys and can carry a monthly call quota and an optional per-end-user rate limit enforced across all their keys."
    >
      <button
        type="button"
        :class="showCreate ? 'btn-secondary' : 'btn-primary'"
        @click="showCreate ? closeForm() : openCreate()"
      >
        {{ showCreate ? "Cancel" : "New consumer" }}
      </button>
    </PageHeader>

    <form v-if="showCreate" class="create-form" @submit.prevent="submitConsumer">
      <FormField label="Name" for="c-name">
        <input id="c-name" v-model="newName" type="text" placeholder="mobile-app" />
        <p v-if="nameError" class="error">{{ nameError }}</p>
      </FormField>
      <FormField label="Monthly quota (blank = unlimited)" for="c-quota">
        <input id="c-quota" v-model="newQuota" type="text" inputmode="numeric" />
        <p v-if="quotaError" class="error">{{ quotaError }}</p>
      </FormField>
      <FormField label="Per-end-user rate limit (calls/min, blank = disabled)" for="c-end-user-limit">
        <input id="c-end-user-limit" v-model="newEndUserLimit" type="text" inputmode="numeric" />
        <p v-if="endUserLimitError" class="error">{{ endUserLimitError }}</p>
      </FormField>
      <p v-if="createError" class="error">{{ createError }}</p>
      <button type="submit" class="btn-primary" :disabled="creating">
        {{
          creating ? (editingConsumer ? "Saving…" : "Creating…") : editingConsumer ? "Save changes" : "Create consumer"
        }}
      </button>
    </form>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <SignalLoader v-if="loading" />
    <EmptyState v-else-if="consumers.length === 0" :icon="Users2">
      No consumers yet. A consumer groups one or more API keys under a shared monthly quota and rate limit.
    </EmptyState>

    <TableCard v-else>
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
            <td>
              <div class="actions" @click.stop>
                <button type="button" class="link-btn" @click="openEdit(c)">Edit</button>
                <button type="button" class="link-btn danger" @click="requestDelete(c)">Delete</button>
              </div>
            </td>
          </tr>
          <tr v-if="expandedId === c.id" class="usage-detail-row">
            <td colspan="6">
              <div class="usage-detail">
                <SignalLoader v-if="usageLoadingId === c.id" label="Loading usage…" />
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
    </TableCard>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this consumer?"
      :message="
        pendingDelete ? `'${pendingDelete.name}' will be removed; its keys keep working but become unattributed.` : ''
      "
      :confirm-label="pendingDelete ? `Delete ${pendingDelete.name}` : 'Delete'"
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </section>
</template>

<style scoped>
.create-form {
  background: var(--surface-sunken);
  padding: 1.25rem;
  border-radius: var(--radius-md);
  margin-bottom: 1.5rem;
  max-width: 23.75rem;
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
:deep(.data-table td.hot) {
  color: var(--breach);
  font-weight: 600;
}
.usage-cell {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.usage-bar-wrap {
  width: 5.625rem;
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
</style>

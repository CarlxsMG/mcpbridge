<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import { toErrorMessage } from "@/utils/errors";
import { formatMaybeDate } from "@/utils/format";
import type { AlertRule, AlertEventType } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import TogglePill from "@/components/ui/TogglePill.vue";
import HoverPreview from "@/components/ui/HoverPreview.vue";
import { BellRing } from "lucide-vue-next";

const EVENT_LABELS: Record<AlertEventType, string> = {
  circuit_breaker_open: "Circuit breaker open",
  client_unreachable: "Client unreachable",
  error_rate: "Error-rate spike",
  usage_spike: "Usage spike (anomaly)",
  schema_drift: "Tool schema drift",
};

const {
  data: rules,
  loading,
  errorMessage,
  load,
} = useResource<AlertRule[]>(
  async () => (await api.get<{ items: AlertRule[] }>("/admin-api/alerts")).items,
  [],
  "Failed to load alerts.",
);
const testMessage = ref("");
const {
  pending: pendingDelete,
  request: requestDelete,
  cancel: cancelDelete,
  confirm: confirmActionDelete,
} = useConfirmAction<AlertRule>();
const {
  pending: pendingDisable,
  request: requestDisable,
  cancel: cancelDisable,
  confirm: confirmActionDisable,
} = useConfirmAction<AlertRule>();
const {
  rowError,
  toggle: toggleField,
  isPending,
} = useOptimisticToggle<AlertRule>((r) => r.id, "Failed to update rule.");
const testingRuleId = ref<number | null>(null);

onMounted(load);

function toggleEnabled(rule: AlertRule) {
  return toggleField(rule, "enabled", (next) => api.patch(`/admin-api/alerts/${rule.id}`, { enabled: next }));
}

function toggle(rule: AlertRule) {
  if (rule.enabled) {
    requestDisable(rule);
  } else {
    toggleEnabled(rule);
  }
}

function confirmDisable() {
  return confirmActionDisable(async (rule) => {
    await toggleEnabled(rule);
  });
}

async function testRule(rule: AlertRule) {
  testingRuleId.value = rule.id;
  testMessage.value = "";
  errorMessage.value = "";
  try {
    await api.post(`/admin-api/alerts/${rule.id}/test`);
    testMessage.value = `Test sent to '${rule.name}'.`;
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? `Test failed: ${err.message}` : "Test delivery failed.";
  } finally {
    testingRuleId.value = null;
  }
}

function confirmDelete() {
  return confirmActionDelete(async (rule) => {
    try {
      await api.delete(`/admin-api/alerts/${rule.id}`);
      await load();
    } catch (err) {
      errorMessage.value = toErrorMessage(err, "Failed to delete rule.");
    }
  });
}
</script>

<template>
  <section>
    <PageHeader title="Alerts">
      <RouterLink to="/alerts/new" class="btn-primary">New rule</RouterLink>
    </PageHeader>
    <p class="hint">
      Rules are evaluated on the leader instance and POST a JSON payload to a webhook when a condition first becomes
      true.
    </p>

    <p v-if="testMessage" class="success" role="status">{{ testMessage }}</p>

    <ListLayout :loading="loading" :error="errorMessage" :empty="rules.length === 0">
      <template #empty>
        <EmptyState :icon="BellRing">
          No alert rules yet. A rule watches for an event and POSTs a JSON payload to a webhook when it fires.
        </EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th>Name</th>
            <th>Event</th>
            <th>Webhook</th>
            <th>Last fired</th>
            <th>Enabled</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="rule in rules" :key="rule.id">
            <td>{{ rule.name }}</td>
            <td>{{ EVENT_LABELS[rule.eventType] }}</td>
            <td>
              <HoverPreview class="cell-truncate" :text="rule.webhookUrl" mono>{{ rule.webhookUrl }}</HoverPreview>
            </td>
            <td>{{ formatMaybeDate(rule.lastFiredAt) }}</td>
            <td>
              <TogglePill
                :on="rule.enabled"
                on-label="Enabled"
                off-label="Disabled"
                :aria-pressed="rule.enabled"
                :disabled="isPending(rule)"
                @click="toggle(rule)"
              />
              <p v-if="rowError[rule.id]" class="row-error">{{ rowError[rule.id] }}</p>
            </td>
            <td>
              <div class="actions">
                <button type="button" class="link-btn" :disabled="testingRuleId === rule.id" @click="testRule(rule)">
                  {{ testingRuleId === rule.id ? "Testing…" : "Test" }}
                </button>
                <button type="button" class="link-btn danger" @click="requestDelete(rule)">Delete</button>
              </div>
            </td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this alert rule?"
      :message="pendingDelete ? `'${pendingDelete.name}' will stop firing.` : ''"
      :confirm-label="pendingDelete ? `Delete ${pendingDelete.name}` : 'Delete'"
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />

    <ConfirmDialog
      :open="pendingDisable !== null"
      title="Disable this alert rule?"
      :message="pendingDisable ? `'${pendingDisable.name}' will stop firing until re-enabled.` : ''"
      :confirm-label="pendingDisable ? `Disable ${pendingDisable.name}` : 'Disable'"
      danger
      @confirm="confirmDisable"
      @cancel="cancelDisable"
    />
  </section>
</template>

<style scoped>
.hint {
  color: var(--text-secondary);
  font-size: 0.85rem;
  margin-bottom: 1.25rem;
}
.cell-truncate {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.83rem;
  max-width: 15rem;
}
.actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.success {
  color: var(--ok);
}
</style>

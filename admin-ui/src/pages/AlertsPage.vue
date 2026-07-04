<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import { useResource } from "../composables/useResource";
import { useConfirmAction } from "../composables/useConfirmAction";
import { useOptimisticToggle } from "../composables/useOptimisticToggle";
import { useEntityForm } from "@/composables/useEntityForm";
import { parseOptionalNumber } from "@/utils/fieldParsing";
import { toErrorMessage } from "@/utils/errors";
import { formatMaybeDate } from "@/utils/format";
import type { AlertRule, AlertEventType } from "../types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import FormField from "@/components/ui/FormField.vue";
import ToggleFormButton from "@/components/ui/ToggleFormButton.vue";
import TogglePill from "@/components/ui/TogglePill.vue";
import { BellRing } from "lucide-vue-next";

const EVENT_LABELS: Record<AlertEventType, string> = {
  circuit_breaker_open: "Circuit breaker open",
  client_unreachable: "Client unreachable",
  error_rate: "Error-rate spike",
  usage_spike: "Usage spike (anomaly)",
  schema_drift: "Tool schema drift",
};

/** Event types that use the threshold + minCalls numeric inputs. */
const NUMERIC_EVENTS = new Set<AlertEventType>(["error_rate", "usage_spike"]);

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

const newName = ref("");
const newEvent = ref<AlertEventType>("circuit_breaker_open");
const newUrl = ref("");
const newThreshold = ref("0.5");
const newMinCalls = ref("10");
const nameError = ref("");
const urlError = ref("");

function resetForm() {
  newName.value = "";
  newUrl.value = "";
}

const { open: showCreate, busy: creating, error: createError, submit } = useEntityForm<void>({ reset: resetForm });

onMounted(load);

async function createRule() {
  createError.value = "";
  nameError.value = "";
  urlError.value = "";
  if (!newName.value.trim()) {
    nameError.value = "Name is required.";
  }
  if (!newUrl.value.trim()) {
    urlError.value = "Webhook URL is required.";
  }
  if (nameError.value || urlError.value) {
    return;
  }
  let threshold: number | null = null;
  let minCalls: number | null = null;
  if (NUMERIC_EVENTS.has(newEvent.value)) {
    // threshold/minCalls are required (not optional) in this branch, so a blank
    // value must be rejected too -- parseOptionalNumber treats blank as valid
    // (value: null, error: null), so check .value rather than just .error.
    const thresholdResult = parseOptionalNumber(newThreshold.value, "Threshold must be a plain number.");
    if (thresholdResult.value === null) {
      createError.value = "Threshold must be a plain number.";
      return;
    }
    const minCallsResult = parseOptionalNumber(newMinCalls.value, "Minimum calls must be a plain number.");
    if (minCallsResult.value === null) {
      createError.value = "Minimum calls must be a plain number.";
      return;
    }
    threshold = thresholdResult.value;
    minCalls = minCallsResult.value;
  }
  const ok = await submit(async () => {
    const body: Record<string, unknown> = {
      name: newName.value.trim(),
      eventType: newEvent.value,
      webhookUrl: newUrl.value.trim(),
    };
    if (NUMERIC_EVENTS.has(newEvent.value)) {
      body.threshold = threshold;
      body.minCalls = minCalls;
    }
    await api.post("/admin-api/alerts", body);
  }, "Failed to create rule.");
  if (ok) await load();
}

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
      <ToggleFormButton v-model="showCreate" show-label="New rule" />
    </PageHeader>
    <p class="hint">
      Rules are evaluated on the leader instance and POST a JSON payload to a webhook when a condition first becomes
      true.
    </p>

    <form v-if="showCreate" class="create-form" @submit.prevent="createRule">
      <FormField label="Name" for="alert-name">
        <input id="alert-name" v-model="newName" type="text" placeholder="pager" />
        <p v-if="nameError" class="error">{{ nameError }}</p>
      </FormField>
      <FormField label="Event" for="alert-event">
        <select id="alert-event" v-model="newEvent">
          <option v-for="(label, ev) in EVENT_LABELS" :key="ev" :value="ev">{{ label }}</option>
        </select>
      </FormField>
      <FormField label="Webhook URL" for="alert-url">
        <input id="alert-url" v-model="newUrl" type="url" placeholder="https://hooks.example.com/x" />
        <p v-if="urlError" class="error">{{ urlError }}</p>
      </FormField>
      <template v-if="NUMERIC_EVENTS.has(newEvent)">
        <FormField
          :label="newEvent === 'usage_spike' ? 'Spike factor (× baseline)' : 'Threshold (0–1)'"
          for="alert-threshold"
        >
          <input
            id="alert-threshold"
            v-model="newThreshold"
            type="text"
            inputmode="decimal"
            :placeholder="newEvent === 'usage_spike' ? '3' : '0.5'"
          />
        </FormField>
        <FormField label="Min calls" for="alert-mincalls">
          <input
            id="alert-mincalls"
            v-model="newMinCalls"
            type="text"
            inputmode="numeric"
            :placeholder="newEvent === 'usage_spike' ? '20' : '10'"
          />
        </FormField>
      </template>
      <p v-if="createError" class="error">{{ createError }}</p>
      <button type="submit" class="btn-primary" :disabled="creating">
        {{ creating ? "Creating…" : "Create rule" }}
      </button>
    </form>

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
            <td class="cell-truncate" :title="rule.webhookUrl">{{ rule.webhookUrl }}</td>
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
.create-form {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: 1.25rem;
  margin-bottom: 1.5rem;
  max-width: 26.25rem;
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

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import { useResource } from "../composables/useResource";
import type { AlertRule, AlertEventType } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import SignalLoader from "../components/SignalLoader.vue";
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
const pendingDelete = ref<AlertRule | null>(null);
const pendingDisable = ref<AlertRule | null>(null);
const togglingRuleId = ref<number | null>(null);
const testingRuleId = ref<number | null>(null);

const showCreate = ref(false);
const newName = ref("");
const newEvent = ref<AlertEventType>("circuit_breaker_open");
const newUrl = ref("");
const newThreshold = ref("0.5");
const newMinCalls = ref("10");
const createError = ref("");
const nameError = ref("");
const urlError = ref("");
const creating = ref(false);

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
  creating.value = true;
  try {
    const body: Record<string, unknown> = {
      name: newName.value.trim(),
      eventType: newEvent.value,
      webhookUrl: newUrl.value.trim(),
    };
    if (NUMERIC_EVENTS.has(newEvent.value)) {
      body.threshold = Number(newThreshold.value);
      body.minCalls = Number(newMinCalls.value);
    }
    await api.post("/admin-api/alerts", body);
    newName.value = "";
    newUrl.value = "";
    showCreate.value = false;
    await load();
  } catch (err) {
    createError.value = err instanceof ApiError ? err.message : "Failed to create rule.";
  } finally {
    creating.value = false;
  }
}

async function doToggle(rule: AlertRule, enabled: boolean) {
  togglingRuleId.value = rule.id;
  try {
    await api.patch(`/admin-api/alerts/${rule.id}`, { enabled });
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to update rule.";
  } finally {
    togglingRuleId.value = null;
  }
}

function toggle(rule: AlertRule) {
  if (rule.enabled) {
    pendingDisable.value = rule;
  } else {
    doToggle(rule, true);
  }
}

async function confirmDisable() {
  if (!pendingDisable.value) return;
  const rule = pendingDisable.value;
  pendingDisable.value = null;
  await doToggle(rule, false);
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

async function confirmDelete() {
  if (!pendingDelete.value) return;
  const rule = pendingDelete.value;
  pendingDelete.value = null;
  try {
    await api.delete(`/admin-api/alerts/${rule.id}`);
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to delete rule.";
  }
}
</script>

<template>
  <section>
    <header class="page-header">
      <h1>Alerts</h1>
      <button type="button" :class="showCreate ? 'btn-secondary' : 'btn-primary'" @click="showCreate = !showCreate">
        {{ showCreate ? "Cancel" : "New rule" }}
      </button>
    </header>
    <p class="hint">
      Rules are evaluated on the leader instance and POST a JSON payload to a webhook when a condition first becomes
      true.
    </p>

    <form v-if="showCreate" class="create-form" @submit.prevent="createRule">
      <div class="field">
        <label for="alert-name">Name</label>
        <input id="alert-name" v-model="newName" type="text" placeholder="pager" />
        <p v-if="nameError" class="error">{{ nameError }}</p>
      </div>
      <div class="field">
        <label for="alert-event">Event</label>
        <select id="alert-event" v-model="newEvent">
          <option v-for="(label, ev) in EVENT_LABELS" :key="ev" :value="ev">{{ label }}</option>
        </select>
      </div>
      <div class="field">
        <label for="alert-url">Webhook URL</label>
        <input id="alert-url" v-model="newUrl" type="url" placeholder="https://hooks.example.com/x" />
        <p v-if="urlError" class="error">{{ urlError }}</p>
      </div>
      <template v-if="NUMERIC_EVENTS.has(newEvent)">
        <div class="field">
          <label for="alert-threshold">{{
            newEvent === "usage_spike" ? "Spike factor (× baseline)" : "Threshold (0–1)"
          }}</label>
          <input
            id="alert-threshold"
            v-model="newThreshold"
            type="text"
            inputmode="decimal"
            :placeholder="newEvent === 'usage_spike' ? '3' : '0.5'"
          />
        </div>
        <div class="field">
          <label for="alert-mincalls">Min calls</label>
          <input
            id="alert-mincalls"
            v-model="newMinCalls"
            type="text"
            inputmode="numeric"
            :placeholder="newEvent === 'usage_spike' ? '20' : '10'"
          />
        </div>
      </template>
      <p v-if="createError" class="error">{{ createError }}</p>
      <button type="submit" class="btn-primary" :disabled="creating">
        {{ creating ? "Creating…" : "Create rule" }}
      </button>
    </form>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <p v-if="testMessage" class="success" role="status">{{ testMessage }}</p>
    <SignalLoader v-if="loading" />

    <div v-else-if="rules.length === 0" class="empty-state">
      <BellRing :size="26" stroke-width="1.5" aria-hidden="true" class="empty-icon" />
      <p>No alert rules yet. A rule watches for an event and POSTs a JSON payload to a webhook when it fires.</p>
    </div>

    <div v-else class="table-card table-scroll">
      <table class="alerts-table">
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
            <td class="url-cell" :title="rule.webhookUrl">{{ rule.webhookUrl }}</td>
            <td>{{ rule.lastFiredAt ? new Date(rule.lastFiredAt).toLocaleString() : "Never" }}</td>
            <td>
              <button
                type="button"
                class="toggle"
                :class="rule.enabled ? 'toggle-on' : 'toggle-off'"
                :aria-pressed="rule.enabled"
                :disabled="togglingRuleId === rule.id"
                @click="toggle(rule)"
              >
                {{ rule.enabled ? "Enabled" : "Disabled" }}
              </button>
            </td>
            <td class="actions">
              <button type="button" class="link-btn" :disabled="testingRuleId === rule.id" @click="testRule(rule)">
                {{ testingRuleId === rule.id ? "Testing…" : "Test" }}
              </button>
              <button type="button" class="link-btn danger" @click="pendingDelete = rule">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this alert rule?"
      :message="pendingDelete ? `'${pendingDelete.name}' will stop firing.` : ''"
      :confirm-label="pendingDelete ? `Delete ${pendingDelete.name}` : 'Delete'"
      danger
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />

    <ConfirmDialog
      :open="pendingDisable !== null"
      title="Disable this alert rule?"
      :message="pendingDisable ? `'${pendingDisable.name}' will stop firing until re-enabled.` : ''"
      :confirm-label="pendingDisable ? `Disable ${pendingDisable.name}` : 'Disable'"
      danger
      @confirm="confirmDisable"
      @cancel="pendingDisable = null"
    />
  </section>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 0.5rem;
}
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
.alerts-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.alerts-table th {
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.alerts-table td {
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.alerts-table tbody tr:last-child td {
  border-bottom: none;
}
.alerts-table tbody tr:hover {
  background: var(--surface-sunken);
}
.url-cell {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.83rem;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.45em;
  border-radius: var(--radius-pill);
  padding: 0.28rem 0.8rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  background: var(--surface);
  transition: background-color 0.12s ease;
}
.toggle::before {
  content: "";
  width: 0.55em;
  height: 0.55em;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.toggle-on {
  border: 1px solid var(--ok);
  color: var(--ok);
}
.toggle-off {
  border: 1px solid var(--border-strong);
  color: var(--text-secondary);
}
.toggle-on:hover {
  background: var(--ok-soft);
}
.toggle-off:hover {
  background: var(--surface-sunken);
}
.toggle:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.success {
  color: var(--ok);
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

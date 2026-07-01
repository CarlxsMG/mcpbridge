<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { AlertRule, AlertEventType } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";

const EVENT_LABELS: Record<AlertEventType, string> = {
  circuit_breaker_open: "Circuit breaker open",
  client_unreachable: "Client unreachable",
  error_rate: "Error-rate spike",
  usage_spike: "Usage spike (anomaly)",
};

/** Event types that use the threshold + minCalls numeric inputs. */
const NUMERIC_EVENTS = new Set<AlertEventType>(["error_rate", "usage_spike"]);

const rules = ref<AlertRule[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const pendingDelete = ref<AlertRule | null>(null);

const showCreate = ref(false);
const newName = ref("");
const newEvent = ref<AlertEventType>("circuit_breaker_open");
const newUrl = ref("");
const newThreshold = ref("0.5");
const newMinCalls = ref("10");
const createError = ref("");
const creating = ref(false);

async function load() {
  loading.value = true;
  errorMessage.value = "";
  try {
    rules.value = (await api.get<{ items: AlertRule[] }>("/admin-api/alerts")).items;
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load alerts.";
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function createRule() {
  createError.value = "";
  if (!newName.value.trim() || !newUrl.value.trim()) {
    createError.value = "Name and webhook URL are required.";
    return;
  }
  creating.value = true;
  try {
    const body: Record<string, unknown> = { name: newName.value.trim(), eventType: newEvent.value, webhookUrl: newUrl.value.trim() };
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

async function toggle(rule: AlertRule) {
  try {
    await api.patch(`/admin-api/alerts/${rule.id}`, { enabled: !rule.enabled });
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to update rule.";
  }
}

async function testRule(rule: AlertRule) {
  try {
    await api.post(`/admin-api/alerts/${rule.id}/test`);
    errorMessage.value = "";
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? `Test failed: ${err.message}` : "Test delivery failed.";
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
      <button type="button" class="btn-primary" @click="showCreate = !showCreate">{{ showCreate ? "Cancel" : "New rule" }}</button>
    </header>
    <p class="hint">Rules are evaluated on the leader instance and POST a JSON payload to a webhook when a condition first becomes true.</p>

    <form v-if="showCreate" class="create-form" @submit.prevent="createRule">
      <div class="field"><label>Name</label><input v-model="newName" type="text" placeholder="pager" /></div>
      <div class="field">
        <label>Event</label>
        <select v-model="newEvent">
          <option v-for="(label, ev) in EVENT_LABELS" :key="ev" :value="ev">{{ label }}</option>
        </select>
      </div>
      <div class="field"><label>Webhook URL</label><input v-model="newUrl" type="url" placeholder="https://hooks.example.com/x" /></div>
      <template v-if="NUMERIC_EVENTS.has(newEvent)">
        <div class="field">
          <label>{{ newEvent === 'usage_spike' ? 'Spike factor (× baseline)' : 'Threshold (0–1)' }}</label>
          <input v-model="newThreshold" type="text" inputmode="decimal" :placeholder="newEvent === 'usage_spike' ? '3' : '0.5'" />
        </div>
        <div class="field"><label>Min calls</label><input v-model="newMinCalls" type="text" inputmode="numeric" :placeholder="newEvent === 'usage_spike' ? '20' : '10'" /></div>
      </template>
      <p v-if="createError" class="error">{{ createError }}</p>
      <button type="submit" class="btn-primary" :disabled="creating">{{ creating ? "Creating…" : "Create rule" }}</button>
    </form>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <div v-if="loading" class="loading">Loading…</div>
    <div v-else-if="rules.length === 0" class="empty">No alert rules yet.</div>

    <div v-else class="table-scroll">
      <table class="alerts-table">
        <thead><tr><th>Name</th><th>Event</th><th>Webhook</th><th>Last fired</th><th>Enabled</th><th></th></tr></thead>
        <tbody>
          <tr v-for="rule in rules" :key="rule.id">
            <td>{{ rule.name }}</td>
            <td>{{ EVENT_LABELS[rule.eventType] }}</td>
            <td class="url-cell">{{ rule.webhookUrl }}</td>
            <td>{{ rule.lastFiredAt ? new Date(rule.lastFiredAt).toLocaleString() : "Never" }}</td>
            <td>
              <button type="button" class="toggle" :class="rule.enabled ? 'toggle-on' : 'toggle-off'" @click="toggle(rule)">
                {{ rule.enabled ? "Enabled" : "Disabled" }}
              </button>
            </td>
            <td class="actions">
              <button type="button" class="link-btn" @click="testRule(rule)">Test</button>
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
.field input,
.field select {
  width: 100%;
  padding: 0.45rem 0.6rem;
  border: 1px solid #cfd4da;
  border-radius: 6px;
  box-sizing: border-box;
}
.alerts-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.alerts-table th {
  text-align: left;
  padding: 0.5rem 0.6rem;
  border-bottom: 2px solid #e5e7eb;
  color: #52565c;
  font-size: 0.78rem;
  text-transform: uppercase;
}
.alerts-table td {
  padding: 0.55rem 0.6rem;
  border-bottom: 1px solid #eef0f2;
}
.url-cell {
  color: #63676e;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.actions {
  display: flex;
  gap: 0.75rem;
}
.toggle {
  border-radius: 6px;
  padding: 0.2rem 0.6rem;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  background: #fff;
}
.toggle-on {
  border: 1px solid #146c2e;
  color: #146c2e;
}
.toggle-off {
  border: 1px solid #9aa0a8;
  color: #52565c;
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

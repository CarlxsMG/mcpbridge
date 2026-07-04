<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import { useResource } from "../composables/useResource";
import type { WsProxyTarget } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import SignalLoader from "../components/SignalLoader.vue";
import TableCard from "../components/TableCard.vue";
import EmptyState from "../components/EmptyState.vue";
import FormField from "../components/FormField.vue";
import { Waypoints } from "lucide-vue-next";

const {
  data: targets,
  loading,
  errorMessage,
  load,
} = useResource<WsProxyTarget[]>(
  async () => (await api.get<{ items: WsProxyTarget[] }>("/admin-api/ws-proxy-targets")).items,
  [],
  "Failed to load WS proxy targets.",
);
const pendingDelete = ref<WsProxyTarget | null>(null);
const pendingDisconnect = ref<WsProxyTarget | null>(null);
const disconnectingName = ref<string | null>(null);

const showCreate = ref(false);
const newName = ref("");
const newBackendUrl = ref("");
const newMaxConnections = ref("");
const newMaxMessageBytes = ref("");
const newIdleTimeoutMinutes = ref("");
const createError = ref("");
const creating = ref(false);
const editingTarget = ref<WsProxyTarget | null>(null);

onMounted(load);

function resetForm() {
  newName.value = "";
  newBackendUrl.value = "";
  newMaxConnections.value = "";
  newMaxMessageBytes.value = "";
  newIdleTimeoutMinutes.value = "";
  createError.value = "";
  editingTarget.value = null;
}

function openCreate() {
  resetForm();
  showCreate.value = true;
}

function openEdit(target: WsProxyTarget) {
  editingTarget.value = target;
  newName.value = target.name;
  newBackendUrl.value = target.backendWsUrl;
  newMaxConnections.value = String(target.maxConnections);
  newMaxMessageBytes.value = String(target.maxMessageBytes);
  newIdleTimeoutMinutes.value = String(Math.round(target.idleTimeoutMs / 60_000));
  createError.value = "";
  showCreate.value = true;
}

function closeForm() {
  showCreate.value = false;
  resetForm();
}

async function submitTarget() {
  createError.value = "";
  if (!newName.value.trim() || !newBackendUrl.value.trim()) {
    createError.value = "Name and backend WebSocket URL are required.";
    return;
  }
  for (const [label, field] of [
    ["Max connections", newMaxConnections],
    ["Max message size", newMaxMessageBytes],
    ["Idle timeout", newIdleTimeoutMinutes],
  ] as const) {
    if (field.value.trim() && !Number.isFinite(Number(field.value.trim()))) {
      createError.value = `${label} must be a plain number, or blank.`;
      return;
    }
  }
  creating.value = true;
  try {
    const body: Record<string, unknown> = { backendWsUrl: newBackendUrl.value.trim() };
    if (newMaxConnections.value.trim()) body.maxConnections = Number(newMaxConnections.value.trim());
    if (newMaxMessageBytes.value.trim()) body.maxMessageBytes = Number(newMaxMessageBytes.value.trim());
    if (newIdleTimeoutMinutes.value.trim()) body.idleTimeoutMs = Number(newIdleTimeoutMinutes.value.trim()) * 60_000;

    if (editingTarget.value) {
      await api.patch(`/admin-api/ws-proxy-targets/${encodeURIComponent(editingTarget.value.name)}`, body);
    } else {
      body.name = newName.value.trim();
      await api.post("/admin-api/ws-proxy-targets", body);
    }
    closeForm();
    await load();
  } catch (err) {
    createError.value = err instanceof ApiError ? err.message : "Failed to save target.";
  } finally {
    creating.value = false;
  }
}

async function toggleEnabled(target: WsProxyTarget) {
  const next = !target.enabled;
  try {
    await api.patch(`/admin-api/ws-proxy-targets/${encodeURIComponent(target.name)}`, {
      enabled: next,
      backendWsUrl: target.backendWsUrl,
    });
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to update target.";
  }
}

function requestDisconnectAll(target: WsProxyTarget) {
  pendingDisconnect.value = target;
}

async function confirmDisconnectAll() {
  if (!pendingDisconnect.value) return;
  const target = pendingDisconnect.value;
  pendingDisconnect.value = null;
  disconnectingName.value = target.name;
  try {
    await api.post(`/admin-api/ws-proxy-targets/${encodeURIComponent(target.name)}/disconnect-all`, {});
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to disconnect.";
  } finally {
    disconnectingName.value = null;
  }
}

async function confirmDelete() {
  if (!pendingDelete.value) return;
  const target = pendingDelete.value;
  pendingDelete.value = null;
  try {
    await api.delete(`/admin-api/ws-proxy-targets/${encodeURIComponent(target.name)}`);
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to delete target.";
  }
}
</script>

<template>
  <section>
    <header class="page-header">
      <div>
        <h1>WS proxy targets</h1>
        <p class="subtitle">
          Live, bidirectional WebSocket passthrough to a raw backend service, served at
          <code>/ws-proxy/&lt;name&gt;</code>. Distinct from a registered server — a target has no tools.
        </p>
      </div>
      <button
        type="button"
        :class="showCreate ? 'btn-secondary' : 'btn-primary'"
        @click="showCreate ? closeForm() : openCreate()"
      >
        {{ showCreate ? "Cancel" : "New target" }}
      </button>
    </header>

    <form v-if="showCreate" class="create-form" @submit.prevent="submitTarget">
      <FormField label="Name" for="wp-name">
        <input
          id="wp-name"
          v-model="newName"
          type="text"
          placeholder="iot-gateway"
          :disabled="editingTarget !== null"
        />
      </FormField>
      <FormField label="Backend WebSocket URL" for="wp-url">
        <input id="wp-url" v-model="newBackendUrl" type="text" placeholder="wss://backend.example.com/socket" />
      </FormField>
      <FormField label="Max concurrent connections (blank = default)" for="wp-max-conn">
        <input id="wp-max-conn" v-model="newMaxConnections" type="text" inputmode="numeric" />
      </FormField>
      <FormField label="Max message size, bytes (blank = default)" for="wp-max-bytes">
        <input id="wp-max-bytes" v-model="newMaxMessageBytes" type="text" inputmode="numeric" />
      </FormField>
      <FormField label="Idle timeout, minutes (blank = default)" for="wp-idle">
        <input id="wp-idle" v-model="newIdleTimeoutMinutes" type="text" inputmode="numeric" />
      </FormField>
      <p v-if="createError" class="error">{{ createError }}</p>
      <button type="submit" class="btn-primary" :disabled="creating">
        {{ creating ? "Saving…" : editingTarget ? "Save changes" : "Create target" }}
      </button>
    </form>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <SignalLoader v-if="loading" />
    <EmptyState v-else-if="targets.length === 0" :icon="Waypoints">
      No WS proxy targets yet. A target lets MCP tools dispatch over a persistent WebSocket connection to a backend
      service instead of plain REST.
    </EmptyState>

    <TableCard v-else>
      <thead>
        <tr>
          <th>Name</th>
          <th>Backend URL</th>
          <th>Connections</th>
          <th>Enabled</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="t in targets" :key="t.name">
          <td>{{ t.name }}</td>
          <td class="url-cell" :title="t.backendWsUrl">{{ t.backendWsUrl }}</td>
          <td>{{ t.activeConnections }} / {{ t.maxConnections }}</td>
          <td>
            <button
              type="button"
              class="toggle"
              :class="t.enabled ? 'toggle-on' : 'toggle-off'"
              @click="toggleEnabled(t)"
            >
              {{ t.enabled ? "Enabled" : "Disabled" }}
            </button>
          </td>
          <td>
            <div class="actions">
              <button type="button" class="link-btn" @click="openEdit(t)">Edit</button>
              <button
                type="button"
                class="link-btn"
                :disabled="disconnectingName === t.name || t.activeConnections === 0"
                @click="requestDisconnectAll(t)"
              >
                {{ disconnectingName === t.name ? "Disconnecting…" : "Disconnect all" }}
              </button>
              <button type="button" class="link-btn danger" @click="pendingDelete = t">Delete</button>
            </div>
          </td>
        </tr>
      </tbody>
    </TableCard>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this WS proxy target?"
      :message="pendingDelete ? `'${pendingDelete.name}' will be removed and any live connections force-closed.` : ''"
      :confirm-label="pendingDelete ? `Delete ${pendingDelete.name}` : 'Delete'"
      danger
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />

    <ConfirmDialog
      :open="pendingDisconnect !== null"
      title="Disconnect all sessions?"
      :message="
        pendingDisconnect
          ? `'${pendingDisconnect.name}' has ${pendingDisconnect.activeConnections} live connection(s); disconnecting will force-close all of them and drop any in-flight messages.`
          : ''
      "
      confirm-label="Disconnect all"
      danger
      @confirm="confirmDisconnectAll"
      @cancel="pendingDisconnect = null"
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
  max-width: 35rem;
}
.create-form {
  background: var(--surface-sunken);
  padding: 1.25rem;
  border-radius: var(--radius-md);
  margin-bottom: 1.5rem;
  max-width: 26.25rem;
}
.field input {
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
  font-family: var(--font-body);
  box-sizing: border-box;
}
.field input:disabled {
  background: var(--surface-sunken);
  color: var(--text-muted);
}
.url-cell {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.83rem;
  max-width: 17.5rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.link-btn.danger {
  color: var(--breach);
}
.link-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
.error {
  color: var(--breach);
}
</style>

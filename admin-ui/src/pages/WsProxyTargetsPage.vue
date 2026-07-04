<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import { useEntityForm } from "@/composables/useEntityForm";
import { parseOptionalNumber } from "@/utils/fieldParsing";
import { toErrorMessage } from "@/utils/errors";
import type { WsProxyTarget } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import FormField from "@/components/ui/FormField.vue";
import TogglePill from "@/components/ui/TogglePill.vue";
import HoverPreview from "@/components/ui/HoverPreview.vue";
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
const {
  pending: pendingDelete,
  request: requestDelete,
  cancel: cancelDelete,
  confirm: confirmActionDelete,
} = useConfirmAction<WsProxyTarget>();
const {
  pending: pendingDisconnect,
  request: requestDisconnectAll,
  cancel: cancelDisconnectAll,
  confirm: confirmActionDisconnectAll,
} = useConfirmAction<WsProxyTarget>();
const disconnectingName = ref<string | null>(null);
const { rowError, toggle: toggleField } = useOptimisticToggle<WsProxyTarget>((t) => t.name, "Failed to update target.");

const newName = ref("");
const newBackendUrl = ref("");
const newMaxConnections = ref("");
const newMaxMessageBytes = ref("");
const newIdleTimeoutMinutes = ref("");

function resetForm() {
  newName.value = "";
  newBackendUrl.value = "";
  newMaxConnections.value = "";
  newMaxMessageBytes.value = "";
  newIdleTimeoutMinutes.value = "";
}

function fillForm(target: WsProxyTarget) {
  newName.value = target.name;
  newBackendUrl.value = target.backendWsUrl;
  newMaxConnections.value = String(target.maxConnections);
  newMaxMessageBytes.value = String(target.maxMessageBytes);
  newIdleTimeoutMinutes.value = String(Math.round(target.idleTimeoutMs / 60_000));
}

const {
  open: showEdit,
  busy: creating,
  error: createError,
  openEdit,
  close: closeForm,
  submit,
} = useEntityForm<WsProxyTarget>({ reset: resetForm, fill: fillForm });

onMounted(load);

async function submitTarget() {
  createError.value = "";
  if (!newName.value.trim() || !newBackendUrl.value.trim()) {
    createError.value = "Name and backend WebSocket URL are required.";
    return;
  }
  const maxConnectionsResult = parseOptionalNumber(
    newMaxConnections.value,
    "Max connections must be a plain number, or blank.",
  );
  const maxMessageBytesResult = parseOptionalNumber(
    newMaxMessageBytes.value,
    "Max message size must be a plain number, or blank.",
  );
  const idleTimeoutMinutesResult = parseOptionalNumber(
    newIdleTimeoutMinutes.value,
    "Idle timeout must be a plain number, or blank.",
  );
  for (const result of [maxConnectionsResult, maxMessageBytesResult, idleTimeoutMinutesResult]) {
    if (result.error) {
      createError.value = result.error;
      return;
    }
  }
  const ok = await submit(async (editing) => {
    if (!editing) return;
    const body: Record<string, unknown> = { backendWsUrl: newBackendUrl.value.trim() };
    if (maxConnectionsResult.value !== null) body.maxConnections = maxConnectionsResult.value;
    if (maxMessageBytesResult.value !== null) body.maxMessageBytes = maxMessageBytesResult.value;
    if (idleTimeoutMinutesResult.value !== null) body.idleTimeoutMs = idleTimeoutMinutesResult.value * 60_000;
    await api.patch(`/admin-api/ws-proxy-targets/${encodeURIComponent(editing.name)}`, body);
  }, "Failed to save target.");
  if (ok) await load();
}

async function toggleEnabled(target: WsProxyTarget) {
  await toggleField(target, "enabled", (next) =>
    api.patch(`/admin-api/ws-proxy-targets/${encodeURIComponent(target.name)}`, {
      enabled: next,
      backendWsUrl: target.backendWsUrl,
    }),
  );
}

async function confirmDisconnectAll() {
  await confirmActionDisconnectAll(async (target) => {
    disconnectingName.value = target.name;
    try {
      await api.post(`/admin-api/ws-proxy-targets/${encodeURIComponent(target.name)}/disconnect-all`, {});
      await load();
    } catch (err) {
      errorMessage.value = toErrorMessage(err, "Failed to disconnect.");
    } finally {
      disconnectingName.value = null;
    }
  });
}

async function confirmDelete() {
  await confirmActionDelete(async (target) => {
    try {
      await api.delete(`/admin-api/ws-proxy-targets/${encodeURIComponent(target.name)}`);
      await load();
    } catch (err) {
      errorMessage.value = toErrorMessage(err, "Failed to delete target.");
    }
  });
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
      <RouterLink to="/ws-proxies/new" class="btn-primary">New target</RouterLink>
    </header>

    <form v-if="showEdit" class="create-form" @submit.prevent="submitTarget">
      <FormField label="Name" for="wp-name">
        <input id="wp-name" v-model="newName" type="text" placeholder="iot-gateway" disabled />
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
      <div class="form-actions">
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? "Saving…" : "Save changes" }}
        </button>
        <button type="button" class="btn-secondary" @click="closeForm">Cancel</button>
      </div>
    </form>

    <ListLayout :loading="loading" :error="errorMessage" :empty="targets.length === 0">
      <template #empty>
        <EmptyState :icon="Waypoints">
          No WS proxy targets yet. A target lets MCP tools dispatch over a persistent WebSocket connection to a backend
          service instead of plain REST.
        </EmptyState>
      </template>

      <TableCard>
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
            <td>
              <HoverPreview class="url-cell" :text="t.backendWsUrl" mono>{{ t.backendWsUrl }}</HoverPreview>
            </td>
            <td>{{ t.activeConnections }} / {{ t.maxConnections }}</td>
            <td>
              <TogglePill
                :on="t.enabled"
                on-label="Enabled"
                off-label="Disabled"
                :aria-pressed="t.enabled"
                @click="toggleEnabled(t)"
              />
              <p v-if="rowError[t.name]" class="row-error">{{ rowError[t.name] }}</p>
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
                <button type="button" class="link-btn danger" @click="requestDelete(t)">Delete</button>
              </div>
            </td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this WS proxy target?"
      :message="pendingDelete ? `'${pendingDelete.name}' will be removed and any live connections force-closed.` : ''"
      :confirm-label="pendingDelete ? `Delete ${pendingDelete.name}` : 'Delete'"
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
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
      @cancel="cancelDisconnectAll"
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
  max-width: 26.25rem;
}
.form-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
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
}
.actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.link-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>

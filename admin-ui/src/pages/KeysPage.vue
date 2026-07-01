<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { McpApiKey, McpApiKeyWithSecret, Consumer } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";

const keys = ref<McpApiKey[]>([]);
const loading = ref(false);
const errorMessage = ref("");

const showCreateForm = ref(false);
const newLabel = ref("");
const newClients = ref("");
const newTools = ref("");
const newExpires = ref("");
const newConsumerId = ref<number | "">("");
const consumers = ref<Consumer[]>([]);
const createError = ref("");
const creating = ref(false);

// The raw secret is shown exactly once, right after minting.
const mintedKey = ref<McpApiKeyWithSecret | null>(null);
const copied = ref(false);

const pendingDelete = ref<McpApiKey | null>(null);

function statusOf(key: McpApiKey): string {
  if (key.revokedAt !== null) return "Revoked";
  if (!key.enabled) return "Disabled";
  if (key.expiresAt !== null && key.expiresAt <= Date.now()) return "Expired";
  return "Active";
}

function scopeSummary(key: McpApiKey): string {
  if (!key.scopes) return "Unrestricted";
  const parts: string[] = [];
  if (key.scopes.clients?.length) parts.push(`${key.scopes.clients.length} client(s)`);
  if (key.scopes.tools?.length) parts.push(`${key.scopes.tools.length} tool(s)`);
  return parts.length ? parts.join(", ") : "Unrestricted";
}

function parseList(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

async function load() {
  loading.value = true;
  errorMessage.value = "";
  try {
    const [k, c] = await Promise.all([
      api.get<{ items: McpApiKey[] }>("/admin-api/mcp-keys"),
      api.get<{ items: Consumer[] }>("/admin-api/consumers"),
    ]);
    keys.value = k.items;
    consumers.value = c.items;
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load API keys.";
  } finally {
    loading.value = false;
  }
}

function consumerName(id: number | null): string {
  if (id === null) return "—";
  return consumers.value.find((c) => c.id === id)?.name ?? `#${id}`;
}

onMounted(load);

async function createKey() {
  createError.value = "";
  if (!newLabel.value.trim()) {
    createError.value = "A label is required.";
    return;
  }
  const clients = parseList(newClients.value);
  const tools = parseList(newTools.value);
  const scopes = clients.length || tools.length ? { clients, tools } : null;
  const expiresAt = newExpires.value ? new Date(newExpires.value).getTime() : null;

  creating.value = true;
  try {
    const created = await api.post<McpApiKeyWithSecret>("/admin-api/mcp-keys", {
      label: newLabel.value.trim(),
      scopes,
      expiresAt,
      consumerId: newConsumerId.value === "" ? null : newConsumerId.value,
    });
    mintedKey.value = created;
    copied.value = false;
    newLabel.value = "";
    newClients.value = "";
    newTools.value = "";
    newExpires.value = "";
    newConsumerId.value = "";
    showCreateForm.value = false;
    await load();
  } catch (err) {
    createError.value = err instanceof ApiError ? err.message : "Failed to create API key.";
  } finally {
    creating.value = false;
  }
}

async function copyKey() {
  if (!mintedKey.value) return;
  try {
    await navigator.clipboard.writeText(mintedKey.value.key);
    copied.value = true;
  } catch {
    copied.value = false;
  }
}

async function toggleEnabled(key: McpApiKey) {
  if (key.revokedAt !== null) return;
  try {
    await api.patch(`/admin-api/mcp-keys/${key.id}`, { enabled: !key.enabled });
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to update key.";
  }
}

async function revoke(key: McpApiKey) {
  try {
    await api.post(`/admin-api/mcp-keys/${key.id}/revoke`);
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to revoke key.";
  }
}

async function confirmDelete() {
  if (!pendingDelete.value) return;
  const key = pendingDelete.value;
  pendingDelete.value = null;
  try {
    await api.delete(`/admin-api/mcp-keys/${key.id}`);
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to delete key.";
  }
}
</script>

<template>
  <section>
    <header class="page-header">
      <h1>API keys</h1>
      <button type="button" class="btn-primary" @click="showCreateForm = !showCreateForm">
        {{ showCreateForm ? "Cancel" : "Mint key" }}
      </button>
    </header>

    <p class="hint">
      MCP keys authenticate clients calling the bridge. Scope a key to specific clients or tools, or leave it
      unrestricted. The secret is shown only once at creation.
    </p>

    <div v-if="mintedKey" class="minted" role="alert">
      <div class="minted-title">New key “{{ mintedKey.label }}” — copy it now, it won't be shown again:</div>
      <div class="minted-row">
        <code class="minted-secret">{{ mintedKey.key }}</code>
        <button type="button" class="btn-secondary" @click="copyKey">{{ copied ? "Copied" : "Copy" }}</button>
        <button type="button" class="link-btn" @click="mintedKey = null">Dismiss</button>
      </div>
    </div>

    <form v-if="showCreateForm" class="create-form" @submit.prevent="createKey">
      <div class="field">
        <label for="k-label">Label</label>
        <input id="k-label" v-model="newLabel" type="text" required placeholder="e.g. ci-bot" />
      </div>
      <div class="field">
        <label for="k-clients">Allowed clients (comma-separated, blank = all)</label>
        <input id="k-clients" v-model="newClients" type="text" placeholder="payments-svc, inventory-svc" />
      </div>
      <div class="field">
        <label for="k-tools">Allowed tools (comma-separated client__tool)</label>
        <input id="k-tools" v-model="newTools" type="text" placeholder="payments-svc__charge" />
      </div>
      <div class="field">
        <label for="k-expires">Expires (optional)</label>
        <input id="k-expires" v-model="newExpires" type="datetime-local" />
      </div>
      <div class="field">
        <label for="k-consumer">Consumer (optional)</label>
        <select id="k-consumer" v-model="newConsumerId">
          <option value="">None</option>
          <option v-for="c in consumers" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </div>
      <p v-if="createError" class="error">{{ createError }}</p>
      <button type="submit" class="btn-primary" :disabled="creating">{{ creating ? "Minting…" : "Mint key" }}</button>
    </form>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <div v-if="loading" class="loading">Loading…</div>

    <div v-else-if="keys.length === 0" class="empty">No API keys yet.</div>

    <div v-else class="table-scroll">
      <table class="keys-table">
        <thead>
          <tr>
            <th>Label</th>
            <th>Prefix</th>
            <th>Scope</th>
            <th>Consumer</th>
            <th>Status</th>
            <th>Last used</th>
            <th>Expires</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="key in keys" :key="key.id">
            <td>{{ key.label }}</td>
            <td><code>{{ key.keyPrefix }}…</code></td>
            <td>{{ scopeSummary(key) }}</td>
            <td>{{ consumerName(key.consumerId) }}</td>
            <td>
              <span class="status" :class="statusOf(key).toLowerCase()">{{ statusOf(key) }}</span>
            </td>
            <td>{{ key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "Never" }}</td>
            <td>{{ key.expiresAt ? new Date(key.expiresAt).toLocaleString() : "—" }}</td>
            <td class="actions">
              <button
                v-if="key.revokedAt === null"
                type="button"
                class="link-btn"
                @click="toggleEnabled(key)"
              >
                {{ key.enabled ? "Disable" : "Enable" }}
              </button>
              <button
                v-if="key.revokedAt === null"
                type="button"
                class="link-btn danger"
                @click="revoke(key)"
              >
                Revoke
              </button>
              <button type="button" class="link-btn danger" @click="pendingDelete = key">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this API key?"
      :message="pendingDelete ? `'${pendingDelete.label}' will stop working immediately and be removed permanently.` : ''"
      :confirm-label="pendingDelete ? `Delete ${pendingDelete.label}` : 'Delete'"
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
  margin-bottom: 0.75rem;
}
.hint {
  color: #63676e;
  font-size: 0.85rem;
  margin-bottom: 1.25rem;
  max-width: 640px;
}
.minted {
  background: #eef7ee;
  border: 1px solid #b7dcb7;
  border-radius: 8px;
  padding: 1rem;
  margin-bottom: 1.25rem;
}
.minted-title {
  font-weight: 600;
  font-size: 0.85rem;
  margin-bottom: 0.5rem;
}
.minted-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.minted-secret {
  background: #fff;
  border: 1px solid #cfd4da;
  border-radius: 6px;
  padding: 0.4rem 0.6rem;
  font-size: 0.85rem;
  word-break: break-all;
  flex: 1;
  min-width: 200px;
}
.create-form {
  background: #fafbfc;
  padding: 1.25rem;
  border-radius: 8px;
  margin-bottom: 1.5rem;
  max-width: 460px;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
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
.keys-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.keys-table th {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 2px solid #e5e7eb;
  color: #52565c;
  font-size: 0.78rem;
  text-transform: uppercase;
}
.keys-table td {
  padding: 0.55rem 0.75rem;
  border-bottom: 1px solid #eef0f2;
}
.actions {
  display: flex;
  gap: 0.75rem;
}
.status {
  font-size: 0.78rem;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-weight: 600;
}
.status.active {
  background: #e3f4e3;
  color: #1d6b1d;
}
.status.revoked,
.status.expired {
  background: #f8e0e0;
  color: #a11212;
}
.status.disabled {
  background: #ececee;
  color: #63676e;
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

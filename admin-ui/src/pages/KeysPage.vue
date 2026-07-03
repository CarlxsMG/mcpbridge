<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import { useLoadState } from "../composables/useResource";
import type { McpApiKey, McpApiKeyWithSecret, Consumer } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import SignalLoader from "../components/SignalLoader.vue";
import { KeyRound } from "lucide-vue-next";

const keys = ref<McpApiKey[]>([]);
const { loading, errorMessage, run } = useLoadState("Failed to load API keys.");

const showCreateForm = ref(false);
const newLabel = ref("");
const newClients = ref("");
const newTools = ref("");
const newExpires = ref("");
const newConsumerId = ref<number | "">("");
const newElevated = ref(false);
const consumers = ref<Consumer[]>([]);
const createError = ref("");
const creating = ref(false);

// The raw secret is shown exactly once, right after minting.
const mintedKey = ref<McpApiKeyWithSecret | null>(null);
const copied = ref(false);

const pendingDelete = ref<McpApiKey | null>(null);
const pendingRevoke = ref<McpApiKey | null>(null);

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
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function load() {
  await run(async () => {
    const [k, c] = await Promise.all([
      api.get<{ items: McpApiKey[] }>("/admin-api/mcp-keys"),
      api.get<{ items: Consumer[] }>("/admin-api/consumers"),
    ]);
    keys.value = k.items;
    consumers.value = c.items;
  });
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
      elevated: newElevated.value,
    });
    mintedKey.value = created;
    copied.value = false;
    newLabel.value = "";
    newClients.value = "";
    newTools.value = "";
    newExpires.value = "";
    newConsumerId.value = "";
    newElevated.value = false;
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

async function confirmRevoke() {
  if (!pendingRevoke.value) return;
  const key = pendingRevoke.value;
  pendingRevoke.value = null;
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
      <div>
        <h1>API keys</h1>
        <p class="subtitle">
          MCP keys authenticate clients calling the bridge. Scope a key to specific clients or tools, or leave it
          unrestricted. The secret is shown only once at creation.
        </p>
      </div>
      <button
        type="button"
        :class="showCreateForm ? 'btn-secondary' : 'btn-primary'"
        @click="showCreateForm = !showCreateForm"
      >
        {{ showCreateForm ? "Cancel" : "Mint key" }}
      </button>
    </header>

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
        <p v-if="createError" class="error">{{ createError }}</p>
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
      <label class="checkbox-field"
        ><input v-model="newElevated" type="checkbox" /> Elevated (bypasses sensitive-tool confirmation)</label
      >
      <button type="submit" class="btn-primary" :disabled="creating">{{ creating ? "Minting…" : "Mint key" }}</button>
    </form>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <SignalLoader v-if="loading" />

    <div v-else-if="keys.length === 0" class="empty-state">
      <KeyRound :size="26" stroke-width="1.5" aria-hidden="true" class="empty-icon" />
      <p>No API keys yet. MCP clients present a key to call tools through this bridge — mint one to get started.</p>
    </div>

    <div v-else class="table-card table-scroll">
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
            <td>{{ key.label }} <span v-if="key.elevated" class="elev-chip">elevated</span></td>
            <td>
              <code>{{ key.keyPrefix }}…</code>
            </td>
            <td>
              {{ scopeSummary(key) }}
              <details v-if="key.scopes" class="scope-disclosure">
                <summary class="link-btn">View scope</summary>
                <div class="scope-detail">
                  <div v-if="key.scopes.clients?.length">Clients: {{ key.scopes.clients.join(", ") }}</div>
                  <div v-if="key.scopes.tools?.length">Tools: {{ key.scopes.tools.join(", ") }}</div>
                </div>
              </details>
            </td>
            <td>{{ consumerName(key.consumerId) }}</td>
            <td>
              <span class="status" :class="statusOf(key).toLowerCase()">{{ statusOf(key) }}</span>
            </td>
            <td>{{ key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "Never" }}</td>
            <td>{{ key.expiresAt ? new Date(key.expiresAt).toLocaleString() : "—" }}</td>
            <td class="actions">
              <button v-if="key.revokedAt === null" type="button" class="link-btn" @click="toggleEnabled(key)">
                {{ key.enabled ? "Disable" : "Enable" }}
              </button>
              <button v-if="key.revokedAt === null" type="button" class="link-btn danger" @click="pendingRevoke = key">
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
      :message="
        pendingDelete ? `'${pendingDelete.label}' will stop working immediately and be removed permanently.` : ''
      "
      :confirm-label="pendingDelete ? `Delete ${pendingDelete.label}` : 'Delete'"
      danger
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />

    <ConfirmDialog
      :open="pendingRevoke !== null"
      title="Revoke this API key?"
      :message="
        pendingRevoke ? `'${pendingRevoke.label}' will stop working immediately. Revoking cannot be undone.` : ''
      "
      :confirm-label="pendingRevoke ? `Revoke ${pendingRevoke.label}` : 'Revoke'"
      danger
      @confirm="confirmRevoke"
      @cancel="pendingRevoke = null"
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
.minted {
  background: var(--ok-soft);
  border: 1px solid var(--ok);
  border-radius: var(--radius-md);
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
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 0.4rem 0.6rem;
  font-size: 0.85rem;
  font-family: var(--font-mono);
  word-break: break-all;
  flex: 1;
  min-width: 200px;
}
.create-form {
  background: var(--surface-sunken);
  padding: 1.25rem;
  border-radius: var(--radius-md);
  margin-bottom: 1.5rem;
  max-width: 460px;
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
.keys-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.keys-table th {
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.keys-table td {
  padding: var(--table-pad-y) 0.85rem;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.keys-table tbody tr:last-child td {
  border-bottom: none;
}
.keys-table tbody tr:hover {
  background: var(--surface-sunken);
}
.actions {
  display: flex;
  gap: 0.75rem;
}
.status {
  font-size: 0.78rem;
  padding: 0.1rem 0.5rem;
  border-radius: var(--radius-pill);
  font-weight: 600;
}
.status.active {
  background: var(--ok-soft);
  color: var(--ok);
}
.status.revoked,
.status.expired {
  background: var(--breach-soft);
  color: var(--breach);
}
.status.disabled {
  background: var(--surface-sunken);
  color: var(--text-secondary);
}
.link-btn.danger {
  color: var(--breach);
}
.checkbox-field {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 1rem;
}
.checkbox-field input {
  width: auto;
}
.elev-chip {
  display: inline-block;
  padding: 0.05rem 0.4rem;
  background: var(--canary-soft);
  color: var(--canary);
  border-radius: var(--radius-pill);
  font-size: 0.7rem;
}
.scope-disclosure summary {
  font-size: 0.8rem;
}
.scope-detail {
  margin-top: 0.35rem;
  font-size: 0.82rem;
  color: var(--text-secondary);
}
.error {
  color: var(--breach);
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

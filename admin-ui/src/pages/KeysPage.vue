<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { api } from "@/composables/useApi";
import { useLoadState } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import { useClipboard } from "@/composables/useClipboard";
import { useEntityForm } from "@/composables/useEntityForm";
import { parseList } from "@/utils/fieldParsing";
import { toErrorMessage } from "@/utils/errors";
import { formatMaybeDate } from "@/utils/format";
import { statusTone, toneColorVar } from "@/utils/status";
import type { McpApiKey, McpApiKeyWithSecret, Consumer } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import FormField from "@/components/ui/FormField.vue";
import ToggleFormButton from "@/components/ui/ToggleFormButton.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import { KeyRound } from "lucide-vue-next";

const keys = ref<McpApiKey[]>([]);
const { loading, errorMessage, run } = useLoadState("Failed to load API keys.");

const newLabel = ref("");
const newClients = ref("");
const newTools = ref("");
const newExpires = ref("");
const newConsumerId = ref<number | "">("");
const newElevated = ref(false);
const consumers = ref<Consumer[]>([]);
const consumerOptions = computed(() => [
  { value: "" as const, label: "None" },
  ...consumers.value.map((c) => ({ value: c.id, label: c.name })),
]);

function resetForm() {
  newLabel.value = "";
  newClients.value = "";
  newTools.value = "";
  newExpires.value = "";
  newConsumerId.value = "";
  newElevated.value = false;
}

const { open: showCreateForm, busy: creating, error: createError, submit } = useEntityForm<void>({ reset: resetForm });

// The raw secret is shown exactly once, right after minting.
const mintedKey = ref<McpApiKeyWithSecret | null>(null);
const { copied, copy, reset: resetCopied } = useClipboard();

const { rowError, toggle: toggleField } = useOptimisticToggle<McpApiKey>((k) => k.id, "Failed to update key.");

const {
  pending: pendingDelete,
  request: requestDelete,
  cancel: cancelDelete,
  confirm: confirmActionDelete,
} = useConfirmAction<McpApiKey>();
const {
  pending: pendingRevoke,
  request: requestRevoke,
  cancel: cancelRevoke,
  confirm: confirmActionRevoke,
} = useConfirmAction<McpApiKey>();

function statusOf(key: McpApiKey): string {
  if (key.revokedAt !== null) return "Revoked";
  if (!key.enabled) return "Disabled";
  if (key.expiresAt !== null && key.expiresAt <= Date.now()) return "Expired";
  return "Active";
}

function keyTone(key: McpApiKey) {
  return statusTone(statusOf(key));
}

function scopeSummary(key: McpApiKey): string {
  if (!key.scopes) return "Unrestricted";
  const parts: string[] = [];
  if (key.scopes.clients?.length) parts.push(`${key.scopes.clients.length} client(s)`);
  if (key.scopes.tools?.length) parts.push(`${key.scopes.tools.length} tool(s)`);
  return parts.length ? parts.join(", ") : "Unrestricted";
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

  const ok = await submit(async () => {
    const created = await api.post<McpApiKeyWithSecret>("/admin-api/mcp-keys", {
      label: newLabel.value.trim(),
      scopes,
      expiresAt,
      consumerId: newConsumerId.value === "" ? null : newConsumerId.value,
      elevated: newElevated.value,
    });
    mintedKey.value = created;
    resetCopied();
  }, "Failed to create API key.");
  if (ok) await load();
}

async function copyKey() {
  if (!mintedKey.value) return;
  await copy(mintedKey.value.key);
}

function toggleEnabled(key: McpApiKey) {
  if (key.revokedAt !== null) return;
  toggleField(key, "enabled", (next) => api.patch(`/admin-api/mcp-keys/${key.id}`, { enabled: next }));
}

function confirmRevoke() {
  return confirmActionRevoke(async (key) => {
    try {
      await api.post(`/admin-api/mcp-keys/${key.id}/revoke`);
      await load();
    } catch (err) {
      errorMessage.value = toErrorMessage(err, "Failed to revoke key.");
    }
  });
}

function confirmDelete() {
  return confirmActionDelete(async (key) => {
    try {
      await api.delete(`/admin-api/mcp-keys/${key.id}`);
      await load();
    } catch (err) {
      errorMessage.value = toErrorMessage(err, "Failed to delete key.");
    }
  });
}
</script>

<template>
  <section>
    <PageHeader
      title="API keys"
      subtitle="MCP keys authenticate clients calling the bridge. Scope a key to specific clients or tools, or leave it unrestricted. The secret is shown only once at creation."
    >
      <ToggleFormButton v-model="showCreateForm" show-label="Mint key" />
    </PageHeader>

    <div v-if="mintedKey" class="minted" role="alert">
      <div class="minted-title">New key “{{ mintedKey.label }}” — copy it now, it won't be shown again:</div>
      <div class="minted-row">
        <code class="minted-secret">{{ mintedKey.key }}</code>
        <button type="button" class="btn-secondary" @click="copyKey">{{ copied ? "Copied" : "Copy" }}</button>
        <button type="button" class="link-btn" @click="mintedKey = null">Dismiss</button>
      </div>
    </div>

    <form v-if="showCreateForm" class="create-form" @submit.prevent="createKey">
      <FormField label="Label" for="k-label">
        <input id="k-label" v-model="newLabel" type="text" required placeholder="e.g. ci-bot" />
        <p v-if="createError" class="error">{{ createError }}</p>
      </FormField>
      <FormField label="Allowed clients (comma-separated, blank = all)" for="k-clients">
        <input id="k-clients" v-model="newClients" type="text" placeholder="payments-svc, inventory-svc" />
      </FormField>
      <FormField label="Allowed tools (comma-separated client__tool)" for="k-tools">
        <input id="k-tools" v-model="newTools" type="text" placeholder="payments-svc__charge" />
      </FormField>
      <FormField label="Expires (optional)" for="k-expires">
        <input id="k-expires" v-model="newExpires" type="datetime-local" />
      </FormField>
      <FormField label="Consumer (optional)" for="k-consumer">
        <SelectMenu
          id="k-consumer"
          v-model="newConsumerId"
          :options="consumerOptions"
          create-path="/consumers"
          create-label="Create consumer"
          :reload="load"
        />
      </FormField>
      <label class="checkbox-field"
        ><input v-model="newElevated" type="checkbox" /> Elevated (bypasses sensitive-tool confirmation)</label
      >
      <button type="submit" class="btn-primary" :disabled="creating">{{ creating ? "Minting…" : "Mint key" }}</button>
    </form>

    <ListLayout :loading="loading" :error="errorMessage" :empty="keys.length === 0">
      <template #empty>
        <EmptyState :icon="KeyRound">
          No API keys yet. MCP clients present a key to call tools through this bridge — mint one to get started.
        </EmptyState>
      </template>

      <TableCard>
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
              <span
                class="status"
                :class="`tone-${keyTone(key)}`"
                :style="{ color: `var(${toneColorVar(keyTone(key))})` }"
                >{{ statusOf(key) }}</span
              >
            </td>
            <td>{{ formatMaybeDate(key.lastUsedAt) }}</td>
            <td>{{ formatMaybeDate(key.expiresAt, "—") }}</td>
            <td>
              <div class="actions">
                <button v-if="key.revokedAt === null" type="button" class="link-btn" @click="toggleEnabled(key)">
                  {{ key.enabled ? "Disable" : "Enable" }}
                </button>
                <button v-if="key.revokedAt === null" type="button" class="link-btn danger" @click="requestRevoke(key)">
                  Revoke
                </button>
                <button type="button" class="link-btn danger" @click="requestDelete(key)">Delete</button>
              </div>
              <p v-if="rowError[key.id]" class="row-error">{{ rowError[key.id] }}</p>
            </td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this API key?"
      :message="
        pendingDelete ? `'${pendingDelete.label}' will stop working immediately and be removed permanently.` : ''
      "
      :confirm-label="pendingDelete ? `Delete ${pendingDelete.label}` : 'Delete'"
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
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
      @cancel="cancelRevoke"
    />
  </section>
</template>

<style scoped>
/* PageHeader's own recipe covers color/margin; this page's subtitle is long
   enough to need a line-length cap that the shared component doesn't set. */
:deep(.subtitle) {
  max-width: 40rem;
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
  min-width: 12.5rem;
}
.create-form {
  max-width: 28.75rem;
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
.status.tone-good {
  background: var(--ok-soft);
}
.status.tone-bad {
  background: var(--breach-soft);
}
.status.tone-neutral {
  background: var(--surface-sunken);
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
.row-error {
  color: var(--breach);
  font-size: 0.75rem;
  margin: 0.25rem 0 0;
}
</style>

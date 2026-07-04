<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api } from "@/composables/useApi";
import { useLoadState } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import { toErrorMessage } from "@/utils/errors";
import { formatMaybeDate } from "@/utils/format";
import { statusTone, toneColorVar } from "@/utils/status";
import type { McpApiKey, Consumer } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import HoverPreview from "@/components/ui/HoverPreview.vue";
import { KeyRound } from "lucide-vue-next";

const keys = ref<McpApiKey[]>([]);
const { loading, errorMessage, run } = useLoadState("Failed to load API keys.");
const consumers = ref<Consumer[]>([]);

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
      <RouterLink to="/keys/new" class="btn-primary">Mint key</RouterLink>
    </PageHeader>

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
              <HoverPreview always-show mono :text="key.keyPrefix">
                <code>{{ key.keyPrefix }}…</code>
              </HoverPreview>
            </td>
            <td>
              <HoverPreview v-if="key.scopes" always-show>
                {{ scopeSummary(key) }}
                <template #content>
                  <div class="scope-detail">
                    <div v-if="key.scopes?.clients?.length">Clients: {{ key.scopes?.clients?.join(", ") }}</div>
                    <div v-if="key.scopes?.tools?.length">Tools: {{ key.scopes?.tools?.join(", ") }}</div>
                  </div>
                </template>
              </HoverPreview>
              <template v-else>{{ scopeSummary(key) }}</template>
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
.elev-chip {
  display: inline-block;
  padding: 0.05rem 0.4rem;
  background: var(--canary-soft);
  color: var(--canary);
  border-radius: var(--radius-pill);
  font-size: 0.7rem;
}
.scope-detail {
  display: grid;
  gap: 0.25rem;
}
.row-error {
  color: var(--breach);
  font-size: 0.75rem;
  margin: 0.25rem 0 0;
}
</style>

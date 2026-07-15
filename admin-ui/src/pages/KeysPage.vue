<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useLoadState } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import { toErrorMessage } from "@/utils/errors";
import { formatMaybeDate } from "@/utils/format";
import { tk } from "@/i18n";
import type { McpApiKey, Consumer } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import HoverPreview from "@/components/ui/HoverPreview.vue";
import StatusBadge from "@/components/ui/StatusBadge.vue";
import { KeyRound } from "lucide-vue-next";

const { t } = useI18n({ useScope: "global" });

const keys = ref<McpApiKey[]>([]);
const loadFallback = tk("pages.keys.errors.load_failed");
const revokeFallback = tk("pages.keys.errors.revoke_failed");
const deleteFallback = tk("pages.keys.errors.delete_failed");
const updateFallback = tk("errors.update_failed");

const { loading, errorMessage, run } = useLoadState(loadFallback);
const consumers = ref<Consumer[]>([]);

const { rowError, toggle: toggleField } = useOptimisticToggle<McpApiKey>((k) => k.id, updateFallback);

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
  if (key.revokedAt !== null) return "revoked";
  if (!key.enabled) return "disabled";
  if (key.expiresAt !== null && key.expiresAt <= Date.now()) return "expired";
  return "active";
}

function scopeSummary(key: McpApiKey): string {
  if (!key.scopes) return t("pages.keys.table.unrestricted");
  const parts: string[] = [];
  if (key.scopes.clients?.length) parts.push(t("pages.keys.table.client_count", { count: key.scopes.clients.length }));
  if (key.scopes.tools?.length) parts.push(t("pages.keys.table.tool_count", { count: key.scopes.tools.length }));
  return parts.length ? parts.join(", ") : t("pages.keys.table.unrestricted");
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
      errorMessage.value = toErrorMessage(err, revokeFallback);
    }
  });
}

function confirmDelete() {
  return confirmActionDelete(async (key) => {
    try {
      await api.delete(`/admin-api/mcp-keys/${key.id}`);
      await load();
    } catch (err) {
      errorMessage.value = toErrorMessage(err, deleteFallback);
    }
  });
}
</script>

<template>
  <section>
    <PageHeader :title="t('pages.keys.title')" :subtitle="t('pages.keys.subtitle')">
      <RouterLink to="/keys/new" class="btn-primary">{{ t("pages.keys.mint_key") }}</RouterLink>
    </PageHeader>

    <ListLayout :loading="loading" :error="errorMessage" :empty="keys.length === 0">
      <template #empty>
        <EmptyState :icon="KeyRound">
          {{ t("pages.keys.empty") }}
        </EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th>{{ t("pages.keys.table.label") }}</th>
            <th>{{ t("pages.keys.table.prefix") }}</th>
            <th>{{ t("pages.keys.table.scope") }}</th>
            <th>{{ t("pages.keys.table.consumer") }}</th>
            <th>{{ t("pages.keys.table.status") }}</th>
            <th>{{ t("pages.keys.table.last_used") }}</th>
            <th>{{ t("pages.keys.table.expires") }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="key in keys" :key="key.id">
            <td>
              {{ key.label }}
              <span v-if="key.elevated" class="elev-chip">{{ t("pages.keys.table.elevated_chip") }}</span>
            </td>
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
                    <div v-if="key.scopes?.clients?.length">
                      {{ t("pages.keys.table.client_count", { count: key.scopes.clients.length }) }}:
                      {{ key.scopes?.clients?.join(", ") }}
                    </div>
                    <div v-if="key.scopes?.tools?.length">
                      {{ t("pages.keys.table.tool_count", { count: key.scopes.tools.length }) }}:
                      {{ key.scopes?.tools?.join(", ") }}
                    </div>
                  </div>
                </template>
              </HoverPreview>
              <template v-else>{{ scopeSummary(key) }}</template>
            </td>
            <td>{{ consumerName(key.consumerId) }}</td>
            <td>
              <StatusBadge :status="statusOf(key)" />
            </td>
            <td>{{ formatMaybeDate(key.lastUsedAt, tk("common.never")) }}</td>
            <td>{{ formatMaybeDate(key.expiresAt, "—") }}</td>
            <td>
              <div class="actions">
                <button v-if="key.revokedAt === null" type="button" class="link-btn" @click="toggleEnabled(key)">
                  {{ key.enabled ? t("pages.keys.table.disable_key") : t("pages.keys.table.enable_key") }}
                </button>
                <button v-if="key.revokedAt === null" type="button" class="link-btn danger" @click="requestRevoke(key)">
                  {{ t("pages.keys.table.revoke_key") }}
                </button>
                <button type="button" class="link-btn danger" @click="requestDelete(key)">
                  {{ t("pages.keys.table.delete_key") }}
                </button>
              </div>
              <p v-if="rowError[key.id]" class="row-error" role="alert">{{ rowError[key.id] }}</p>
            </td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <ConfirmDialog
      :open="pendingDelete !== null"
      :title="t('pages.keys.confirm.delete_title')"
      :message="pendingDelete ? t('pages.keys.confirm.delete_message', { label: pendingDelete.label }) : ''"
      :confirm-label="
        pendingDelete ? t('pages.keys.confirm.delete_label_named', { label: pendingDelete.label }) : t('common.delete')
      "
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />

    <ConfirmDialog
      :open="pendingRevoke !== null"
      :title="t('pages.keys.confirm.revoke_title')"
      :message="pendingRevoke ? t('pages.keys.confirm.revoke_message', { label: pendingRevoke.label }) : ''"
      :confirm-label="
        pendingRevoke
          ? t('pages.keys.confirm.revoke_label_named', { label: pendingRevoke.label })
          : t('pages.keys.table.revoke_key')
      "
      danger
      @confirm="confirmRevoke"
      @cancel="cancelRevoke"
    />
  </section>
</template>

<style scoped>
:deep(.subtitle) {
  max-width: 40rem;
}
.actions {
  display: flex;
  gap: 0.75rem;
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
</style>

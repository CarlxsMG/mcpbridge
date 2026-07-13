<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import { useEntityForm } from "@/composables/useEntityForm";
import { parseOptionalNumber } from "@/utils/fieldParsing";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";
import type { WsProxyTarget } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import FormField from "@/components/ui/FormField.vue";
import TogglePill from "@/components/ui/TogglePill.vue";
import HoverPreview from "@/components/ui/HoverPreview.vue";
import FieldError from "@/components/ui/FieldError.vue";
import { Waypoints } from "lucide-vue-next";

const { t } = useI18n({ useScope: "global" });

const {
  data: targets,
  loading,
  errorMessage,
  load,
} = useResource<WsProxyTarget[]>(
  async () => (await api.get<{ items: WsProxyTarget[] }>("/admin-api/ws-proxy-targets")).items,
  [],
  tk("pages.ws_proxy_targets.errors.load_failed"),
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
const { rowError, toggle: toggleField } = useOptimisticToggle<WsProxyTarget>(
  (tt) => tt.name,
  tk("pages.ws_proxy_targets.errors.toggle_failed"),
);

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
    createError.value = t("pages.ws_proxy_targets.errors.name_and_url_required");
    return;
  }
  const maxConnectionsResult = parseOptionalNumber(
    newMaxConnections.value,
    t("pages.ws_proxy_targets.errors.max_connections_invalid"),
  );
  const maxMessageBytesResult = parseOptionalNumber(
    newMaxMessageBytes.value,
    t("pages.ws_proxy_targets.errors.max_message_bytes_invalid"),
  );
  const idleTimeoutMinutesResult = parseOptionalNumber(
    newIdleTimeoutMinutes.value,
    t("pages.ws_proxy_targets.errors.idle_timeout_invalid"),
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
  }, tk("pages.ws_proxy_targets.errors.save_failed"));
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
      errorMessage.value = toErrorMessage(err, tk("pages.ws_proxy_targets.errors.disconnect_failed"));
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
      errorMessage.value = toErrorMessage(err, tk("pages.ws_proxy_targets.errors.delete_failed"));
    }
  });
}
</script>

<template>
  <section>
    <PageHeader :title="t('pages.ws_proxy_targets.title')">
      <RouterLink to="/ws-proxies/new" class="btn-primary">{{ t("pages.ws_proxy_targets.new_target") }}</RouterLink>
    </PageHeader>
    <p class="subtitle">
      {{ t("pages.ws_proxy_targets.subtitle_p1") }}
      <code>/ws-proxy/&lt;name&gt;</code>
      {{ t("pages.ws_proxy_targets.subtitle_p2") }}
    </p>

    <form v-if="showEdit" class="create-form" @submit.prevent="submitTarget">
      <FormField :label="t('pages.ws_proxy_targets.fields.name')" for="wp-name">
        <input id="wp-name" v-model="newName" type="text" placeholder="iot-gateway" disabled />
      </FormField>
      <FormField :label="t('pages.ws_proxy_targets.fields.backend_url')" for="wp-url">
        <input id="wp-url" v-model="newBackendUrl" type="text" placeholder="wss://backend.example.com/socket" />
      </FormField>
      <FormField :label="t('pages.ws_proxy_targets.fields.max_connections')" for="wp-max-conn">
        <input id="wp-max-conn" v-model="newMaxConnections" type="text" inputmode="numeric" />
      </FormField>
      <FormField :label="t('pages.ws_proxy_targets.fields.max_message_bytes')" for="wp-max-bytes">
        <input id="wp-max-bytes" v-model="newMaxMessageBytes" type="text" inputmode="numeric" />
      </FormField>
      <FormField :label="t('pages.ws_proxy_targets.fields.idle_timeout')" for="wp-idle">
        <input id="wp-idle" v-model="newIdleTimeoutMinutes" type="text" inputmode="numeric" />
      </FormField>
      <FieldError :message="createError" />
      <div class="form-actions">
        <button type="submit" class="btn-primary" :disabled="creating">
          {{ creating ? t("pages.ws_proxy_targets.saving") : t("pages.ws_proxy_targets.save_changes") }}
        </button>
        <button type="button" class="btn-secondary" @click="closeForm">{{ t("common.cancel") }}</button>
      </div>
    </form>

    <ListLayout :loading="loading" :error="errorMessage" :empty="targets.length === 0">
      <template #empty>
        <EmptyState :icon="Waypoints">
          {{ t("pages.ws_proxy_targets.empty") }}
        </EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th>{{ t("pages.ws_proxy_targets.table.name") }}</th>
            <th>{{ t("pages.ws_proxy_targets.table.backend_url") }}</th>
            <th>{{ t("pages.ws_proxy_targets.table.connections") }}</th>
            <th>{{ t("pages.ws_proxy_targets.table.enabled") }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="target in targets" :key="target.name">
            <td>{{ target.name }}</td>
            <td>
              <HoverPreview class="url-cell" :text="target.backendWsUrl" mono>{{ target.backendWsUrl }}</HoverPreview>
            </td>
            <td>{{ target.activeConnections }} / {{ target.maxConnections }}</td>
            <td>
              <TogglePill
                :on="target.enabled"
                :on-label="t('pages.ws_proxy_targets.enabled')"
                :off-label="t('pages.ws_proxy_targets.disabled')"
                @click="toggleEnabled(target)"
              />
              <p v-if="rowError[target.name]" class="row-error">{{ rowError[target.name] }}</p>
            </td>
            <td>
              <div class="actions">
                <button type="button" class="link-btn" @click="openEdit(target)">{{ t("common.edit") }}</button>
                <button
                  type="button"
                  class="link-btn"
                  :disabled="disconnectingName === target.name || target.activeConnections === 0"
                  @click="requestDisconnectAll(target)"
                >
                  {{
                    disconnectingName === target.name
                      ? t("pages.ws_proxy_targets.disconnecting")
                      : t("pages.ws_proxy_targets.disconnect_all")
                  }}
                </button>
                <button type="button" class="link-btn danger" @click="requestDelete(target)">
                  {{ t("common.delete") }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <ConfirmDialog
      :open="pendingDelete !== null"
      :title="t('pages.ws_proxy_targets.confirm.delete_title')"
      :message="pendingDelete ? t('pages.ws_proxy_targets.confirm.delete_message', { name: pendingDelete.name }) : ''"
      :confirm-label="
        pendingDelete
          ? t('pages.ws_proxy_targets.confirm.delete_cta', { name: pendingDelete.name })
          : t('common.delete')
      "
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />

    <ConfirmDialog
      :open="pendingDisconnect !== null"
      :title="t('pages.ws_proxy_targets.confirm.disconnect_title')"
      :message="
        pendingDisconnect
          ? t('pages.ws_proxy_targets.confirm.disconnect_message', {
              name: pendingDisconnect.name,
              count: pendingDisconnect.activeConnections,
            })
          : ''
      "
      :confirm-label="t('pages.ws_proxy_targets.disconnect_all')"
      danger
      @confirm="confirmDisconnectAll"
      @cancel="cancelDisconnectAll"
    />
  </section>
</template>

<style scoped>
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

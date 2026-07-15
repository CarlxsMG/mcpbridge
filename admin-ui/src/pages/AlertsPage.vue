<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import { toErrorMessage } from "@/utils/errors";
import { formatMaybeDate } from "@/utils/format";
import { tk } from "@/i18n";
import type { AlertRule, AlertEventType } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import TogglePill from "@/components/ui/TogglePill.vue";
import HoverPreview from "@/components/ui/HoverPreview.vue";
import { BellRing } from "lucide-vue-next";

const { t } = useI18n({ useScope: "global" });

const EVENT_LABELS: Record<AlertEventType, string> = {
  circuit_breaker_open: tk("pages.alerts.event.circuit_breaker_open"),
  client_unreachable: tk("pages.alerts.event.client_unreachable"),
  error_rate: tk("pages.alerts.event.error_rate"),
  usage_spike: tk("pages.alerts.event.usage_spike"),
  schema_drift: tk("pages.alerts.event.schema_drift"),
};

const loadFallback = tk("pages.alerts.errors.load_failed");

const {
  data: rules,
  loading,
  errorMessage,
  load,
} = useResource<AlertRule[]>(
  async () => (await api.get<{ items: AlertRule[] }>("/admin-api/alerts")).items,
  [],
  loadFallback,
);
const testMessage = ref("");
const {
  pending: pendingDelete,
  request: requestDelete,
  cancel: cancelDelete,
  confirm: confirmActionDelete,
} = useConfirmAction<AlertRule>();
const {
  pending: pendingDisable,
  request: requestDisable,
  cancel: cancelDisable,
  confirm: confirmActionDisable,
} = useConfirmAction<AlertRule>();
const toggleFallback = tk("pages.alerts.errors.toggle_failed");
const deleteFallback = tk("pages.alerts.errors.delete_failed");

const { rowError, toggle: toggleField, isPending } = useOptimisticToggle<AlertRule>((r) => r.id, toggleFallback);
const testingRuleId = ref<number | null>(null);

onMounted(load);

function toggleEnabled(rule: AlertRule) {
  return toggleField(rule, "enabled", (next) => api.patch(`/admin-api/alerts/${rule.id}`, { enabled: next }));
}

function toggle(rule: AlertRule) {
  if (rule.enabled) {
    requestDisable(rule);
  } else {
    toggleEnabled(rule);
  }
}

function confirmDisable() {
  return confirmActionDisable(async (rule) => {
    await toggleEnabled(rule);
  });
}

async function testRule(rule: AlertRule) {
  testingRuleId.value = rule.id;
  testMessage.value = "";
  errorMessage.value = "";
  try {
    await api.post(`/admin-api/alerts/${rule.id}/test`);
    testMessage.value = t("pages.alerts.test_sent", { name: rule.name });
    await load();
  } catch (err) {
    errorMessage.value = toErrorMessage(err, t("pages.alerts.errors.test_delivery_failed"));
  } finally {
    testingRuleId.value = null;
  }
}

function confirmDelete() {
  return confirmActionDelete(async (rule) => {
    try {
      await api.delete(`/admin-api/alerts/${rule.id}`);
      await load();
    } catch (err) {
      errorMessage.value = toErrorMessage(err, deleteFallback);
    }
  });
}

// Mirrors NewAlertPage's per-eventType threshold semantics: circuit_breaker_open,
// client_unreachable and schema_drift don't carry a threshold at all, and
// usage_spike's number is a spike factor (× baseline), not a plain ratio.
function formatThreshold(rule: AlertRule): string {
  if (rule.threshold === null) return "—";
  return rule.eventType === "usage_spike" ? `${rule.threshold}×` : String(rule.threshold);
}
</script>

<template>
  <section>
    <PageHeader :title="t('pages.alerts.title')">
      <RouterLink to="/alerts/new" class="btn-primary">{{ t("pages.alerts.create_alert") }}</RouterLink>
    </PageHeader>
    <p class="hint">{{ t("pages.alerts.subtitle") }}</p>

    <p v-if="testMessage" class="success" role="status">{{ testMessage }}</p>

    <ListLayout :loading="loading" :error="errorMessage" :empty="rules.length === 0">
      <template #empty>
        <EmptyState :icon="BellRing">{{ t("pages.alerts.empty.no_alerts") }}</EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th>{{ t("pages.alerts.table.name") }}</th>
            <th>{{ t("pages.alerts.table.type") }}</th>
            <th>{{ t("pages.alerts.table.target") }}</th>
            <th>{{ t("pages.alerts.table.threshold") }}</th>
            <th>{{ t("pages.alerts.table.last_fired") }}</th>
            <th>{{ t("pages.alerts.table.actions") }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="rule in rules" :key="rule.id">
            <td>{{ rule.name }}</td>
            <td>{{ EVENT_LABELS[rule.eventType] }}</td>
            <td>
              <HoverPreview class="cell-truncate" :text="rule.webhookUrl" mono>{{ rule.webhookUrl }}</HoverPreview>
            </td>
            <td>{{ formatThreshold(rule) }}</td>
            <td>{{ formatMaybeDate(rule.lastFiredAt, tk("common.never")) }}</td>
            <td>
              <TogglePill
                :on="rule.enabled"
                :on-label="t('pages.alerts.table.enabled_label')"
                :off-label="t('pages.alerts.table.disabled_label')"
                :disabled="isPending(rule)"
                @click="toggle(rule)"
              />
              <p v-if="rowError[rule.id]" class="row-error" role="alert">{{ rowError[rule.id] }}</p>
            </td>
            <td>
              <div class="actions">
                <button type="button" class="link-btn" :disabled="testingRuleId === rule.id" @click="testRule(rule)">
                  {{ testingRuleId === rule.id ? t("pages.alerts.testing") : t("pages.alerts.test") }}
                </button>
                <button type="button" class="link-btn danger" @click="requestDelete(rule)">
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
      :title="t('pages.alerts.confirm.delete_title')"
      :message="pendingDelete ? t('pages.alerts.confirm.delete_message', { name: pendingDelete.name }) : ''"
      :confirm-label="
        pendingDelete ? t('pages.alerts.confirm.delete_label', { name: pendingDelete.name }) : t('common.delete')
      "
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />

    <ConfirmDialog
      :open="pendingDisable !== null"
      :title="t('pages.alerts.confirm.disable_title')"
      :message="pendingDisable ? t('pages.alerts.confirm.disable_message', { name: pendingDisable.name }) : ''"
      :confirm-label="
        pendingDisable ? t('pages.alerts.confirm.disable_label', { name: pendingDisable.name }) : t('common.disable')
      "
      danger
      @confirm="confirmDisable"
      @cancel="cancelDisable"
    />
  </section>
</template>

<style scoped>
.hint {
  color: var(--text-secondary);
  font-size: 0.85rem;
  margin-bottom: 1.25rem;
}
.cell-truncate {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.83rem;
  max-width: 15rem;
}
.actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.success {
  color: var(--ok);
}
</style>

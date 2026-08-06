<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { toErrorMessage } from "@/utils/errors";
import { tk } from "@/i18n";
import type { ConsumerWithUsage, ConsumerUsage } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import QuotaBar from "@/components/charts/QuotaBar.vue";
import SignalLoader from "@/components/ui/SignalLoader.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import FieldError from "@/components/ui/FieldError.vue";
import { Users2, ChevronDown, ChevronRight } from "lucide-vue-next";

const { t } = useI18n({ useScope: "global" });

const loadFallback = tk("pages.consumers.errors.load_failed");
const deleteFallback = tk("pages.consumers.errors.delete_failed");
const usageDetailFallback = tk("pages.consumers.errors.usage_detail_failed");

const {
  data: consumers,
  loading,
  errorMessage,
  errorRequestId,
  load,
} = useResource<ConsumerWithUsage[]>(
  async () => (await api.get<{ items: ConsumerWithUsage[] }>("/admin-api/consumers")).items,
  [],
  loadFallback,
);
const {
  pending: pendingDelete,
  request: requestDelete,
  cancel: cancelDelete,
  confirm: confirmActionDelete,
} = useConfirmAction<ConsumerWithUsage>();

const expandedId = ref<number | null>(null);
const usageById = ref<Record<number, ConsumerUsage>>({});
const usageLoadingId = ref<number | null>(null);
const usageErrorById = ref<Record<number, string>>({});

function remainingLabel(usage: ConsumerUsage): string {
  if (usage.quota === null) return t("pages.consumers.unlimited");
  return String(Math.max(usage.quota - usage.used, 0));
}

async function toggleUsage(consumer: ConsumerWithUsage) {
  if (expandedId.value === consumer.id) {
    expandedId.value = null;
    return;
  }
  expandedId.value = consumer.id;
  if (usageById.value[consumer.id]) return;
  usageLoadingId.value = consumer.id;
  delete usageErrorById.value[consumer.id];
  try {
    usageById.value[consumer.id] = await api.get<ConsumerUsage>(`/admin-api/consumers/${consumer.id}/usage`);
  } catch (err) {
    usageErrorById.value[consumer.id] = toErrorMessage(err, usageDetailFallback);
  } finally {
    usageLoadingId.value = null;
  }
}

onMounted(load);

function confirmDelete() {
  return confirmActionDelete(async (c) => {
    try {
      await api.delete(`/admin-api/consumers/${c.id}`);
      await load();
    } catch (err) {
      errorMessage.value = toErrorMessage(err, deleteFallback);
    }
  });
}
</script>

<template>
  <section>
    <PageHeader :title="t('pages.consumers.title')" :subtitle="t('pages.consumers.subtitle')">
      <RouterLink to="/consumers/new" class="btn-primary">{{ t("pages.consumers.create") }}</RouterLink>
    </PageHeader>

    <ListLayout
      :loading="loading"
      :error="errorMessage"
      :error-request-id="errorRequestId"
      :empty="consumers.length === 0"
    >
      <template #empty>
        <EmptyState :icon="Users2">
          {{ t("pages.consumers.empty.no_consumers") }}
        </EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th scope="col"></th>
            <th scope="col">{{ t("common.name") }}</th>
            <th scope="col">{{ t("pages.consumers.table.quota") }}</th>
            <th scope="col">{{ t("pages.consumers.table.end_user_limit") }}</th>
            <th scope="col">{{ t("pages.consumers.table.used_this_month") }}</th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="c in consumers" :key="c.id">
            <!-- Row click is mouse-only convenience; the accessible control is
                 the expander <button> below (keyboard + aria-expanded), so the
                 row itself is intentionally not a focusable target. -->
            <tr class="cons-row" @click="toggleUsage(c)">
              <td class="expand-col">
                <button
                  type="button"
                  class="expand-btn"
                  :aria-expanded="expandedId === c.id"
                  :aria-label="t('pages.consumers.aria.toggle_usage', { name: c.name })"
                  @click.stop="toggleUsage(c)"
                >
                  <ChevronDown v-if="expandedId === c.id" :size="15" stroke-width="2" aria-hidden="true" />
                  <ChevronRight v-else :size="15" stroke-width="2" aria-hidden="true" />
                </button>
              </td>
              <td>{{ c.name }}</td>
              <td>{{ c.monthlyQuota ?? t("pages.consumers.unlimited") }}</td>
              <td>
                {{
                  c.endUserRateLimitPerMin !== null
                    ? t("pages.consumers.end_user_limit_value", { value: c.endUserRateLimitPerMin })
                    : "—"
                }}
              </td>
              <td :class="{ hot: c.monthlyQuota !== null && c.usedThisMonth >= c.monthlyQuota }">
                <div class="usage-cell">
                  <span>{{ c.usedThisMonth }}</span>
                  <div class="usage-bar-wrap"><QuotaBar :used="c.usedThisMonth" :quota="c.monthlyQuota" /></div>
                </div>
              </td>
              <td>
                <div class="actions" @click.stop>
                  <RouterLink class="link-btn" :to="`/consumers/${c.id}/edit`">{{ t("common.edit") }}</RouterLink>
                  <button type="button" class="link-btn danger" @click="requestDelete(c)">
                    {{ t("common.delete") }}
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="expandedId === c.id" class="usage-detail-row">
              <td colspan="6">
                <div class="usage-detail">
                  <SignalLoader v-if="usageLoadingId === c.id" />
                  <FieldError v-else-if="usageErrorById[c.id]" :message="usageErrorById[c.id]" />
                  <template v-else-if="usageById[c.id]">
                    <div class="usage-detail-stats">
                      <div class="usage-stat">
                        <span class="usage-stat-label">{{ t("pages.consumers.usage.used_this_month") }}</span>
                        <span class="usage-stat-value">{{ usageById[c.id].used }}</span>
                      </div>
                      <div class="usage-stat">
                        <span class="usage-stat-label">{{ t("pages.consumers.usage.monthly_quota") }}</span>
                        <span class="usage-stat-value">{{
                          usageById[c.id].quota ?? t("pages.consumers.unlimited")
                        }}</span>
                      </div>
                      <div class="usage-stat">
                        <span class="usage-stat-label">{{ t("pages.consumers.usage.remaining") }}</span>
                        <span class="usage-stat-value">{{ remainingLabel(usageById[c.id]) }}</span>
                      </div>
                    </div>
                    <QuotaBar :used="usageById[c.id].used" :quota="usageById[c.id].quota" />
                  </template>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </TableCard>
    </ListLayout>

    <ConfirmDialog
      :open="pendingDelete !== null"
      :title="t('pages.consumers.confirm.delete_title')"
      :message="pendingDelete ? t('pages.consumers.confirm.delete_message', { name: pendingDelete.name }) : ''"
      :confirm-label="
        pendingDelete ? t('pages.consumers.confirm.delete_label', { name: pendingDelete.name }) : t('common.delete')
      "
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </section>
</template>

<style scoped>
.usage-cell {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.usage-bar-wrap {
  width: 5.625rem;
}
.actions {
  display: flex;
  gap: 0.75rem;
}
.cons-row {
  cursor: pointer;
}
.expand-col {
  width: 2rem;
}
.expand-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  padding: 0.2rem;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.expand-btn:hover {
  color: var(--text-primary);
  background: var(--surface-sunken);
}
.usage-detail-row td {
  padding: 0;
  border-bottom: 1px solid var(--border);
}
.usage-detail {
  background: var(--surface-sunken);
  padding: var(--space-4) var(--space-5);
}
.usage-detail-stats {
  display: flex;
  gap: var(--space-8);
  margin-bottom: var(--space-3);
}
.usage-stat {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.usage-stat-label {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  font-weight: 600;
}
.usage-stat-value {
  font-family: var(--font-display);
  font-size: 1.1rem;
  color: var(--text-primary);
}
</style>

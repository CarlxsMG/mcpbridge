<script setup lang="ts">
import { onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import { toErrorMessage } from "@/utils/errors";
import { formatMaybeDate } from "@/utils/format";
import { describeCron } from "@/utils/cron";
import { tk } from "@/i18n";
import type { Schedule } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import TogglePill from "@/components/ui/TogglePill.vue";
import { Clock } from "lucide-vue-next";

const { t } = useI18n({ useScope: "global" });
const loadFallback = tk("pages.schedules.errors.load_failed");
const toggleFallback = tk("pages.schedules.errors.toggle_failed");
const deleteFallback = tk("pages.schedules.errors.delete_failed");

const {
  data: items,
  loading,
  errorMessage,
  load,
} = useResource<Schedule[]>(
  async () => (await api.get<{ items: Schedule[] }>("/admin-api/schedules")).items,
  [],
  loadFallback,
);
const { rowError, toggle: toggleField } = useOptimisticToggle<Schedule>((s) => s.id, toggleFallback);
const {
  pending: pendingDelete,
  request: requestDelete,
  cancel: cancelDelete,
  confirm: confirmActionDelete,
} = useConfirmAction<Schedule>();

onMounted(load);

function toggle(s: Schedule) {
  toggleField(s, "enabled", (next) => api.patch(`/admin-api/schedules/${s.id}`, { enabled: next }));
}

function confirmDelete() {
  return confirmActionDelete(async (s) => {
    try {
      await api.delete(`/admin-api/schedules/${s.id}`);
      await load();
    } catch (err) {
      errorMessage.value = toErrorMessage(err, deleteFallback);
    }
  });
}

function formatLastRun(m: number | null): string {
  return formatMaybeDate(m === null ? null : m * 60_000, tk("common.never"));
}
</script>

<template>
  <section>
    <PageHeader :title="t('pages.schedules.title')">
      <RouterLink to="/schedules/new" class="btn-primary">{{ t("pages.schedules.create") }}</RouterLink>
    </PageHeader>
    <p class="subtitle">{{ t("pages.schedules.subtitle") }}</p>

    <ListLayout :loading="loading" :error="errorMessage" :empty="items.length === 0">
      <template #empty>
        <EmptyState :icon="Clock">{{ t("pages.schedules.empty.no_schedules") }}</EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th>{{ t("pages.schedules.table.target") }}</th>
            <th>{{ t("pages.schedules.table.action") }}</th>
            <th>{{ t("pages.schedules.table.schedule") }}</th>
            <th>{{ t("pages.schedules.table.enabled") }}</th>
            <th>{{ t("pages.schedules.table.last_run") }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in items" :key="s.id">
            <td>
              <code>{{ s.clientName }}</code
              ><template v-if="s.toolName">
                → <code>{{ s.toolName }}</code></template
              >
              <span class="tag">{{ s.targetType }}</span>
            </td>
            <td>{{ s.action }}</td>
            <td>
              <div class="schedule-cell">
                <span>{{ describeCron(s.cron) }}</span>
                <code v-if="describeCron(s.cron) !== s.cron" class="cron-raw">{{ s.cron }}</code>
              </div>
            </td>
            <td>
              <TogglePill
                :on="s.enabled"
                :on-label="t('pages.schedules.table.disable')"
                :off-label="t('pages.schedules.table.enable')"
                @click="toggle(s)"
              />
              <p v-if="rowError[s.id]" class="row-error" role="alert">{{ rowError[s.id] }}</p>
            </td>
            <td>
              <span :class="{ 'last-run-never': s.lastRunMinute === null }">{{ formatLastRun(s.lastRunMinute) }}</span>
            </td>
            <td>
              <button type="button" class="link-btn danger" @click="requestDelete(s)">{{ t("common.delete") }}</button>
            </td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <ConfirmDialog
      :open="pendingDelete !== null"
      :title="t('pages.schedules.confirm.delete_title')"
      :message="
        pendingDelete
          ? t('pages.schedules.confirm.delete_message', {
              cron: describeCron(pendingDelete.cron),
              client: pendingDelete.clientName,
              tool_part: pendingDelete.toolName ? ' → ' + pendingDelete.toolName : '',
            })
          : ''
      "
      :confirm-label="t('common.delete')"
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </section>
</template>

<style scoped>
.subtitle {
  color: var(--text-secondary);
  margin: 0 0 1.25rem;
  font-size: 0.9rem;
}
.tag {
  background: var(--surface-sunken);
  border-radius: var(--radius-pill);
  padding: 0.05rem 0.45rem;
  font-size: 0.72rem;
  color: var(--text-secondary);
}
.schedule-cell {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.schedule-cell .cron-raw {
  color: var(--text-muted);
  font-size: 0.78rem;
}
.last-run-never {
  color: var(--text-muted);
}
</style>

<script setup lang="ts">
import { onMounted } from "vue";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import { toErrorMessage } from "@/utils/errors";
import { formatMaybeDate } from "@/utils/format";
import { describeCron } from "@/utils/cron";
import type { Schedule } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import TogglePill from "@/components/ui/TogglePill.vue";
import { Clock } from "lucide-vue-next";

const {
  data: items,
  loading,
  errorMessage,
  load,
} = useResource<Schedule[]>(
  async () => (await api.get<{ items: Schedule[] }>("/admin-api/schedules")).items,
  [],
  "Failed to load schedules.",
);
const { rowError, toggle: toggleField } = useOptimisticToggle<Schedule>((s) => s.id, "Failed.");
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
      rowError.value[s.id] = toErrorMessage(err, "Failed.");
    }
  });
}

function formatLastRun(m: number | null): string {
  return formatMaybeDate(m === null ? null : m * 60_000);
}
</script>

<template>
  <section>
    <PageHeader title="Maintenance schedules">
      <RouterLink to="/schedules/new" class="btn-primary">New schedule</RouterLink>
    </PageHeader>
    <p class="subtitle">
      Automatically enables or disables a client or a single tool on a recurring schedule, evaluated once a minute in
      UTC on the leader instance.
    </p>

    <ListLayout :loading="loading" :error="errorMessage" :empty="items.length === 0">
      <template #empty>
        <EmptyState :icon="Clock">
          No schedules yet. A schedule enables or disables a client or tool automatically on a cron interval.
        </EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th>Target</th>
            <th>Action</th>
            <th>Schedule</th>
            <th>Enabled</th>
            <th>Last run</th>
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
                on-label="Enabled"
                off-label="Disabled"
                :aria-pressed="s.enabled"
                @click="toggle(s)"
              />
              <p v-if="rowError[s.id]" class="row-error">{{ rowError[s.id] }}</p>
            </td>
            <td>
              <span :class="{ 'last-run-never': s.lastRunMinute === null }">{{ formatLastRun(s.lastRunMinute) }}</span>
            </td>
            <td><button class="link-btn danger" @click="requestDelete(s)">Delete</button></td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this schedule?"
      :message="
        pendingDelete
          ? `This schedule (${describeCron(pendingDelete.cron)}) for ${pendingDelete.clientName}${pendingDelete.toolName ? ' → ' + pendingDelete.toolName : ''} will be removed.`
          : ''
      "
      confirm-label="Delete"
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

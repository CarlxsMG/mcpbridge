<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { useOptimisticToggle } from "@/composables/useOptimisticToggle";
import { toErrorMessage } from "@/utils/errors";
import { formatMaybeDate } from "@/utils/format";
import type { Schedule } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import FormField from "@/components/ui/FormField.vue";
import TogglePill from "@/components/ui/TogglePill.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import { Clock } from "lucide-vue-next";

const TARGET_TYPE_OPTIONS: { value: "client" | "tool"; label: string }[] = [
  { value: "client", label: "Client" },
  { value: "tool", label: "Tool" },
];
const ACTION_OPTIONS: { value: "enable" | "disable"; label: string }[] = [
  { value: "disable", label: "disable" },
  { value: "enable", label: "enable" },
];

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

const form = ref({
  targetType: "client" as "client" | "tool",
  clientName: "",
  toolName: "",
  action: "disable" as "enable" | "disable",
  cron: "0 3 * * *",
});
const createError = ref("");
const creating = ref(false);

onMounted(load);

async function create() {
  createError.value = "";
  if (!form.value.clientName.trim() || !form.value.cron.trim()) {
    createError.value = "Client and cron are required.";
    return;
  }
  creating.value = true;
  try {
    await api.post("/admin-api/schedules", {
      targetType: form.value.targetType,
      clientName: form.value.clientName.trim(),
      toolName: form.value.targetType === "tool" ? form.value.toolName.trim() : undefined,
      action: form.value.action,
      cron: form.value.cron.trim(),
    });
    form.value.clientName = "";
    form.value.toolName = "";
    await load();
  } catch (err) {
    createError.value = toErrorMessage(err, "Failed to create schedule.");
  } finally {
    creating.value = false;
  }
}

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
    <PageHeader title="Maintenance schedules" />
    <p class="subtitle">
      Cron-driven enable/disable of a client or a single tool. Evaluated once a minute in UTC on the leader instance.
      Fields: <code>min hour day-of-month month day-of-week</code>.
    </p>

    <form class="create-form" @submit.prevent="create">
      <FormField label="Type" for="sched-type">
        <SelectMenu id="sched-type" v-model="form.targetType" :options="TARGET_TYPE_OPTIONS" />
      </FormField>
      <FormField label="Client" for="sched-client">
        <input id="sched-client" v-model="form.clientName" type="text" placeholder="client name" />
      </FormField>
      <FormField v-if="form.targetType === 'tool'" label="Tool" for="sched-tool">
        <input id="sched-tool" v-model="form.toolName" type="text" placeholder="tool name" />
      </FormField>
      <FormField label="Action" for="sched-action">
        <SelectMenu id="sched-action" v-model="form.action" :options="ACTION_OPTIONS" />
      </FormField>
      <FormField label="Cron" for="sched-cron">
        <input id="sched-cron" v-model="form.cron" type="text" placeholder="0 3 * * *" class="cron" />
      </FormField>
      <button class="btn-primary" type="submit" :disabled="creating">Add</button>
    </form>
    <p v-if="createError" class="error" role="alert">{{ createError }}</p>

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
            <th>Cron</th>
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
              <code>{{ s.cron }}</code>
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
          ? `This schedule (${pendingDelete.cron}) for ${pendingDelete.clientName}${pendingDelete.toolName ? ' → ' + pendingDelete.toolName : ''} will be removed.`
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
.create-form {
  display: flex;
  flex-wrap: wrap;
  gap: 0.9rem;
  align-items: flex-end;
  background: var(--surface-sunken);
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  margin-bottom: 1rem;
}
.field {
  margin-bottom: 0;
}
.field .cron {
  font-family: var(--font-mono);
  min-width: 8.75rem;
}
.tag {
  background: var(--surface-sunken);
  border-radius: var(--radius-pill);
  padding: 0.05rem 0.45rem;
  font-size: 0.72rem;
  color: var(--text-secondary);
}
.last-run-never {
  color: var(--text-muted);
}
</style>

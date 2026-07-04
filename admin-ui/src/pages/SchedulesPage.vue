<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import { useResource } from "../composables/useResource";
import type { Schedule } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import SignalLoader from "../components/SignalLoader.vue";
import TableCard from "../components/TableCard.vue";
import EmptyState from "../components/EmptyState.vue";
import FormField from "../components/FormField.vue";
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
const rowError = ref<Record<number, string>>({});
const pendingDelete = ref<Schedule | null>(null);

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
    createError.value = err instanceof ApiError ? err.message : "Failed to create schedule.";
  } finally {
    creating.value = false;
  }
}

async function toggle(s: Schedule) {
  const next = !s.enabled;
  const prev = s.enabled;
  s.enabled = next;
  delete rowError.value[s.id];
  try {
    await api.patch(`/admin-api/schedules/${s.id}`, { enabled: next });
  } catch (err) {
    s.enabled = prev;
    rowError.value[s.id] = err instanceof ApiError ? err.message : "Failed.";
  }
}

async function confirmDelete() {
  if (!pendingDelete.value) return;
  const s = pendingDelete.value;
  pendingDelete.value = null;
  try {
    await api.delete(`/admin-api/schedules/${s.id}`);
    await load();
  } catch (err) {
    rowError.value[s.id] = err instanceof ApiError ? err.message : "Failed.";
  }
}

function formatLastRun(m: number | null): string {
  return m === null ? "Never" : new Date(m * 60_000).toLocaleString();
}
</script>

<template>
  <section class="page">
    <header class="page-header">
      <div>
        <h1>Maintenance schedules</h1>
        <p class="subtitle">
          Cron-driven enable/disable of a client or a single tool. Evaluated once a minute in UTC on the leader
          instance. Fields: <code>min hour day-of-month month day-of-week</code>.
        </p>
      </div>
    </header>

    <form class="create-form" @submit.prevent="create">
      <FormField label="Type" for="sched-type">
        <select id="sched-type" v-model="form.targetType">
          <option value="client">Client</option>
          <option value="tool">Tool</option>
        </select>
      </FormField>
      <FormField label="Client" for="sched-client">
        <input id="sched-client" v-model="form.clientName" type="text" placeholder="client name" />
      </FormField>
      <FormField v-if="form.targetType === 'tool'" label="Tool" for="sched-tool">
        <input id="sched-tool" v-model="form.toolName" type="text" placeholder="tool name" />
      </FormField>
      <FormField label="Action" for="sched-action">
        <select id="sched-action" v-model="form.action">
          <option value="disable">disable</option>
          <option value="enable">enable</option>
        </select>
      </FormField>
      <FormField label="Cron" for="sched-cron">
        <input id="sched-cron" v-model="form.cron" type="text" placeholder="0 3 * * *" class="cron" />
      </FormField>
      <button class="btn-primary" type="submit" :disabled="creating">Add</button>
    </form>
    <p v-if="createError" class="error" role="alert">{{ createError }}</p>
    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

    <SignalLoader v-if="loading" />

    <EmptyState v-else-if="items.length === 0" :icon="Clock">
      No schedules yet. A schedule enables or disables a client or tool automatically on a cron interval.
    </EmptyState>

    <TableCard v-else>
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
            <button
              type="button"
              class="toggle"
              :class="s.enabled ? 'toggle-on' : 'toggle-off'"
              :aria-pressed="s.enabled"
              @click="toggle(s)"
            >
              {{ s.enabled ? "Enabled" : "Disabled" }}
            </button>
            <p v-if="rowError[s.id]" class="row-error">{{ rowError[s.id] }}</p>
          </td>
          <td>
            <span :class="{ 'last-run-never': s.lastRunMinute === null }">{{ formatLastRun(s.lastRunMinute) }}</span>
          </td>
          <td><button class="link-btn danger" @click="pendingDelete = s">Delete</button></td>
        </tr>
      </tbody>
    </TableCard>

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
      @cancel="pendingDelete = null"
    />
  </section>
</template>

<style scoped>
.page {
  max-width: 56.25rem;
}
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
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.45em;
  border-radius: var(--radius-pill);
  padding: 0.28rem 0.8rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  background: var(--surface);
  transition: background-color 0.12s ease;
}
.toggle::before {
  content: "";
  width: 0.55em;
  height: 0.55em;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.toggle-on {
  border: 1px solid var(--ok);
  color: var(--ok);
}
.toggle-off {
  border: 1px solid var(--border-strong);
  color: var(--text-secondary);
}
.toggle-on:hover {
  background: var(--ok-soft);
}
.toggle-off:hover {
  background: var(--surface-sunken);
}
.last-run-never {
  color: var(--text-muted);
}
.row-error {
  color: var(--breach);
  font-size: 0.75rem;
  margin: 0.25rem 0 0;
}
</style>

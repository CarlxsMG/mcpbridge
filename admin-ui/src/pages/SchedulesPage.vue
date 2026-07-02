<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { Schedule } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { Clock } from "lucide-vue-next";

const items = ref<Schedule[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const rowError = ref<Record<number, string>>({});
const pendingDelete = ref<Schedule | null>(null);

const form = ref({ targetType: "client" as "client" | "tool", clientName: "", toolName: "", action: "disable" as "enable" | "disable", cron: "0 3 * * *" });
const createError = ref("");
const creating = ref(false);

async function load() {
  loading.value = true;
  errorMessage.value = "";
  try {
    const res = await api.get<{ items: Schedule[] }>("/admin-api/schedules");
    items.value = res.items;
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load schedules.";
  } finally {
    loading.value = false;
  }
}
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
        <p class="subtitle">Cron-driven enable/disable of a client or a single tool. Evaluated once a minute in UTC on the leader instance. Fields: <code>min hour day-of-month month day-of-week</code>.</p>
      </div>
    </header>

    <form class="create-form" @submit.prevent="create">
      <div class="field">
        <label for="sched-type">Type</label>
        <select id="sched-type" v-model="form.targetType">
          <option value="client">Client</option>
          <option value="tool">Tool</option>
        </select>
      </div>
      <div class="field">
        <label for="sched-client">Client</label>
        <input id="sched-client" v-model="form.clientName" type="text" placeholder="client name" />
      </div>
      <div v-if="form.targetType === 'tool'" class="field">
        <label for="sched-tool">Tool</label>
        <input id="sched-tool" v-model="form.toolName" type="text" placeholder="tool name" />
      </div>
      <div class="field">
        <label for="sched-action">Action</label>
        <select id="sched-action" v-model="form.action">
          <option value="disable">disable</option>
          <option value="enable">enable</option>
        </select>
      </div>
      <div class="field">
        <label for="sched-cron">Cron</label>
        <input id="sched-cron" v-model="form.cron" type="text" placeholder="0 3 * * *" class="cron" />
      </div>
      <button class="btn-primary" type="submit" :disabled="creating">Add</button>
    </form>
    <p v-if="createError" class="error" role="alert">{{ createError }}</p>
    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

    <div v-if="loading" class="loading">Loading…</div>

    <template v-else-if="items.length === 0">
      <div class="empty-state">
        <Clock :size="26" stroke-width="1.5" aria-hidden="true" class="empty-icon" />
        <p>No schedules yet.</p>
      </div>
    </template>

    <div v-else class="table-card table-scroll">
      <table class="schedules-table">
        <thead><tr><th>Target</th><th>Action</th><th>Cron</th><th>Enabled</th><th>Last run</th><th></th></tr></thead>
        <tbody>
          <tr v-for="s in items" :key="s.id">
            <td><code>{{ s.clientName }}</code><template v-if="s.toolName"> → <code>{{ s.toolName }}</code></template> <span class="tag">{{ s.targetType }}</span></td>
            <td>{{ s.action }}</td>
            <td><code>{{ s.cron }}</code></td>
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
            <td><span :class="{ 'last-run-never': s.lastRunMinute === null }">{{ formatLastRun(s.lastRunMinute) }}</span></td>
            <td><button class="link-btn danger" @click="pendingDelete = s">delete</button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this schedule?"
      :message="pendingDelete ? `This schedule (${pendingDelete.cron}) for ${pendingDelete.clientName}${pendingDelete.toolName ? ' → ' + pendingDelete.toolName : ''} will be removed.` : ''"
      confirm-label="Delete"
      danger
      @confirm="confirmDelete"
      @cancel="pendingDelete = null"
    />
  </section>
</template>

<style scoped>
.page { max-width: 900px; }
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
.field { margin-bottom: 0; }
.field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.3rem;
}
.field input, .field select, .field textarea {
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
  font-family: var(--font-body);
  box-sizing: border-box;
}
.field .cron { font-family: var(--font-mono); min-width: 140px; }
.table-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
}
.schedules-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
.schedules-table th {
  text-align: left; padding: 0.65rem 0.85rem; border-bottom: 1px solid var(--border);
  color: var(--text-muted); font-size: 0.74rem; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.schedules-table td { padding: 0.6rem 0.85rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
.schedules-table tbody tr:last-child td { border-bottom: none; }
.schedules-table tbody tr:hover { background: var(--surface-sunken); }
.tag {
  background: var(--surface-sunken);
  border-radius: var(--radius-pill);
  padding: 0.05rem 0.45rem;
  font-size: 0.72rem;
  color: var(--text-secondary);
}
.toggle {
  display: inline-flex; align-items: center; gap: 0.45em;
  border-radius: var(--radius-pill); padding: 0.28rem 0.8rem;
  font-size: 0.78rem; font-weight: 600; cursor: pointer;
  background: var(--surface); transition: background-color 0.12s ease;
}
.toggle::before { content: ""; width: 0.55em; height: 0.55em; border-radius: 50%; background: currentColor; flex-shrink: 0; }
.toggle-on { border: 1px solid var(--ok); color: var(--ok); }
.toggle-off { border: 1px solid var(--border-strong); color: var(--text-secondary); }
.toggle-on:hover { background: var(--ok-soft); }
.toggle-off:hover { background: var(--surface-sunken); }
.last-run-never { color: var(--text-muted); }
.empty-state {
  padding: 3rem 2rem;
  text-align: center;
  color: var(--text-secondary);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.empty-icon { color: var(--text-muted); margin-bottom: 0.75rem; }
.loading { color: var(--text-muted); padding: 1rem 0; }
.row-error { color: var(--breach); font-size: 0.75rem; margin: 0.25rem 0 0; }
</style>

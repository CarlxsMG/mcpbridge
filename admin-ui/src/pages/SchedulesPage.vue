<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { Schedule } from "../types/api";

const items = ref<Schedule[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const rowError = ref<Record<number, string>>({});

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

async function remove(s: Schedule) {
  if (!confirm(`Delete this schedule?`)) return;
  try {
    await api.delete(`/admin-api/schedules/${s.id}`);
    await load();
  } catch (err) {
    rowError.value[s.id] = err instanceof ApiError ? err.message : "Failed.";
  }
}
</script>

<template>
  <section class="page">
    <h1>Maintenance schedules</h1>
    <p class="lead">Cron-driven enable/disable of a client or a single tool. Evaluated once a minute in UTC on the leader instance. Fields: <code>min hour day-of-month month day-of-week</code>.</p>

    <form class="create-form" @submit.prevent="create">
      <select v-model="form.targetType">
        <option value="client">Client</option>
        <option value="tool">Tool</option>
      </select>
      <input v-model="form.clientName" type="text" placeholder="client name" />
      <input v-if="form.targetType === 'tool'" v-model="form.toolName" type="text" placeholder="tool name" />
      <select v-model="form.action">
        <option value="disable">disable</option>
        <option value="enable">enable</option>
      </select>
      <input v-model="form.cron" type="text" placeholder="0 3 * * *" class="cron" />
      <button class="btn-primary" type="submit" :disabled="creating">Add</button>
    </form>
    <p v-if="createError" class="field-error">{{ createError }}</p>
    <p v-if="errorMessage" class="field-error">{{ errorMessage }}</p>

    <table v-if="!loading" class="grid">
      <thead><tr><th>Target</th><th>Action</th><th>Cron</th><th>Enabled</th><th></th></tr></thead>
      <tbody>
        <tr v-for="s in items" :key="s.id">
          <td><code>{{ s.clientName }}{{ s.toolName ? "__" + s.toolName : "" }}</code> <span class="tag">{{ s.targetType }}</span></td>
          <td>{{ s.action }}</td>
          <td><code>{{ s.cron }}</code></td>
          <td>
            <label class="switch"><input type="checkbox" :checked="s.enabled" @change="toggle(s)" /> {{ s.enabled ? "on" : "off" }}</label>
            <p v-if="rowError[s.id]" class="field-error">{{ rowError[s.id] }}</p>
          </td>
          <td><button class="link-btn" @click="remove(s)">delete</button></td>
        </tr>
        <tr v-if="items.length === 0"><td colspan="5" class="empty">No schedules yet.</td></tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.page { max-width: 900px; }
.lead { color: #555; font-size: 0.9rem; }
.create-form { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; background: #f7f8fa; padding: 0.8rem; border-radius: 8px; margin-bottom: 0.5rem; }
.create-form input, .create-form select { padding: 0.4rem 0.55rem; border: 1px solid #cfd4da; border-radius: 6px; font-size: 0.9rem; }
.create-form .cron { font-family: ui-monospace, monospace; min-width: 130px; }
.grid { width: 100%; border-collapse: collapse; margin-top: 0.8rem; }
.grid th, .grid td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid #eee; font-size: 0.9rem; }
.tag { background: #eef1f4; border-radius: 10px; padding: 0.05rem 0.45rem; font-size: 0.72rem; color: #555; }
.switch { display: inline-flex; gap: 0.4rem; align-items: center; }
.empty { color: #888; text-align: center; }
.field-error { color: #a11212; font-size: 0.82rem; margin: 0.25rem 0 0; }
.link-btn { background: none; border: none; color: #a11212; cursor: pointer; }
</style>

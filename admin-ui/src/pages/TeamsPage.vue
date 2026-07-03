<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import { useResource } from "../composables/useResource";
import type { Team } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { UsersRound } from "lucide-vue-next";

const {
  data: teams,
  loading,
  errorMessage,
  load,
} = useResource<Team[]>(
  async () => (await api.get<{ items: Team[] }>("/admin-api/teams")).items,
  [],
  "Failed to load teams.",
);
const newName = ref("");
const creating = ref(false);
const pendingDelete = ref<Team | null>(null);

onMounted(load);

async function create() {
  if (!newName.value.trim()) return;
  creating.value = true;
  errorMessage.value = "";
  try {
    await api.post("/admin-api/teams", { name: newName.value.trim() });
    newName.value = "";
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to create team.";
  } finally {
    creating.value = false;
  }
}

function requestRemove(t: Team) {
  pendingDelete.value = t;
}

async function confirmRemove() {
  if (!pendingDelete.value) return;
  const t = pendingDelete.value;
  pendingDelete.value = null;
  try {
    await api.delete(`/admin-api/teams/${t.id}`);
    await load();
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to delete team.";
  }
}
</script>

<template>
  <section class="page">
    <header class="page-header">
      <div>
        <h1>Teams</h1>
        <p class="subtitle">
          Teams own clients; a team-scoped admin only sees and manages its own team's servers. Super-admins (admin role
          with no team) manage teams and assign ownership. Assign a client's team from its detail page.
        </p>
      </div>
    </header>

    <form class="create-form" @submit.prevent="create">
      <div class="field">
        <label for="new-team-name">Team name</label>
        <input id="new-team-name" v-model="newName" type="text" placeholder="Team name (e.g. Payments)" required />
      </div>
      <button class="btn-primary" type="submit" :disabled="creating || !newName.trim()">Create team</button>
    </form>
    <p v-if="errorMessage" class="field-error">{{ errorMessage }}</p>

    <div v-if="!loading && teams.length === 0" class="empty-state">
      <UsersRound :size="26" stroke-width="1.5" aria-hidden="true" class="empty-icon" />
      <p>No teams yet.</p>
    </div>

    <div v-else-if="!loading" class="table-card table-scroll">
      <table class="grid">
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in teams" :key="t.id">
            <td>{{ t.id }}</td>
            <td>{{ t.name }}</td>
            <td>{{ new Date(t.createdAt).toLocaleDateString() }}</td>
            <td><button class="link-btn danger" @click="requestRemove(t)">delete</button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this team?"
      :message="
        pendingDelete ? `Delete team &quot;${pendingDelete.name}&quot;? Its clients and users become unowned.` : ''
      "
      :confirm-label="pendingDelete ? `Delete ${pendingDelete.name}` : 'Delete'"
      danger
      @confirm="confirmRemove"
      @cancel="pendingDelete = null"
    />
  </section>
</template>

<style scoped>
.page {
  max-width: 760px;
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
  gap: 0.5rem;
  margin: 1rem 0;
  align-items: flex-end;
}
.field {
  flex: 1;
}
.field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.3rem;
}
.field input {
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
  font-family: var(--font-body);
  box-sizing: border-box;
}
.table-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
}
.grid {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.grid th {
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.grid td {
  text-align: left;
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.grid tbody tr:last-child td {
  border-bottom: none;
}
.grid tbody tr:hover {
  background: var(--surface-sunken);
}
.empty-state {
  padding: 3rem 2rem;
  text-align: center;
  color: var(--text-secondary);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.empty-icon {
  color: var(--text-muted);
  margin-bottom: 0.75rem;
}
.field-error {
  color: var(--breach);
  font-size: 0.85rem;
}
</style>

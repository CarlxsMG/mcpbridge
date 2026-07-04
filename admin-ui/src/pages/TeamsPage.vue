<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import { useResource } from "../composables/useResource";
import type { Team } from "../types/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import SignalLoader from "../components/SignalLoader.vue";
import PageHeader from "../components/PageHeader.vue";
import FormField from "../components/FormField.vue";
import EmptyState from "../components/EmptyState.vue";
import TableCard from "../components/TableCard.vue";
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
    <PageHeader
      title="Teams"
      subtitle="Teams own clients; a team-scoped admin only sees and manages its own team's servers. Super-admins (admin role with no team) manage teams and assign ownership. Assign a client's team from its detail page."
    />

    <form class="create-form" @submit.prevent="create">
      <FormField label="Team name" for="new-team-name">
        <input id="new-team-name" v-model="newName" type="text" placeholder="Team name (e.g. Payments)" required />
      </FormField>
      <button class="btn-primary" type="submit" :disabled="creating || !newName.trim()">Create team</button>
    </form>
    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>

    <SignalLoader v-if="loading" />

    <EmptyState v-if="!loading && teams.length === 0" :icon="UsersRound">
      No teams yet. A team groups servers under shared ownership, so operator-role admins only see and manage what's
      assigned to their team.
    </EmptyState>

    <TableCard v-else-if="!loading">
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
          <td><button class="link-btn danger" @click="requestRemove(t)">Delete</button></td>
        </tr>
      </tbody>
    </TableCard>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this team?"
      :message="pendingDelete ? `Delete team '${pendingDelete.name}'? Its servers and users become unowned.` : ''"
      :confirm-label="pendingDelete ? `Delete ${pendingDelete.name}` : 'Delete'"
      danger
      @confirm="confirmRemove"
      @cancel="pendingDelete = null"
    />
  </section>
</template>

<style scoped>
.page {
  max-width: 47.5rem;
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
.field-error {
  color: var(--breach);
  font-size: 0.85rem;
}
</style>

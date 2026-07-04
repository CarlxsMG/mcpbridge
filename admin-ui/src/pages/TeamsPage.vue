<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { toErrorMessage } from "@/utils/errors";
import type { Team } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import FormField from "@/components/ui/FormField.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import TableCard from "@/components/ui/TableCard.vue";
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
const {
  pending: pendingDelete,
  request: requestRemove,
  cancel: cancelRemove,
  confirm: confirmDeleteAction,
} = useConfirmAction<Team>();

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
    errorMessage.value = toErrorMessage(err, "Failed to create team.");
  } finally {
    creating.value = false;
  }
}

async function confirmRemove() {
  await confirmDeleteAction(async (t) => {
    try {
      await api.delete(`/admin-api/teams/${t.id}`);
      await load();
    } catch (err) {
      errorMessage.value = toErrorMessage(err, "Failed to delete team.");
    }
  });
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
    <ListLayout :loading="loading" :error="errorMessage" :empty="teams.length === 0">
      <template #empty>
        <EmptyState :icon="UsersRound">
          No teams yet. A team groups servers under shared ownership, so operator-role admins only see and manage what's
          assigned to their team.
        </EmptyState>
      </template>

      <TableCard>
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
    </ListLayout>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this team?"
      :message="pendingDelete ? `Delete team '${pendingDelete.name}'? Its servers and users become unowned.` : ''"
      :confirm-label="pendingDelete ? `Delete ${pendingDelete.name}` : 'Delete'"
      danger
      @confirm="confirmRemove"
      @cancel="cancelRemove"
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

<script setup lang="ts">
import { onMounted } from "vue";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { toErrorMessage } from "@/utils/errors";
import type { Team } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
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
const {
  pending: pendingDelete,
  request: requestRemove,
  cancel: cancelRemove,
  confirm: confirmDeleteAction,
} = useConfirmAction<Team>();

onMounted(load);

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
  <section>
    <PageHeader
      title="Teams"
      subtitle="Teams own clients; a team-scoped admin only sees and manages its own team's servers. Super-admins (admin role with no team) manage teams and assign ownership. Assign a client's team from its detail page."
    >
      <RouterLink to="/teams/new" class="btn-primary">New team</RouterLink>
    </PageHeader>

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

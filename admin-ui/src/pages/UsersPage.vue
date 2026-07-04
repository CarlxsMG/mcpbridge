<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useAuth } from "@/composables/useAuth";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { toErrorMessage } from "@/utils/errors";
import { formatMaybeDate } from "@/utils/format";
import type { AdminUserSummary, AdminRole, Team } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import { UserCog } from "lucide-vue-next";

const ROLE_OPTIONS: { value: AdminRole; label: string }[] = [
  { value: "admin", label: "admin" },
  { value: "operator", label: "operator" },
  { value: "auditor", label: "auditor" },
  { value: "viewer", label: "viewer" },
];

const { state: authState } = useAuth();

const {
  data: users,
  loading,
  errorMessage,
  load,
} = useResource<AdminUserSummary[]>(
  async () => (await api.get<{ users: AdminUserSummary[] }>("/admin-api/users")).users,
  [],
  "Failed to load users.",
);
const {
  pending: pendingDelete,
  request: requestDelete,
  cancel: cancelDelete,
  confirm: confirmActionDelete,
} = useConfirmAction<AdminUserSummary>();
const {
  pending: pendingRoleChange,
  request: requestRoleChangeAction,
  cancel: cancelRoleChangeAction,
  confirm: confirmActionRoleChange,
} = useConfirmAction<{ user: AdminUserSummary; nextRole: string }>();

// Teams — any admin may read the list (needed to populate the assignment dropdown),
// but only a super-admin (admin role, no team) can actually change a user's team;
// non-super-admins will get a FORBIDDEN error back from the PUT below.
const teams = ref<Team[]>([]);
const teamsError = ref("");
async function loadTeams() {
  try {
    teams.value = (await api.get<{ items: Team[] }>("/admin-api/teams")).items;
  } catch (err) {
    teams.value = [];
    teamsError.value = toErrorMessage(err, "Failed to load teams.");
  }
}
const {
  pending: pendingTeamChange,
  request: requestTeamChangeAction,
  cancel: cancelTeamChangeAction,
  confirm: confirmActionTeamChange,
} = useConfirmAction<{ user: AdminUserSummary; nextTeamId: number | null }>();
const teamChangeError = ref("");
const teamOptions = computed(() => [
  { value: null as number | null, label: "None (super-admin)" },
  ...teams.value.map((t) => ({ value: t.id as number | null, label: t.name })),
]);

function teamName(teamId: number | null): string {
  if (teamId === null) return "None (super-admin)";
  return teams.value.find((t) => t.id === teamId)?.name ?? `#${teamId}`;
}

const activeAdminCount = computed(() => users.value.filter((u) => u.role === "admin" && u.is_active).length);

// Mirrors the backend's LAST_ADMIN_PROTECTED guard so the control is disabled
// up front instead of letting the operator hit a guaranteed-to-fail request.
function isLastActiveAdmin(user: AdminUserSummary): boolean {
  return user.role === "admin" && user.is_active && activeAdminCount.value <= 1;
}

onMounted(() => {
  load();
  loadTeams();
});

async function changeRole(user: AdminUserSummary, nextRole: string) {
  try {
    await api.patch(`/admin-api/users/${encodeURIComponent(user.username)}`, { role: nextRole });
    await load();
  } catch (err) {
    errorMessage.value = toErrorMessage(err, "Failed to update role.");
    await load(); // reset the select back to the persisted value
  }
}

function requestRoleChange(user: AdminUserSummary, nextRole: string) {
  if (nextRole === user.role) return;
  requestRoleChangeAction({ user, nextRole });
}

function roleChangeMessage(user: AdminUserSummary, nextRole: string): string {
  if (user.username === authState.user?.username) {
    return `You are changing your own role from '${user.role}' to '${nextRole}'. This may immediately restrict what you can do in this admin panel.`;
  }
  return `Change '${user.username}''s role from '${user.role}' to '${nextRole}'?`;
}

function confirmRoleChange() {
  return confirmActionRoleChange(async ({ user, nextRole }) => {
    await changeRole(user, nextRole);
  });
}

async function changeTeam(user: AdminUserSummary, nextTeamId: number | null) {
  teamChangeError.value = "";
  try {
    await api.put(`/admin-api/users/${encodeURIComponent(user.username)}/team`, { teamId: nextTeamId });
    await load();
  } catch (err) {
    teamChangeError.value = toErrorMessage(err, "Failed to assign team (super-admin only).");
    await load(); // reset the select back to the persisted value
  }
}

function requestTeamChange(user: AdminUserSummary, nextTeamId: number | null) {
  if (nextTeamId === user.team_id) return;
  requestTeamChangeAction({ user, nextTeamId });
}

function teamChangeMessage(user: AdminUserSummary, nextTeamId: number | null): string {
  const base = `Assign '${user.username}' to ${teamName(nextTeamId)}?`;
  if (user.username === authState.user?.username && nextTeamId !== null) {
    return `${base} You are scoping your own account — you will lose super-admin access (team management, cross-team visibility) immediately.`;
  }
  return base;
}

function confirmTeamChange() {
  return confirmActionTeamChange(async ({ user, nextTeamId }) => {
    await changeTeam(user, nextTeamId);
  });
}

function confirmDelete() {
  return confirmActionDelete(async (user) => {
    try {
      await api.delete(`/admin-api/users/${encodeURIComponent(user.username)}`);
      await load();
    } catch (err) {
      errorMessage.value = toErrorMessage(err, "Failed to delete user.");
    }
  });
}
</script>

<template>
  <section>
    <PageHeader title="Users">
      <RouterLink to="/users/new" class="btn-primary">Add user</RouterLink>
    </PageHeader>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <p v-if="teamChangeError" class="error" role="alert">{{ teamChangeError }}</p>
    <p v-if="teamsError" class="error" role="alert">{{ teamsError }}</p>

    <ListLayout :loading="loading" :empty="users.length === 0">
      <template #empty>
        <EmptyState :icon="UserCog">
          No admin users yet. Every person who signs in to this panel needs their own account here -- shared logins
          aren't supported.
        </EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>Team</th>
            <th>Active</th>
            <th>Last login</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in users" :key="user.username">
            <td>
              {{ user.username }} <span v-if="user.username === authState.user?.username" class="you-tag">(you)</span>
            </td>
            <td>
              <SelectMenu
                :model-value="user.role"
                :options="ROLE_OPTIONS"
                :disabled="isLastActiveAdmin(user)"
                :title="
                  isLastActiveAdmin(user) ? 'Cannot change the last active admin — promote another user first.' : ''
                "
                @update:model-value="(v) => requestRoleChange(user, v)"
              />
              <br />
              <span v-if="isLastActiveAdmin(user)" class="switch-hint"
                >Cannot change the last active admin — promote another user first.</span
              >
            </td>
            <td>
              <SelectMenu
                :model-value="user.team_id"
                :options="teamOptions"
                title="Only super-admins can change this."
                create-path="/teams/new"
                create-label="Create team"
                :reload="loadTeams"
                @update:model-value="(v) => requestTeamChange(user, v)"
              />
            </td>
            <td>{{ user.is_active ? "Yes" : "No" }}</td>
            <td>{{ formatMaybeDate(user.last_login_at) }}</td>
            <td>
              <button
                type="button"
                class="link-btn danger"
                :disabled="isLastActiveAdmin(user)"
                :title="
                  isLastActiveAdmin(user) ? 'Cannot delete the last active admin — promote another user first.' : ''
                "
                @click="requestDelete(user)"
              >
                Delete</button
              ><br />
              <span v-if="isLastActiveAdmin(user)" class="switch-hint">
                Cannot delete the last active admin — promote another user first.
              </span>
            </td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="Delete this user?"
      :message="
        pendingDelete
          ? `'${pendingDelete.username}' will lose access immediately and all their sessions will be revoked.`
          : ''
      "
      :confirm-label="pendingDelete ? `Delete ${pendingDelete.username}` : 'Delete'"
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />

    <ConfirmDialog
      :open="pendingRoleChange !== null"
      title="Change this user's role?"
      :message="pendingRoleChange ? roleChangeMessage(pendingRoleChange.user, pendingRoleChange.nextRole) : ''"
      :confirm-label="pendingRoleChange ? `Change to ${pendingRoleChange.nextRole}` : 'Change role'"
      @confirm="confirmRoleChange"
      @cancel="cancelRoleChangeAction"
    />

    <ConfirmDialog
      :open="pendingTeamChange !== null"
      title="Change this user's team?"
      :message="pendingTeamChange ? teamChangeMessage(pendingTeamChange.user, pendingTeamChange.nextTeamId) : ''"
      :confirm-label="pendingTeamChange ? `Assign to ${teamName(pendingTeamChange.nextTeamId)}` : 'Assign team'"
      @confirm="confirmTeamChange"
      @cancel="cancelTeamChangeAction"
    />
  </section>
</template>

<style scoped>
.you-tag {
  color: var(--text-muted);
  font-size: 0.8rem;
}
.switch-hint {
  color: var(--text-muted);
  font-weight: 400;
  font-size: 0.78rem;
}
</style>

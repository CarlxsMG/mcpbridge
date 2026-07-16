<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useAuth } from "@/composables/useAuth";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { toErrorMessage } from "@/utils/errors";
import { formatMaybeDate } from "@/utils/format";
import { tk } from "@/i18n";
import type { AdminUserSummary, AdminRole, Team } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import TableCard from "@/components/ui/TableCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import { UserCog } from "lucide-vue-next";

const { t } = useI18n({ useScope: "global" });

const ROLE_OPTIONS: { value: AdminRole; label: string }[] = [
  { value: "admin", label: t("pages.users.roles.admin") },
  { value: "operator", label: t("pages.users.roles.operator") },
  { value: "auditor", label: t("pages.users.roles.auditor") },
  { value: "viewer", label: t("pages.users.roles.viewer") },
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
  tk("pages.users.errors.load_failed"),
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

const teams = ref<Team[]>([]);
const teamsError = ref("");
async function loadTeams() {
  try {
    teams.value = (await api.get<{ items: Team[] }>("/admin-api/teams")).items;
  } catch (err) {
    teams.value = [];
    teamsError.value = toErrorMessage(err, tk("pages.users.errors.teams_load_failed"));
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
  { value: null as number | null, label: t("pages.users.team.none") },
  ...teams.value.map((tt) => ({ value: tt.id as number | null, label: tt.name })),
]);

function teamName(teamId: number | null): string {
  if (teamId === null) return t("pages.users.team.none");
  return teams.value.find((tt) => tt.id === teamId)?.name ?? `#${teamId}`;
}

const activeAdminCount = computed(() => users.value.filter((u) => u.role === "admin" && u.is_active).length);

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
    errorMessage.value = toErrorMessage(err, tk("pages.users.errors.update_role_failed"));
    await load();
  }
}

function requestRoleChange(user: AdminUserSummary, nextRole: string) {
  if (nextRole === user.role) return;
  requestRoleChangeAction({ user, nextRole });
}

function roleChangeMessage(user: AdminUserSummary, nextRole: string): string {
  if (user.username === authState.user?.username) {
    return t("pages.users.confirm.role_self", { current: user.role, next: nextRole });
  }
  return t("pages.users.confirm.role_other", { username: user.username, current: user.role, next: nextRole });
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
    teamChangeError.value = toErrorMessage(err, tk("pages.users.errors.assign_team_failed"));
    await load();
  }
}

function requestTeamChange(user: AdminUserSummary, nextTeamId: number | null) {
  if (nextTeamId === user.team_id) return;
  requestTeamChangeAction({ user, nextTeamId });
}

function teamChangeMessage(user: AdminUserSummary, nextTeamId: number | null): string {
  const base = t("pages.users.confirm.team_base", { username: user.username, team: teamName(nextTeamId) });
  if (user.username === authState.user?.username && nextTeamId !== null) {
    return `${base} ${t("pages.users.confirm.team_self_warning")}`;
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
      errorMessage.value = toErrorMessage(err, tk("pages.users.errors.delete_failed"));
    }
  });
}
</script>

<template>
  <section>
    <PageHeader :title="t('pages.users.title')">
      <RouterLink to="/users/new" class="btn-primary">{{ t("pages.users.add_user") }}</RouterLink>
    </PageHeader>

    <p v-if="teamChangeError" class="error" role="alert">{{ teamChangeError }}</p>
    <p v-if="teamsError" class="error" role="alert">{{ teamsError }}</p>

    <ListLayout :loading="loading" :error="errorMessage" :empty="users.length === 0">
      <template #empty>
        <EmptyState :icon="UserCog">
          {{ t("pages.users.empty") }}
        </EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th scope="col">{{ t("pages.users.table.username") }}</th>
            <th scope="col">{{ t("pages.users.table.role") }}</th>
            <th scope="col">{{ t("pages.users.table.team") }}</th>
            <th scope="col">{{ t("pages.users.table.active") }}</th>
            <th scope="col">{{ t("pages.users.table.last_login") }}</th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in users" :key="user.username">
            <td>
              {{ user.username }}
              <span v-if="user.username === authState.user?.username" class="you-tag">{{
                t("pages.users.you_tag")
              }}</span>
            </td>
            <td>
              <SelectMenu
                :key="user.role"
                :model-value="user.role"
                :options="ROLE_OPTIONS"
                :disabled="isLastActiveAdmin(user)"
                :title="isLastActiveAdmin(user) ? t('pages.users.last_admin_locked') : ''"
                :aria-label="t('pages.users.aria.change_role', { username: user.username })"
                @update:model-value="(v) => requestRoleChange(user, v)"
              />
              <br />
              <span v-if="isLastActiveAdmin(user)" class="switch-hint">{{ t("pages.users.last_admin_locked") }}</span>
            </td>
            <td>
              <SelectMenu
                :key="user.team_id ?? 'none'"
                :model-value="user.team_id"
                :options="teamOptions"
                :title="t('pages.users.team.change_locked')"
                :aria-label="t('pages.users.aria.change_team', { username: user.username })"
                create-path="/teams/new"
                :create-label="t('pages.users.team.create')"
                :reload="loadTeams"
                @update:model-value="(v) => requestTeamChange(user, v)"
              />
            </td>
            <td>{{ user.is_active ? t("pages.users.yes") : t("pages.users.no") }}</td>
            <td>{{ formatMaybeDate(user.last_login_at, tk("common.never")) }}</td>
            <td>
              <button
                type="button"
                class="link-btn danger"
                :disabled="isLastActiveAdmin(user)"
                :title="isLastActiveAdmin(user) ? t('pages.users.last_admin_locked') : ''"
                @click="requestDelete(user)"
              >
                {{ t("common.delete") }}</button
              ><br />
              <span v-if="isLastActiveAdmin(user)" class="switch-hint">
                {{ t("pages.users.last_admin_locked") }}
              </span>
            </td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <ConfirmDialog
      :open="pendingDelete !== null"
      :title="t('pages.users.confirm.delete_title')"
      :message="pendingDelete ? t('pages.users.confirm.delete_message', { username: pendingDelete.username }) : ''"
      :confirm-label="
        pendingDelete ? t('pages.users.confirm.delete_cta', { username: pendingDelete.username }) : t('common.delete')
      "
      danger
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />

    <ConfirmDialog
      :open="pendingRoleChange !== null"
      :title="
        pendingRoleChange ? t('pages.users.confirm.role_title', { username: pendingRoleChange.user.username }) : ''
      "
      :message="pendingRoleChange ? roleChangeMessage(pendingRoleChange.user, pendingRoleChange.nextRole) : ''"
      :confirm-label="
        pendingRoleChange
          ? t('pages.users.confirm.role_cta', { next: pendingRoleChange.nextRole })
          : t('pages.users.confirm.role_cta_default')
      "
      @confirm="confirmRoleChange"
      @cancel="cancelRoleChangeAction"
    />

    <ConfirmDialog
      :open="pendingTeamChange !== null"
      :title="
        pendingTeamChange ? t('pages.users.confirm.team_title', { username: pendingTeamChange.user.username }) : ''
      "
      :message="pendingTeamChange ? teamChangeMessage(pendingTeamChange.user, pendingTeamChange.nextTeamId) : ''"
      :confirm-label="
        pendingTeamChange
          ? t('pages.users.confirm.team_cta', { team: teamName(pendingTeamChange.nextTeamId) })
          : t('pages.users.confirm.team_cta_default')
      "
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

<script setup lang="ts">
import { onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { useResource } from "@/composables/useResource";
import { useConfirmAction } from "@/composables/useConfirmAction";
import { toErrorMessage } from "@/utils/errors";
import { formatDateTime } from "@/utils/format";
import { tk } from "@/i18n";
import type { Team } from "@/types/api";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PageHeader from "@/components/ui/PageHeader.vue";
import ListLayout from "@/components/ui/ListLayout.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import TableCard from "@/components/ui/TableCard.vue";
import { UsersRound } from "lucide-vue-next";

const { t } = useI18n({ useScope: "global" });

const {
  data: teams,
  loading,
  errorMessage,
  load,
} = useResource<Team[]>(
  async () => (await api.get<{ items: Team[] }>("/admin-api/teams")).items,
  [],
  tk("pages.teams.errors.load_failed"),
);
const {
  pending: pendingDelete,
  request: requestRemove,
  cancel: cancelRemove,
  confirm: confirmDeleteAction,
} = useConfirmAction<Team>();

onMounted(load);

async function confirmRemove() {
  await confirmDeleteAction(async (team) => {
    try {
      await api.delete(`/admin-api/teams/${team.id}`);
      await load();
    } catch (err) {
      errorMessage.value = toErrorMessage(err, tk("pages.teams.errors.delete_failed"));
    }
  });
}
</script>

<template>
  <section>
    <PageHeader :title="t('pages.teams.title')" :subtitle="t('pages.teams.subtitle')">
      <RouterLink to="/teams/new" class="btn-primary">{{ t("pages.teams.new_team") }}</RouterLink>
    </PageHeader>

    <ListLayout :loading="loading" :error="errorMessage" :empty="teams.length === 0">
      <template #empty>
        <EmptyState :icon="UsersRound">
          {{ t("pages.teams.empty") }}
        </EmptyState>
      </template>

      <TableCard>
        <thead>
          <tr>
            <th>{{ t("pages.teams.table.id") }}</th>
            <th>{{ t("pages.teams.table.name") }}</th>
            <th>{{ t("pages.teams.table.created") }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="team in teams" :key="team.id">
            <td>{{ team.id }}</td>
            <td>{{ team.name }}</td>
            <td>{{ formatDateTime(team.createdAt) }}</td>
            <td>
              <button type="button" class="link-btn danger" @click="requestRemove(team)">
                {{ t("common.delete") }}
              </button>
            </td>
          </tr>
        </tbody>
      </TableCard>
    </ListLayout>

    <ConfirmDialog
      :open="pendingDelete !== null"
      :title="t('pages.teams.confirm.delete_title')"
      :message="pendingDelete ? t('pages.teams.confirm.delete_message', { name: pendingDelete.name }) : ''"
      :confirm-label="
        pendingDelete ? t('pages.teams.confirm.delete_cta', { name: pendingDelete.name }) : t('common.delete')
      "
      danger
      @confirm="confirmRemove"
      @cancel="cancelRemove"
    />
  </section>
</template>

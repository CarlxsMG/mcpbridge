<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "@/composables/useApi";
import { clientPath } from "@/utils/apiPaths";
import { useResource } from "@/composables/useResource";
import { usePatchResource } from "@/composables/usePatchResource";
import { tk } from "@/i18n";
import type { Team } from "@/types/api";
import ConfigSection from "./ConfigSection.vue";
import SelectMenu from "@/components/ui/SelectMenu.vue";
import FieldError from "@/components/ui/FieldError.vue";

const props = defineProps<{ clientName: string; teamId: number | null }>();
const { t } = useI18n({ useScope: "global" });

const { data: teams, load: loadTeams } = useResource<Team[]>(
  () => api.get<{ items: Team[] }>("/admin-api/teams").then((res) => res.items),
  [],
);
onMounted(loadTeams);
const teamOptions = computed(() => [
  { value: null as number | null, label: t("components.server_detail_team.unowned") },
  ...teams.value.map((tt) => ({ value: tt.id as number | null, label: tt.name })),
]);

const currentTeamId = ref(props.teamId);

watch(
  () => props.teamId,
  (next) => {
    currentTeamId.value = next;
  },
);

const { error: teamError, run: runAssignTeam } = usePatchResource(() => clientPath(props.clientName, "team"));

async function assignTeam(teamId: number | null) {
  const previous = currentTeamId.value;
  currentTeamId.value = teamId; // optimistic
  const ok = await runAssignTeam(
    (path) => api.put(path, { teamId }),
    tk("components.server_detail_team.errors.assign_failed"),
  );
  if (!ok) currentTeamId.value = previous;
}
</script>

<template>
  <ConfigSection :title="t('components.server_detail_team.title')">
    <p class="ua-status">
      {{ t("components.server_detail_team.owning_team") }}:
      <strong>{{
        currentTeamId
          ? (teams.find((tt) => tt.id === currentTeamId)?.name ?? `#${currentTeamId}`)
          : t("components.server_detail_team.unowned")
      }}</strong
      >. {{ t("components.server_detail_team.admin_only") }}
    </p>
    <div class="field-inline">
      <SelectMenu
        :model-value="currentTeamId"
        :options="teamOptions"
        :aria-label="t('components.server_detail_team.change_team_aria')"
        create-path="/teams/new"
        :create-label="t('components.server_detail_team.create_team')"
        :reload="loadTeams"
        @update:model-value="assignTeam"
      />
    </div>
    <FieldError :message="teamError" />
  </ConfigSection>
</template>

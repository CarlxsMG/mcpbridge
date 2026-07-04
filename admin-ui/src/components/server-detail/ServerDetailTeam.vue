<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { api } from "@/composables/useApi";
import { clientPath } from "@/utils/apiPaths";
import { useResource } from "@/composables/useResource";
import { usePatchResource } from "@/composables/usePatchResource";
import type { Team } from "@/types/api";
import ConfigSection from "./ConfigSection.vue";

const props = defineProps<{ clientName: string; teamId: number | null }>();

const { data: teams, load: loadTeams } = useResource<Team[]>(
  () => api.get<{ items: Team[] }>("/admin-api/teams").then((res) => res.items),
  [],
);
onMounted(loadTeams);

const currentTeamId = ref(props.teamId);

watch(
  () => props.teamId,
  (t) => {
    currentTeamId.value = t;
  },
);

const { error: teamError, run: runAssignTeam } = usePatchResource(() => clientPath(props.clientName, "team"));

async function assignTeam(teamId: number | null) {
  const previous = currentTeamId.value;
  currentTeamId.value = teamId; // optimistic
  const ok = await runAssignTeam((path) => api.put(path, { teamId }), "Failed to assign team (super-admin only).");
  if (!ok) currentTeamId.value = previous;
}
</script>

<template>
  <ConfigSection title="Team ownership">
    <p class="ua-status">
      Owning team:
      <strong>{{
        currentTeamId ? (teams.find((t) => t.id === currentTeamId)?.name ?? `#${currentTeamId}`) : "unowned"
      }}</strong
      >. Only super-admins can change this.
    </p>
    <div class="field-inline">
      <select
        :value="currentTeamId ?? ''"
        @change="
          assignTeam(
            ($event.target as HTMLSelectElement).value ? Number(($event.target as HTMLSelectElement).value) : null,
          )
        "
      >
        <option value="">— unowned —</option>
        <option v-for="t in teams" :key="t.id" :value="t.id">{{ t.name }}</option>
      </select>
    </div>
    <p v-if="teamError" class="error">{{ teamError }}</p>
  </ConfigSection>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import { clientPath } from "../composables/apiPaths";
import type { Team } from "../types/api";

const props = defineProps<{ clientName: string; teamId: number | null }>();

const teams = ref<Team[]>([]);
const currentTeamId = ref(props.teamId);
const teamError = ref("");

watch(
  () => props.teamId,
  (t) => {
    currentTeamId.value = t;
  },
);

async function loadTeams() {
  try {
    teams.value = (await api.get<{ items: Team[] }>("/admin-api/teams")).items;
  } catch {
    teams.value = [];
  }
}
onMounted(loadTeams);

async function assignTeam(teamId: number | null) {
  teamError.value = "";
  const previous = currentTeamId.value;
  currentTeamId.value = teamId; // optimistic
  try {
    await api.put(clientPath(props.clientName, "team"), { teamId });
  } catch (err) {
    currentTeamId.value = previous;
    teamError.value = err instanceof ApiError ? err.message : "Failed to assign team (super-admin only).";
  }
}
</script>

<template>
  <div class="upstream-auth">
    <div class="ua-head">
      <h2>Team ownership</h2>
    </div>
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
  </div>
</template>

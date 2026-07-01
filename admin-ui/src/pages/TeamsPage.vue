<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { Team } from "../types/api";

const teams = ref<Team[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const newName = ref("");
const creating = ref(false);

async function load() {
  loading.value = true;
  errorMessage.value = "";
  try {
    teams.value = (await api.get<{ items: Team[] }>("/admin-api/teams")).items;
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load teams.";
  } finally {
    loading.value = false;
  }
}
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

async function remove(t: Team) {
  if (!confirm(`Delete team "${t.name}"? Its clients and users become unowned.`)) return;
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
    <h1>Teams</h1>
    <p class="lead">
      Teams own clients; a team-scoped admin only sees and manages its own team's servers.
      Super-admins (admin role with no team) manage teams and assign ownership. Assign a client's team from its detail page.
    </p>

    <form class="create-form" @submit.prevent="create">
      <input v-model="newName" type="text" placeholder="Team name (e.g. Payments)" />
      <button class="btn-primary" type="submit" :disabled="creating">Create team</button>
    </form>
    <p v-if="errorMessage" class="field-error">{{ errorMessage }}</p>

    <table v-if="!loading" class="grid">
      <thead><tr><th>ID</th><th>Name</th><th>Created</th><th></th></tr></thead>
      <tbody>
        <tr v-for="t in teams" :key="t.id">
          <td>{{ t.id }}</td>
          <td>{{ t.name }}</td>
          <td>{{ new Date(t.createdAt).toLocaleDateString() }}</td>
          <td><button class="link-btn" @click="remove(t)">delete</button></td>
        </tr>
        <tr v-if="teams.length === 0"><td colspan="4" class="empty">No teams yet.</td></tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.page { max-width: 760px; }
.lead { color: #555; font-size: 0.9rem; }
.create-form { display: flex; gap: 0.5rem; margin: 1rem 0; }
.create-form input { flex: 1; padding: 0.45rem 0.6rem; border: 1px solid #cfd4da; border-radius: 6px; }
.grid { width: 100%; border-collapse: collapse; }
.grid th, .grid td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid #eee; font-size: 0.9rem; }
.empty { color: #888; text-align: center; }
.field-error { color: #a11212; font-size: 0.85rem; }
.link-btn { background: none; border: none; color: #a11212; cursor: pointer; }
</style>

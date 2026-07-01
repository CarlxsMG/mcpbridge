<script setup lang="ts">
import { ref, onMounted } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { OverviewStats } from "../types/api";

const stats = ref<OverviewStats | null>(null);
const errorMessage = ref("");
const loading = ref(false);

async function load() {
  loading.value = true;
  errorMessage.value = "";
  try {
    stats.value = await api.get<OverviewStats>("/admin-api/overview");
  } catch (err) {
    errorMessage.value = err instanceof ApiError ? err.message : "Failed to load overview.";
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section>
    <header class="page-header">
      <h1>Overview</h1>
      <p class="subtitle">Live snapshot of this bridge instance.</p>
    </header>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <div v-if="loading" class="loading">Loading…</div>

    <div v-else-if="stats" class="cards">
      <div class="card">
        <h2>Clients</h2>
        <p class="big">{{ stats.clients.live }}</p>
        <p class="detail">{{ stats.clients.disabled }} disabled · {{ stats.clients.unreachable }} unreachable</p>
      </div>
      <div class="card">
        <h2>Tools</h2>
        <p class="big">{{ stats.tools.total }}</p>
        <p class="detail">{{ stats.tools.disabled }} disabled</p>
      </div>
      <div class="card">
        <h2>Circuit breakers</h2>
        <p class="big">{{ stats.circuit_breakers.open }}</p>
        <p class="detail">open · {{ stats.circuit_breakers.half_open }} half-open</p>
      </div>
      <div class="card">
        <h2>Admin users</h2>
        <p class="big">{{ stats.admin_users }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.page-header h1 {
  margin: 0 0 0.2rem;
}
.subtitle {
  color: #63676e;
  margin: 0 0 1.25rem;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1rem;
}
.card {
  background: #fafbfc;
  border-radius: 10px;
  padding: 1.25rem;
}
.card h2 {
  font-size: 0.8rem;
  text-transform: uppercase;
  color: #63676e;
  margin: 0 0 0.4rem;
}
.big {
  font-size: 2rem;
  font-weight: 700;
  margin: 0;
}
.detail {
  color: #63676e;
  font-size: 0.85rem;
  margin: 0.2rem 0 0;
}
.error {
  color: #a11212;
}
.loading {
  color: #63676e;
}
</style>

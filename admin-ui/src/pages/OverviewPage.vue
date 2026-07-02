<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { api, ApiError } from "../composables/useApi";
import type { OverviewStats } from "../types/api";
import StatCard from "../components/StatCard.vue";
import SegmentedBar from "../components/SegmentedBar.vue";
import { Server, Wrench, GitBranch, ShieldCheck, RefreshCw } from "lucide-vue-next";

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

const clientSegments = computed(() => {
  if (!stats.value) return [];
  const c = stats.value.clients;
  return [
    { label: "Healthy", value: c.healthy, color: "var(--ok)" },
    { label: "Degraded", value: c.degraded, color: "var(--canary)" },
    { label: "Unreachable", value: c.unreachable, color: "var(--breach)" },
  ].filter((s) => s.value > 0);
});

onMounted(load);
</script>

<template>
  <section>
    <header class="page-header">
      <div>
        <h1>Overview</h1>
        <p class="subtitle">Live snapshot of this bridge instance.</p>
      </div>
      <button type="button" class="btn-secondary" :disabled="loading" @click="load">
        <RefreshCw :size="14" stroke-width="2" aria-hidden="true" :class="{ spin: loading }" />
        {{ loading ? "Refreshing…" : "Refresh" }}
      </button>
    </header>

    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <div v-if="loading && !stats" class="loading">Loading…</div>

    <div v-else-if="stats" class="cards">
      <StatCard :icon="Server" label="Clients" :value="stats.clients.live" :detail="`${stats.clients.disabled} disabled`">
        <SegmentedBar v-if="clientSegments.length" :segments="clientSegments" />
      </StatCard>
      <StatCard :icon="Wrench" label="Tools" :value="stats.tools.total" :detail="`${stats.tools.disabled} disabled`" />
      <StatCard
        :icon="GitBranch"
        label="Circuit breakers"
        :value="stats.circuit_breakers.open"
        :detail="`${stats.circuit_breakers.half_open} half-open`"
        :tone="stats.circuit_breakers.open > 0 ? 'danger' : 'ok'"
        :pulse="stats.circuit_breakers.open > 0"
      />
      <StatCard :icon="ShieldCheck" label="Admin users" :value="stats.admin_users" />
    </div>
  </section>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1.5rem;
}
.page-header h1 {
  margin: 0 0 0.2rem;
}
.subtitle {
  color: var(--text-secondary);
  margin: 0;
}
.page-header .btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.spin {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 1rem;
}
.error {
  color: var(--breach);
}
.loading {
  color: var(--text-muted);
}
</style>

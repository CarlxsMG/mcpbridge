<script setup lang="ts">
import { Waypoints } from "lucide-vue-next";
</script>

<template>
  <section class="not-found">
    <Waypoints :size="28" stroke-width="1.5" color="var(--text-muted)" aria-hidden="true" class="not-found-icon" />
    <h1>Route not found</h1>
    <p class="subtitle">This bridge doesn't answer at that path.</p>
    <p><RouterLink to="/servers" class="btn-secondary">Back to Servers</RouterLink></p>
  </section>
</template>

<style scoped>
.not-found {
  text-align: center;
  padding: var(--space-12) var(--space-4);
}
.not-found-icon {
  margin-bottom: var(--space-4);
}
.subtitle {
  color: var(--text-secondary);
}
</style>

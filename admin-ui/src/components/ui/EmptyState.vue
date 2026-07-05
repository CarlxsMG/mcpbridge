<script setup lang="ts">
import type { Component } from "vue";

defineProps<{ icon: Component; muted?: boolean }>();
</script>

<template>
  <div class="empty-state">
    <component :is="icon" :size="26" stroke-width="1.5" aria-hidden="true" class="empty-icon" />
    <p :class="{ 'is-muted': muted }"><slot /></p>
  </div>
</template>

<style scoped>
.empty-state {
  padding: 3rem 2rem;
  text-align: center;
  color: var(--text-secondary);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.empty-icon {
  color: var(--text-muted);
  margin-bottom: 0.75rem;
}
.is-muted {
  color: var(--text-muted);
}
</style>

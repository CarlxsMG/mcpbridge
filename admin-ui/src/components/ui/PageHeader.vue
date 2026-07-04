<script setup lang="ts">
import type { RouteLocationRaw } from "vue-router";
import { ChevronLeft } from "lucide-vue-next";

defineProps<{
  title: string;
  subtitle?: string;
  backLink?: { to: RouteLocationRaw; label: string };
}>();
</script>

<template>
  <div class="page-header">
    <div>
      <RouterLink v-if="backLink" :to="backLink.to" class="back-link">
        <ChevronLeft :size="14" stroke-width="2" aria-hidden="true" />
        {{ backLink.label }}
      </RouterLink>
      <h1>{{ title }}</h1>
      <div v-if="$slots.meta" class="header-meta"><slot name="meta" /></div>
      <p v-if="subtitle" class="subtitle">{{ subtitle }}</p>
    </div>
    <div v-if="$slots.default" class="header-actions"><slot /></div>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1.25rem;
}
.page-header h1 {
  margin: 0 0 0.2rem;
}
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  color: var(--text-secondary);
  font-size: 0.85rem;
  text-decoration: none;
  margin-bottom: 0.3rem;
}
.back-link:hover {
  color: var(--text-primary);
}
.header-meta {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0 0 0.2rem;
}
.subtitle {
  color: var(--text-secondary);
  margin: 0;
}
</style>

<script setup lang="ts">
import { Waypoints } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
const { t } = useI18n({ useScope: "global" });
</script>

<template>
  <section class="not-found">
    <Waypoints :size="28" stroke-width="1.5" color="var(--text-muted)" aria-hidden="true" class="not-found-icon" />
    <h1>{{ t("pages.not_found.title") }}</h1>
    <p class="subtitle">{{ t("pages.not_found.subtitle") }}</p>
    <p>
      <RouterLink to="/servers" class="btn-secondary">{{ t("pages.not_found.go_servers") }}</RouterLink>
      <RouterLink to="/overview" class="btn-secondary">{{ t("pages.not_found.go_overview") }}</RouterLink>
    </p>
  </section>
</template>

<style scoped>
.not-found {
  text-align: center;
  padding: var(--space-12) var(--space-4);
}
.not-found p {
  display: flex;
  gap: var(--space-3);
  justify-content: center;
  flex-wrap: wrap;
}
.not-found-icon {
  margin-bottom: var(--space-4);
}
.subtitle {
  color: var(--text-secondary);
}
</style>

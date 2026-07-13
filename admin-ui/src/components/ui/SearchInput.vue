<script setup lang="ts">
import { Search } from "lucide-vue-next";
import { useI18n } from "vue-i18n";

defineProps<{ placeholder?: string; ariaLabel?: string }>();
const model = defineModel<string>({ default: "" });
const { t } = useI18n({ useScope: "global" });
</script>

<template>
  <div class="search-input">
    <Search :size="15" stroke-width="2" aria-hidden="true" />
    <input
      v-model="model"
      type="search"
      :placeholder="placeholder"
      :aria-label="ariaLabel ?? placeholder ?? t('common.search')"
    />
  </div>
</template>

<style scoped>
.search-input {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 0 0.6rem;
  background: var(--surface);
}
.search-input svg {
  color: var(--text-muted);
  flex-shrink: 0;
}
.search-input input {
  flex: 1;
  width: 100%;
  padding: 0.45rem 0;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: 0.9rem;
}
</style>

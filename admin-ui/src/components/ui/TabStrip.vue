<script setup lang="ts" generic="T extends string">
import type { Component } from "vue";

defineProps<{ tabs: { key: T; label: string; icon?: Component }[]; ariaLabel?: string }>();
const active = defineModel<T>({ required: true });
</script>

<template>
  <div class="tab-strip" role="tablist" :aria-label="ariaLabel">
    <button
      v-for="tab in tabs"
      :key="tab.key"
      type="button"
      role="tab"
      :aria-selected="active === tab.key"
      class="tab-btn"
      :class="{ 'tab-active': active === tab.key }"
      @click="active = tab.key"
    >
      <component :is="tab.icon" v-if="tab.icon" :size="15" stroke-width="2" aria-hidden="true" />
      {{ tab.label }}
    </button>
  </div>
</template>

<style scoped>
.tab-strip {
  display: flex;
  gap: 0.25rem;
  margin-bottom: 1.25rem;
  border-bottom: 1px solid var(--border);
}
.tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font-weight: 600;
  font-size: 0.88rem;
  padding: 0.55rem 0.35rem;
  margin-bottom: -1px;
  cursor: pointer;
  transition:
    color 0.12s ease,
    border-color 0.12s ease;
}
.tab-btn:hover {
  color: var(--text-primary);
}
.tab-btn.tab-active {
  color: var(--signal-strong);
  border-bottom-color: var(--signal);
}
</style>

<script setup lang="ts">
import type { Component } from "vue";

withDefaults(
  defineProps<{
    icon: Component;
    label: string;
    value: string | number;
    detail?: string;
    tone?: "default" | "danger" | "warning" | "ok";
    pulse?: boolean;
  }>(),
  { detail: "", tone: "default", pulse: false },
);
</script>

<template>
  <div class="stat-card" :class="`tone-${tone}`">
    <div class="stat-head">
      <div class="stat-icon" :class="{ pulse }">
        <component :is="icon" :size="16" stroke-width="2" aria-hidden="true" />
      </div>
      <p class="stat-label">{{ label }}</p>
    </div>
    <p class="stat-value">{{ value }}</p>
    <p v-if="detail" class="stat-detail">{{ detail }}</p>
    <div v-if="$slots.default" class="stat-extra"><slot /></div>
  </div>
</template>

<style scoped>
.stat-card {
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-4) var(--space-5);
  box-shadow: var(--shadow-xs);
  transition:
    box-shadow 0.15s ease,
    transform 0.15s ease;
}
.stat-card:hover {
  box-shadow: var(--shadow-sm);
  transform: translateY(-1px);
}

.stat-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.stat-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.625rem;
  height: 1.625rem;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  background: var(--signal-soft);
  color: var(--signal-strong);
}
.stat-icon.pulse {
  animation: signal-pulse 1.6s ease-in-out infinite;
}

.tone-danger .stat-icon {
  background: var(--breach-soft);
  color: var(--breach);
}
.tone-warning .stat-icon {
  background: var(--canary-soft);
  color: var(--canary);
}
.tone-ok .stat-icon {
  background: var(--ok-soft);
  color: var(--ok);
}

.stat-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: break-spaces;
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  margin: 0;
}
.stat-value {
  text-align: left;
  font-family: var(--font-display);
  font-size: 1.85rem; /* display size, deliberately above the --text-* scale (body/UI text only) */
  font-weight: 600;
  line-height: 1.2;
  margin: var(--space-1-5) 0 0;
  padding: 0 0 0 var(--space-1);
  color: var(--text-primary);
  overflow-wrap: anywhere;
}
.tone-danger .stat-value {
  color: var(--breach);
}
.stat-detail {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  margin: var(--space-1) 0 0;
}
.stat-extra {
  margin-top: var(--space-2);
}
</style>

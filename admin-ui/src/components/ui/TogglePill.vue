<script setup lang="ts">
defineProps<{ on: boolean; onLabel: string; offLabel: string; disabled?: boolean }>();
</script>

<template>
  <button type="button" class="toggle" :class="on ? 'toggle-on' : 'toggle-off'" :aria-pressed="on" :disabled="disabled">
    {{ on ? onLabel : offLabel }}
  </button>
</template>

<style scoped>
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.45em;
  border-radius: var(--radius-pill);
  padding: 0.28rem 0.8rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  background: var(--surface);
  transition: background-color 0.12s ease;
}
.toggle::before {
  content: "";
  width: 0.55em;
  height: 0.55em;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.toggle-on {
  /* Border keeps --ok (non-text, 3:1); the label needs --ok-text, which clears
     4.5:1 on every surface a row can sit on (5.18 / 4.95 / 4.82). --ok itself
     managed only 4.13 here. */
  border: 1px solid var(--ok);
  color: var(--ok-text);
}
.toggle-off {
  border: 1px solid var(--border-strong);
  color: var(--text-secondary);
}
.toggle-on:hover {
  background: var(--ok-soft);
}
.toggle-off:hover {
  background: var(--surface-sunken);
}
</style>

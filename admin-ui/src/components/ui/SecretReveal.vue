<script setup lang="ts">
/**
 * One-time "secret minted" reveal block — shown right after creating an API
 * key, install link, or similar credential that can only be displayed once.
 * Callers supply the heading text and the secret value; the action row
 * (copy button, dismiss/done link, etc.) is left to the caller via slots
 * since it varies enough between call sites not to be worth a prop surface.
 */
defineProps<{
  /** Heading shown above the secret, e.g. "New install link created". */
  title: string;
  /** The one-time secret/value rendered in the monospace reveal field. */
  secret: string;
}>();
</script>

<template>
  <div class="minted" role="alert">
    <div class="minted-title">{{ title }}</div>
    <div class="minted-row">
      <code class="minted-secret">{{ secret }}</code>
      <slot />
    </div>
    <div v-if="$slots.footer" class="minted-footer">
      <slot name="footer" />
    </div>
  </div>
</template>

<style scoped>
.minted {
  background: var(--ok-soft);
  border: 1px solid var(--ok);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  margin-bottom: var(--space-4);
}
.minted-title {
  font-weight: 600;
  font-size: var(--text-sm);
  margin-bottom: var(--space-2);
}
.minted-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.minted-secret {
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 0.4rem 0.6rem;
  font-size: 0.82rem;
  font-family: var(--font-mono);
  word-break: break-all;
  flex: 1;
  min-width: 12.5rem;
}
.minted-footer {
  margin-top: var(--space-4);
}
</style>

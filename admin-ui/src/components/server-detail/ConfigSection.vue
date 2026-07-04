<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <div class="upstream-auth">
    <div class="ua-head">
      <h2>{{ title }}</h2>
      <div v-if="$slots.actions" class="ua-actions"><slot name="actions" /></div>
    </div>
    <slot />
  </div>
</template>

<style>
/* Deliberately unscoped: .upstream-auth, .ua-head, .ua-actions, .ua-status,
   .ua-form and .link-btn.danger style the shell this component renders, but
   the 7 ServerDetailXxx.vue section components that use it
   (ServerDetailUpstreamAuth, ServerDetailOAuth, ServerDetailResync,
   ServerDetailLb, ServerDetailCanary, ServerDetailTeam, ServerDetailRemove)
   each render under their own scope hash, not this one — a scoped block here
   would never reach the status paragraph or form markup they pass into the
   default slot. Same reasoning as ui/TableCard.vue's unscoped .data-table
   block and guard-editor/GuardEditor.vue's unscoped .guard-editor block.
   Verified none of these class names collide with anything else in
   admin-ui/src. */
.upstream-auth {
  margin: 0 0 1.75rem;
  padding: 1rem 1.25rem;
  background: var(--surface-sunken);
  border-radius: 8px;
}
.ua-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.ua-head h2 {
  margin: 0;
  font-size: 1.05rem;
}
.ua-actions {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}
.ua-status {
  font-size: 0.85rem;
  color: var(--text-secondary);
  margin: 0.5rem 0 0;
}
.ua-form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  margin-top: 0.9rem;
  max-width: 22.5rem;
}
.ua-form label {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.82rem;
  font-weight: 600;
}
.ua-form input,
.ua-form select {
  padding: 0.4rem 0.55rem;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  font-weight: 400;
}
.link-btn.danger {
  color: var(--breach);
}
</style>

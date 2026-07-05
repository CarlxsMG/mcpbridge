<script setup lang="ts">
// `.content` (App.vue) is deliberately full-bleed for table/dashboard pages —
// but a single narrow form left flush against a wide viewport (this app also
// targets large-monitor/TV widths) reads as broken, not spacious. Refactoring
// UI's rule for narrow content on a wide page: cap the width AND center it,
// rather than let it float in a sea of blank space on one side. Centers the
// whole column (PageHeader included) so the title and the form share one
// consistent left edge instead of the header staying flush-left above a
// centered form.
withDefaults(defineProps<{ maxWidth?: string }>(), { maxWidth: "30rem" });
</script>

<template>
  <div class="form-page">
    <div class="form-page-column" :style="{ maxWidth }">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.form-page {
  display: flex;
  justify-content: center;
}
.form-page-column {
  width: 100%;
  min-width: 0;
}

/* Consumers put a `.form-card` class on the <form> they pass in as slot
   content. :slotted() (not :deep()) is required because that <form> is
   compiled in the consumer's own scope, not this component's. Distinct
   from the unrelated global `.create-form` in style.css. */
:slotted(.form-card) {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
</style>

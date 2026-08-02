<script setup lang="ts">
import { Search } from "lucide-vue-next";
import { useI18n } from "vue-i18n";

defineProps<{ placeholder?: string; ariaLabel?: string; id?: string }>();
const model = defineModel<string>({ default: "" });
const { t } = useI18n({ useScope: "global" });
</script>

<template>
  <div class="search-input">
    <Search :size="15" stroke-width="2" aria-hidden="true" />
    <input
      :id="id"
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
  /* The focus ring belongs on the wrapper, not here: `.search-input` is what
     reads as the control (it owns the border, radius and background), so an
     outline on the bare input would be drawn *inside* that border. Suppressing
     it is only safe because of the `:has()` rule below — on its own this line
     silently beats the global `:focus-visible` ring in style.css (a scoped
     rule, so higher specificity) and leaves the field with no focus indicator
     at all, on every list page that uses this component. */
  outline: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: 0.9rem;
}
/* The global `:focus-visible` ring from style.css, hoisted to the wrapper.
   Same `:has(... :focus-visible)` idiom `.segmented label` already uses there,
   so the two stay visually identical if the token ever changes. */
.search-input:has(input:focus-visible) {
  outline: 2px solid var(--signal);
  outline-offset: 2px;
}
</style>

<script setup lang="ts">
import { computed } from "vue";
import { Search } from "lucide-vue-next";
import { useI18n } from "vue-i18n";

const props = defineProps<{ placeholder?: string; ariaLabel?: string; id?: string }>();
const model = defineModel<string>({ default: "" });
const { t } = useI18n({ useScope: "global" });

/**
 * The input's accessible name, or undefined to leave it to the caller's own
 * `<label for>`.
 *
 * Passing an `id` is the signal that the caller has rendered a visible
 * `<label for>` — every call site that passes one does (ServersPage's "Search",
 * AuditLogPage's "Actor"/"Action"). In that case the component must stay out of
 * the naming: an `aria-label` OVERRIDES the visible label rather than adding to
 * it, so the placeholder fallback used to make the field announce "Filter by
 * actor…" while showing "Actor". The visible text still happened to be a
 * substring of the announced name, so it scraped past WCAG 2.5.3 (Label in
 * Name) — but a speech-input user saying the label they can see was relying on
 * that coincidence, and the mismatch is exactly what 2.5.3 exists to prevent.
 *
 * An explicit `ariaLabel` still wins, for callers that want a name different
 * from both. With neither, the placeholder (then a generic "Search") names the
 * field — which is why the unlabelled call sites are fine as they are.
 *
 * The contract is enforced, not just documented: e2e/accessibility.spec.ts
 * fails on any rendered input with no accessible name, so passing an `id`
 * without a matching `<label for>` shows up as a test failure rather than as a
 * silently unnamed field.
 */
const accessibleName = computed<string | undefined>(() => {
  if (props.ariaLabel) return props.ariaLabel;
  if (props.id) return undefined;
  return props.placeholder ?? t("common.search");
});
</script>

<template>
  <div class="search-input">
    <Search :size="15" stroke-width="2" aria-hidden="true" />
    <input :id="id" v-model="model" type="search" :placeholder="placeholder" :aria-label="accessibleName" />
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

<script setup lang="ts">
/**
 * The "you have unsaved edits, really leave?" prompt, as one component.
 *
 * 14 pages (the 11 New*Page routes plus RegisterServerPage, BundleDetailPage and
 * CompositeDetailPage) each hand-wired `useUnsavedChangesGuard` and then repeated a
 * byte-identical 9-line <ConfirmDialog> that differed only in its i18n key prefix.
 * That cost 42 catalog keys per locale, and 12 of the 14 messages were the same
 * sentence with a different noun swapped in.
 *
 * The default copy names no entity on purpose. The dialog only ever opens while the
 * user is looking at the form in question, so "this bundle" / "this API key" adds
 * nothing a glance doesn't already supply — and dropping it avoids a real problem in
 * Spanish, where an interpolated noun drags its gendered article along with it
 * ("este bundle" vs "esta API key"). Pages whose message genuinely says something
 * different (not just a different noun) pass `message`.
 *
 * Calling `onBeforeRouteLeave` from a child component is supported: vue-router
 * resolves it against `matchedRouteKey`, "the RouteRecord being rendered by the
 * closest ancestor Router View", which RouterView provides to every descendant.
 */
import { useI18n } from "vue-i18n";
import { useUnsavedChangesGuard } from "@/composables/useUnsavedChangesGuard";
import ConfirmDialog from "./ConfirmDialog.vue";

const props = defineProps<{
  /** Whether the form currently holds edits worth warning about. */
  dirty: boolean;
  /**
   * Leave without prompting even while dirty. Two real cases: a submit is in
   * flight (the navigation IS the save), and the record was just deleted, which
   * leaves the form permanently "dirty" against a server state that is now gone.
   */
  bypass?: boolean;
  /** Overrides the default sentence for a page whose warning is genuinely different. */
  message?: string;
}>();

const { t } = useI18n({ useScope: "global" });

const { pendingLeave, confirmLeave, cancelLeave } = useUnsavedChangesGuard(
  () => props.dirty,
  () => props.bypass ?? false,
);
</script>

<template>
  <ConfirmDialog
    :open="pendingLeave"
    :title="t('components.unsaved_changes.title')"
    :message="message ?? t('components.unsaved_changes.message')"
    :confirm-label="t('components.unsaved_changes.cta')"
    danger
    @confirm="confirmLeave"
    @cancel="cancelLeave"
  />
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import CopyButton from "@/components/ui/CopyButton.vue";

/**
 * Drop-in replacement for the `<p class="error" role="alert">{{ msg }}</p>`
 * block every page hand-wrote, extended with the failing request's correlation
 * id.
 *
 * The id is what lets an operator take "Failed to update." and find the
 * matching row in the audit log, the trace viewer, or the server's stdout —
 * before this it was generated on every request, returned in every error
 * envelope, and then dropped on the floor by the client.
 *
 * It is rendered outside the `role="alert"` element deliberately: the live
 * region should announce the human sentence, not spell out a 36-character
 * UUID. Screen-reader users still reach the id by navigating to it, where the
 * visible "Request ref" label gives it context.
 */
defineProps<{
  message: string;
  /**
   * Correlation id, when the failure came from a real HTTP response. Null for
   * network-level failures and client-synthesized errors, which have no
   * server-side request to correlate — the ref line is then omitted entirely
   * rather than shown empty.
   */
  requestId?: string | null;
}>();

const { t } = useI18n({ useScope: "global" });
</script>

<template>
  <div class="error-note">
    <p class="error" role="alert">{{ message }}</p>
    <p v-if="requestId" class="error-ref">
      <span class="error-ref-label">{{ t("errors.request_ref") }}</span>
      <code>{{ requestId }}</code>
      <CopyButton :text="requestId" class="error-ref-copy" />
    </p>
  </div>
</template>

<style scoped>
.error-note {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.error-ref {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--text-secondary);
}
.error-ref-label {
  font-weight: 600;
}
.error-ref code {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  background: var(--surface-sunken);
  border-radius: var(--radius-sm);
  padding: 0.1rem 0.4rem;
  /* The id is a UUID: on a narrow viewport it must be allowed to wrap rather
     than force the whole page into a horizontal scroll. */
  word-break: break-all;
}
.error-ref-copy {
  padding: 0.15rem 0.45rem;
  font-size: var(--text-xs);
}
</style>

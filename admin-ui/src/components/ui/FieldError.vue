<script setup lang="ts">
/**
 * Shared replacement for the hand-rolled `<p v-if="error" class="error">{{ error }}</p>`
 * pattern repeated across (previously) every New*Page.vue create form. Adds
 * `role="alert"` so async submit/save failures are actually announced to
 * screen readers — a plain `<p>` update is silent to assistive tech since
 * nothing about it says "this changed, tell the user".
 *
 * Use this for any future error-display site too, instead of re-hand-writing
 * the `<p v-if="..." class="error">` markup.
 *
 * Rendering delegates to `<ErrorNote>` so a create/save failure shows the same
 * copyable correlation ref as a load failure does through ListLayout. Pass
 * `requestId` from the form composable's `errorRequestId`; omitting it renders
 * exactly the markup this component always did.
 */
import ErrorNote from "@/components/ui/ErrorNote.vue";

defineProps<{ message: string; requestId?: string | null }>();
</script>

<template>
  <ErrorNote v-if="message" :message="message" :request-id="requestId" />
</template>

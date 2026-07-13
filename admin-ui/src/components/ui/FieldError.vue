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
 */
defineProps<{ message: string }>();
</script>

<template>
  <p v-if="message" class="error" role="alert">{{ message }}</p>
</template>

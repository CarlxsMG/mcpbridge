<script setup lang="ts">
import SignalLoader from "@/components/ui/SignalLoader.vue";
import ErrorNote from "@/components/ui/ErrorNote.vue";

defineProps<{
  loading: boolean;
  error?: string;
  /**
   * Correlation id for `error`, as produced alongside it by useLoadState /
   * useResource. Optional so call sites that don't yet pass it keep working
   * unchanged — they simply render no ref line.
   */
  errorRequestId?: string | null;
  empty: boolean;
}>();
</script>

<template>
  <ErrorNote v-if="error" :message="error" :request-id="errorRequestId" />
  <SignalLoader v-else-if="loading" />
  <slot v-else-if="empty" name="empty" />
  <slot v-else />
</template>

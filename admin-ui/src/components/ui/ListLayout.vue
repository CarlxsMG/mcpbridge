<script setup lang="ts">
import SignalLoader from "@/components/ui/SignalLoader.vue";

defineProps<{ loading: boolean; error?: string; empty: boolean }>();
</script>

<template>
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <SignalLoader v-else-if="loading" />
  <slot v-else-if="empty" name="empty" />
  <slot v-else />
</template>

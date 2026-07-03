<script setup lang="ts">
const show = defineModel<boolean>({ required: true });
defineProps<{ showLabel: string; hideLabel?: string }>();
</script>

<template>
  <button type="button" :class="show ? 'btn-secondary' : 'btn-primary'" @click="show = !show">
    {{ show ? (hideLabel ?? "Cancel") : showLabel }}
  </button>
</template>

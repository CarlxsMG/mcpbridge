<script setup lang="ts">
const props = defineProps<{ label: string; for: string }>();
</script>

<template>
  <div class="field">
    <label :for="props.for">{{ label }}</label>
    <slot />
  </div>
</template>

<style scoped>
.field {
  margin-bottom: 1rem;
}
.field label {
  display: block;
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.3rem;
}
</style>

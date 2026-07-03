<script setup lang="ts">
defineProps<{ hasPrev: boolean; hasNext: boolean; label?: string }>();
const emit = defineEmits<{ prev: []; next: [] }>();
</script>

<template>
  <div class="pagination-bar">
    <button type="button" class="btn-secondary" :disabled="!hasPrev" @click="emit('prev')">Previous</button>
    <button type="button" class="btn-secondary" :disabled="!hasNext" @click="emit('next')">Next</button>
    <span v-if="label">{{ label }}</span>
  </div>
</template>

<style scoped>
/* Positioning (.pagination sticky/margin-auto/border-top/background/padding) stays page-side —
   it styles an ancestor's relationship to `section`, not this component's own root. */
.pagination-bar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
</style>

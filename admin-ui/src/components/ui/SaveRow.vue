<script setup lang="ts">
defineProps<{ label: string; savingLabel?: string; saving: boolean; saved: boolean; error?: string }>();
const emit = defineEmits<{ save: [] }>();
</script>

<template>
  <button type="button" class="btn-secondary desc-save" :disabled="saving" @click="emit('save')">
    {{ saving ? (savingLabel ?? "Saving…") : label }}
  </button>
  <span v-if="saved" class="save-ok">Saved</span>
  <p v-if="error" class="field-error">{{ error }}</p>
</template>

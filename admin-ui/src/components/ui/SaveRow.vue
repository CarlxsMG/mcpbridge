<script setup lang="ts">
import { useI18n } from "vue-i18n";
defineProps<{ label: string; savingLabel?: string; saving: boolean; saved: boolean; error?: string }>();
const emit = defineEmits<{ save: [] }>();
const { t } = useI18n({ useScope: "global" });
</script>

<template>
  <button type="button" class="btn-secondary desc-save" :disabled="saving" @click="emit('save')">
    {{ saving ? (savingLabel ?? t("common.saving")) : label }}
  </button>
  <span v-if="saved" class="save-ok" role="status">{{ t("common.saved") }}</span>
  <p v-if="error" class="field-error" role="alert">{{ error }}</p>
</template>

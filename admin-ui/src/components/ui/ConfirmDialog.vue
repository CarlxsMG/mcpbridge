<script setup lang="ts">
import { useI18n } from "vue-i18n";
import ModalShell from "./ModalShell.vue";

defineProps<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
}>();

const emit = defineEmits<{ confirm: []; cancel: [] }>();
const { t } = useI18n({ useScope: "global" });
</script>

<template>
  <ModalShell :open="open" :label="title" alert :max-width="'26.25rem'" @close="emit('cancel')">
    <h2>{{ title }}</h2>
    <p>{{ message }}</p>
    <div class="actions">
      <button type="button" class="btn-secondary" @click="emit('cancel')">{{ t("common.cancel") }}</button>
      <button type="button" :class="danger ? 'btn-danger' : 'btn-primary'" @click="emit('confirm')">
        {{ confirmLabel }}
      </button>
    </div>
  </ModalShell>
</template>

<style scoped>
h2 {
  margin: 0 0 var(--space-2);
  font-size: var(--text-lg);
}
p {
  margin: 0 0 var(--space-5);
  color: var(--text-secondary);
  line-height: 1.4;
  font-family: var(--font-body);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
